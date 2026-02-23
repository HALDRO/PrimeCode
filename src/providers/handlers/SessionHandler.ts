import * as vscode from 'vscode';
import type {
	ConversationIndexEntry,
	OpenCodeProviderData,
	SessionMessageData,
	SessionMessageUpdate,
	TotalStats,
} from '../../common';
import { generateId, parseModelId } from '../../common';
import { IMPROVE_PROMPT_DEFAULT_TEMPLATE } from '../../common/promptImprover';
import type { CommandOf, QueuedMessageData, WebviewCommand } from '../../common/protocol';
import { computeDiffLineStats, isFileEditTool } from '../../common/toolRegistry';
import {
	buildTranscript,
	extractFilePath,
	mapMessageEvent,
	mapThinkingEvent,
	mapToolResultEvent,
	mapToolUseEvent,
	mapUserEvent,
} from '../../core/eventToMessage';
import { LogNormalizer } from '../../core/executor/LogNormalizer';
import type { CLIConfig, CLIEvent } from '../../core/executor/types';
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

	/** Sessions whose history has already been replayed into the webview. */
	private replayedSessions = new Set<string>();

	// Improve Prompt State
	private improvePromptController: AbortController | null = null;
	private improvePromptActiveRequestId: string | null = null;

	/** Per-session message queue — up to MAX_QUEUE_SIZE per session (FIFO). */
	private static readonly MAX_QUEUE_SIZE = 3;
	private readonly pendingMessages = new Map<string, QueuedMessageData[]>();
	private queueIdCounter = 0;

	/** Per-session sending lock — prevents race between processQueueOnIdle and onSendMessage. */
	private readonly sendingLock = new Set<string>();

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
			case 'renameConversation':
				await this.onRenameConversation(msg);
				break;
		}
	}

	// =============================================================================
	// Public Methods for ChatProvider interaction (Event Reflection)
	// =============================================================================

	public postSessionMessage(
		message: SessionMessageData | SessionMessageUpdate,
		sessionId?: string,
	): void {
		const targetId = sessionId;
		if (!targetId) {
			logger.warn('[SessionHandler] postSessionMessage dropped: no sessionId', {
				messageType: message.type,
				messageId: message.id,
			});
			return;
		}

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
		const targetId = sessionId;
		if (!targetId) {
			logger.warn('[SessionHandler] postComplete dropped: no sessionId', { partId });
			return;
		}
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
		const targetId = sessionId;
		if (!targetId) {
			logger.warn('[SessionHandler] postTurnTokens dropped: no sessionId');
			return;
		}
		this.context.bridge.session.turnTokens(targetId, data);
	}

	public handleSessionUpdatedEvent(data: unknown, eventSessionId?: string): void {
		const record = asRecord(data) ?? {};

		// Resolve target session: event-level sessionId > data.sessionId > activeSessionId
		const backendSessionId = eventSessionId || getStringProp(record, 'sessionId');

		const status = record.status as
			| { type?: string; attempt?: number; message?: string; next?: number }
			| undefined;

		// STRICT: never fallback to activeSessionId for any event routing.
		// Without a real sessionId, we'd route data to the wrong session after tab switch.
		const targetSessionId = backendSessionId;
		if (!targetSessionId) {
			logger.warn('[SessionHandler] Dropping session_updated event without sessionId', {
				statusType: status?.type,
				hasStats: !!asRecord(record.totalStats),
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
			this.postStatus(targetSessionId, 'busy', 'Working...');
		} else if (status?.type === 'idle') {
			// During stop guard, suppress idle too — we already forced idle.
			if (this.context.sessionState.isStopGuarded(targetSessionId)) {
				logger.debug('[SessionHandler] Suppressed idle status (stop guard active)', {
					targetSessionId,
				});
				return;
			}
			this.postStatus(targetSessionId, 'idle', 'Ready');

			// Auto-dequeue: if there's a queued message, send it now.
			// This is the OpenCode-style "callback resolution" pattern.
			void this.processQueueOnIdle(targetSessionId);
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

			// Switch to the active tab — query real status from executor
			this.context.sessionState.activeSessionId = activeTab;
			const isActiveTabBusy = this.context.cli.isSessionActive?.(activeTab) ?? false;
			this.postLifecycle('switched', activeTab, { isProcessing: isActiveTabBusy });

			// Replay history only for the active tab (others lazy-load on switch)
			// Pass allSessions to avoid a redundant listSessions() call inside replaySessionFromCLI
			await this.replaySessionFromCLI(activeTab, config, allSessions);
			this.replayedSessions.add(activeTab);
			// Post status matching real backend state
			if (isActiveTabBusy) {
				this.postStatus(activeTab, 'busy', 'Working...');
			} else {
				this.postStatus(activeTab, 'idle', 'Ready');
			}

			// Post real status for non-active tabs
			for (const tabId of tabsToRestore) {
				if (tabId !== activeTab) {
					const isBusy = this.context.cli.isSessionActive?.(tabId) ?? false;
					this.postStatus(tabId, isBusy ? 'busy' : 'idle', isBusy ? 'Working...' : 'Ready');
				}
			}
		} catch (error) {
			logger.error('[SessionHandler] Failed to restore sessions from CLI:', error);
		}
	}

	/**
	 * Loads a session's full history (including child subagent sessions) from CLI
	 * and replays it into the webview. Uses SessionGraph for parent↔child linkage.
	 *
	 * @param cachedSessions - Pre-fetched sessions list to avoid redundant listSessions() calls.
	 *                         When omitted, falls back to fetching from CLI.
	 */
	private async replaySessionFromCLI(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
		cachedSessions?: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>,
	): Promise<void> {
		const graph = this.context.sessionGraph;

		const allSessions = cachedSessions ?? (await this.context.cli.listSessions(config));
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

		// Register all parent↔child links in the graph
		graph.registerChildrenFromHistory(sessionId, taskToolUseIds, childSessionIds);

		// Pre-load ALL child histories in parallel (instead of sequential loop).
		// Child events are aggregated into parent subtask transcripts (no separate buckets).
		const childHistories = new Map<string, CLIEvent[]>();
		const childDurations = new Map<string, number>();
		const childTokensMap = new Map<
			string,
			{ input: number; output: number; total: number; cacheRead: number }
		>();

		if (childSessions.length > 0) {
			const childResults = await Promise.all(
				childSessions.map(async child => ({
					id: child.id,
					title: child.title,
					history: await this.context.cli.getHistory(child.id, config),
				})),
			);

			for (const { id, history } of childResults) {
				childHistories.set(id, history);

				if (history.length > 0) {
					const firstTs = (history[0].data as { timestamp?: string })?.timestamp;
					const lastTs = (history[history.length - 1].data as { timestamp?: string })?.timestamp;
					if (firstTs && lastTs) {
						const duration = new Date(lastTs).getTime() - new Date(firstTs).getTime();
						if (duration > 0) childDurations.set(id, duration);
					}

					// Aggregate turn_tokens from child history for childTokens on subtask cards
					let totalInput = 0;
					let totalOutput = 0;
					let totalTokens = 0;
					let totalCacheRead = 0;
					for (const ev of history) {
						if (ev.type === 'turn_tokens') {
							const d = ev.data as {
								inputTokens?: number;
								outputTokens?: number;
								totalTokens?: number;
								cacheReadTokens?: number;
							};
							totalInput += d.inputTokens ?? 0;
							totalOutput += d.outputTokens ?? 0;
							totalTokens += d.totalTokens ?? 0;
							totalCacheRead += d.cacheReadTokens ?? 0;
						}
					}
					if (totalTokens > 0) {
						childTokensMap.set(id, {
							input: totalInput,
							output: totalOutput,
							total: totalTokens,
							cacheRead: totalCacheRead,
						});
					}
				}
			}
		}

		// Batch all replay messages into a single postMessage to reduce overhead.
		// startCollect() buffers session_event messages; flushCollected() sends them as one batch.
		// Restore revert state from persisted workspaceState.
		// If this session was reverted before the extension restarted,
		// we need to re-apply the revert marker so messages stay dimmed.
		const isReverted = this.context.isSessionReverted?.(sessionId) ?? false;

		this.context.bridge.startCollect();
		try {
			// Surface child sessions as subtask cards if parent history is compacted
			if (taskToolUseIds.length === 0 && childSessions.length > 0) {
				for (const child of childSessions) {
					const duration = childDurations.get(child.id);
					const childTokens = childTokensMap.get(child.id);
					const childHistory = childHistories.get(child.id) || [];
					const transcript = this.buildTranscriptFromHistory(childHistory) as unknown[];
					this.postSessionMessage(
						{
							id: `hist-subtask-${child.id}`,
							type: 'subtask',
							agent: 'subagent',
							prompt: '',
							description: child.title || 'Subtask',
							status: 'completed',
							transcript: transcript as import('../../common/schemas').ConversationMessage[],
							timestamp: new Date().toISOString(),
							...(duration ? { durationMs: duration } : {}),
							...(childTokens ? { childTokens } : {}),
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
					childHistories,
					childTokensMap,
				});
			}
		} finally {
			this.context.bridge.flushCollected();
		}

		// After replay is flushed, restore revert state if this session was
		// reverted before the extension restarted. This must happen AFTER
		// flushCollected() so the messages are already in the webview store
		// and the revert marker can dim them correctly.
		if (isReverted) {
			// Find the last user message ID to use as the revert point.
			// The OpenCode server's session.revert field tracks the real revert point,
			// but we don't have it here. The last user message in the replayed history
			// is the closest approximation — messages after it were reverted.
			// Reverse search without allocating a copy (findLast unavailable in extension tsconfig)
			let lastUserEvent: CLIEvent | undefined;
			for (let i = parentHistory.length - 1; i >= 0; i--) {
				const ev = parentHistory[i];
				if (ev.type === 'normalized_log' && (ev.data as { role?: string }).role === 'user') {
					lastUserEvent = ev;
					break;
				}
			}
			const lastUserMessageId = lastUserEvent
				? (lastUserEvent.data as { messageId?: string }).messageId
				: undefined;

			if (lastUserMessageId) {
				this.context.bridge.session.restore(sessionId, {
					action: 'success',
					canUnrevert: true,
					revertedFromMessageId: lastUserMessageId,
				});
				logger.info('[SessionHandler] Restored revert state after replay', {
					sessionId,
					revertedFromMessageId: lastUserMessageId,
				});
			}
		}
	}

	private async onCreateSession(): Promise<void> {
		logger.info('[SessionHandler] Creating new real session');

		try {
			const config = this.buildBaseConfig();
			const newSessionId = await this.context.cli.createEmptySession(config);

			this.context.sessionState.activeSessionId = newSessionId;
			this.context.sessionState.startedSessions.add(newSessionId);
			this.replayedSessions.add(newSessionId);

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

		// Query REAL processing status from the backend executor.
		// The executor tracks active sessions via SSE session.status events.
		const isActive = this.context.cli.isSessionActive?.(sessionId) ?? false;
		this.postLifecycle('switched', sessionId, { isProcessing: isActive });
		this.initializeSessionStats(sessionId);
		this.persistOpenTabs(sessionId);

		// Lazy-load history for tabs that were restored but not yet replayed
		if (!this.replayedSessions.has(sessionId)) {
			try {
				const config = this.buildBaseConfig();
				await this.replaySessionFromCLI(sessionId, config);
				this.replayedSessions.add(sessionId);
			} catch (error) {
				logger.error('[SessionHandler] Failed to lazy-load session history:', error);
			}
		}

		// Post status matching the real backend state
		if (isActive) {
			this.postStatus(sessionId, 'busy', 'Working...');
		} else {
			this.postStatus(sessionId, 'idle', 'Ready');
		}
	}

	private async onCloseSession(msg: CommandOf<'closeSession'>): Promise<void> {
		const { sessionId } = msg;
		if (!sessionId) return;
		logger.info('[SessionHandler] Closing session', { sessionId });

		this.context.sessionState.startedSessions.delete(sessionId);
		this.replayedSessions.delete(sessionId);
		this.clearSessionStats(sessionId);
		this.clearPendingMessage(sessionId);

		// If closing active session, clear backend reference
		if (this.context.sessionState.activeSessionId === sessionId) {
			this.context.sessionState.activeSessionId = undefined;
		}

		this.postLifecycle('closed', sessionId);
		this.persistOpenTabs(undefined, sessionId);
	}

	private async onSendMessage(msg: CommandOf<'sendMessage'>): Promise<void> {
		const { text, model: uiModel, sessionId, messageID, attachments, agent } = msg;
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
			this.enqueueMessage(targetId, text, uiModel, resolvedAgent, attachments);
			return;
		}

		await this.handleSendMessage(text, uiModel, sessionId, messageID, attachments, resolvedAgent);
	}

	private onCancelQueuedMessage(msg: CommandOf<'cancelQueuedMessage'>): void {
		const { sessionId, queueId } = msg;
		const queue = this.pendingMessages.get(sessionId);
		if (!queue) return;
		const idx = queue.findIndex(e => e.queueId === queueId);
		if (idx === -1) return;
		const removed = queue[idx];
		const newQueue = queue.filter(e => e.queueId !== queueId);
		if (newQueue.length === 0) this.pendingMessages.delete(sessionId);
		else this.pendingMessages.set(sessionId, newQueue);
		logger.info('[SessionHandler] Cancelled queued message', { sessionId, queueId });
		this.context.bridge.queue.update(
			'cancelled',
			sessionId,
			newQueue.length > 0 ? [...newQueue] : [],
			removed.text,
			removed.attachments,
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

		this.pendingMessages.set(sessionId, reordered);
		this.context.bridge.queue.update('enqueued', sessionId, [...reordered]);
	}

	private async onForceQueuedMessage(msg: CommandOf<'forceQueuedMessage'>): Promise<void> {
		const { sessionId, queueId } = msg;
		const queue = this.pendingMessages.get(sessionId);
		if (!queue) return;
		const idx = queue.findIndex(e => e.queueId === queueId);
		if (idx === -1) return;
		const entry = queue[idx];
		const newQueue = queue.filter(e => e.queueId !== queueId);
		if (newQueue.length === 0) this.pendingMessages.delete(sessionId);
		else this.pendingMessages.set(sessionId, newQueue);

		// Only stop if session is actually busy (avoids false "Stopped by user")
		const isBusy = this.context.cli.isSessionActive?.(sessionId) ?? false;
		if (isBusy) {
			// onStopRequest already awaits abortSession() — no setTimeout needed
			await this.onStopRequest({ type: 'stopRequest', sessionId });
		}

		// Notify webview of updated queue
		const remaining = this.pendingMessages.get(sessionId) ?? [];
		this.context.bridge.queue.update('dequeued', sessionId, [...remaining]);

		// Acquire sending lock to prevent race with concurrent onSendMessage
		this.sendingLock.add(sessionId);
		try {
			await this.handleSendMessage(
				entry.text,
				entry.model,
				entry.sessionId,
				undefined,
				entry.attachments,
				entry.agent,
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
		const queue = this.pendingMessages.get(sessionId);
		if (!queue || queue.length === 0) return;
		const entry = queue[0];
		queue.shift();
		if (queue.length === 0) this.pendingMessages.delete(sessionId);

		logger.info('[SessionHandler] Auto-dequeuing message on idle', {
			sessionId,
			queueId: entry.queueId,
		});

		const remaining = this.pendingMessages.get(sessionId) ?? [];
		this.context.bridge.queue.update('dequeued', sessionId, [...remaining]);

		// Acquire sending lock to prevent race with concurrent onSendMessage
		this.sendingLock.add(sessionId);
		try {
			await this.handleSendMessage(
				entry.text,
				entry.model,
				entry.sessionId,
				undefined,
				entry.attachments,
				entry.agent,
			);
		} catch (error) {
			logger.error('[SessionHandler] Failed to send dequeued message, returning to input', error);
			this.context.bridge.queue.update(
				'cancelled',
				sessionId,
				[...remaining],
				entry.text,
				entry.attachments,
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
	): void {
		const queue = this.pendingMessages.get(sessionId) ?? [];
		if (queue.length >= SessionHandler.MAX_QUEUE_SIZE) {
			logger.warn('[SessionHandler] Queue full, rejecting message', { sessionId });
			// Return text and attachments to input so user doesn't lose them
			this.context.bridge.queue.update(
				'cancelled',
				sessionId,
				[...queue],
				text,
				attachments,
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
			sessionsToStop.add(childId);
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
		this.postStatus(targetId, 'idle', 'Stopped');
		this.postSessionMessage(
			{
				id: `interrupted-${Date.now()}`,
				type: 'interrupted',
				content: 'Stopped by user',
				timestamp: new Date().toISOString(),
			},
			targetId,
		);

		// Also force idle on child sessions (subagents) of the target session only
		for (const sid of sessionsToStop) {
			if (sid !== targetId) {
				this.postStatus(sid, 'idle', 'Stopped');
			}
		}
	}

	private async handleSendMessage(
		text: string,
		uiModel?: string,
		explicitSessionId?: string,
		messageIdToTruncate?: string,
		attachments?: CommandOf<'sendMessage'>['attachments'],
		agent?: string,
	): Promise<void> {
		// Clear stop guard for the target session — user is explicitly sending
		// a new message, so SSE 'busy' events should be allowed through again.
		const targetSessionForGuard = explicitSessionId || this.context.sessionState.activeSessionId;
		if (targetSessionForGuard) {
			this.context.sessionState.clearStopGuard(targetSessionForGuard);
		}

		const config = this.buildSendConfig(uiModel);

		// Per-message agent override takes precedence over the global opencode.agent setting.
		if (agent) {
			config.agent = agent;
		}
		let modelNotice: string | undefined;

		if (config.provider === 'opencode' && typeof config.model === 'string' && config.model.trim()) {
			const selectedModel = config.model.trim();
			const parsed = parseModelId(selectedModel);
			if (!parsed) {
				// Drop the override to avoid silent invalid routing.
				config.model = undefined;
				modelNotice = `Invalid OpenCode model selection: "${selectedModel}". Expected "provider/model". Please reselect a model in Settings.`;
			} else {
				const sdkClient = this.context.cli.getSdkClient();
				if (sdkClient) {
					try {
						const providers = (await this.context.services.openCodeClient.getConnectedProviders(
							sdkClient,
						)) as OpenCodeProviderData[];
						const provider = providers.find(p => p.id === parsed.providerId);
						const exists = provider?.models?.some(m => m.id === parsed.modelId) ?? false;
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

			// Intercept internal slash commands that need special routing.
			// /compact and /summarize must call the summarize API endpoint,
			// not be sent as regular text prompts.
			const isOpenCode = config.provider === 'opencode';
			const slashMatch = text.trim().match(/^\/(\S+)(?:\s+(.*))?$/);
			const slashCmd = slashMatch?.[1]?.toLowerCase();

			if (isOpenCode && (slashCmd === 'compact' || slashCmd === 'summarize')) {
				// Don't post user message — compact is a system operation
				logger.info('[SessionHandler] Routing /compact to executeCommand', { sessionId: activeId });
				this.postStatus(activeId, 'busy', 'Compacting session...');
				await this.context.cli.executeCommand(text.trim(), [], config, activeId);
				return;
			}

			if (!activeId) throw new Error('No active session after initialization');

			// OpenCode edit flow: truncate FIRST, then post user message.
			// This prevents message duplication on session restore: if we posted
			// the user message first and then truncated, the server would still
			// have the original message. On restore, both would appear.
			// By truncating first, the server history is clean before we send.
			if (isOpenCode && messageIdToTruncate) {
				logger.info('[SessionHandler] Editing message: revert then resend', {
					messageId: messageIdToTruncate,
				});
				await this.context.cli.truncateSession(activeId, messageIdToTruncate, config);
			}

			// Post user message and send to CLI.
			// For edits: generate a NEW id — the old message was truncated on the server,
			// and the UI already removed messages after it via deleteMessagesAfterId.
			// Reusing the old ID would cause the server to have a different ID than the UI.
			const prefix = isOpenCode ? 'msg' : 'user';
			const userMessageId = generateId(prefix);
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

			this.postStatus(activeId, 'busy', 'Working...');
			this.initializeSessionStats(activeId);

			// Pass our client-generated ID to the server so it uses it as the
			// real user message ID (OpenCode prompt.ts: id = input.messageID ?? ...).
			// This eliminates the need for SSE-based ID reconciliation.
			config.messageID = userMessageId;

			await this.context.cli.spawnFollowUp(text, activeId, config, attachments);
		} catch (error) {
			logger.error('[SessionHandler] Failed to spawn CLI:', error);

			if (activeId) {
				this.context.sessionState.startedSessions.delete(activeId);
				this.sessionTotalsByUiSession.delete(activeId);

				this.postSessionMessage(
					{
						id: `error-${Date.now()}`,
						type: 'error',
						content: error instanceof Error ? error.message : 'Failed to start CLI',
						isError: true,
						timestamp: new Date().toISOString(),
					},
					activeId,
				);
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
		// New conversations are never busy — they haven't been sent to yet
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.initializeSessionStats(sessionId);
		this.persistOpenTabs(sessionId);

		try {
			const config = this.buildBaseConfig();
			await this.replaySessionFromCLI(sessionId, config);
			this.replayedSessions.add(sessionId);
			// Query real status — loaded conversation could theoretically be active
			const isBusy = this.context.cli.isSessionActive?.(sessionId) ?? false;
			this.postStatus(sessionId, isBusy ? 'busy' : 'idle', isBusy ? 'Working...' : 'Ready');
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
			childHistories?: Map<string, CLIEvent[]>;
			childTokensMap?: Map<
				string,
				{ input: number; output: number; total: number; cacheRead: number }
			>;
		},
	): void {
		// Track subtask metadata from tool_use so tool_result can carry it forward
		const subtaskMeta = new Map<string, { description: string; prompt: string; agent: string }>();

		for (const event of history) {
			if (event.type === 'message') {
				this.postSessionMessage(
					mapMessageEvent(event.data, { idPrefix: 'hist', normalizedEntry: event.normalizedEntry }),
					sessionId,
				);
				continue;
			}

			if (event.type === 'normalized_log') {
				const data = event.data;
				if (data.role === 'user') {
					const userMsg = mapUserEvent(data, { normalizedEntry: event.normalizedEntry });
					this.postSessionMessage(userMsg, sessionId);

					// Emit checkpoint so the restore button appears for replayed user messages
					const replayCommitId = generateId('checkpoint');
					this.context.registerCheckpoint?.(replayCommitId, {
						sessionId,
						messageId: userMsg.id,
						associatedMessageId: userMsg.id,
						isOpenCode: true,
					});

					this.context.bridge.session.restore(sessionId, {
						action: 'add_commit',
						commit: {
							id: replayCommitId,
							sha: replayCommitId,
							message: 'Checkpoint before message',
							timestamp: data.timestamp || new Date().toISOString(),
							associatedMessageId: userMsg.id,
						},
					});
				}
				continue;
			}

			if (event.type === 'thinking') {
				this.postSessionMessage(mapThinkingEvent(event.data, { idPrefix: 'hist' }), sessionId);
				continue;
			}

			if (event.type === 'tool_use') {
				const data = event.data;
				const toolName = data.tool || 'unknown';
				const input = (data.input as Record<string, unknown>) || {};
				const toolUseId = data.toolUseId || `hist-tool-${Math.random()}`;
				const filePathFromInput = extractFilePath(input);

				// Question tool — render as resolved QuestionCard instead of generic tool card
				if (toolName.toLowerCase() === 'question') {
					const questions = Array.isArray(input.questions)
						? (input.questions as import('../../common/schemas').QuestionInfo[])
						: [];
					this.postSessionMessage(
						{
							id: `question-${toolUseId}`,
							type: 'question',
							requestId: toolUseId,
							questions,
							resolved: true,
							timestamp: data.timestamp || new Date().toISOString(),
						},
						sessionId,
					);
					continue;
				}

				if (options?.mode === 'parent' && toolName === 'task') {
					const graph = this.context.sessionGraph;
					const childSessionId = graph.getChildByTaskId(toolUseId);
					const subtaskDuration = childSessionId
						? options.childDurations?.get(childSessionId)
						: undefined;
					const childTokens = childSessionId
						? options.childTokensMap?.get(childSessionId)
						: undefined;
					const agent = typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent';
					const prompt = typeof input.prompt === 'string' ? input.prompt : '';
					const description = typeof input.description === 'string' ? input.description : 'Subtask';
					subtaskMeta.set(toolUseId, { description, prompt, agent });

					// Build transcript from child history instead of using contextId
					const childHistory = childSessionId
						? options.childHistories?.get(childSessionId)
						: undefined;
					const transcript = childHistory
						? (this.buildTranscriptFromHistory(
								childHistory,
							) as unknown as import('../../common/schemas').ConversationMessage[])
						: undefined;

					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							agent,
							prompt,
							description,
							status: 'running',
							transcript,
							timestamp: data.timestamp || new Date().toISOString(),
							startTime: data.timestamp || new Date().toISOString(),
							...(subtaskDuration ? { durationMs: subtaskDuration } : {}),
							...(childTokens ? { childTokens } : {}),
						},
						sessionId,
					);
					continue;
				}

				const toolUseMsg = mapToolUseEvent(data, {
					idPrefix: 'hist',
					normalizedEntry: event.normalizedEntry,
				});
				this.postSessionMessage(toolUseMsg, sessionId);

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
					const diffStats = computeDiffLineStats(String(oldContent), String(newContent));

					this.context.bridge.session.fileChanged(sessionId, {
						filePath: filePathFromInput,
						fileName: filePathFromInput.split(/[/\\]/).pop() || filePathFromInput,
						linesAdded: diffStats.added,
						linesRemoved: diffStats.removed,
						toolUseId,
					});
				}

				continue;
			}

			if (event.type === 'tool_result') {
				const data = event.data;
				const toolName = data.tool || 'unknown';
				const toolUseId = data.tool_use_id || `hist-tool-${Math.random()}`;

				// Extract answers from question tool_result and merge into the existing QuestionCard
				if (toolName.toLowerCase() === 'question') {
					const content = data.content;
					const inputData = (data.input as Record<string, unknown>) || {};
					const questionsArr = Array.isArray(inputData.questions)
						? (inputData.questions as Array<{
								question: string;
								options: Array<{ label: string }>;
							}>)
						: [];
					let answers: string[][] | undefined;

					// Try parsing content as structured answers (JSON)
					if (typeof content === 'string') {
						try {
							const parsed = JSON.parse(content);
							if (Array.isArray(parsed)) {
								answers = parsed as string[][];
							} else if (parsed && Array.isArray(parsed.answers)) {
								answers = parsed.answers as string[][];
							}
						} catch {
							// Not JSON — try parsing human-readable "question"="answer" pairs
							// CLI format: User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue...
							const pairRegex = /"([^"]+)"="([^"]+)"/g;
							const pairs: Array<{ question: string; answer: string }> = [];
							for (
								let pairMatch = pairRegex.exec(content);
								pairMatch !== null;
								pairMatch = pairRegex.exec(content)
							) {
								pairs.push({ question: pairMatch[1], answer: pairMatch[2] });
							}

							if (pairs.length > 0 && questionsArr.length > 0) {
								// Build answers array aligned with questions
								answers = questionsArr.map(q => {
									const pair = pairs.find(p => p.question === q.question);
									if (!pair) return [];
									// Split comma-separated values and return ALL parts
									// (QuestionCard separates option labels from custom text itself)
									return pair.answer
										.split(', ')
										.map(s => s.trim())
										.filter(Boolean);
								});
							} else if (content.trim()) {
								answers = [[content.trim()]];
							}
						}
					} else if (Array.isArray(content)) {
						answers = content as string[][];
					} else if (content && typeof content === 'object') {
						const obj = content as Record<string, unknown>;
						if (Array.isArray(obj.answers)) {
							answers = obj.answers as string[][];
						}
					}

					// Post merge update with answers (mergeOrAddMessage will merge by ID)
					if (answers && answers.length > 0) {
						this.postSessionMessage(
							{
								id: `question-${toolUseId}`,
								type: 'question' as const,
								resolved: true,
								answers,
								timestamp: data.timestamp || new Date().toISOString(),
							},
							sessionId,
						);
					}
					continue;
				}

				if (options?.mode === 'parent' && toolName === 'task') {
					const graph = this.context.sessionGraph;
					const childSessionId = graph.getChildByTaskId(toolUseId);
					const subtaskDuration = childSessionId
						? options.childDurations?.get(childSessionId)
						: undefined;
					const childTokens = childSessionId
						? options.childTokensMap?.get(childSessionId)
						: undefined;
					const savedMeta = subtaskMeta.get(toolUseId);
					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							status: data.is_error ? 'error' : 'completed',
							result: String(data.content || ''),
							timestamp: data.timestamp || new Date().toISOString(),
							...(subtaskDuration ? { durationMs: subtaskDuration } : {}),
							...(childTokens ? { childTokens } : {}),
							...(savedMeta ?? {}),
						},
						sessionId,
					);
					continue;
				}

				this.postSessionMessage(
					mapToolResultEvent(data, { idPrefix: 'hist', normalizedEntry: event.normalizedEntry }),
					sessionId,
				);
				continue;
			}

			// Replay per-turn token stats so the UI shows real token counts
			if (event.type === 'turn_tokens') {
				this.postTurnTokens(event.data, sessionId);
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
				this.clearPendingMessage(sessionId);

				// Clean up restore/revert state for deleted session
				this.context.cleanupSessionRestore?.(sessionId);

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
			const sendConfig = this.buildSendConfig();
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
		client: import('@opencode-ai/sdk').OpencodeClient;
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
		const { data: sessionData, error: createError } = await client.session.create({ signal });
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
			const { data, error } = await client.session.prompt({
				path: { id: sessionId },
				query: { directory },
				body: {
					parts: [{ type: 'text', text: fullText }],
					...(modelOverride ? { model: modelOverride } : {}),
				},
				signal,
			});

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

	private buildSendConfig(uiModel?: string): CLIConfig {
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
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			autoApprove: Boolean(
				this.context.settings.get('access.autoApprove') ||
					this.context.settings.get('access.yoloMode') ||
					false,
			),
			policies: this.context.getPermissionPolicies?.() as
				| Partial<Record<string, string>>
				| undefined,
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

	/**
	 * Build a transcript array from child session history events.
	 * Used during replay to inline child messages into the parent subtask card.
	 */
	private buildTranscriptFromHistory(
		history: CLIEvent[],
	): import('../../common').SessionMessageData[] {
		return buildTranscript(history, 'child');
	}

	/** Check if a tool name corresponds to a file-editing operation */
	private isFileEditTool(toolName: string): boolean {
		return isFileEditTool(toolName);
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
