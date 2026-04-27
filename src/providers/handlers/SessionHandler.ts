import * as vscode from 'vscode';
import type { ConversationIndexEntry, OpenCodeProviderData } from '../../common';
import { generateId, parseModelId } from '../../common';
import { prependInlineAttachmentReferences } from '../../common/inlineAttachments';
import { IMPROVE_PROMPT_DEFAULT_TEMPLATE } from '../../common/promptImprover';
import type { CommandOf, QueuedMessageData, WebviewCommand } from '../../common/protocol';
import { parseSessionUpdatedRuntimePayload } from '../../common/schemas';
import type { CLIConfig } from '../../core/executor/types';
import { buildOptimisticPromptParts } from '../../core/promptParts';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class SessionHandler implements WebviewMessageHandler {
	/** Sessions whose canonical snapshot has already been restored into the webview. */
	private restoredSessions = new Set<string>();
	/** Sessions currently restoring to avoid duplicate snapshot work. */
	private restoringSessions = new Map<string, Promise<void>>();

	/** Deferred flag: webviewDidLaunch arrived before the server was ready. */
	private pendingWebviewLaunch = false;

	/**
	 * Guard: true once initial restoration has finished.
	 * While false, the only persistence writes allowed are the explicit
	 * `writePersistedTabs` calls inside `restoreOrCreateSession` itself.
	 */
	private restorationComplete = false;

	// Improve Prompt State
	private improvePromptController: AbortController | null = null;
	private improvePromptActiveRequestId: string | null = null;

	/** Per-session message queue — up to MAX_QUEUE_SIZE per session (FIFO). */
	private static readonly MAX_QUEUE_SIZE = 3;
	private readonly pendingMessages = new Map<string, QueuedMessageData[]>();
	private queueIdCounter = 0;

	/** Per-session sending lock — prevents race between processQueueOnIdle and onSendMessage. */
	private readonly sendingLock = new Set<string>();

	constructor(private context: HandlerContext) {
		this.context.cli.on('sdk_event', (event: unknown) => {
			const sdkEvent = event as {
				type?: string;
				properties?: { sessionID?: string; status?: { type?: string } };
			};
			const targetSessionId = sdkEvent.properties?.sessionID;
			if (!targetSessionId) return;

			if (sdkEvent.type === 'session.status') {
				const status = sdkEvent.properties?.status;
				if (status?.type === 'idle' && !this.context.sessionState.isStopGuarded(targetSessionId)) {
					void this.processQueueOnIdle(targetSessionId);
				}
				return;
			}

			if (sdkEvent.type === 'session.idle') {
				if (!this.context.sessionState.isStopGuarded(targetSessionId)) {
					void this.processQueueOnIdle(targetSessionId);
				}
			}
		});
	}

	private updateQueue(
		sessionId: string,
		mutator: (queue: QueuedMessageData[]) => QueuedMessageData[],
	): QueuedMessageData[] {
		const current = this.pendingMessages.get(sessionId) ?? [];
		const next = mutator([...current]);
		if (next.length === 0) this.pendingMessages.delete(sessionId);
		else this.pendingMessages.set(sessionId, next);
		return next;
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'webviewDidLaunch':
				await this.onWebviewDidLaunch();
				break;
			case 'createSession':
				await this.onCreateSession();
				break;
			case 'switchSession':
				await this.onSwitchSession(msg);
				break;
			case 'closeSession':
				await this.onCloseSession(msg);
				break;
			case 'sendMessage':
				await this.onSendMessage(msg);
				break;
			case 'stopRequest':
				await this.onStopRequest(msg);
				break;
			case 'cancelQueuedMessage':
				this.onCancelQueuedMessage(msg);
				break;
			case 'forceQueuedMessage':
				await this.onForceQueuedMessage(msg);
				break;
			case 'reorderQueue':
				this.onReorderQueue(msg);
				break;
			case 'improvePromptRequest':
				await this.onImprovePromptRequest(msg);
				break;
			case 'cancelImprovePrompt':
				await this.onCancelImprovePrompt(msg);
				break;
			case 'getConversationList':
				await this.onGetConversationList();
				break;
			case 'loadConversation':
				await this.onLoadConversation(msg);
				break;
			case 'deleteConversation':
				await this.onDeleteConversation(msg);
				break;
			case 'clearAllConversations':
				await this.onClearAllConversations();
				break;
			case 'renameConversation':
				await this.onRenameConversation(msg);
				break;
		}
	}

	public handleSessionUpdatedEvent(data: unknown, eventSessionId?: string): void {
		const parsed = parseSessionUpdatedRuntimePayload(data);

		// Resolve target session: event-level sessionId > data.sessionId > activeSessionId
		const backendSessionId = eventSessionId || parsed.sessionId;

		const status = parsed.status;

		// STRICT: never fallback to activeSessionId for any event routing.
		// Without a real sessionId, we'd route data to the wrong session after tab switch.
		const targetSessionId = backendSessionId;
		if (!targetSessionId) {
			logger.warn('[SessionHandler] Dropping session_updated event without sessionId', {
				statusType: status?.type,
			});
			return;
		}

		// Ensure session is tracked as started
		if (!this.context.sessionState.startedSessions.has(targetSessionId)) {
			this.context.sessionState.startedSessions.add(targetSessionId);
		}

		if (status?.type === 'busy') {
			// Stop guard: suppress 'busy' events that arrive after user clicked Stop.
			// This prevents delayed SSE events from overwriting the forced 'idle' status.
			if (this.context.sessionState.isStopGuarded(targetSessionId)) {
				logger.debug('[SessionHandler] Suppressed busy status (stop guard active)', {
					targetSessionId,
				});
				return;
			}
			this.context.bridge.emit(targetSessionId, 'status', {
				status: 'busy',
				statusText: 'Working...',
			});
		} else if (status?.type === 'idle') {
			// During stop guard, suppress idle too — we already forced idle.
			if (this.context.sessionState.isStopGuarded(targetSessionId)) {
				logger.debug('[SessionHandler] Suppressed idle status (stop guard active)', {
					targetSessionId,
				});
				return;
			}
			this.context.bridge.emit(targetSessionId, 'status', {
				status: 'idle',
				statusText: 'Ready',
			});

			// Auto-dequeue: if there's a queued message, send it now.
			// This is the OpenCode-style "callback resolution" pattern.
			void this.processQueueOnIdle(targetSessionId);
		} else if (status?.type === 'retry') {
			this.context.bridge.emit(targetSessionId, 'status', {
				status: 'retrying',
				statusText: 'Retrying…',
				retryInfo: {
					attempt: typeof status.attempt === 'number' ? status.attempt : 1,
					message: typeof status.message === 'string' ? status.message : 'Retrying…',
					nextRetryAt:
						typeof status.next === 'number' ? new Date(status.next).toISOString() : undefined,
				},
			});
		}
	}

	// =============================================================================
	// Private Handlers
	// =============================================================================

	private async onWebviewDidLaunch(): Promise<void> {
		// If the server isn't ready yet, defer restoration until onServerReady() is called.
		const serverInfo = this.context.cli.getOpenCodeServerInfo();
		if (!serverInfo?.baseUrl) {
			logger.info('[SessionHandler] Server not ready yet, deferring webviewDidLaunch');
			this.pendingWebviewLaunch = true;
			return;
		}

		await this.restoreOrCreateSession();
	}

	/**
	 * Called by ChatProvider after the OpenCode server has started successfully.
	 * If webviewDidLaunch was deferred (server wasn't ready), run restoration now.
	 */
	public async onServerReady(): Promise<void> {
		if (!this.pendingWebviewLaunch) return;
		this.pendingWebviewLaunch = false;
		logger.info('[SessionHandler] Server is now ready, running deferred session restoration');
		await this.restoreOrCreateSession();
	}

	/**
	 * Core restoration logic: restore persisted tabs or auto-create a session
	 * for first-time users so they can start typing immediately.
	 */
	private async restoreOrCreateSession(): Promise<void> {
		try {
			const config = this.buildBaseConfig();
			const allSessions = await this.context.cli.listSessions(config);
			const validSessionIds = new Set(allSessions.filter(s => !s.parentID).map(s => s.id));

			// First-time user: no sessions exist — auto-create one so they can type immediately.
			if (validSessionIds.size === 0) {
				logger.info('[SessionHandler] No sessions found, auto-creating first session');
				await this.onCreateSession();
				return;
			}

			// Read persisted tabs
			const persisted = this.getPersistedTabs();
			const hadPersistedTabs = persisted.openTabs.length > 0;
			// Filter out tabs that no longer exist in CLI
			const tabsToRestore = persisted.openTabs.filter(id => validSessionIds.has(id));
			let activeTab =
				persisted.activeTab && validSessionIds.has(persisted.activeTab)
					? persisted.activeTab
					: undefined;

			// If we had persisted tabs but none of them still exist, the saved state is stale.
			// Do not resurrect an unrelated recent chat in that case - start fresh instead.
			if (tabsToRestore.length === 0) {
				if (hadPersistedTabs) {
					logger.info('[SessionHandler] Persisted tabs are stale, clearing restore state', {
						persistedOpenTabs: persisted.openTabs,
					});
					await this.writePersistedTabs([], undefined);
					await this.onCreateSession();
					return;
				}

				// Fallback only when there was no persisted tab state at all.
				const topLevel = allSessions
					.filter(s => !s.parentID)
					.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
				if (topLevel.length > 0) {
					tabsToRestore.push(topLevel[0].id);
					activeTab = topLevel[0].id;
				}
			}

			if (tabsToRestore.length === 0) return;
			if (!activeTab) {
				activeTab = [...tabsToRestore].sort((a, b) => {
					const aLastModified = allSessions.find(s => s.id === a)?.lastModified || 0;
					const bLastModified = allSessions.find(s => s.id === b)?.lastModified || 0;
					return bLastModified - aLastModified;
				})[0];
			}

			await this.writePersistedTabs(tabsToRestore, activeTab);

			logger.info('[SessionHandler] Restoring tabs from persistence', {
				tabCount: tabsToRestore.length,
				activeTab,
			});

			// Create all tabs in webview
			for (const tabId of tabsToRestore) {
				this.context.sessionState.startedSessions.add(tabId);
				this.postLifecycle('created', tabId);
			}

			// Switch to the active tab — query real status from executor
			this.context.sessionState.activeSessionId = activeTab;
			const isActiveTabBusy = this.context.cli.isSessionActive?.(activeTab) ?? false;

			await this.restoreSessionIfNeeded(activeTab, config, allSessions);
			this.postLifecycle('switched', activeTab, { isProcessing: isActiveTabBusy });
			this.syncSessionRuntimeState(activeTab);
			// Post status matching real backend state
			if (isActiveTabBusy) {
				this.context.bridge.emit(activeTab, 'status', {
					status: 'busy',
					statusText: 'Working...',
				});
			} else {
				this.context.bridge.emit(activeTab, 'status', {
					status: 'idle',
					statusText: 'Ready',
				});
			}

			// Post real status for non-active tabs
			for (const tabId of tabsToRestore) {
				if (tabId !== activeTab) {
					const isBusy = this.context.cli.isSessionActive?.(tabId) ?? false;
					this.context.bridge.emit(tabId, 'status', {
						status: isBusy ? 'busy' : 'idle',
						statusText: isBusy ? 'Working...' : 'Ready',
					});
				}
			}

			this.preloadRestoredTabs(tabsToRestore, activeTab, config, allSessions);
		} catch (error) {
			logger.error('[SessionHandler] Failed to restore sessions from CLI:', error);
			// Fallback: auto-create a session so the user can start typing immediately
			// even if CLI listing/restoration failed (e.g. server just started).
			try {
				await this.onCreateSession();
			} catch (createError) {
				logger.error('[SessionHandler] Fallback session creation also failed:', createError);
			}
		} finally {
			this.restorationComplete = true;
			logger.info('[SessionHandler] Restoration complete, tab persistence now active');
		}
	}

	private async restoreSessionIfNeeded(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
		cachedSessions?: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
			revert?: { messageID: string; partID?: string };
		}>,
	): Promise<void> {
		if (this.restoredSessions.has(sessionId)) {
			return;
		}

		const inFlight = this.restoringSessions.get(sessionId);
		if (inFlight) {
			await inFlight;
			return;
		}

		const restorePromise = this.restoreSessionFromCanonicalSnapshot(
			sessionId,
			config,
			cachedSessions,
		);
		this.restoringSessions.set(sessionId, restorePromise);
		try {
			await restorePromise;
			this.restoredSessions.add(sessionId);
		} finally {
			this.restoringSessions.delete(sessionId);
		}
	}

	private async restoreSessionFromCanonicalSnapshot(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
		cachedSessions?: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
			revert?: { messageID: string; partID?: string };
		}>,
	): Promise<void> {
		const sdkClient = this.context.cli.getSdkClient?.();
		if (!sdkClient) {
			throw new Error('OpenCode SDK client unavailable for restore');
		}

		const allSessions = cachedSessions ?? (await this.context.cli.listSessions(config));
		for (const session of allSessions) {
			this.context.sessionManager.setSession(session);
		}
		const currentSession = allSessions.find(s => s.id === sessionId);

		// Fetch messages + parts via REST
		const messagesResult = await sdkClient.session.messages({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});
		if (messagesResult.error) {
			throw new Error(`Failed to fetch session messages: ${JSON.stringify(messagesResult.error)}`);
		}

		const entries = (messagesResult.data ?? []).sort(
			(a, b) => a.info.time.created - b.info.time.created,
		);
		const SKIP_PARTS = new Set(['patch', 'step-start', 'step-finish', 'snapshot']);
		const partsByMessageId: Record<string, import('@opencode-ai/sdk/v2/client').Part[]> = {};
		for (const entry of entries) {
			partsByMessageId[entry.info.id] = entry.parts.filter(part => !SKIP_PARTS.has(part.type));
		}

		this.context.bridge.data('restore_session', {
			sessionId,
			messages: entries.map(entry => entry.info),
			parts: partsByMessageId,
		});

		// Child sessions don't own file changes — diffs belong to the parent.
		// Fetching diff for a child would return the parent's workspace-level changes,
		// causing duplicate/misleading file counts in the UI.
		const isChildSession = !!currentSession?.parentID;

		if (!isChildSession) {
			// Fetch and send diffs
			const diffResult = await sdkClient.session.diff({
				sessionID: sessionId,
				directory: config.workspaceRoot,
			});
			if (diffResult.data) {
				this.context.bridge.sendSdkEvent({
					type: 'session.diff',
					properties: { sessionID: sessionId, diff: diffResult.data },
				});
			}
		}

		// Fetch and send todos
		try {
			const todoResult = await sdkClient.session.todo({
				sessionID: sessionId,
				directory: config.workspaceRoot,
			});
			if (todoResult.data) {
				this.context.bridge.sendSdkEvent({
					type: 'todo.updated',
					properties: { sessionID: sessionId, todos: todoResult.data },
				});
			}
		} catch {
			// Todos are optional — ignore errors
		}

		// Register child session links from task tool parts
		for (const entry of entries) {
			for (const part of entry.parts) {
				if (part.type !== 'tool' || part.tool.toLowerCase() !== 'task') continue;
				const metadata = part.metadata as { sessionId?: string } | undefined;
				if (metadata?.sessionId) {
					this.context.sessionGraph.registerChild(
						metadata.sessionId,
						sessionId,
						part.callID,
						'restored',
					);
				}
			}
		}

		// Restore child sessions (on-demand — send session.created events)
		const childSessionIds = new Set<string>();
		for (const entry of entries) {
			for (const part of entry.parts) {
				if (part.type !== 'tool' || part.tool.toLowerCase() !== 'task') continue;
				const metadata = part.metadata as { sessionId?: string } | undefined;
				if (metadata?.sessionId) childSessionIds.add(metadata.sessionId);
			}
		}
		for (const child of allSessions.filter(s => s.parentID === sessionId)) {
			childSessionIds.add(child.id);
		}

		// Send session.created for child sessions so webview knows about them
		const childBatch: unknown[] = [];
		for (const childId of childSessionIds) {
			const childSession = allSessions.find(s => s.id === childId);
			if (childSession) {
				childBatch.push({
					type: 'session.created',
					properties: {
						sessionID: childId,
						info: childSession as import('@opencode-ai/sdk/v2/client').Session,
					},
				});
			}
		}
		if (childBatch.length > 0) {
			this.context.bridge.sendSdkEventBatch(childBatch);
		}

		if (currentSession) {
			this.context.bridge.sendSdkEvent({
				type: 'session.updated',
				properties: {
					info: currentSession,
				},
			});
		}

		await this.restoreDescendantSessions(sessionId, config, allSessions);
	}

	private async restoreDescendantSessions(
		rootSessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
		allSessions: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
			revert?: { messageID: string; partID?: string };
		}>,
	): Promise<void> {
		const directChildren = allSessions.filter(session => session.parentID === rootSessionId);
		if (directChildren.length === 0) return;

		await Promise.all(
			directChildren.map(async childSession => {
				await this.restoreSessionIfNeeded(childSession.id, config, allSessions);
			}),
		);
	}

	private async onCreateSession(): Promise<void> {
		logger.info('[SessionHandler] Creating new real session');

		try {
			const config = this.buildBaseConfig();
			const newSessionId = await this.context.cli.createEmptySession(config);

			this.context.sessionState.activeSessionId = newSessionId;
			this.context.sessionState.startedSessions.add(newSessionId);
			this.restoredSessions.add(newSessionId);

			this.postLifecycle('created', newSessionId);
			this.postLifecycle('switched', newSessionId, { isProcessing: false });
			this.context.bridge.emit(newSessionId, 'status', {
				status: 'idle',
				statusText: 'Ready',
			});
			await this.persistAddTab(newSessionId);
		} catch (error) {
			logger.error('[SessionHandler] Failed to create session:', error);
			this.context.sessionState.activeSessionId = undefined;
		}
	}

	private async onSwitchSession(msg: CommandOf<'switchSession'>): Promise<void> {
		const { sessionId } = msg;
		if (!sessionId) return;
		logger.info('[SessionHandler] Switching session', {
			from: this.context.sessionState.activeSessionId,
			to: sessionId,
		});
		this.context.sessionState.activeSessionId = sessionId;
		this.context.sessionState.startedSessions.add(sessionId);

		// Query REAL processing status from the backend executor.
		// The executor tracks active sessions via SSE session.status events.
		const isActive = this.context.cli.isSessionActive?.(sessionId) ?? false;
		await this.persistAddTab(sessionId);

		if (!this.restoredSessions.has(sessionId)) {
			try {
				const config = this.buildBaseConfig();
				await this.restoreSessionIfNeeded(sessionId, config);
			} catch (error) {
				logger.error('[SessionHandler] Failed to lazy-load session history:', error);
			}
		}

		this.postLifecycle('switched', sessionId, { isProcessing: isActive });

		// Post status matching the real backend state
		if (isActive) {
			this.context.bridge.emit(sessionId, 'status', {
				status: 'busy',
				statusText: 'Working...',
			});
		} else {
			this.context.bridge.emit(sessionId, 'status', {
				status: 'idle',
				statusText: 'Ready',
			});
		}

		this.syncSessionRuntimeState(sessionId);
	}

	private async onCloseSession(msg: CommandOf<'closeSession'>): Promise<void> {
		const { sessionId } = msg;
		if (!sessionId) return;
		logger.info('[SessionHandler] Closing session', { sessionId });

		// Abort the session (and its children) if currently active in OpenCode,
		// so it doesn't keep running in the background consuming resources.
		const sessionsToAbort = new Set<string>([sessionId]);
		for (const childId of this.context.sessionGraph.getChildren(sessionId)) {
			sessionsToAbort.add(childId);
		}

		const cli = this.context.cli;
		if (cli.abortSession) {
			await Promise.allSettled(
				[...sessionsToAbort].map(sid =>
					cli
						.abortSession?.(sid)
						.catch(e =>
							logger.warn(`[SessionHandler] Failed to abort session on close: ${sid}`, e),
						),
				),
			);
		}

		this.context.sessionState.startedSessions.delete(sessionId);
		this.restoredSessions.delete(sessionId);
		this.restoringSessions.delete(sessionId);
		this.clearPendingMessage(sessionId);
		this.context.clearSessionAutoAccept?.(sessionId);
		// Clean up session graph entries to prevent unbounded Map growth
		this.context.sessionGraph.clearParent(sessionId);

		// If closing active session, clear backend reference
		if (this.context.sessionState.activeSessionId === sessionId) {
			this.context.sessionState.activeSessionId = undefined;
		}

		this.postLifecycle('closed', sessionId);
		await this.persistRemoveTab(sessionId);
	}

	private async onSendMessage(msg: CommandOf<'sendMessage'>): Promise<void> {
		const {
			text,
			model: uiModel,
			sessionId,
			messageID,
			clientMessageID,
			editMode,
			attachments,
			agent,
			variant,
		} = msg;
		const resolvedAgent = agent;

		// Resolve target session
		const targetId = sessionId || this.context.sessionState.activeSessionId;

		// If editing history, clear the queue — queued messages reference a future
		// that is about to be truncated, so they would produce nonsensical context.
		if (messageID && targetId) {
			this.clearPendingMessage(targetId);
		}

		// If the target session is busy OR currently sending (lock held by processQueueOnIdle/force),
		// and this is NOT a message edit, queue the message.
		if (
			targetId &&
			!messageID &&
			(this.context.cli.isSessionActive?.(targetId) || this.sendingLock.has(targetId))
		) {
			logger.info('[SessionHandler] Session busy or sending, queuing message', {
				sessionId: targetId,
				textLen: text.length,
			});
			this.enqueueMessage(targetId, text, uiModel, resolvedAgent, attachments, variant);
			return;
		}

		await this.handleSendMessage(
			text,
			uiModel,
			sessionId,
			messageID,
			editMode,
			attachments,
			resolvedAgent,
			variant,
			clientMessageID,
		);
	}

	private onCancelQueuedMessage(msg: CommandOf<'cancelQueuedMessage'>): void {
		const { sessionId, queueId } = msg;
		let removed: QueuedMessageData | undefined;
		const newQueue = this.updateQueue(sessionId, queue => {
			const idx = queue.findIndex(entry => entry.queueId === queueId);
			if (idx !== -1) removed = queue.splice(idx, 1)[0];
			return queue;
		});
		if (!removed) return;
		logger.info('[SessionHandler] Cancelled queued message', { sessionId, queueId });
		const restored = this.restoreInlineAttachmentsForDraft(removed.text, removed.attachments);
		this.context.bridge.queue.update(
			'cancelled',
			sessionId,
			newQueue.length > 0 ? [...newQueue] : [],
			restored.text,
			restored.attachments,
			removed.agent,
		);
	}

	private onReorderQueue(msg: CommandOf<'reorderQueue'>): void {
		const { sessionId, queueIds } = msg;
		const queue = this.pendingMessages.get(sessionId);
		if (!queue || queue.length < 2) return;

		// O(1) lookup via Map instead of O(N) includes
		const queueMap = new Map(queue.map(e => [e.queueId, e]));
		const reordered: QueuedMessageData[] = [];
		for (const id of queueIds) {
			const entry = queueMap.get(id);
			if (entry) {
				reordered.push(entry);
				queueMap.delete(id);
			}
		}
		// Safety: keep any entries not in queueIds at the end
		reordered.push(...queueMap.values());

		this.updateQueue(sessionId, () => reordered);
		this.context.bridge.queue.update('enqueued', sessionId, [...reordered]);
	}

	private async onForceQueuedMessage(msg: CommandOf<'forceQueuedMessage'>): Promise<void> {
		const { sessionId, queueId } = msg;
		let entry: QueuedMessageData | undefined;
		const newQueue = this.updateQueue(sessionId, queue => {
			const idx = queue.findIndex(item => item.queueId === queueId);
			if (idx !== -1) entry = queue.splice(idx, 1)[0];
			return queue;
		});
		if (!entry) return;

		// Only stop if session is actually busy (avoids false "Stopped by user")
		const isBusy = this.context.cli.isSessionActive?.(sessionId) ?? false;
		if (isBusy) {
			// onStopRequest already awaits abortSession() — no setTimeout needed
			await this.onStopRequest({ type: 'stopRequest', sessionId });
		}

		// Notify webview of updated queue
		this.context.bridge.queue.update('dequeued', sessionId, [...newQueue]);

		// Acquire sending lock to prevent race with concurrent onSendMessage
		this.sendingLock.add(sessionId);
		try {
			await this.handleSendMessage(
				entry.text,
				entry.model,
				entry.sessionId,
				undefined,
				undefined,
				entry.attachments,
				entry.agent,
				entry.variant,
			);
		} finally {
			this.sendingLock.delete(sessionId);
		}
	}

	/**
	 * Called when a session transitions to idle. Dequeues the FIRST message
	 * (FIFO) and sends it. Remaining messages stay in queue for next idle.
	 */
	public async processQueueOnIdle(sessionId: string): Promise<void> {
		let entry: QueuedMessageData | undefined;
		const remaining = this.updateQueue(sessionId, queue => {
			entry = queue.shift();
			return queue;
		});
		if (!entry) return;

		logger.info('[SessionHandler] Auto-dequeuing message on idle', {
			sessionId,
			queueId: entry.queueId,
		});

		this.context.bridge.queue.update('dequeued', sessionId, [...remaining]);

		// Acquire sending lock to prevent race with concurrent onSendMessage
		this.sendingLock.add(sessionId);
		try {
			await this.handleSendMessage(
				entry.text,
				entry.model,
				entry.sessionId,
				undefined,
				undefined,
				entry.attachments,
				entry.agent,
				entry.variant,
			);
		} catch (error) {
			logger.error('[SessionHandler] Failed to send dequeued message, returning to input', error);
			const restored = this.restoreInlineAttachmentsForDraft(entry.text, entry.attachments);
			this.context.bridge.queue.update(
				'cancelled',
				sessionId,
				[...remaining],
				restored.text,
				restored.attachments,
				entry.agent,
			);
		} finally {
			this.sendingLock.delete(sessionId);
		}
	}

	// =========================================================================
	// Inline Message Queue (up to MAX_QUEUE_SIZE per session, FIFO)
	// =========================================================================

	private enqueueMessage(
		sessionId: string,
		text: string,
		model?: string,
		agent?: string,
		attachments?: QueuedMessageData['attachments'],
		variant?: string,
	): void {
		const queue = this.pendingMessages.get(sessionId) ?? [];
		if (queue.length >= SessionHandler.MAX_QUEUE_SIZE) {
			logger.warn('[SessionHandler] Queue full, rejecting message', { sessionId });
			// Return text and attachments to input so user doesn't lose them
			const restored = this.restoreInlineAttachmentsForDraft(text, attachments);
			this.context.bridge.queue.update(
				'cancelled',
				sessionId,
				[...queue],
				restored.text,
				restored.attachments,
				agent,
			);
			return;
		}
		const entry: QueuedMessageData = {
			queueId: `q-${Date.now()}-${++this.queueIdCounter}`,
			text,
			model,
			sessionId,
			agent,
			variant,
			attachments,
			queuedAt: Date.now(),
		};
		queue.push(entry);
		this.pendingMessages.set(sessionId, queue);
		this.context.bridge.queue.update('enqueued', sessionId, [...queue]);
	}

	private clearPendingMessage(sessionId: string): void {
		if (this.pendingMessages.delete(sessionId)) {
			this.context.bridge.queue.update('cleared', sessionId, []);
		}
	}

	private async onStopRequest(msg: CommandOf<'stopRequest'>): Promise<void> {
		// Use the sessionId from the requesting tab, fall back to global active session
		const targetId = msg.sessionId || this.context.sessionState.activeSessionId;

		if (!targetId) {
			logger.warn('[SessionHandler] Stop request ignored - no target session');
			return;
		}

		// Collect the target session + its child sessions (subagents) only.
		// Do NOT touch unrelated sessions from other tabs.
		const sessionsToStop = new Set<string>([targetId]);
		for (const childId of this.context.sessionGraph.getChildren(targetId)) {
			if (this.context.cli.isSessionActive?.(childId)) {
				sessionsToStop.add(childId);
			}
		}

		// Activate per-session stop guard — blocks incoming SSE 'busy' events
		// from overwriting our status during the abort window.
		for (const sid of sessionsToStop) {
			this.context.sessionState.activateStopGuard(10_000, sid);
		}

		// Abort only the targeted sessions on the backend, not all active sessions.
		try {
			await Promise.allSettled(
				[...sessionsToStop].map(sid =>
					this.context.cli.abortSession ? this.context.cli.abortSession(sid) : Promise.resolve(),
				),
			);
		} catch (error) {
			logger.error('[SessionHandler] Abort failed:', error);
		}

		// NOW update UI — backend has confirmed the stop.
		this.context.bridge.emit(targetId, 'status', { status: 'idle', statusText: 'Stopped' });

		// Also force idle on child sessions (subagents) of the target session only
		for (const sid of sessionsToStop) {
			if (sid !== targetId) {
				const toolUseId = this.context.sessionGraph.getEntry(sid)?.taskToolCallId;
				const parentSessionId = this.context.sessionGraph.getParent(sid);
				if (toolUseId && parentSessionId) {
					this.context.bridge.emit(parentSessionId, 'complete', {
						partId: toolUseId,
						toolUseId,
					});
				}
				this.context.bridge.emit(sid, 'status', {
					status: 'idle',
					statusText: 'Stopped',
				});
			}
		}
	}

	private async handleSendMessage(
		text: string,
		uiModel?: string,
		explicitSessionId?: string,
		messageIdToTruncate?: string,
		editMode?: 'revert' | 'history_only',
		attachments?: CommandOf<'sendMessage'>['attachments'],
		agent?: string,
		variant?: string,
		clientMessageID?: string,
	): Promise<void> {
		// Clear stop guard for the target session — user is explicitly sending
		// a new message, so SSE 'busy' events should be allowed through again.
		const targetSessionForGuard = explicitSessionId || this.context.sessionState.activeSessionId;
		if (targetSessionForGuard) {
			this.context.sessionState.clearStopGuard(targetSessionForGuard);
		}

		const config = await this.buildSendConfig(uiModel);
		const restoreTargetId = explicitSessionId || this.context.sessionState.activeSessionId;

		// Per-message agent override takes precedence over the global opencode.agent setting.
		if (agent) {
			config.agent = agent;
		}
		if (variant) {
			config.variant = variant;
		}
		if (config.provider === 'opencode' && typeof config.model === 'string' && config.model.trim()) {
			const selectedModel = config.model.trim();
			const parsed = parseModelId(selectedModel);
			if (!parsed) {
				this.restoreFailedSendDraft(
					restoreTargetId,
					text,
					attachments,
					agent,
					`Invalid model selection: "${selectedModel}". Expected format "provider/model". Please choose another model.`,
					clientMessageID,
				);
				return;
			}

			const sdkClient = this.context.cli.getSdkClient();
			if (sdkClient) {
				try {
					const providers = (await this.context.services.openCodeClient.getConnectedProviders(
						sdkClient,
					)) as OpenCodeProviderData[];
					const provider = providers.find(p => p.id === parsed.providerId);
					const exists = provider?.models?.some(m => m.id === parsed.modelId) ?? false;
					if (!exists) {
						this.restoreFailedSendDraft(
							restoreTargetId,
							text,
							attachments,
							agent,
							`Model "${selectedModel}" is unavailable. Please reconnect the provider or choose another model.`,
							clientMessageID,
						);
						return;
					}
				} catch {
					// Do not block send if live model sync check fails; send path will report runtime errors.
				}
			}
		}

		// Resolve active session
		let activeId = this.context.sessionState.activeSessionId;

		if (explicitSessionId && explicitSessionId !== activeId) {
			logger.info('[SessionHandler] Switching context to explicit session', {
				from: activeId,
				to: explicitSessionId,
			});
			activeId = explicitSessionId;
			this.context.sessionState.activeSessionId = activeId;
			this.context.sessionState.startedSessions.add(activeId);
		}

		// Explicitly targeted session must never be treated as "new":
		// otherwise messages sent from history can incorrectly create a fresh chat.
		const isNewSession =
			!activeId || (!explicitSessionId && !this.context.sessionState.startedSessions.has(activeId));

		logger.info('[SessionHandler] handleSendMessage', {
			text: text.slice(0, 50),
			model: config.model,
			provider: config.provider,
			sessionId: activeId || 'none',
			isNewSession,
		});

		try {
			if (isNewSession) {
				// No active session — create one on the backend first
				const newSessionId = await this.context.cli.createEmptySession(config);
				this.context.sessionState.activeSessionId = newSessionId;
				this.context.sessionState.startedSessions.add(newSessionId);

				this.postLifecycle('created', newSessionId);
				this.postLifecycle('switched', newSessionId, { isProcessing: true });

				activeId = newSessionId;
			}

			// Intercept internal slash commands that need special routing.
			// /compact and /summarize must call the summarize API endpoint,
			// not be sent as regular text prompts.
			const isOpenCode = config.provider === 'opencode';
			const slashMatch = text.trim().match(/^\/(\S+)(?:\s+(.*))?$/);
			const slashCmd = slashMatch?.[1]?.toLowerCase();

			if (isOpenCode && (slashCmd === 'compact' || slashCmd === 'summarize')) {
				// Don't post user message — compact is a system operation
				logger.info('[SessionHandler] Routing /compact to executeCommand', { sessionId: activeId });
				if (!activeId) throw new Error('No active session after initialization');
				const activeSessionId = activeId;
				this.context.bridge.emit(activeSessionId, 'status', {
					status: 'busy',
					statusText: 'Compacting session...',
				});
				await this.context.cli.executeCommand(text.trim(), [], config, activeSessionId);
				return;
			}

			if (!activeId) throw new Error('No active session after initialization');

			// OpenCode edit flow: truncate FIRST, then post user message.
			// This prevents message duplication on session restore: if we posted
			// the user message first and then truncated, the server would still
			// have the original message. On restore, both would appear.
			// By truncating first, the server history is clean before we send.
			if (isOpenCode && messageIdToTruncate) {
				if (editMode !== 'revert') {
					logger.info('[SessionHandler] Editing message: prune history without workspace revert', {
						messageId: messageIdToTruncate,
					});
					const deletedMessageIds =
						(await this.context.cli.deleteSessionMessagesFrom?.(
							activeId,
							messageIdToTruncate,
							config,
						)) ?? [];
					if (deletedMessageIds.length > 0) {
						this.context.bridge.sendSdkEventBatch(
							deletedMessageIds.map(messageID => ({
								type: 'message.removed',
								properties: { sessionID: activeId, messageID },
							})),
						);
					}
				} else {
					logger.info('[SessionHandler] Editing message: revert workspace then replace message', {
						messageId: messageIdToTruncate,
					});
					await this.context.cli.truncateSession(activeId, messageIdToTruncate, config);
					// `session.revert()` restores workspace state before the target message,
					// but the message itself can still remain in transcript history.
					// For edit-resend we must replace that user prompt, not append after it.
					const deletedMessageIds =
						(await this.context.cli.deleteSessionMessagesFrom?.(
							activeId,
							messageIdToTruncate,
							config,
						)) ?? [];
					if (deletedMessageIds.length > 0) {
						this.context.bridge.sendSdkEventBatch(
							deletedMessageIds.map(messageID => ({
								type: 'message.removed',
								properties: { sessionID: activeId, messageID },
							})),
						);
					}
				}
			}

			// Use the same client-generated ID for the optimistic UI row and the backend
			// prompt. Server events reconcile into this row instead of creating a duplicate.
			const prefix = isOpenCode ? 'msg' : 'user';
			const userMessageId = clientMessageID || generateId(prefix);
			const optimisticParts = buildOptimisticPromptParts({
				text,
				attachments,
				sessionId: activeId,
				messageId: userMessageId,
			});

			this.context.bridge.sendSdkEventBatch([
				{
					type: 'message.updated',
					properties: {
						sessionID: activeId,
						info: {
							id: userMessageId,
							sessionID: activeId,
							role: 'user',
							time: { created: Date.now() },
							modelID: config.model,
							...(config.agent ? { agent: config.agent } : {}),
						},
					},
				},
				...optimisticParts.map(part => ({
					type: 'message.part.updated' as const,
					properties: {
						sessionID: activeId,
						part,
					},
				})),
				{
					type: 'session.status',
					properties: {
						sessionID: activeId,
						status: { type: 'busy' },
					},
				},
			]);

			// Pass our client-generated ID to the server so it uses it as the
			// real user message ID (OpenCode prompt.ts: id = input.messageID ?? ...).
			// This eliminates the need for SSE-based ID reconciliation.
			config.messageID = userMessageId;

			await this.context.cli.spawnFollowUp(text, activeId, config, attachments);
		} catch (error) {
			logger.error('[SessionHandler] Failed to spawn CLI:', error);
			this.restoreFailedSendDraft(
				activeId,
				text,
				attachments,
				agent,
				error instanceof Error ? error.message : 'Failed to start CLI',
				clientMessageID,
			);

			if (activeId) {
				this.context.sessionState.startedSessions.delete(activeId);
				this.context.bridge.emit(activeId, 'status', {
					status: 'error',
					statusText: 'Failed to start',
				});
			}
		}
	}

	// =============================================================================
	// Conversation History
	// =============================================================================

	private async onGetConversationList(): Promise<void> {
		try {
			const conversations = await this.listConversationsFromCLI();
			logger.info('[SessionHandler] Sending conversation list to webview', {
				count: conversations.length,
				titles: conversations.slice(0, 5).map(c => c.customTitle || c.firstUserMessage),
			});
			this.context.bridge.data('conversationList', conversations);
		} catch (error) {
			logger.error('[SessionHandler] Failed to get conversation list:', error);
			this.context.bridge.data('conversationList', []);
		}
	}

	/** Inline replacement for ConversationService — lists top-level sessions from CLI. */
	private async listConversationsFromCLI(): Promise<ConversationIndexEntry[]> {
		try {
			const config = this.buildBaseConfig();
			const sessions = await this.context.cli.listSessions(config);
			return sessions
				.filter(s => !s.parentID)
				.filter(s => s.hasMessages !== false)
				.map(s => ({
					filename: s.id,
					sessionId: s.id,
					startTime: new Date(s.created || s.lastModified || 0).toISOString(),
					endTime: new Date(s.lastModified || 0).toISOString(),
					messageCount: 0,
					totalCost: 0,
					firstUserMessage: s.title || 'New Session',
					lastUserMessage: '',
					customTitle: s.title || undefined,
				}))
				.sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());
		} catch (error) {
			logger.warn('[SessionHandler] Failed to list CLI sessions:', error);
			return [];
		}
	}

	private async onLoadConversation(msg: CommandOf<'loadConversation'>): Promise<void> {
		const { filename } = msg;
		if (!filename) return;

		// For OpenCode, filename IS the sessionId
		const sessionId = filename;

		// Guard: if this session is already open as a tab, just switch to it
		// instead of creating a duplicate tab and replaying history again.
		if (this.context.sessionState.startedSessions.has(sessionId)) {
			logger.info('[SessionHandler] Session already open, switching to it', { sessionId });
			this.context.sessionState.activeSessionId = sessionId;
			const isBusy = this.context.cli.isSessionActive?.(sessionId) ?? false;
			await this.persistAddTab(sessionId);
			if (!this.restoredSessions.has(sessionId)) {
				try {
					const config = this.buildBaseConfig();
					await this.restoreSessionIfNeeded(sessionId, config);
				} catch (error) {
					logger.error('[SessionHandler] Failed to restore already-open session before switch:', {
						sessionId,
						error,
					});
				}
			}
			this.postLifecycle('switched', sessionId, { isProcessing: isBusy });
			return;
		}

		logger.info('[SessionHandler] Loading conversation', { sessionId });

		// Set active session and mark as started so follow-up messages reuse it
		this.context.sessionState.activeSessionId = sessionId;
		this.context.sessionState.startedSessions.add(sessionId);
		this.postLifecycle('created', sessionId);
		await this.persistAddTab(sessionId);

		try {
			const config = this.buildBaseConfig();
			await this.restoreSessionIfNeeded(sessionId, config);
			// New conversations are never busy — they haven't been sent to yet
			this.postLifecycle('switched', sessionId, { isProcessing: false });
			this.syncSessionRuntimeState(sessionId);
			// Query real status — loaded conversation could theoretically be active
			const isBusy = this.context.cli.isSessionActive?.(sessionId) ?? false;
			this.context.bridge.emit(sessionId, 'status', {
				status: isBusy ? 'busy' : 'idle',
				statusText: isBusy ? 'Working...' : 'Ready',
			});
		} catch (error) {
			logger.error('[SessionHandler] Failed to load conversation:', error);
			this.context.bridge.emit(sessionId, 'status', {
				status: 'error',
				statusText: 'Failed to load',
			});
		}
	}

	private async restoreSessionRuntimeStateFromServer(sessionId: string): Promise<void> {
		const sdkClient = this.context.cli.getSdkClient?.();
		const admin = this.context.cli.getOpenCodeServerInfo();
		if (!sdkClient || !admin?.baseUrl) return;

		const safeFetchPermissions = async () => {
			try {
				return await this.context.services.openCodeClient.getSessionPermissions(
					admin.baseUrl,
					admin.directory,
					sessionId,
				);
			} catch (error) {
				logger.warn('[SessionHandler] Failed to fetch session permissions', { sessionId, error });
				return [];
			}
		};
		const safeFetchQuestions = async () => {
			try {
				return await this.context.services.openCodeClient.getSessionQuestions(
					admin.baseUrl,
					admin.directory,
					sessionId,
				);
			} catch (error) {
				logger.warn('[SessionHandler] Failed to fetch session questions', { sessionId, error });
				return [];
			}
		};
		try {
			const [permissionResult, questionResult] = await Promise.all([
				safeFetchPermissions(),
				safeFetchQuestions(),
			]);

			this.context.bridge.emit(sessionId, 'permission', {
				action: 'set',
				requests: permissionResult,
			});
			this.context.bridge.emit(sessionId, 'question', {
				action: 'set',
				requests: questionResult,
			});
		} catch (error) {
			logger.warn('[SessionHandler] Failed to restore session runtime state', {
				sessionId,
				error,
			});
		}
	}

	private async onDeleteConversation(msg: CommandOf<'deleteConversation'>): Promise<void> {
		const sessionId = msg.filename;
		if (!sessionId) return;

		logger.info('[SessionHandler] Deleting conversation', { sessionId });

		try {
			const config = this.buildBaseConfig();
			const success = await this.context.cli.deleteSession(sessionId, config);

			if (success) {
				const wasActive = this.context.sessionState.activeSessionId === sessionId;
				// Clean up local state if this was the active session
				this.context.sessionState.startedSessions.delete(sessionId);
				this.clearPendingMessage(sessionId);
				this.context.clearSessionAutoAccept?.(sessionId);
				this.restoredSessions.delete(sessionId);
				this.restoringSessions.delete(sessionId);
				this.context.sessionGraph.clearParent(sessionId);

				const nextActiveSessionId = wasActive ? this.getLastStartedSessionId() : undefined;
				this.context.sessionState.activeSessionId = nextActiveSessionId;

				this.postLifecycle('closed', sessionId);
				if (nextActiveSessionId) {
					const isProcessing = this.context.cli.isSessionActive?.(nextActiveSessionId) ?? false;
					this.postLifecycle('switched', nextActiveSessionId, { isProcessing });
				}
				await this.persistRemoveTab(sessionId);
			}
		} catch (error) {
			logger.error('[SessionHandler] Failed to delete conversation:', error);
		}

		await this.onGetConversationList();
	}

	private async onClearAllConversations(): Promise<void> {
		logger.info('[SessionHandler] Clearing all conversations');

		try {
			const config = this.buildBaseConfig();
			const sessions = await this.context.cli.listSessions(config);
			const topLevelSessions = sessions.filter(s => !s.parentID);

			for (const session of topLevelSessions) {
				try {
					const success = await this.context.cli.deleteSession(session.id, config);
					if (!success) continue;

					this.context.sessionState.startedSessions.delete(session.id);
					this.clearPendingMessage(session.id);
					this.context.clearSessionAutoAccept?.(session.id);
					this.restoredSessions.delete(session.id);
					this.restoringSessions.delete(session.id);
					this.context.sessionGraph.clearParent(session.id);
					if (this.context.sessionState.activeSessionId === session.id) {
						this.context.sessionState.activeSessionId = undefined;
					}
					this.postLifecycle('closed', session.id);
				} catch (error) {
					logger.error('[SessionHandler] Failed to delete conversation during clearAll:', {
						sessionId: session.id,
						error,
					});
				}
			}

			this.context.bridge.send({ type: 'allConversationsCleared' });
			await this.persistClearAllTabs();
		} catch (error) {
			logger.error('[SessionHandler] Failed to clear all conversations:', error);
		}

		await this.onGetConversationList();
	}

	private async onRenameConversation(msg: CommandOf<'renameConversation'>): Promise<void> {
		const { filename: sessionId, newTitle } = msg;
		if (!sessionId || !newTitle) return;

		logger.info('[SessionHandler] Renaming conversation', { sessionId, newTitle });

		try {
			const config = this.buildBaseConfig();
			await this.context.cli.renameSession(sessionId, newTitle, config);
		} catch (error) {
			logger.error('[SessionHandler] Failed to rename conversation:', error);
		}

		await this.onGetConversationList();
	}

	// =============================================================================
	// Prompt Improvement
	// =============================================================================

	private async onImprovePromptRequest(msg: CommandOf<'improvePromptRequest'>): Promise<void> {
		const { text, requestId } = msg;
		logger.info(
			`[ImprovePrompt] Request received: requestId=${requestId}, textLen=${text?.length ?? 0}`,
		);
		// Hardcoded 30s timeout — prompt improvement is a short task,
		// and SDK prompt() is synchronous (no streaming), so this is an absolute cap.
		const timeoutMs = 30_000;

		if (!text.trim() || !requestId) {
			logger.warn('[ImprovePrompt] Missing text or requestId');
			this.context.bridge.data('improvePromptError', {
				requestId: requestId || '',
				error: 'Missing text or requestId',
			});
			return;
		}

		this.improvePromptController?.abort();
		this.improvePromptController = new AbortController();
		this.improvePromptActiveRequestId = requestId;

		const timeout = setTimeout(() => this.improvePromptController?.abort(), timeoutMs);

		try {
			// --- Template resolution ---
			const templateFromSettings = this.context.settings.get('promptImprove.template');
			const template =
				typeof templateFromSettings === 'string' && templateFromSettings.trim()
					? templateFromSettings
					: IMPROVE_PROMPT_DEFAULT_TEMPLATE;

			logger.info(
				`[ImprovePrompt] Template from settings: raw=${JSON.stringify(templateFromSettings)}, resolved="${template.slice(0, 80)}..."`,
			);

			// --- Model resolution ---
			// Priority: 1) promptImprove.model from settings  2) main chat model
			// NOTE: msg.model is intentionally ignored — ChatInput should NOT pass
			// the chat model here; Prompt Improver has its own model setting.
			const improveModelFromSettings = this.context.settings.get('promptImprove.model');
			const sendConfig = await this.buildSendConfig();
			const resolvedModel =
				(typeof improveModelFromSettings === 'string' && improveModelFromSettings.trim()
					? improveModelFromSettings
					: undefined) || sendConfig.model;

			logger.info(
				`[ImprovePrompt] Model resolution: settings=${JSON.stringify(improveModelFromSettings)}, mainModel=${JSON.stringify(sendConfig.model)}, resolved=${JSON.stringify(resolvedModel)}`,
			);

			const sdkClient = this.context.cli.getSdkClient();
			if (!sdkClient) {
				throw new Error('OpenCode server is not running. Send a message first to start it.');
			}

			const improvedText = await this.improvePromptViaOpenCode({
				text,
				template,
				client: sdkClient,
				model: resolvedModel,
				signal: this.improvePromptController.signal,
			});

			if (this.improvePromptActiveRequestId !== requestId) return;

			logger.info(
				`[ImprovePrompt] Success: requestId=${requestId}, resultLen=${improvedText.length}`,
			);
			this.context.bridge.data('improvePromptResult', { requestId, improvedText });
		} catch (error) {
			if (this.improvePromptActiveRequestId !== requestId) return;

			const err = error instanceof Error ? error.message : String(error);
			const aborted = err.toLowerCase().includes('abort');
			logger.error(
				`[ImprovePrompt] ${aborted ? 'Aborted' : 'Error'}: requestId=${requestId}, error=${err}`,
			);
			this.context.bridge.data(
				aborted ? 'improvePromptCancelled' : 'improvePromptError',
				aborted ? { requestId } : { requestId, error: err },
			);
		} finally {
			clearTimeout(timeout);
			if (this.improvePromptActiveRequestId === requestId) {
				this.improvePromptActiveRequestId = null;
				this.improvePromptController = null;
			}
		}
	}

	private async onCancelImprovePrompt(msg: CommandOf<'cancelImprovePrompt'>): Promise<void> {
		const { requestId } = msg;
		if (requestId && this.improvePromptActiveRequestId !== requestId) {
			return;
		}

		this.improvePromptController?.abort();
		this.improvePromptController = null;
		this.improvePromptActiveRequestId = null;

		this.context.bridge.data('improvePromptCancelled', { requestId: requestId || '' });
	}

	/**
	 * Routes the "Improve Prompt" request through the running OpenCode server.
	 * Creates a temporary session, sends the prompt via SDK's synchronous prompt(),
	 * which blocks until the LLM finishes and returns the full response directly.
	 */
	private async improvePromptViaOpenCode(params: {
		text: string;
		template: string;
		model?: string;
		client: import('@opencode-ai/sdk/v2/client').OpencodeClient;
		signal: AbortSignal;
	}): Promise<string> {
		const { client, signal } = params;

		if (!params.template.trim()) {
			throw new Error(
				'Prompt Improver template is empty. Configure it in Settings → Prompt Improver.',
			);
		}

		// Replace {{TEXT}} placeholder with user text, or append if placeholder is missing
		const fullText = params.template.includes('{{TEXT}}')
			? params.template.replace('{{TEXT}}', params.text)
			: `${params.template.trim()}\n\n---\n\n${params.text}`;

		logger.info(
			`[ImprovePrompt] fullText length=${fullText.length}, model=${params.model ?? 'default'}`,
		);

		const directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

		// 1. Create a temporary session
		const { data: sessionData, error: createError } = await client.session.create({ directory });
		if (createError || !sessionData?.id) {
			throw new Error(`Failed to create temp session: ${createError ?? 'no session id'}`);
		}
		const sessionId = sessionData.id;
		logger.info(`[ImprovePrompt] Temp session: ${sessionId}`);

		try {
			// Parse model string safely using shared utility
			const parsedModel = params.model ? parseModelId(params.model) : undefined;
			const modelOverride = parsedModel
				? { providerID: parsedModel.providerId, modelID: parsedModel.modelId }
				: undefined;

			// 2. Synchronous prompt — blocks until the LLM finishes, returns full response
			const { data, error } = await client.session.prompt(
				{
					sessionID: sessionId,
					directory,
					parts: [{ type: 'text', text: fullText }],
					...(modelOverride ? { model: modelOverride } : {}),
				},
				{ signal },
			);

			if (error) throw new Error(`Prompt failed: ${JSON.stringify(error)}`);

			// 3. Extract text from response parts
			const response = data as { parts?: Array<{ type: string; text?: string }> } | undefined;
			let result = '';
			for (const part of response?.parts ?? []) {
				if (part.type === 'text' && part.text) result += part.text;
			}
			result = result.trim();

			if (!result) throw new Error('Empty response from model');

			logger.info(`[ImprovePrompt] Got response: ${result.length} chars`);
			return result;
		} finally {
			client.session.delete({ sessionID: sessionId }).catch(() => {});
		}
	}

	// =============================================================================
	// Utils
	// =============================================================================

	private buildBaseConfig(): { provider: 'opencode'; workspaceRoot: string } {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error('No workspace root');
		}
		return {
			provider: 'opencode',
			workspaceRoot,
		};
	}

	private async readWorkspaceDefaultModel(workspaceRoot: string): Promise<string | undefined> {
		try {
			const projectDefaults =
				await this.context.services.openCodeClient.getProjectModelDefaults(workspaceRoot);
			return projectDefaults.model && parseModelId(projectDefaults.model)
				? projectDefaults.model
				: undefined;
		} catch {
			return undefined;
		}
	}

	private async buildSendConfig(uiModel?: string): Promise<CLIConfig> {
		const { provider, workspaceRoot } = this.buildBaseConfig();
		const model = uiModel ?? (await this.readWorkspaceDefaultModel(workspaceRoot));

		const opencodeAgent = this.context.settings.get('opencode.agent');
		const opencodeServerTimeout = this.context.settings.get('opencode.serverTimeout');

		return {
			provider,
			model,
			workspaceRoot,
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			autoApprove: Boolean(this.context.settings.get('access.autoApprove') || false),
			policies: this.context.getPermissionPolicies?.() as
				| Partial<Record<string, string>>
				| undefined,
			serverTimeoutMs:
				typeof opencodeServerTimeout === 'number' && Number.isFinite(opencodeServerTimeout)
					? Math.max(0, opencodeServerTimeout) * 1000
					: undefined,
		};
	}

	// =========================================================================
	// Tab persistence — delta-based, read-modify-write approach.
	//
	// Instead of deriving persisted state from the in-memory `startedSessions`
	// set (which can be empty/stale during startup or after errors), every
	// mutation reads the *current* persisted state, applies a small delta,
	// and writes back.  This makes each operation self-contained and immune
	// to in-memory state corruption.
	// =========================================================================

	private static readonly OPEN_TABS_KEY = 'primecode.openTabs';
	private static readonly ACTIVE_TAB_KEY = 'primecode.activeTab';

	/** Low-level write — only called by the delta helpers and restoreOrCreateSession. */
	private async writePersistedTabs(
		openTabs: string[],
		activeTab: string | undefined,
	): Promise<void> {
		await Promise.all([
			this.context.extensionContext.globalState.update(SessionHandler.OPEN_TABS_KEY, openTabs),
			this.context.extensionContext.globalState.update(SessionHandler.ACTIVE_TAB_KEY, activeTab),
		]);
		logger.trace('[SessionHandler] Wrote persisted tabs', {
			count: openTabs.length,
			active: activeTab,
		});
	}

	/** Low-level read. */
	private getPersistedTabs(): { openTabs: string[]; activeTab: string | undefined } {
		const openTabs =
			this.context.extensionContext.globalState.get<string[]>(SessionHandler.OPEN_TABS_KEY) || [];
		const activeTab = this.context.extensionContext.globalState.get<string>(
			SessionHandler.ACTIVE_TAB_KEY,
		);
		return { openTabs, activeTab };
	}

	/**
	 * Add a tab to persisted state and set it as active.
	 * No-op if already present (just updates active).
	 * Guarded: skipped before restoration completes.
	 */
	private async persistAddTab(sessionId: string): Promise<void> {
		if (!this.restorationComplete) return;
		const { openTabs } = this.getPersistedTabs();
		const newTabs = openTabs.includes(sessionId) ? openTabs : [...openTabs, sessionId];
		await this.writePersistedTabs(newTabs, sessionId);
	}

	private preloadRestoredTabs(
		tabsToRestore: string[],
		activeTab: string,
		config: { provider: 'opencode'; workspaceRoot: string },
		allSessions: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
			revert?: { messageID: string; partID?: string };
		}>,
	): void {
		const preloadIds = tabsToRestore.filter(
			tabId => tabId !== activeTab && !this.restoredSessions.has(tabId),
		);
		if (preloadIds.length === 0) return;

		void Promise.all(
			preloadIds.map(async sessionId => {
				try {
					await this.restoreSessionIfNeeded(sessionId, config, allSessions);
					this.syncSessionRuntimeState(sessionId);
				} catch (error) {
					logger.warn('[SessionHandler] Failed to preload restored tab history', {
						sessionId,
						error,
					});
				}
			}),
		);
	}

	/**
	 * Remove a tab from persisted state.
	 * If the removed tab was active, picks the last remaining tab.
	 * Safety: never writes an empty list if the previous state was non-empty.
	 * Guarded: skipped before restoration completes.
	 */
	private async persistRemoveTab(sessionId: string): Promise<void> {
		if (!this.restorationComplete) return;
		const { openTabs, activeTab } = this.getPersistedTabs();
		const newTabs = openTabs.filter(id => id !== sessionId);

		// Safety: never overwrite non-empty with empty (protects against bugs)
		if (newTabs.length === 0 && openTabs.length > 0) {
			logger.warn('[SessionHandler] persistRemoveTab would produce empty tab list — skipping', {
				sessionId,
				previousTabs: openTabs,
			});
			return;
		}

		const newActive = activeTab === sessionId ? newTabs[newTabs.length - 1] : activeTab;
		await this.writePersistedTabs(newTabs, newActive);
	}

	/**
	 * Explicitly clear all persisted tabs (used by clearAllConversations).
	 * This is the ONLY path that is allowed to write an empty list.
	 */
	private async persistClearAllTabs(): Promise<void> {
		await this.writePersistedTabs([], undefined);
	}

	private getLastStartedSessionId(): string | undefined {
		const started = [...this.context.sessionState.startedSessions];
		return started[started.length - 1];
	}

	/**
	 * Post a model error notification to the webview and abort the send.
	 * Uses the active session if available, otherwise broadcasts without a session.
	 */
	private restoreFailedSendDraft(
		sessionId: string | undefined,
		text: string,
		attachments: CommandOf<'sendMessage'>['attachments'] | undefined,
		agent: string | undefined,
		content: string,
		clientMessageID?: string,
	): void {
		if (sessionId) {
			if (clientMessageID) {
				this.context.bridge.sendSdkEvent({
					type: 'message.removed',
					properties: { sessionID: sessionId, messageID: clientMessageID },
				});
			}
			const restored = this.restoreInlineAttachmentsForDraft(text, attachments);
			this.context.bridge.queue.update(
				'cancelled',
				sessionId,
				[],
				restored.text,
				restored.attachments,
				agent,
			);
			this.context.bridge.data('showNotification', {
				notification: {
					id: `error-${Date.now()}`,
					type: 'error',
					content,
					timestamp: new Date().toISOString(),
				},
			});
		} else {
			this.context.bridge.data('showNotification', {
				notification: {
					id: `error-${Date.now()}`,
					type: 'error',
					content,
					timestamp: new Date().toISOString(),
				},
			});
		}
	}

	private postLifecycle(
		action: 'created' | 'closed' | 'switched' | 'cleared',
		sessionId: string,
		data?: { isProcessing?: boolean },
	): void {
		switch (action) {
			case 'created':
				this.context.bridge.lifecycle.created(sessionId);
				break;
			case 'switched':
				this.context.bridge.lifecycle.switched(sessionId, data?.isProcessing);
				break;
			case 'closed':
				this.context.bridge.lifecycle.closed(sessionId);
				break;
			case 'cleared':
				this.context.bridge.lifecycle.cleared(sessionId);
				break;
		}
	}

	private restoreInlineAttachmentsForDraft(
		text: string,
		attachments: CommandOf<'sendMessage'>['attachments'] | undefined,
	): {
		text: string;
		attachments?: Pick<NonNullable<CommandOf<'sendMessage'>['attachments']>, 'images'>;
	} {
		return {
			text: prependInlineAttachmentReferences(
				text,
				attachments?.files ?? [],
				(attachments?.codeSnippets ?? []).map(snippet => ({
					filePath: snippet.filePath,
					startLine: snippet.startLine ?? 1,
					endLine: snippet.endLine ?? snippet.startLine ?? 1,
				})),
			),
			attachments: attachments?.images?.length ? { images: attachments.images } : undefined,
		};
	}

	private collectDescendantSessionIds(rootSessionId: string): string[] {
		const result: string[] = [];
		const queue = [...this.context.sessionGraph.getChildren(rootSessionId)];
		const visited = new Set<string>();

		let head = 0;
		while (head < queue.length) {
			const current = queue[head++];
			if (!current || visited.has(current)) continue;
			visited.add(current);
			result.push(current);
			queue.push(...this.context.sessionGraph.getChildren(current));
		}

		return result;
	}

	private syncSessionRuntimeState(sessionId: string): void {
		const sessionIds = [sessionId, ...this.collectDescendantSessionIds(sessionId)];
		for (const currentSessionId of sessionIds) {
			this.syncSingleSessionRuntimeState(currentSessionId);
		}
	}

	private syncSingleSessionRuntimeState(sessionId: string): void {
		const autoAcceptState = this.context.getSessionAutoAcceptState?.(sessionId);
		const sessionInfo = this.context.sessionManager.getSession(sessionId);
		const sessionTitle = sessionInfo?.title;
		this.context.bridge.data('syncSessionState', {
			sessionId,
			...(typeof sessionTitle === 'string' && sessionTitle.trim() ? { title: sessionTitle } : {}),
			...(typeof sessionInfo?.parentID === 'string'
				? { parentSessionId: sessionInfo.parentID }
				: {}),
			autoAccept:
				autoAcceptState?.effective ?? this.context.getSessionAutoAccept?.(sessionId) ?? false,
			...(autoAcceptState ? { permissionAutoAccept: autoAcceptState } : {}),
		});
		void this.restoreSessionRuntimeStateFromServer(sessionId).catch(error =>
			logger.warn('[SessionHandler] Failed to sync session runtime state', { sessionId, error }),
		);
	}
}
