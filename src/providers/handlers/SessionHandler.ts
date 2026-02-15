import * as vscode from 'vscode';
import type {
	ConversationIndexEntry,
	OpenCodeProviderData,
	SessionMessageData,
	TotalStats,
} from '../../common';
import { generateId } from '../../common';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import { LogNormalizer } from '../../core/executor/LogNormalizer';
import type { CLIEvent } from '../../core/executor/types';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const getStringProp = (record: Record<string, unknown>, key: string): string | undefined => {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
};

export class SessionHandler implements WebviewMessageHandler {
	private readonly logNormalizer = new LogNormalizer();
	private sessionTotalsByUiSession = new Map<
		string,
		{
			requestCount: number;
			totalDuration: number;
			subagentTokensInput: number;
			subagentTokensOutput: number;
			subagentCount: number;
			totalInputTokens: number;
			totalOutputTokens: number;
			/** Previous snapshot values for computing deltas */
			_prevContextTokens: number;
			_prevOutputTokens: number;
		}
	>();

	// Improve Prompt State
	private improvePromptController: AbortController | null = null;
	private improvePromptActiveRequestId: string | null = null;

	constructor(private context: HandlerContext) {}

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
				await this.onStopRequest();
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
			case 'renameConversation':
				await this.onRenameConversation(msg);
				break;
		}
	}

	// =============================================================================
	// Public Methods for ChatProvider interaction (Event Reflection)
	// =============================================================================

	public postSessionMessage(message: SessionMessageData, sessionId?: string): void {
		const targetId = sessionId || this.context.sessionState.activeSessionId;
		if (!targetId) return;

		// Only log non-streaming message types to avoid per-token spam
		if (message.type !== 'thinking' && message.type !== 'assistant') {
			logger.debug('[SessionHandler] postSessionMessage', {
				messageType: message.type,
				messageId: message.id,
				targetSessionId: targetId,
			});
		}

		this.context.bridge.session.message(targetId, message);
	}

	public postStatus(
		sessionId: string | undefined,
		status: import('../../common').SessionStatus,
		statusText?: string,
	): void {
		if (!sessionId) return;
		this.context.bridge.session.status(sessionId, status, statusText);
	}

	public postComplete(partId: string, toolUseId?: string, sessionId?: string): void {
		const targetId = sessionId || this.context.sessionState.activeSessionId;
		if (!targetId) return;
		this.context.bridge.session.complete(targetId, partId, toolUseId);
	}

	public postTurnTokens(
		data: {
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadTokens: number;
			durationMs?: number;
			userMessageId?: string;
		},
		sessionId?: string,
	): void {
		const targetId = sessionId || this.context.sessionState.activeSessionId;
		if (!targetId) return;
		this.context.bridge.session.turnTokens(targetId, data);
	}

	public handleSessionUpdatedEvent(data: unknown, eventSessionId?: string): void {
		const record = asRecord(data) ?? {};

		// Resolve target session: event-level sessionId > data.sessionId > activeSessionId
		const backendSessionId = eventSessionId || getStringProp(record, 'sessionId');
		const targetSessionId = backendSessionId || this.context.sessionState.activeSessionId;
		if (!targetSessionId) return;

		// Ensure session is tracked as started
		if (!this.context.sessionState.startedSessions.has(targetSessionId)) {
			this.context.sessionState.startedSessions.add(targetSessionId);
		}

		const status = record.status as
			| { type?: string; attempt?: number; message?: string; next?: number }
			| undefined;

		if (status?.type === 'busy') {
			// Stop guard: suppress 'busy' events that arrive after user clicked Stop.
			// This prevents delayed SSE events from overwriting the forced 'idle' status.
			if (this.context.sessionState.isStopGuarded()) {
				logger.debug('[SessionHandler] Suppressed busy status (stop guard active)', {
					targetSessionId,
				});
				return;
			}
			this.postStatus(targetSessionId, 'busy', 'Working...');
		} else if (status?.type === 'idle') {
			// During stop guard, suppress idle too — we already forced idle.
			if (this.context.sessionState.isStopGuarded()) {
				logger.debug('[SessionHandler] Suppressed idle status (stop guard active)', {
					targetSessionId,
				});
				return;
			}
			this.postStatus(targetSessionId, 'idle', 'Ready');
		} else if (status?.type === 'retry') {
			this.context.bridge.session.status(targetSessionId, 'retrying', 'Retrying…', {
				attempt: typeof status.attempt === 'number' ? status.attempt : 1,
				message: typeof status.message === 'string' ? status.message : 'Retrying…',
				nextRetryAt:
					typeof status.next === 'number' ? new Date(status.next).toISOString() : undefined,
			});
		}

		const totalStatsRecord = asRecord(record.totalStats);
		const totalStatsPatch = totalStatsRecord as Partial<TotalStats> | undefined;

		// Aggregate only truly cumulative counters per UI session
		this.initializeSessionStats(targetSessionId);
		const totals = this.sessionTotalsByUiSession.get(targetSessionId);
		if (!totals) return;

		if (totalStatsPatch?.currentDuration) {
			totals.totalDuration += totalStatsPatch.currentDuration;
		} else if (totalStatsPatch?.totalDuration && totals.totalDuration === 0) {
			// History replay sends pre-computed totalDuration (not incremental)
			totals.totalDuration = totalStatsPatch.totalDuration;
		}

		if (typeof totalStatsPatch?.requestCount === 'number') {
			totals.requestCount += totalStatsPatch.requestCount;
		}

		if (typeof totalStatsPatch?.subagentCount === 'number') {
			totals.subagentCount += totalStatsPatch.subagentCount;
		}

		// Accumulate token deltas: contextTokens/outputTokens are snapshots (last API call),
		// so we compute deltas from previous snapshot to get cumulative totals.
		if (typeof totalStatsPatch?.contextTokens === 'number' && totalStatsPatch.contextTokens > 0) {
			const delta = Math.max(0, totalStatsPatch.contextTokens - totals._prevContextTokens);
			totals.totalInputTokens += delta;
			totals._prevContextTokens = totalStatsPatch.contextTokens;
		}
		if (typeof totalStatsPatch?.outputTokens === 'number' && totalStatsPatch.outputTokens > 0) {
			const delta = Math.max(0, totalStatsPatch.outputTokens - totals._prevOutputTokens);
			totals.totalOutputTokens += delta;
			totals._prevOutputTokens = totalStatsPatch.outputTokens;
		}

		this.postStats(targetSessionId, {
			totalStats: {
				...(totalStatsPatch ?? {}),
				requestCount: totals.requestCount,
				totalDuration: totals.totalDuration,
				subagentCount: totals.subagentCount,
				totalInputTokens: totals.totalInputTokens,
				totalOutputTokens: totals.totalOutputTokens,
			},
			modelID: getStringProp(record, 'modelID'),
			providerID: getStringProp(record, 'providerID'),
		});

		this.context.bridge.session.info(targetSessionId, [], []);
	}

	// =============================================================================
	// Private Handlers
	// =============================================================================

	private async onWebviewDidLaunch(): Promise<void> {
		// Restore all previously open tabs from globalState, then replay their history.
		try {
			const config = this.buildBaseConfig();
			const allSessions = await this.context.cli.listSessions(config);
			const validSessionIds = new Set(allSessions.filter(s => !s.parentID).map(s => s.id));

			if (validSessionIds.size === 0) {
				logger.info('[SessionHandler] No sessions found in CLI, staying in EmptyState');
				return;
			}

			// Read persisted tabs
			const persisted = this.getPersistedTabs();
			// Filter out tabs that no longer exist in CLI
			const tabsToRestore = persisted.openTabs.filter(id => validSessionIds.has(id));
			let activeTab =
				persisted.activeTab && validSessionIds.has(persisted.activeTab)
					? persisted.activeTab
					: undefined;

			// Fallback: if no persisted tabs, restore the most recent session
			if (tabsToRestore.length === 0) {
				const topLevel = allSessions
					.filter(s => !s.parentID)
					.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
				if (topLevel.length > 0) {
					tabsToRestore.push(topLevel[0].id);
					activeTab = topLevel[0].id;
				}
			}

			if (tabsToRestore.length === 0) return;
			if (!activeTab) activeTab = tabsToRestore[tabsToRestore.length - 1];

			logger.info('[SessionHandler] Restoring tabs from persistence', {
				tabCount: tabsToRestore.length,
				activeTab,
			});

			// Create all tabs in webview
			for (const tabId of tabsToRestore) {
				this.context.sessionState.startedSessions.add(tabId);
				this.postLifecycle('created', tabId);
				this.initializeSessionStats(tabId);
			}

			// Switch to the active tab
			this.context.sessionState.activeSessionId = activeTab;
			this.postLifecycle('switched', activeTab, { isProcessing: false });

			// Replay history only for the active tab (others load on switch)
			await this.replaySessionFromCLI(activeTab, config);
			this.postStatus(activeTab, 'idle', 'Ready');

			// Mark non-active tabs as idle
			for (const tabId of tabsToRestore) {
				if (tabId !== activeTab) {
					this.postStatus(tabId, 'idle', 'Ready');
				}
			}
		} catch (error) {
			logger.error('[SessionHandler] Failed to restore sessions from CLI:', error);
		}
	}

	/**
	 * Loads a session's full history (including child subagent sessions) from CLI
	 * and replays it into the webview. Uses SessionGraph for parent↔child linkage.
	 */
	private async replaySessionFromCLI(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<void> {
		const graph = this.context.sessionGraph;

		const allSessions = await this.context.cli.listSessions(config);
		const childSessions = allSessions
			.filter(s => s.parentID === sessionId)
			.sort((a, b) => (a.created || 0) - (b.created || 0));
		const childSessionIds = childSessions.map(s => s.id);

		// Extract task toolUseIds from parent history to build graph links
		const parentHistory = await this.context.cli.getHistory(sessionId, config);
		const taskToolUseIds: string[] = [];
		for (const ev of parentHistory) {
			if (ev.type === 'tool_use') {
				const d = ev.data as { tool?: string; toolUseId?: string };
				if (d.tool === 'task' && typeof d.toolUseId === 'string') {
					taskToolUseIds.push(d.toolUseId);
				}
			}
		}

		// Register all parent↔child links in the graph (single source of truth)
		graph.registerChildrenFromHistory(sessionId, taskToolUseIds, childSessionIds);

		// Replay child sessions into their own buckets and compute durations
		const childDurations = new Map<string, number>();
		for (const child of childSessions) {
			const childHistory = await this.context.cli.getHistory(child.id, config);
			this.replayHistoryIntoSession(child.id, childHistory);

			// Compute child session duration from first/last event timestamps
			if (childHistory.length > 0) {
				const firstTs = (childHistory[0].data as { timestamp?: string })?.timestamp;
				const lastTs = (childHistory[childHistory.length - 1].data as { timestamp?: string })
					?.timestamp;
				if (firstTs && lastTs) {
					const duration = new Date(lastTs).getTime() - new Date(firstTs).getTime();
					if (duration > 0) childDurations.set(child.id, duration);
				}
			}
		}

		// Surface child sessions as subtask cards if parent history is compacted
		if (taskToolUseIds.length === 0 && childSessions.length > 0) {
			for (const child of childSessions) {
				const duration = childDurations.get(child.id);
				this.postSessionMessage(
					{
						id: `hist-subtask-${child.id}`,
						type: 'subtask',
						agent: 'subagent',
						description: child.title || 'Subtask',
						status: 'completed',
						contextId: child.id,
						metadata: { childSessionId: child.id },
						timestamp: new Date().toISOString(),
						...(duration ? { durationMs: duration } : {}),
					},
					sessionId,
				);
			}
		}

		// Replay parent history, using graph for task→child resolution
		if (parentHistory.length > 0) {
			logger.info(
				`[SessionHandler] Replaying ${parentHistory.length} events for session ${sessionId}`,
			);
			this.replayHistoryIntoSession(sessionId, parentHistory, {
				mode: 'parent',
				parentSessionId: sessionId,
				childDurations,
			});
		}
	}

	private async onCreateSession(): Promise<void> {
		logger.info('[SessionHandler] Creating new real session');

		try {
			const config = this.buildBaseConfig();
			const newSessionId = await this.context.cli.createEmptySession(config);

			this.context.sessionState.activeSessionId = newSessionId;
			this.context.sessionState.startedSessions.add(newSessionId);

			this.postLifecycle('created', newSessionId);
			this.postLifecycle('switched', newSessionId, { isProcessing: false });
			this.postStatus(newSessionId, 'idle', 'Ready');
			this.initializeSessionStats(newSessionId);
			this.persistOpenTabs(newSessionId);
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
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.postStatus(sessionId, 'idle', 'Ready');
		this.initializeSessionStats(sessionId);
		this.persistOpenTabs(sessionId);
	}

	private async onCloseSession(msg: CommandOf<'closeSession'>): Promise<void> {
		const { sessionId } = msg;
		if (!sessionId) return;
		logger.info('[SessionHandler] Closing session', { sessionId });

		this.context.sessionState.startedSessions.delete(sessionId);
		this.clearSessionStats(sessionId);

		// If closing active session, clear backend reference
		if (this.context.sessionState.activeSessionId === sessionId) {
			this.context.sessionState.activeSessionId = undefined;
		}

		this.postLifecycle('closed', sessionId);
		this.persistOpenTabs(undefined, sessionId);
	}

	private async onSendMessage(msg: CommandOf<'sendMessage'>): Promise<void> {
		const { text, model: uiModel, sessionId, messageID, attachments } = msg;
		await this.handleSendMessage(text, uiModel, sessionId, messageID, attachments);
	}

	private async onStopRequest(): Promise<void> {
		const activeId = this.context.sessionState.activeSessionId;

		// Only process stop request if there's an active session
		if (!activeId) {
			logger.warn('[SessionHandler] Stop request ignored - no active session');
			return;
		}

		// Activate stop guard FIRST — blocks any incoming SSE 'busy' events
		// from overwriting our forced 'idle' status during the race window.
		this.context.sessionState.activateStopGuard(10_000);

		// Force UI to idle IMMEDIATELY — before awaiting abort.
		// This guarantees the Stop button always responds, even if the
		// abort request hangs or the server is unreachable.
		this.postStatus(activeId, 'idle', 'Stopped');
		this.postSessionMessage(
			{
				id: `interrupted-${Date.now()}`,
				type: 'interrupted',
				content: 'Stopped by user',
				timestamp: new Date().toISOString(),
			},
			activeId,
		);

		// Also force idle on any known child sessions (subagents)
		for (const sid of this.context.sessionState.startedSessions) {
			if (sid !== activeId) {
				this.postStatus(sid, 'idle', 'Stopped');
			}
		}

		// Now abort all sessions on the backend (main + subagents).
		// Wrapped in try/catch so the UI is never left stuck.
		try {
			await this.context.cli.abort();
		} catch (error) {
			logger.error('[SessionHandler] Abort failed (UI already reset):', error);
		}
	}

	private async handleSendMessage(
		text: string,
		uiModel?: string,
		explicitSessionId?: string,
		messageIdToTruncate?: string,
		attachments?: CommandOf<'sendMessage'>['attachments'],
	): Promise<void> {
		// Clear stop guard — user is explicitly sending a new message,
		// so SSE 'busy' events should be allowed through again.
		this.context.sessionState.clearStopGuard();

		const config = this.buildSendConfig(uiModel);
		let modelNotice: string | undefined;

		if (config.provider === 'opencode' && typeof config.model === 'string' && config.model.trim()) {
			const selectedModel = config.model.trim();
			// OpenCode model must be "provider/model".
			if (!selectedModel.includes('/')) {
				// Drop the override to avoid silent invalid routing.
				config.model = undefined;
				modelNotice = `Invalid OpenCode model selection: "${selectedModel}". Expected "provider/model". Please reselect a model in Settings.`;
			} else {
				const [providerId, modelId] = selectedModel.split('/', 2);
				const sdkClient = this.context.cli.getSdkClient();
				if (sdkClient) {
					try {
						const providers = (await this.context.services.openCodeClient.getConnectedProviders(
							sdkClient,
						)) as OpenCodeProviderData[];
						const provider = providers.find(p => p.id === providerId);
						const exists = provider?.models?.some(m => m.id === modelId) ?? false;
						if (!exists) {
							config.model = undefined;
							modelNotice = `Selected model "${selectedModel}" is unavailable. Please reconnect provider or choose another model in Settings.`;
						}
					} catch {
						// Do not block send if live model sync check fails; send path will report runtime errors.
					}
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
				this.initializeSessionStats(newSessionId);

				activeId = newSessionId;
			}

			if (modelNotice && activeId) {
				this.postSessionMessage(
					{
						id: `system_notice-${Date.now()}`,
						type: 'system_notice',
						content: modelNotice,
						timestamp: new Date().toISOString(),
					},
					activeId,
				);
			}

			// Post user message and send to CLI
			const isOpenCode = config.provider === 'opencode';
			const prefix = isOpenCode ? 'msg' : 'user';
			// Reuse edited message ID for UI merge (prevents duplicate user bubble after edit).
			const userMessageId = messageIdToTruncate || generateId(prefix);
			const hasAttachments =
				attachments?.files?.length ||
				attachments?.codeSnippets?.length ||
				attachments?.images?.length;
			this.postSessionMessage(
				{
					id: userMessageId,
					type: 'user' as const,
					content: text,
					model: config.model,
					timestamp: new Date().toISOString(),
					normalizedEntry: this.logNormalizer.normalizeMessage(text, 'user'),
					...(hasAttachments ? { attachments } : {}),
				},
				activeId,
			);

			// Emit checkpoint so the "Restore to Checkpoint" button appears on this user message
			if (activeId) {
				const commitId = generateId('checkpoint');
				// Register on backend so RestoreHandler can resolve commitId → API params
				this.context.registerCheckpoint?.(commitId, {
					sessionId: activeId,
					messageId: userMessageId,
					associatedMessageId: userMessageId,
					isOpenCode,
				});

				this.context.bridge.session.restore(activeId, {
					action: 'add_commit',
					commit: {
						id: commitId,
						sha: commitId,
						message: 'Checkpoint before message',
						timestamp: new Date().toISOString(),
						associatedMessageId: userMessageId,
					},
				});
			}

			this.postStatus(activeId, 'busy', 'Working...');
			this.initializeSessionStats(activeId);

			if (!activeId) throw new Error('No active session after initialization');

			// OpenCode edit flow (matches opencode-gui reference):
			// 1. Revert session to the edited message (truncates history on server)
			// 2. Send a clean prompt WITHOUT messageID (server treats it as a new message)
			// File restore is handled separately by RestoreHandler when the user
			// explicitly confirms via the "Restore & Send" dialog.
			if (isOpenCode && messageIdToTruncate) {
				logger.info('[SessionHandler] Editing message: revert then resend', {
					messageId: messageIdToTruncate,
				});
				await this.context.cli.truncateSession(activeId, messageIdToTruncate, config);
			}

			await this.context.cli.spawnFollowUp(text, activeId, config, attachments);
		} catch (error) {
			logger.error('[SessionHandler] Failed to spawn CLI:', error);

			if (activeId) {
				this.context.sessionState.startedSessions.delete(activeId);
				this.sessionTotalsByUiSession.delete(activeId);

				this.postSessionMessage({
					id: `error-${Date.now()}`,
					type: 'error',
					content: error instanceof Error ? error.message : 'Failed to start CLI',
					isError: true,
					timestamp: new Date().toISOString(),
				});
				this.postStatus(activeId, 'error', 'Failed to start');
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
			return (
				sessions
					.filter(s => !s.parentID)
					// Filter out empty sessions (no title means user never sent a message)
					.filter(s => s.title && s.title.trim() !== '')
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
					.sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime())
			);
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

		logger.info('[SessionHandler] Loading conversation', { sessionId });

		// Set active session and mark as started so follow-up messages reuse it
		this.context.sessionState.activeSessionId = sessionId;
		this.context.sessionState.startedSessions.add(sessionId);
		this.postLifecycle('created', sessionId);
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.initializeSessionStats(sessionId);
		this.persistOpenTabs(sessionId);

		try {
			const config = this.buildBaseConfig();
			await this.replaySessionFromCLI(sessionId, config);
			this.postStatus(sessionId, 'idle', 'Ready');
		} catch (error) {
			logger.error('[SessionHandler] Failed to load conversation:', error);
			this.postStatus(sessionId, 'error', 'Failed to load');
		}
	}

	private replayHistoryIntoSession(
		sessionId: string,
		history: CLIEvent[],
		options?: {
			mode?: 'default' | 'parent';
			parentSessionId?: string;
			childDurations?: Map<string, number>;
		},
	): void {
		// Track subtask metadata from tool_use so tool_result can carry it forward
		const subtaskMeta = new Map<string, { description: string; prompt: string; agent: string }>();

		for (const event of history) {
			if (event.type === 'message') {
				const data = event.data as {
					content?: string;
					partId?: string;
					isDelta?: boolean;
					timestamp?: string;
				};
				this.postSessionMessage(
					{
						id: data.partId ? `msg-${data.partId}` : `hist-msg-${Math.random()}`,
						type: 'assistant',
						content: data.content || '',
						isDelta: false,
						timestamp: data.timestamp || new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
					},
					sessionId,
				);
				continue;
			}

			if (event.type === 'normalized_log') {
				const data = event.data as {
					role?: string;
					content?: string;
					timestamp?: string;
					messageId?: string;
					attachments?: {
						files?: string[];
						codeSnippets?: Array<{
							filePath: string;
							startLine: number;
							endLine: number;
							content: string;
						}>;
						images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
					};
				};
				if (data.role === 'user') {
					const userMsgId =
						data.messageId?.trim() || `msg-local-${Math.random().toString(36).slice(2, 9)}`;
					const { attachments } = data;
					this.postSessionMessage(
						{
							id: userMsgId,
							type: 'user',
							content: data.content || '',
							timestamp: data.timestamp || new Date().toISOString(),
							normalizedEntry: event.normalizedEntry,
							...(attachments ? { attachments } : {}),
						},
						sessionId,
					);

					// Emit checkpoint so the restore button appears for replayed user messages
					const replayCommitId = generateId('checkpoint');
					this.context.registerCheckpoint?.(replayCommitId, {
						sessionId,
						messageId: userMsgId,
						associatedMessageId: userMsgId,
						isOpenCode: true,
					});

					this.context.bridge.session.restore(sessionId, {
						action: 'add_commit',
						commit: {
							id: replayCommitId,
							sha: replayCommitId,
							message: 'Checkpoint before message',
							timestamp: data.timestamp || new Date().toISOString(),
							associatedMessageId: userMsgId,
						},
					});
				}
				continue;
			}

			if (event.type === 'thinking') {
				const data = event.data as {
					content?: string;
					partId?: string;
					timestamp?: string;
					durationMs?: number;
				};
				this.postSessionMessage(
					{
						id: data.partId ? `thinking-${data.partId}` : `hist-thinking-${Math.random()}`,
						type: 'thinking',
						content: data.content || '',
						isDelta: false,
						isStreaming: false,
						timestamp: data.timestamp || new Date().toISOString(),
						...(data.durationMs ? { durationMs: data.durationMs } : {}),
					},
					sessionId,
				);
				continue;
			}

			if (event.type === 'tool_use') {
				const data = event.data as {
					tool?: string;
					input?: unknown;
					toolUseId?: string;
					timestamp?: string;
				};
				const toolName = data.tool || 'unknown';
				const input = (data.input as Record<string, unknown>) || {};
				const toolUseId = data.toolUseId || `hist-tool-${Math.random()}`;
				const filePathFromInput =
					typeof input.filePath === 'string'
						? input.filePath
						: typeof input.file_path === 'string'
							? input.file_path
							: typeof input.path === 'string'
								? input.path
								: undefined;

				if (options?.mode === 'parent' && toolName === 'task') {
					const graph = this.context.sessionGraph;
					const childSessionId = graph.getChildByTaskId(toolUseId);
					const subtaskDuration = childSessionId
						? options.childDurations?.get(childSessionId)
						: undefined;
					const agent = typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent';
					const prompt = typeof input.prompt === 'string' ? input.prompt : '';
					const description = typeof input.description === 'string' ? input.description : 'Subtask';
					// Save metadata so tool_result replay can carry it forward
					subtaskMeta.set(toolUseId, { description, prompt, agent });
					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							agent,
							prompt,
							description,
							status: 'running',
							contextId: childSessionId,
							metadata: childSessionId ? { childSessionId } : undefined,
							timestamp: data.timestamp || new Date().toISOString(),
							startTime: data.timestamp || new Date().toISOString(),
							...(subtaskDuration ? { durationMs: subtaskDuration } : {}),
						},
						sessionId,
					);
					continue;
				}

				this.postSessionMessage(
					{
						id: toolUseId,
						type: 'tool_use',
						toolName,
						toolUseId,
						rawInput: input,
						toolInput: JSON.stringify(input),
						filePath: filePathFromInput,
						timestamp: data.timestamp || new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
					},
					sessionId,
				);

				// Emit file change event for edit tools during replay
				// so ChangedFilesPanel is restored after extension restart
				if (filePathFromInput && this.isFileEditTool(toolName)) {
					const oldContent =
						typeof input.old_string === 'string'
							? input.old_string
							: typeof input.old_str === 'string'
								? input.old_str
								: typeof input.oldString === 'string'
									? input.oldString
									: '';
					const newContent =
						typeof input.new_string === 'string'
							? input.new_string
							: typeof input.new_str === 'string'
								? input.new_str
								: typeof input.newString === 'string'
									? input.newString
									: typeof input.content === 'string'
										? input.content
										: '';
					const oldLines = oldContent ? String(oldContent).split('\n').length : 0;
					const newLines = newContent ? String(newContent).split('\n').length : 0;

					this.context.bridge.session.fileChanged(sessionId, {
						filePath: filePathFromInput,
						fileName: filePathFromInput.split(/[/\\]/).pop() || filePathFromInput,
						linesAdded: Math.max(0, newLines - oldLines),
						linesRemoved: Math.max(0, oldLines - newLines),
						toolUseId,
					});
				}

				continue;
			}

			if (event.type === 'tool_result') {
				const data = event.data as {
					tool?: string;
					content?: string;
					isError?: boolean;
					toolUseId?: string;
					timestamp?: string;
					metadata?: unknown;
					title?: unknown;
				};
				const toolName = data.tool || 'unknown';
				const toolUseId = data.toolUseId || `hist-tool-${Math.random()}`;
				const metadata =
					data.metadata && typeof data.metadata === 'object'
						? (data.metadata as Record<string, unknown>)
						: undefined;

				if (options?.mode === 'parent' && toolName === 'task') {
					const graph = this.context.sessionGraph;
					const childSessionId = graph.getChildByTaskId(toolUseId);
					const subtaskDuration = childSessionId
						? options.childDurations?.get(childSessionId)
						: undefined;
					// Carry forward metadata saved from tool_use replay
					const savedMeta = subtaskMeta.get(toolUseId);
					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							status: data.isError ? 'error' : 'completed',
							result: data.content || '',
							contextId: childSessionId,
							metadata: childSessionId ? { childSessionId } : undefined,
							timestamp: data.timestamp || new Date().toISOString(),
							...(subtaskDuration ? { durationMs: subtaskDuration } : {}),
							...(savedMeta ?? {}),
						},
						sessionId,
					);
					continue;
				}

				this.postSessionMessage(
					{
						id: `res-${toolUseId || Math.random()}`,
						type: 'tool_result',
						toolName,
						toolUseId,
						content: data.content || '',
						isError: Boolean(data.isError),
						title: typeof data.title === 'string' ? data.title : undefined,
						metadata,
						timestamp: data.timestamp || new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
					},
					sessionId,
				);
				continue;
			}

			// Replay per-turn token stats so the UI shows real token counts
			if (event.type === 'turn_tokens') {
				this.postTurnTokens(
					event.data as {
						inputTokens: number;
						outputTokens: number;
						totalTokens: number;
						cacheReadTokens: number;
						durationMs?: number;
						userMessageId?: string;
					},
					sessionId,
				);
				continue;
			}

			// Restore aggregated token stats from history
			if (event.type === 'session_updated') {
				this.handleSessionUpdatedEvent(event.data, sessionId);
			}
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
				// Clean up local state if this was the active session
				this.context.sessionState.startedSessions.delete(sessionId);
				this.clearSessionStats(sessionId);

				if (this.context.sessionState.activeSessionId === sessionId) {
					this.context.sessionState.activeSessionId = undefined;
				}

				this.postLifecycle('closed', sessionId);
			}
		} catch (error) {
			logger.error('[SessionHandler] Failed to delete conversation:', error);
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
		const timeoutMs =
			msg.timeoutMs && Number.isFinite(msg.timeoutMs)
				? Math.max(1000, Math.round(msg.timeoutMs))
				: 60_000;

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
			const templateFromSettings = this.context.settings.get('promptImprove.template');
			const template = typeof templateFromSettings === 'string' ? templateFromSettings : undefined;

			// Use the same model & server as the main chat
			const sdkClient = this.context.cli.getSdkClient();
			if (!sdkClient) {
				throw new Error('OpenCode server is not running. Send a message first to start it.');
			}

			const sendConfig = this.buildSendConfig();

			const improvedText = await this.improvePromptViaOpenCode({
				text,
				template,
				client: sdkClient,
				model: sendConfig.model,
				parentSessionId: this.context.sessionState.activeSessionId,
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
	 * which waits for the assistant response and returns it directly.
	 */
	private async improvePromptViaOpenCode(params: {
		text: string;
		template?: string;
		model?: string;
		client: import('@opencode-ai/sdk').OpencodeClient;
		parentSessionId?: string;
		signal: AbortSignal;
	}): Promise<string> {
		const { client, signal } = params;

		const instruction =
			params.template?.trim() ||
			'Rewrite the following user prompt to be clearer, more specific, and more actionable for an AI coding agent. Preserve the original intent and constraints. Return ONLY the rewritten prompt text, nothing else — no explanations, no markdown fences, no preamble.';

		const fullText = `${instruction}\n\n---\n\n${params.text}`;

		// 1. Create a temporary session via SDK
		logger.info('[ImprovePrompt] Creating temp session...');
		const { data: sessionData, error: createError } = await client.session.create({
			body: params.parentSessionId ? { parentID: params.parentSessionId } : undefined,
			signal,
		});
		if (createError || !sessionData?.id) {
			throw new Error(`Failed to create temp session: ${createError ?? 'no session id'}`);
		}
		const sessionId = sessionData.id;
		logger.info(`[ImprovePrompt] Temp session created: ${sessionId}`);

		try {
			// 2. Send message via SDK's synchronous prompt() — waits for assistant response
			const modelOverride = params.model?.includes('/')
				? { providerID: params.model.split('/')[0], modelID: params.model.split('/')[1] }
				: undefined;

			logger.info(`[ImprovePrompt] Sending message to session ${sessionId}...`);
			const { data: response, error: promptError } = await client.session.prompt({
				path: { id: sessionId },
				body: {
					parts: [{ type: 'text', text: fullText }],
					model: modelOverride,
				},
				signal,
			});

			if (promptError) {
				throw new Error(`Improve prompt failed: ${promptError}`);
			}

			// 3. Extract assistant text from response parts
			let assistantText = '';
			for (const part of response?.parts ?? []) {
				if (part.type === 'text' && 'text' in part) {
					assistantText += (part as { text: string }).text;
				}
			}
			assistantText = assistantText.trim();

			if (!assistantText) {
				throw new Error('No assistant response in prompt result');
			}

			logger.info(`[ImprovePrompt] Got response: ${assistantText.length} chars`);
			return assistantText;
		} finally {
			// 4. Clean up — delete the temporary session (fire and forget)
			client.session.delete({ path: { id: sessionId } }).catch(() => {});
		}
	}

	// =============================================================================
	// Utils
	// =============================================================================

	private getSelectedModelKey(): string {
		return 'primecode.selectedModel.opencode';
	}

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

	private buildSendConfig(uiModel?: string) {
		const { provider, workspaceRoot } = this.buildBaseConfig();

		const savedModel = this.context.extensionContext.globalState.get<string>(
			this.getSelectedModelKey(),
		);
		const model = uiModel ?? savedModel;

		const opencodeAgent = this.context.settings.get('opencode.agent');
		const opencodeServerTimeout = this.context.settings.get('opencode.serverTimeout');

		return {
			provider,
			model,
			workspaceRoot,
			yoloMode: Boolean(this.context.settings.get('yoloMode') || false),
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			autoApprove: Boolean(this.context.settings.get('autoApprove') || false),
			serverTimeoutMs:
				typeof opencodeServerTimeout === 'number' && Number.isFinite(opencodeServerTimeout)
					? Math.max(0, opencodeServerTimeout) * 1000
					: undefined,
		};
	}

	private initializeSessionStats(sessionId: string | undefined): void {
		if (!sessionId || this.sessionTotalsByUiSession.has(sessionId)) {
			return;
		}
		this.sessionTotalsByUiSession.set(sessionId, {
			requestCount: 0,
			totalDuration: 0,
			subagentTokensInput: 0,
			subagentTokensOutput: 0,
			subagentCount: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			_prevContextTokens: 0,
			_prevOutputTokens: 0,
		});

		this.postStats(sessionId, {
			totalStats: {
				contextTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				reasoningTokens: 0,
				requestCount: 0,
				totalDuration: 0,
				totalCost: 0,
				subagentTokensInput: 0,
				subagentTokensOutput: 0,
				subagentCount: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
			},
		});
	}

	private clearSessionStats(sessionId: string): void {
		this.sessionTotalsByUiSession.delete(sessionId);
	}

	private static readonly OPEN_TABS_KEY = 'primecode.openTabs';
	private static readonly ACTIVE_TAB_KEY = 'primecode.activeTab';

	/**
	 * Persist the current set of open tabs and active tab to globalState.
	 * @param activeSessionId - the tab to mark active (defaults to current)
	 * @param excludeSessionId - a tab to remove (used on close)
	 */
	private persistOpenTabs(activeSessionId?: string, excludeSessionId?: string): void {
		const tabs = [...this.context.sessionState.startedSessions];
		const filtered = excludeSessionId ? tabs.filter(id => id !== excludeSessionId) : tabs;
		const active = activeSessionId || this.context.sessionState.activeSessionId;

		this.context.extensionContext.globalState.update(SessionHandler.OPEN_TABS_KEY, filtered);
		this.context.extensionContext.globalState.update(SessionHandler.ACTIVE_TAB_KEY, active);

		logger.debug('[SessionHandler] Persisted open tabs', {
			count: filtered.length,
			active,
		});
	}

	private getPersistedTabs(): { openTabs: string[]; activeTab: string | undefined } {
		const openTabs =
			this.context.extensionContext.globalState.get<string[]>(SessionHandler.OPEN_TABS_KEY) || [];
		const activeTab = this.context.extensionContext.globalState.get<string>(
			SessionHandler.ACTIVE_TAB_KEY,
		);
		return { openTabs, activeTab };
	}

	/** Check if a tool name corresponds to a file-editing operation */
	private isFileEditTool(toolName: string): boolean {
		const normalized = toolName.toLowerCase();
		const editTools = new Set([
			'write',
			'edit',
			'multiedit',
			'multi_edit',
			'patch',
			'create',
			'writefile',
			'editfile',
			'write_file',
			'edit_file',
			'create_file',
			'apply_diff',
			'insert_code',
		]);
		if (editTools.has(normalized)) return true;
		return /\b(write|edit|patch|create|overwrite|insert|replace|append|delete_file)\b/.test(
			normalized,
		);
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

	private postStats(
		sessionId: string,
		payload: { totalStats?: Partial<TotalStats>; modelID?: string; providerID?: string },
	): void {
		this.context.bridge.session.stats(sessionId, payload);
	}
}
