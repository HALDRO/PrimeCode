import * as vscode from 'vscode';
import type {
	CommitInfo,
	ConversationIndexEntry,
	OpenCodeProviderData,
	SessionEventPayload,
	SessionEventType,
	SessionSubtaskPayload,
	SessionTodoItem,
	SessionUserMessagePayload,
	TotalStats,
} from '../../common';
import { generateId, parseModelId } from '../../common';
import { IMPROVE_PROMPT_DEFAULT_TEMPLATE } from '../../common/promptImprover';
import type { CommandOf, QueuedMessageData, WebviewCommand } from '../../common/protocol';
import { parseSessionTodoItem, parseSessionUpdatedRuntimePayload } from '../../common/schemas';
import {
	computeDiffLineStats,
	extractPatchFilePaths,
	isFileEditTool,
	resolveToolName,
} from '../../common/toolRegistry';
import { LogNormalizer } from '../../core/executor/LogNormalizer';
import {
	mapSdkMessageToRecord,
	mapSdkPartToPayload,
} from '../../core/executor/OpenCodeEventMapper';
import type { CLIConfig, CLIEvent } from '../../core/executor/types';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

type CanonicalSdkMessage = Parameters<typeof mapSdkMessageToRecord>[0];
type CanonicalSdkPart = Parameters<typeof mapSdkPartToPayload>[0];
type ReplayChildTokens = { input: number; output: number; total: number; cacheRead: number };
type ReplayTurnTokens = {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	durationMs?: number;
};
type ReplayBuildOptions = {
	mode?: 'default' | 'parent';
	parentSessionId?: string;
	childDurations?: Map<string, number>;
	childHistories?: Map<string, CLIEvent[]>;
	childTokensMap?: Map<string, ReplayChildTokens>;
	childModelIdMap?: Map<string, string>;
};

type SessionReplayAction =
	| {
			kind: 'event';
			targetId: string;
			eventType: SessionEventType;
			payload: SessionEventPayload;
			normalizedEntry?: CLIEvent['normalizedEntry'];
	  }
	| {
			kind: 'session_updated';
			targetId: string;
			data: unknown;
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
	/** Sessions currently replaying history to avoid duplicate restore work. */
	private replayingSessions = new Map<string, Promise<void>>();

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

	constructor(private context: HandlerContext) {}

	private static extractFilePath(input: Record<string, unknown>): string | undefined {
		if (typeof input.filePath === 'string') return input.filePath;
		if (typeof input.file_path === 'string') return input.file_path;
		if (typeof input.path === 'string') return input.path;
		return undefined;
	}

	private static getFieldValue(
		obj: Record<string, unknown>,
		keys: string[],
		fallback = '',
	): string {
		for (const key of keys) {
			if (typeof obj[key] === 'string') return obj[key] as string;
		}
		return fallback;
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
				hasStats: !!parsed.totalStats,
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

		const totalStatsPatch = parsed.totalStats as Partial<TotalStats> | undefined;

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
			modelID: parsed.modelID,
			providerID: parsed.providerID,
		});
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
			revert?: { messageID: string; partID?: string };
		}>,
	): Promise<void> {
		const inFlight = this.replayingSessions.get(sessionId);
		if (inFlight) {
			await inFlight;
			return;
		}

		const replayPromise = this.doReplaySessionFromCLI(sessionId, config, cachedSessions);
		this.replayingSessions.set(sessionId, replayPromise);
		try {
			await replayPromise;
		} finally {
			this.replayingSessions.delete(sessionId);
		}
	}

	private async doReplaySessionFromCLI(
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
		if (sdkClient) {
			await this.restoreSessionFromCanonicalSnapshot(sessionId, config, cachedSessions);
			return;
		}

		const graph = this.context.sessionGraph;

		const allSessions = cachedSessions ?? (await this.context.cli.listSessions(config));

		// Extract task toolUseId → childSessionId links from parent history metadata.
		// listSessions() returns roots-only, so we cannot rely on allSessions to find children.
		// Instead, trust metadata.sessionId from task tool_result events directly.
		const parentHistory = await this.context.cli.getHistory(sessionId, config);
		const explicitLinks = new Map<string, string>(); // toolUseId → childSessionId

		for (const ev of parentHistory) {
			if (ev.type === 'tool_result') {
				const d = ev.data as {
					tool?: string;
					tool_use_id?: string;
					metadata?: { sessionId?: string };
					content?: string;
				};
				if (d.tool === 'task' && d.tool_use_id) {
					const metaSessionId = d.metadata?.sessionId;
					if (metaSessionId) {
						explicitLinks.set(d.tool_use_id, metaSessionId);
					}
				}
			}
		}

		// Build childSessions from explicitLinks (authoritative) merged with allSessions fallback
		const linkedChildIds = new Set(explicitLinks.values());
		const childSessionsFromList = allSessions
			.filter(s => s.parentID === sessionId)
			.sort((a, b) => (a.created || 0) - (b.created || 0));
		// Merge: all linked IDs + any from allSessions not yet included
		const allChildIds = new Set(linkedChildIds);
		for (const s of childSessionsFromList) allChildIds.add(s.id);
		const childSessions = [...allChildIds].map(id => {
			const fromList = childSessionsFromList.find(s => s.id === id);
			return {
				id,
				title: fromList?.title,
				created: fromList?.created,
				lastModified: fromList?.lastModified,
			};
		});

		// Register explicit links in SessionGraph
		for (const [toolUseId, childId] of explicitLinks) {
			graph.registerChild(childId, sessionId, toolUseId);
		}

		// Pre-load ALL child histories in parallel (instead of sequential loop).
		// Child events are aggregated into parent subtask transcripts (no separate buckets).
		const childHistories = new Map<string, CLIEvent[]>();
		const childDurations = new Map<string, number>();
		const childTokensMap = new Map<
			string,
			{ input: number; output: number; total: number; cacheRead: number }
		>();
		const childModelIdMap = new Map<string, string>();

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
					const childSession = childSessions.find(child => child.id === id);
					const duration = this.computeChildSessionDuration(history, {
						fallbackCreatedAt: childSession?.created,
						fallbackUpdatedAt: childSession?.lastModified,
					});
					if (typeof duration === 'number' && duration > 0) {
						childDurations.set(id, duration);
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

					// Extract modelID from child session_updated events
					for (const ev of history) {
						if (ev.type === 'session_updated') {
							const rec = ev.data as Record<string, unknown> | undefined;
							const mid = rec && typeof rec.modelID === 'string' ? rec.modelID : undefined;
							if (mid) {
								childModelIdMap.set(id, mid);
							}
						}
					}
				}
			}
		}

		// Batch all replay messages into a single postMessage to reduce overhead.
		// startCollect() buffers session_event messages; flushCollected() sends them as one batch.
		// Use server-side revert state (source of truth) instead of persisted workspaceState.
		// The CLI session object has a `revert` field that tracks the real revert point.
		const currentSession = allSessions.find(s => s.id === sessionId);
		const serverRevert = currentSession?.revert;

		const actions: SessionReplayAction[] = [];
		// Surface child sessions as subtask cards if parent history is compacted
		if (explicitLinks.size === 0 && childSessions.length > 0) {
			for (const child of childSessions) {
				const duration = childDurations.get(child.id);
				const childTokens = childTokensMap.get(child.id);
				actions.push({
					kind: 'event',
					targetId: sessionId,
					eventType: 'subtask',
					payload: {
						eventType: 'subtask',
						subtask: {
							id: `hist-subtask-${child.id}`,
							agent: 'subagent',
							prompt: '',
							description: child.title || 'Subtask',
							status: 'completed',
							timestamp: new Date().toISOString(),
							...(duration ? { durationMs: duration } : {}),
							...(childTokens ? { childTokens } : {}),
							...(childModelIdMap.get(child.id)
								? { childModelId: childModelIdMap.get(child.id) }
								: {}),
						},
					},
				});
			}
		}

		// Replay parent history, using graph for task→child resolution
		if (parentHistory.length > 0) {
			logger.info(
				`[SessionHandler] Replaying ${parentHistory.length} events for session ${sessionId}`,
			);
			actions.push(
				...this.buildHistoryReplayActions(sessionId, parentHistory, {
					mode: 'parent',
					parentSessionId: sessionId,
					childDurations,
					childHistories,
					childTokensMap,
					childModelIdMap,
				}),
			);
		}

		this.emitReplayActions(actions);

		// Official OpenCode keeps session diff as separate session-scoped data,
		// not as part of the regular message history. Restore it explicitly after
		// replaying the session timeline so the webview gets the current diff state.
		await this.restoreSessionDiffFromServer(sessionId, config);
		await this.restoreSessionRuntimeStateFromServer(sessionId, config);

		// After replay is flushed, restore revert state using the server's revert field
		// (source of truth). The CLI session object has a `revert.messageID` that tracks
		// the exact revert point. This replaces the old workspaceState-based approach
		// which could become stale and cause phantom UnRevert buttons.
		if (serverRevert?.messageID) {
			const revertUserMessageId = this.findReplayedUserMessageIdInHistory(
				parentHistory,
				serverRevert.messageID,
			);

			if (revertUserMessageId) {
				this.context.bridge.emit(sessionId, 'restore', {
					action: 'success',
					canUnrevert: true,
					revertedFromMessageId: revertUserMessageId,
				});
				logger.info('[SessionHandler] Restored revert state from server', {
					sessionId,
					revertedFromMessageId: revertUserMessageId,
					serverRevertMessageId: serverRevert.messageID,
				});
			} else {
				logger.warn(
					'[SessionHandler] Skipping revert state restore: message not present in replayed history',
					{
						sessionId,
						serverRevertMessageId: serverRevert.messageID,
					},
				);
			}
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
			throw new Error('OpenCode SDK client unavailable for canonical snapshot restore');
		}

		const allSessions = cachedSessions ?? (await this.context.cli.listSessions(config));
		const currentSession = allSessions.find(s => s.id === sessionId);

		const parentHistory = await this.context.cli.getHistory(sessionId, config);
		const explicitLinks = this.extractExplicitTaskLinks(parentHistory, sessionId);
		const childSessionIds = new Set<string>(explicitLinks.values());
		for (const child of allSessions.filter(s => s.parentID === sessionId)) {
			childSessionIds.add(child.id);
		}

		const { childHistories, childDurations, childTokensMap, childModelIdMap } =
			await this.collectChildSessionStats(childSessionIds, allSessions, config);

		const messagesResult = await sdkClient.session.messages({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});
		const diffResult = await sdkClient.session.diff({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});

		if (messagesResult.error) {
			throw new Error(
				`Failed to fetch canonical session messages: ${JSON.stringify(messagesResult.error)}`,
			);
		}

		const entries = messagesResult.data ?? [];
		const parentTurnTokens = this.buildTurnTokenMap(parentHistory, entries);
		const childResults = await Promise.all(
			[...childSessionIds].map(async childSessionId => ({
				childSessionId,
				childHistory: childHistories.get(childSessionId) ?? [],
				childMessagesResult: await sdkClient.session.messages({
					sessionID: childSessionId,
					directory: config.workspaceRoot,
				}),
			})),
		);

		const childSnapshots = new Map<
			string,
			{
				messages: Array<SessionUserMessagePayload['message'] | SessionSubtaskPayload['subtask']>;
				runtimeMessageRecords: import('../../common').SessionMessageRecordPayload['message'][];
				runtimeMessageParts: import('../../common').SessionMessagePartPayload['part'][];
				changedFiles: Array<{
					filePath: string;
					fileName: string;
					linesAdded: number;
					linesRemoved: number;
					toolUseId: string;
					timestamp: number;
				}>;
				cumulativeDiffs: Array<{
					file: string;
					additions: number;
					deletions: number;
					status?: 'added' | 'deleted' | 'modified';
				}>;
				todos?: SessionTodoItem[];
				turnTokens: Record<
					string,
					{ input: number; output: number; total?: number; cacheRead?: number; durationMs?: number }
				>;
				restoreCommits: CommitInfo[];
			}
		>();
		for (const { childSessionId, childHistory, childMessagesResult } of childResults) {
			if (childMessagesResult.error) {
				logger.warn(
					'[SessionHandler] Failed to fetch canonical child session messages, falling back to history replay',
					{
						sessionId: childSessionId,
						error: childMessagesResult.error,
					},
				);
				if (childHistory.length > 0) {
					const fallbackActions = this.buildHistoryReplayActions(childSessionId, childHistory, {
						mode: 'default',
					});
					this.emitReplayActions(fallbackActions);
				}
				continue;
			}

			const childEntries = childMessagesResult.data ?? [];
			if (childEntries.length > 0) {
				const canonicalDuration = this.computeCanonicalSessionDuration(childEntries);
				if (typeof canonicalDuration === 'number' && canonicalDuration > 0) {
					childDurations.set(childSessionId, canonicalDuration);
				}
				const childTurnTokens = this.buildTurnTokenMap(childHistory, childEntries);
				childSnapshots.set(
					childSessionId,
					this.buildCanonicalSessionSnapshot(childSessionId, childEntries, childTurnTokens, {
						workspaceSessionId: childSessionId,
					}),
				);
				continue;
			}

			if (childHistory.length > 0) {
				const fallbackActions = this.buildHistoryReplayActions(childSessionId, childHistory, {
					mode: 'default',
				});
				this.emitReplayActions(fallbackActions);
			}
		}

		for (const [childSessionId, snapshot] of childSnapshots) {
			this.context.bridge.emit(childSessionId, 'messages_reload', {
				messages: snapshot.messages,
				runtimeMessageRecords: snapshot.runtimeMessageRecords,
				runtimeMessageParts: snapshot.runtimeMessageParts,
				changedFiles: snapshot.changedFiles,
				cumulativeDiffs: snapshot.cumulativeDiffs,
				turnTokens: snapshot.turnTokens,
				restoreCommits: snapshot.restoreCommits,
			});
			if (snapshot.todos) {
				this.context.bridge.emit(childSessionId, 'todo', { todos: snapshot.todos });
			}
		}

		const snapshot = this.buildCanonicalSessionSnapshot(sessionId, entries, parentTurnTokens, {
			workspaceSessionId: sessionId,
			explicitLinks,
			childDurations,
			childTokensMap,
			childModelIdMap,
		});
		this.context.bridge.emit(sessionId, 'messages_reload', {
			messages: snapshot.messages,
			runtimeMessageRecords: snapshot.runtimeMessageRecords,
			runtimeMessageParts: snapshot.runtimeMessageParts,
			changedFiles: snapshot.changedFiles,
			cumulativeDiffs: diffResult.data
				? diffResult.data.map(entry => ({
						file: entry.file,
						additions: entry.additions || 0,
						deletions: entry.deletions || 0,
						status: entry.status as 'added' | 'deleted' | 'modified' | undefined,
					}))
				: snapshot.cumulativeDiffs,
			turnTokens: snapshot.turnTokens,
			restoreCommits: snapshot.restoreCommits,
		});
		if (snapshot.todos) {
			this.context.bridge.emit(sessionId, 'todo', { todos: snapshot.todos });
		}

		void this.restoreSessionCounterStateFromHistory(sessionId, config).catch(error =>
			logger.warn(
				'[SessionHandler] Failed to restore session counter state after canonical replay',
				{
					sessionId,
					error,
				},
			),
		);
		void this.restoreSessionDiffFromServer(sessionId, config).catch(error =>
			logger.warn('[SessionHandler] Failed to restore session diff after canonical replay', {
				sessionId,
				error,
			}),
		);
		void this.restoreSessionRuntimeStateFromServer(sessionId, config).catch(error =>
			logger.warn(
				'[SessionHandler] Failed to restore session runtime state after canonical replay',
				{
					sessionId,
					error,
				},
			),
		);

		if (
			currentSession?.revert?.messageID &&
			this.hasCanonicalUserMessage(entries, currentSession.revert.messageID)
		) {
			this.context.bridge.emit(sessionId, 'restore', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: currentSession.revert.messageID,
			});
		} else if (currentSession?.revert?.messageID) {
			logger.warn(
				'[SessionHandler] Skipping canonical revert state restore: message not present in canonical entries',
				{
					sessionId,
					serverRevertMessageId: currentSession.revert.messageID,
				},
			);
		}
	}

	private extractCanonicalUserAttachments(
		parts: CanonicalSdkPart[],
	): SessionUserMessagePayload['message']['attachments'] | undefined {
		const files: string[] = [];
		const codeSnippets: NonNullable<
			NonNullable<SessionUserMessagePayload['message']['attachments']>['codeSnippets']
		> = [];
		const images: NonNullable<
			NonNullable<SessionUserMessagePayload['message']['attachments']>['images']
		> = [];

		for (const part of parts) {
			if (part.type !== 'file') continue;

			const mime = 'mime' in part && typeof part.mime === 'string' ? part.mime : undefined;
			const filename =
				'filename' in part && typeof part.filename === 'string' ? part.filename : 'image';
			const url = 'url' in part && typeof part.url === 'string' ? part.url : undefined;
			const source =
				'source' in part && part.source && typeof part.source === 'object'
					? part.source
					: undefined;

			if (mime?.startsWith('image/') && url) {
				images.push({
					id: `img-${Math.random().toString(36).slice(2, 9)}`,
					name: filename,
					dataUrl: url,
					...(source && 'path' in source && typeof source.path === 'string'
						? { path: source.path }
						: {}),
				});
				continue;
			}

			if (source && 'path' in source && typeof source.path === 'string') {
				const sourceText =
					'text' in source && source.text && typeof source.text === 'object'
						? source.text
						: undefined;
				const startLine =
					sourceText && 'start' in sourceText && typeof sourceText.start === 'number'
						? sourceText.start
						: undefined;
				const endLine =
					sourceText && 'end' in sourceText && typeof sourceText.end === 'number'
						? sourceText.end
						: undefined;
				const content =
					sourceText && 'value' in sourceText && typeof sourceText.value === 'string'
						? sourceText.value
						: undefined;

				if (typeof startLine === 'number' && typeof endLine === 'number' && content) {
					codeSnippets.push({
						filePath: source.path,
						content,
						startLine,
						endLine,
					});
				} else {
					files.push(source.path);
				}
				continue;
			}

			if (url) {
				try {
					const parsed = new URL(url);
					files.push(decodeURIComponent(parsed.pathname).replace(/^\//, ''));
				} catch {
					const filePath = url.startsWith('file://') ? url.replace('file://', '') : url;
					files.push(decodeURIComponent(filePath));
				}
			}
		}

		if (files.length === 0 && codeSnippets.length === 0 && images.length === 0) {
			return undefined;
		}

		return {
			...(files.length > 0 ? { files } : {}),
			...(codeSnippets.length > 0 ? { codeSnippets } : {}),
			...(images.length > 0 ? { images } : {}),
		};
	}

	private extractExplicitTaskLinks(
		history: CLIEvent[],
		parentSessionId: string,
	): Map<string, string> {
		const explicitLinks = new Map<string, string>();
		for (const ev of history) {
			if (ev.type !== 'tool_result') continue;
			const d = ev.data as {
				tool?: string;
				tool_use_id?: string;
				metadata?: { sessionId?: string };
			};
			if (d.tool === 'task' && d.tool_use_id && d.metadata?.sessionId) {
				explicitLinks.set(d.tool_use_id, d.metadata.sessionId);
				this.context.sessionGraph.registerChild(
					d.metadata.sessionId,
					parentSessionId,
					d.tool_use_id,
				);
			}
		}
		return explicitLinks;
	}

	private async collectChildSessionStats(
		childSessionIds: Set<string>,
		allSessions: Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<{
		childHistories: Map<string, CLIEvent[]>;
		childDurations: Map<string, number>;
		childTokensMap: Map<
			string,
			{ input: number; output: number; total: number; cacheRead: number }
		>;
		childModelIdMap: Map<string, string>;
	}> {
		const childHistories = new Map<string, CLIEvent[]>();
		const childDurations = new Map<string, number>();
		const childTokensMap = new Map<
			string,
			{ input: number; output: number; total: number; cacheRead: number }
		>();
		const childModelIdMap = new Map<string, string>();

		if (childSessionIds.size === 0) {
			return { childHistories, childDurations, childTokensMap, childModelIdMap };
		}

		const childHistoryResults = await Promise.all(
			[...childSessionIds].map(async childId => ({
				id: childId,
				history: await this.context.cli.getHistory(childId, config),
			})),
		);

		for (const { id, history } of childHistoryResults) {
			childHistories.set(id, history);
			if (history.length === 0) continue;
			const childSession = allSessions.find(session => session.id === id);
			const duration = this.computeChildSessionDuration(history, {
				fallbackCreatedAt: childSession?.created,
				fallbackUpdatedAt: childSession?.lastModified,
			});
			if (typeof duration === 'number' && duration > 0) childDurations.set(id, duration);

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
				if (ev.type === 'session_updated') {
					const rec = ev.data as Record<string, unknown> | undefined;
					const mid = rec && typeof rec.modelID === 'string' ? rec.modelID : undefined;
					if (mid) childModelIdMap.set(id, mid);
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

		return { childHistories, childDurations, childTokensMap, childModelIdMap };
	}

	private computeChildSessionDuration(
		history: CLIEvent[],
		fallbacks?: { fallbackCreatedAt?: number; fallbackUpdatedAt?: number },
	): number | undefined {
		if (
			typeof fallbacks?.fallbackCreatedAt === 'number' &&
			typeof fallbacks?.fallbackUpdatedAt === 'number' &&
			fallbacks.fallbackUpdatedAt > fallbacks.fallbackCreatedAt
		) {
			return fallbacks.fallbackUpdatedAt - fallbacks.fallbackCreatedAt;
		}

		let earliestTs: number | undefined;
		let latestTs: number | undefined;

		for (const ev of history) {
			const rawTs = (ev.data as { timestamp?: string | number } | undefined)?.timestamp;
			const ts =
				typeof rawTs === 'number'
					? rawTs
					: typeof rawTs === 'string'
						? new Date(rawTs).getTime()
						: Number.NaN;
			if (!Number.isFinite(ts) || ts <= 0) continue;
			earliestTs = earliestTs === undefined ? ts : Math.min(earliestTs, ts);
			latestTs = latestTs === undefined ? ts : Math.max(latestTs, ts);
		}

		const start = earliestTs;
		const end = latestTs;
		if (typeof start !== 'number' || typeof end !== 'number' || end <= start) {
			return undefined;
		}
		return end - start;
	}

	private computeCanonicalSessionDuration(
		entries: Array<{ info: CanonicalSdkMessage; parts: CanonicalSdkPart[] }>,
	): number | undefined {
		let earliestTs: number | undefined;
		let latestTs: number | undefined;

		for (const entry of entries) {
			const created = entry.info.time?.created;
			const completed = Reflect.get(entry.info.time as object, 'completed');
			if (typeof created === 'number' && created > 0) {
				earliestTs = earliestTs === undefined ? created : Math.min(earliestTs, created);
				latestTs = latestTs === undefined ? created : Math.max(latestTs, created);
			}
			if (typeof completed === 'number' && completed > 0) {
				latestTs = latestTs === undefined ? completed : Math.max(latestTs, completed);
			}

			for (const part of entry.parts) {
				const partTime =
					'time' in part && part.time && typeof part.time === 'object'
						? (part.time as { start?: number; end?: number; created?: number })
						: undefined;
				for (const ts of [partTime?.created, partTime?.start, partTime?.end]) {
					if (typeof ts !== 'number' || ts <= 0) continue;
					earliestTs = earliestTs === undefined ? ts : Math.min(earliestTs, ts);
					latestTs = latestTs === undefined ? ts : Math.max(latestTs, ts);
				}
			}
		}

		if (typeof earliestTs !== 'number' || typeof latestTs !== 'number' || latestTs <= earliestTs) {
			return undefined;
		}
		return latestTs - earliestTs;
	}

	private mapCanonicalTaskPartToSubtask(
		part: {
			id?: string;
			callID?: string;
			tool?: string;
			state?: unknown;
		},
		info: { id: string; time?: { created?: number } },
		partTime: { start?: number; end?: number; created?: number } | undefined,
		sessionId: string,
		explicitLinks: Map<string, string>,
		childDurations: Map<string, number>,
		childTokensMap: Map<
			string,
			{ input: number; output: number; total: number; cacheRead: number }
		>,
		childModelIdMap: Map<string, string>,
	): SessionSubtaskPayload['subtask'] | undefined {
		if (part.tool !== 'task') return undefined;

		const taskState =
			part.state && typeof part.state === 'object' ? (part.state as Record<string, unknown>) : {};
		const taskInput =
			taskState.input && typeof taskState.input === 'object'
				? (taskState.input as Record<string, unknown>)
				: {};
		const toolUseId = typeof part.callID === 'string' ? part.callID : part.id || info.id;
		const childSessionId =
			taskState.metadata &&
			typeof taskState.metadata === 'object' &&
			typeof (taskState.metadata as Record<string, unknown>).sessionId === 'string'
				? ((taskState.metadata as Record<string, unknown>).sessionId as string)
				: explicitLinks.get(toolUseId);

		return {
			id: toolUseId,
			partId: toolUseId,
			toolUseId,
			toolName: part.tool,
			agent: typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : 'subagent',
			prompt: typeof taskInput.prompt === 'string' ? taskInput.prompt : '',
			description: typeof taskInput.description === 'string' ? taskInput.description : 'Subtask',
			status:
				taskState.status === 'completed'
					? 'completed'
					: taskState.status === 'error'
						? 'error'
						: 'running',
			...(typeof taskState.output === 'string' ? { result: taskState.output } : {}),
			parentSessionId: sessionId,
			...(childSessionId ? { childSessionId } : {}),
			toolInput: Object.keys(taskInput).length > 0 ? JSON.stringify(taskInput) : '',
			rawInput: taskInput,
			isRunning: taskState.status !== 'completed' && taskState.status !== 'error',
			timestamp:
				typeof partTime?.start === 'number'
					? new Date(partTime.start).toISOString()
					: typeof info.time?.created === 'number'
						? new Date(info.time.created).toISOString()
						: new Date().toISOString(),
			startTime:
				typeof partTime?.start === 'number' ? new Date(partTime.start).toISOString() : undefined,
			...(childSessionId && childDurations.get(childSessionId)
				? { durationMs: childDurations.get(childSessionId) }
				: {}),
			...(childSessionId && childTokensMap.get(childSessionId)
				? { childTokens: childTokensMap.get(childSessionId) }
				: {}),
			...(childSessionId && childModelIdMap.get(childSessionId)
				? { childModelId: childModelIdMap.get(childSessionId) }
				: {}),
		};
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
			this.context.bridge.emit(newSessionId, 'status', {
				status: 'idle',
				statusText: 'Ready',
			});
			this.initializeSessionStats(newSessionId);
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
		this.postLifecycle('switched', sessionId, { isProcessing: isActive });
		this.initializeSessionStats(sessionId);
		await this.persistAddTab(sessionId);

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

		if (this.replayedSessions.has(sessionId)) {
			this.context.bridge.emit(sessionId, 'session_info', {
				data: {
					sessionId,
					autoAccept: this.context.getSessionAutoAccept?.(sessionId) ?? false,
				},
			});
			return;
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
		this.replayedSessions.delete(sessionId);
		this.replayingSessions.delete(sessionId);
		this.clearSessionStats(sessionId);
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
		);
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
				undefined,
				entry.attachments,
				entry.agent,
				entry.variant,
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
		variant?: string,
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
		this.context.bridge.emit(targetId, 'notification', {
			notification: {
				id: `interrupted-${Date.now()}`,
				type: 'interrupted',
				content: 'Stopped by user',
				timestamp: new Date().toISOString(),
			},
		});

		// Also force idle on child sessions (subagents) of the target session only
		for (const sid of sessionsToStop) {
			if (sid !== targetId) {
				const toolUseId = this.context.sessionGraph.getEntry(sid)?.taskToolCallId;
				const parentSessionId = this.context.sessionGraph.getParent(sid);
				if (toolUseId && parentSessionId) {
					this.context.bridge.emit(parentSessionId, 'subtask', {
						subtask: {
							id: toolUseId,
							agent: 'subagent',
							prompt: '',
							description: 'Subtask',
							status: 'cancelled',
							childSessionId: sid,
							parentSessionId,
							timestamp: new Date().toISOString(),
						},
					});
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
	): Promise<void> {
		// Clear stop guard for the target session — user is explicitly sending
		// a new message, so SSE 'busy' events should be allowed through again.
		const targetSessionForGuard = explicitSessionId || this.context.sessionState.activeSessionId;
		if (targetSessionForGuard) {
			this.context.sessionState.clearStopGuard(targetSessionForGuard);
		}

		const config = this.buildSendConfig(uiModel);
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
				this.initializeSessionStats(newSessionId);

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
				if (editMode === 'history_only') {
					logger.info('[SessionHandler] Editing message: prune history without workspace revert', {
						messageId: messageIdToTruncate,
					});
					await this.context.cli.deleteSessionMessagesFrom?.(activeId, messageIdToTruncate, config);
				} else {
					logger.info('[SessionHandler] Editing message: revert then resend', {
						messageId: messageIdToTruncate,
					});
					await this.context.cli.truncateSession(activeId, messageIdToTruncate, config);
				}
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
			this.context.bridge.emit(
				activeId,
				'user_message',
				{
					message: {
						id: userMessageId,
						content: text,
						model: config.model,
						...(config.agent ? { agent: config.agent } : {}),
						timestamp: new Date().toISOString(),
						normalizedEntry: this.logNormalizer.normalizeMessage(text, 'user'),
						...(hasAttachments ? { attachments } : {}),
					},
				},
				{ normalizedEntry: this.logNormalizer.normalizeMessage(text, 'user') },
			);

			this.emitCheckpointForUserMessage(
				activeId,
				userMessageId,
				new Date().toISOString(),
				isOpenCode,
			);

			this.context.bridge.emit(activeId, 'status', {
				status: 'busy',
				statusText: 'Working...',
			});
			this.initializeSessionStats(activeId);

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
			);

			if (activeId) {
				this.context.sessionState.startedSessions.delete(activeId);
				this.sessionTotalsByUiSession.delete(activeId);
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
			this.postLifecycle('switched', sessionId, { isProcessing: isBusy });
			await this.persistAddTab(sessionId);
			return;
		}

		logger.info('[SessionHandler] Loading conversation', { sessionId });

		// Set active session and mark as started so follow-up messages reuse it
		this.context.sessionState.activeSessionId = sessionId;
		this.context.sessionState.startedSessions.add(sessionId);
		this.postLifecycle('created', sessionId);
		// New conversations are never busy — they haven't been sent to yet
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.initializeSessionStats(sessionId);
		await this.persistAddTab(sessionId);

		try {
			const config = this.buildBaseConfig();
			await this.replaySessionFromCLI(sessionId, config);
			this.replayedSessions.add(sessionId);
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

	private emitReplayActions(actions: SessionReplayAction[]): void {
		if (actions.length === 0) return;
		this.context.bridge.startCollect();
		try {
			for (const action of actions) {
				if (action.kind === 'session_updated') {
					this.handleSessionUpdatedEvent(action.data, action.targetId);
					continue;
				}
				this.context.bridge.emit(action.targetId, action.eventType, action.payload, {
					...(action.normalizedEntry ? { normalizedEntry: action.normalizedEntry } : {}),
				});
			}
		} finally {
			this.context.bridge.flushCollected();
		}
	}

	private pushReplayEvent<T extends SessionEventType>(
		actions: SessionReplayAction[],
		targetId: string,
		eventType: T,
		payload: Extract<SessionEventPayload, { eventType: T }>,
		normalizedEntry?: CLIEvent['normalizedEntry'],
	): void {
		actions.push({
			kind: 'event',
			targetId,
			eventType,
			payload,
			...(normalizedEntry ? { normalizedEntry } : {}),
		});
	}

	private pushReplaySessionUpdated(
		actions: SessionReplayAction[],
		targetId: string,
		data: unknown,
	): void {
		actions.push({ kind: 'session_updated', targetId, data });
	}

	private extractTodoSnapshot(raw: unknown): SessionTodoItem[] | undefined {
		if (!Array.isArray(raw) || raw.length === 0) return undefined;
		const todos = raw.flatMap((item, index) => {
			const parsed = parseSessionTodoItem(item);
			if (parsed) return [parsed];
			if (!item || typeof item !== 'object') return [];
			const record = item as Record<string, unknown>;
			const content = typeof record.content === 'string' ? record.content : undefined;
			if (!content) return [];
			return [
				{
					id: typeof record.id === 'string' ? record.id : `todo-${index}-${content}`,
					content,
					status:
						record.status === 'completed' ||
						record.status === 'in_progress' ||
						record.status === 'cancelled'
							? record.status
							: 'pending',
					priority: typeof record.priority === 'string' ? record.priority : 'medium',
				} satisfies SessionTodoItem,
			];
		});
		return todos.length > 0 ? todos : undefined;
	}

	private extractTodoSnapshotFromToolInput(input: unknown): SessionTodoItem[] | undefined {
		if (!input || typeof input !== 'object') return undefined;
		return this.extractTodoSnapshot((input as { todos?: unknown }).todos);
	}

	private pushReplayCheckpoint(
		actions: SessionReplayAction[],
		targetId: string,
		messageId: string,
		timestamp: string,
	): void {
		const commitId = generateId('checkpoint');
		this.context.registerCheckpoint?.(commitId, {
			sessionId: targetId,
			messageId,
			associatedMessageId: messageId,
			isOpenCode: true,
		});
		this.pushReplayEvent(actions, targetId, 'restore', {
			eventType: 'restore',
			action: 'add_commit',
			commit: {
				id: commitId,
				sha: commitId,
				message: 'Checkpoint before message',
				timestamp,
				associatedMessageId: messageId,
			},
		});
	}

	private pushReplayFileActions(
		actions: SessionReplayAction[],
		sessionId: string,
		toolName: string,
		input: Record<string, unknown>,
		toolUseId: string,
		stats?: { added: number; removed: number },
	): void {
		const filePath = SessionHandler.extractFilePath(input);
		if (filePath && this.isFileEditTool(toolName)) {
			this.pushReplayEvent(actions, sessionId, 'file', {
				eventType: 'file',
				action: 'changed',
				filePath,
				fileName: filePath.split(/[/\\]/).pop() || filePath,
				linesAdded: stats?.added ?? 0,
				linesRemoved: stats?.removed ?? 0,
				toolUseId,
			});
			return;
		}
		if (resolveToolName(toolName) !== 'apply_patch') return;
		for (const patchPath of extractPatchFilePaths(input)) {
			this.pushReplayEvent(actions, sessionId, 'file', {
				eventType: 'file',
				action: 'changed',
				filePath: patchPath,
				fileName: patchPath.split(/[/\\]/).pop() || patchPath,
				linesAdded: 0,
				linesRemoved: 0,
				toolUseId,
			});
		}
	}

	private buildCanonicalUserReplayMessage(entry: {
		info: CanonicalSdkMessage;
		parts: CanonicalSdkPart[];
	}): Extract<SessionEventPayload, { eventType: 'user_message' }>['message'] {
		const { info, parts } = entry;
		const modelInfo = info as CanonicalSdkMessage & { model?: { modelID?: string } };
		const attachments = this.extractCanonicalUserAttachments(parts);
		const diffs =
			'summary' in info &&
			info.summary &&
			typeof info.summary === 'object' &&
			'diffs' in info.summary
				? info.summary.diffs
				: undefined;
		return {
			id: info.id,
			content: parts
				.filter(
					part => part.type === 'text' && !part.synthetic && !('ignored' in part && part.ignored),
				)
				.map(part => ('text' in part && typeof part.text === 'string' ? part.text : ''))
				.join(''),
			timestamp:
				typeof info.time?.created === 'number'
					? new Date(info.time.created).toISOString()
					: new Date().toISOString(),
			...(modelInfo.model?.modelID ? { model: modelInfo.model.modelID } : {}),
			...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
			...(diffs
				? {
						summary: {
							diffs: diffs.map(diff => ({
								file: diff.file,
								additions: diff.additions || 0,
								deletions: diff.deletions || 0,
							})),
						},
					}
				: {}),
			...(attachments ? { attachments } : {}),
		};
	}

	private buildHistoryNormalizedLogReplayActions(
		actions: SessionReplayAction[],
		sessionId: string,
		event: Extract<CLIEvent, { type: 'normalized_log' }>,
	): void {
		const data = event.data as {
			role?: string;
			content?: string;
			timestamp?: string;
			messageId?: string;
			model?: string;
			agent?: string;
			summary?: SessionUserMessagePayload['message']['summary'];
			attachments?: SessionUserMessagePayload['message']['attachments'];
		};
		if (data.role !== 'user') return;
		const messageId =
			data.messageId?.trim() || `msg-local-${Math.random().toString(36).slice(2, 9)}`;
		const timestamp = data.timestamp || new Date().toISOString();
		this.pushReplayEvent(actions, sessionId, 'message_record', {
			eventType: 'message_record',
			message: {
				id: messageId,
				sessionId,
				role: 'user',
				createdAt: new Date(timestamp).getTime(),
				...(data.model ? { modelId: data.model } : {}),
				...(data.agent ? { agent: data.agent } : {}),
			},
		});
		this.pushReplayEvent(
			actions,
			sessionId,
			'user_message',
			{
				eventType: 'user_message',
				message: {
					id: messageId,
					content: data.content || '',
					timestamp,
					...(data.model ? { model: data.model } : {}),
					...(data.agent ? { agent: data.agent } : {}),
					...(data.summary ? { summary: data.summary } : {}),
					...(data.attachments ? { attachments: data.attachments } : {}),
					...(event.normalizedEntry ? { normalizedEntry: event.normalizedEntry } : {}),
				},
			},
			event.normalizedEntry,
		);
		this.pushReplayCheckpoint(actions, sessionId, messageId, timestamp);
	}

	private buildHistoryTaskSubtaskReplayAction(
		actions: SessionReplayAction[],
		sessionId: string,
		toolUseId: string,
		meta: { description: string; prompt: string; agent: string },
		options: ReplayBuildOptions,
		timestamp?: string,
		result?: string,
		isError?: boolean,
		normalizedEntry?: CLIEvent['normalizedEntry'],
	): void {
		const childSessionId = this.context.sessionGraph.getChildByTaskId(toolUseId);
		this.pushReplayEvent(
			actions,
			sessionId,
			'subtask',
			{
				eventType: 'subtask',
				subtask: {
					id: toolUseId,
					...meta,
					...(typeof result === 'string' ? { result } : {}),
					...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
					...(childSessionId ? { childSessionId } : {}),
					status: isError ? 'error' : result === undefined ? 'running' : 'completed',
					timestamp: timestamp || new Date().toISOString(),
					...(result === undefined ? { startTime: timestamp } : {}),
					...(childSessionId && options.childDurations?.get(childSessionId)
						? { durationMs: options.childDurations.get(childSessionId) }
						: {}),
					...(childSessionId && options.childTokensMap?.get(childSessionId)
						? { childTokens: options.childTokensMap.get(childSessionId) }
						: {}),
					...(childSessionId && options.childModelIdMap?.get(childSessionId)
						? { childModelId: options.childModelIdMap.get(childSessionId) }
						: {}),
					...(normalizedEntry ? { normalizedEntry } : {}),
				},
			},
			normalizedEntry,
		);
	}

	private buildHistoryReplayActions(
		sessionId: string,
		history: CLIEvent[],
		options: ReplayBuildOptions = {},
	): SessionReplayAction[] {
		const actions: SessionReplayAction[] = [];
		const subtaskMeta = new Map<string, { description: string; prompt: string; agent: string }>();
		let latestTodos: SessionTodoItem[] | undefined;

		for (const event of history) {
			switch (event.type) {
				case 'normalized_log':
					this.buildHistoryNormalizedLogReplayActions(actions, sessionId, event);
					break;
				case 'turn_tokens':
					this.pushReplayEvent(
						actions,
						sessionId,
						'turn_tokens',
						event.data as Extract<SessionEventPayload, { eventType: 'turn_tokens' }>,
					);
					break;
				case 'session_updated':
					this.pushReplaySessionUpdated(actions, sessionId, event.data);
					break;
				case 'tool_use': {
					const data = event.data as {
						tool?: string;
						input?: unknown;
						toolUseId?: string;
						timestamp?: string;
					};
					const toolName = data.tool || 'unknown';
					if (resolveToolName(toolName) === 'todowrite') {
						latestTodos = this.extractTodoSnapshotFromToolInput(data.input) ?? latestTodos;
					}
					if (toolName.toLowerCase() === 'question') break;
					const input = (data.input as Record<string, unknown>) || {};
					const toolUseId = data.toolUseId || `hist-tool-${Math.random()}`;
					if (options.mode === 'parent' && toolName === 'task') {
						const meta = {
							agent: typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent',
							prompt: typeof input.prompt === 'string' ? input.prompt : '',
							description: typeof input.description === 'string' ? input.description : 'Subtask',
						};
						subtaskMeta.set(toolUseId, meta);
						this.buildHistoryTaskSubtaskReplayAction(
							actions,
							sessionId,
							toolUseId,
							meta,
							options,
							data.timestamp,
						);
						break;
					}
					this.pushReplayEvent(actions, sessionId, 'message_part', {
						eventType: 'message_part',
						part: {
							id: toolUseId,
							messageId: toolUseId,
							sessionId,
							type: 'tool',
							callId: toolUseId,
							toolName,
							state: { status: 'running', input },
							...(event.normalizedEntry ? { normalizedEntry: event.normalizedEntry } : {}),
						},
					});
					const oldContent = SessionHandler.getFieldValue(input, [
						'old_string',
						'old_str',
						'oldString',
					]);
					const newContent = SessionHandler.getFieldValue(input, [
						'new_string',
						'new_str',
						'newString',
						'content',
					]);
					this.pushReplayFileActions(
						actions,
						sessionId,
						toolName,
						input,
						toolUseId,
						computeDiffLineStats(String(oldContent), String(newContent)),
					);
					break;
				}
				case 'tool_result': {
					const data = event.data as {
						tool?: string;
						tool_use_id?: string;
						content?: unknown;
						input?: unknown;
						is_error?: boolean;
						metadata?: unknown;
						timestamp?: string;
					};
					const toolName = data.tool || 'unknown';
					if (toolName.toLowerCase() === 'question') break;
					const toolUseId = data.tool_use_id || `hist-tool-${Math.random()}`;
					if (options.mode === 'parent' && toolName === 'task') {
						const savedMeta = subtaskMeta.get(toolUseId);
						this.buildHistoryTaskSubtaskReplayAction(
							actions,
							sessionId,
							toolUseId,
							{
								agent: savedMeta?.agent || 'subagent',
								prompt: savedMeta?.prompt || '',
								description: savedMeta?.description || 'Subtask',
							},
							options,
							data.timestamp,
							String(data.content || ''),
							data.is_error,
							event.normalizedEntry,
						);
						break;
					}
					const metadata =
						resolveToolName(toolName) === 'apply_patch' &&
						data.metadata &&
						typeof data.metadata === 'object'
							? (data.metadata as Record<string, unknown>)
							: undefined;
					for (const entry of Array.isArray(metadata?.files) ? metadata.files : []) {
						if (!entry || typeof entry !== 'object') continue;
						const file = entry as Record<string, unknown>;
						const filePath =
							(typeof file.filePath === 'string' && file.filePath) ||
							(typeof file.relativePath === 'string' && file.relativePath) ||
							(typeof file.path === 'string' && file.path) ||
							'';
						if (!filePath) continue;
						this.pushReplayEvent(actions, sessionId, 'file', {
							eventType: 'file',
							action: 'changed',
							filePath,
							fileName: filePath.split(/[/\\]/).pop() || filePath,
							linesAdded: typeof file.additions === 'number' ? file.additions : 0,
							linesRemoved: typeof file.deletions === 'number' ? file.deletions : 0,
							toolUseId,
						});
					}
					this.pushReplayEvent(actions, sessionId, 'message_part', {
						eventType: 'message_part',
						part: {
							id: toolUseId,
							messageId: toolUseId,
							sessionId,
							type: 'tool',
							callId: toolUseId,
							toolName,
							state: {
								status: data.is_error ? 'error' : 'completed',
								input: data.input,
								output:
									typeof data.content === 'string'
										? data.content
										: JSON.stringify(data.content ?? ''),
								title:
									typeof (data as { title?: unknown }).title === 'string'
										? ((data as { title?: string }).title ?? undefined)
										: undefined,
								metadata: data.metadata,
							},
							...(event.normalizedEntry ? { normalizedEntry: event.normalizedEntry } : {}),
						},
					});
					break;
				}
				default:
					break;
			}
		}
		if (latestTodos) {
			this.pushReplayEvent(actions, sessionId, 'todo', {
				eventType: 'todo',
				todos: latestTodos,
			});
		}
		return actions;
	}

	private buildCanonicalSessionSnapshot(
		sessionId: string,
		entries: Array<{ info: CanonicalSdkMessage; parts: CanonicalSdkPart[] }>,
		turnTokensByUser: Map<string, ReplayTurnTokens>,
		options: {
			workspaceSessionId: string;
			explicitLinks?: Map<string, string>;
			childDurations?: Map<string, number>;
			childTokensMap?: Map<string, ReplayChildTokens>;
			childModelIdMap?: Map<string, string>;
		},
	): {
		messages: Array<SessionUserMessagePayload['message'] | SessionSubtaskPayload['subtask']>;
		runtimeMessageRecords: import('../../common').SessionMessageRecordPayload['message'][];
		runtimeMessageParts: import('../../common').SessionMessagePartPayload['part'][];
		changedFiles: Array<{
			filePath: string;
			fileName: string;
			linesAdded: number;
			linesRemoved: number;
			toolUseId: string;
			timestamp: number;
		}>;
		cumulativeDiffs: Array<{
			file: string;
			additions: number;
			deletions: number;
			status?: 'added' | 'deleted' | 'modified';
		}>;
		todos?: SessionTodoItem[];
		turnTokens: Record<
			string,
			{ input: number; output: number; total?: number; cacheRead?: number; durationMs?: number }
		>;
		restoreCommits: CommitInfo[];
	} {
		const messages: Array<SessionUserMessagePayload['message'] | SessionSubtaskPayload['subtask']> =
			[];
		const runtimeMessageRecords: import('../../common').SessionMessageRecordPayload['message'][] =
			[];
		const runtimeMessageParts: import('../../common').SessionMessagePartPayload['part'][] = [];
		const changedFiles: Array<{
			filePath: string;
			fileName: string;
			linesAdded: number;
			linesRemoved: number;
			toolUseId: string;
			timestamp: number;
		}> = [];
		const cumulativeDiffs: Array<{
			file: string;
			additions: number;
			deletions: number;
			status?: 'added' | 'deleted' | 'modified';
		}> = [];
		let latestTodos: SessionTodoItem[] | undefined;
		const turnTokens: Record<
			string,
			{ input: number; output: number; total?: number; cacheRead?: number; durationMs?: number }
		> = {};
		const restoreCommits: CommitInfo[] = [];

		for (const entry of entries) {
			const info = entry.info;
			if (info.role === 'user') {
				const message = this.buildCanonicalUserReplayMessage(entry);
				messages.push(message);
				const turn = turnTokensByUser.get(info.id);
				if (turn) {
					turnTokens[info.id] = {
						input: turn.inputTokens,
						output: turn.outputTokens,
						total: turn.totalTokens,
						cacheRead: turn.cacheReadTokens,
						...(typeof turn.durationMs === 'number' ? { durationMs: turn.durationMs } : {}),
					};
				}
				restoreCommits.push({
					id: info.id,
					sha: info.id,
					message: 'Checkpoint before message',
					timestamp: String(message.timestamp),
					associatedMessageId: info.id,
				});
			}

			runtimeMessageRecords.push(mapSdkMessageToRecord(info));

			for (const part of entry.parts) {
				if (part.type === 'tool' && typeof part.tool === 'string') {
					if (resolveToolName(part.tool) === 'todowrite') {
						const toolState =
							part.state && typeof part.state === 'object'
								? (part.state as Record<string, unknown>)
								: undefined;
						latestTodos = this.extractTodoSnapshotFromToolInput(toolState?.input) ?? latestTodos;
					}
				}
				const partTime =
					'time' in part && part.time && typeof part.time === 'object'
						? (part.time as { start?: number; end?: number; created?: number })
						: undefined;
				const subtask = this.mapCanonicalTaskPartToSubtask(
					part,
					info,
					partTime,
					options.workspaceSessionId,
					options.explicitLinks ?? new Map<string, string>(),
					options.childDurations ?? new Map<string, number>(),
					options.childTokensMap ?? new Map(),
					options.childModelIdMap ?? new Map<string, string>(),
				);
				if (subtask) {
					messages.push(subtask);
					continue;
				}

				runtimeMessageParts.push(mapSdkPartToPayload(part, info.id, sessionId));
				if (part.type !== 'tool' || typeof part.tool !== 'string') continue;
				const toolState =
					part.state && typeof part.state === 'object'
						? (part.state as Record<string, unknown>)
						: undefined;
				const toolInput =
					toolState?.input && typeof toolState.input === 'object'
						? (toolState.input as Record<string, unknown>)
						: undefined;
				const toolUseId = typeof part.callID === 'string' ? part.callID : undefined;
				if (!toolUseId || !toolInput) continue;
				const oldContent = SessionHandler.getFieldValue(toolInput, [
					'old_string',
					'old_str',
					'oldString',
				]);
				const newContent = SessionHandler.getFieldValue(toolInput, [
					'new_string',
					'new_str',
					'newString',
					'content',
				]);
				const filePath = SessionHandler.extractFilePath(toolInput);
				if (filePath && this.isFileEditTool(part.tool)) {
					const diffStats = computeDiffLineStats(String(oldContent), String(newContent));
					changedFiles.push({
						filePath,
						fileName: filePath.split(/[/\\]/).pop() || filePath,
						linesAdded: diffStats.added,
						linesRemoved: diffStats.removed,
						toolUseId,
						timestamp: typeof info.time?.created === 'number' ? info.time.created : Date.now(),
					});
					continue;
				}
				if (resolveToolName(part.tool) !== 'apply_patch') continue;
				for (const patchPath of extractPatchFilePaths(toolInput)) {
					changedFiles.push({
						filePath: patchPath,
						fileName: patchPath.split(/[/\\]/).pop() || patchPath,
						linesAdded: 0,
						linesRemoved: 0,
						toolUseId,
						timestamp: typeof info.time?.created === 'number' ? info.time.created : Date.now(),
					});
				}
			}
		}

		return {
			messages,
			runtimeMessageRecords,
			runtimeMessageParts,
			changedFiles,
			cumulativeDiffs,
			...(latestTodos ? { todos: latestTodos } : {}),
			turnTokens,
			restoreCommits,
		};
	}

	private async restoreSessionDiffFromServer(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<void> {
		const sdkClient = this.context.cli.getSdkClient?.();
		if (!sdkClient) {
			return;
		}

		try {
			const { data, error } = await sdkClient.session.diff({
				sessionID: sessionId,
				directory: config.workspaceRoot,
			});
			if (error) {
				logger.warn('[SessionHandler] Failed to fetch session diff during restore', {
					sessionId,
					error,
				});
				return;
			}

			this.context.bridge.emit(sessionId, 'file_diff', {
				diffs: (data || []).map(entry => ({
					file: entry.file,
					additions: entry.additions || 0,
					deletions: entry.deletions || 0,
					status: entry.status as 'added' | 'deleted' | 'modified' | undefined,
				})),
			});
		} catch (error) {
			logger.warn('[SessionHandler] Session diff restore request failed', {
				sessionId,
				error,
			});
		}
	}

	private async restoreSessionRuntimeStateFromServer(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<void> {
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
		const safeFetchTodos = async () => {
			try {
				return await this.context.services.openCodeClient.getSessionTodos(
					sdkClient,
					sessionId,
					config.workspaceRoot,
				);
			} catch (error) {
				logger.warn('[SessionHandler] Failed to fetch session todos', { sessionId, error });
				return [];
			}
		};

		try {
			const [todos, permissionResult, questionResult] = await Promise.all([
				safeFetchTodos(),
				safeFetchPermissions(),
				safeFetchQuestions(),
			]);

			this.context.bridge.emit(sessionId, 'todo', { todos });
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
				this.clearSessionStats(sessionId);
				this.clearPendingMessage(sessionId);
				this.replayedSessions.delete(sessionId);
				this.replayingSessions.delete(sessionId);
				this.context.sessionGraph.clearParent(sessionId);

				// Clean up restore/revert state for deleted session
				this.context.cleanupSessionRestore?.(sessionId);

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
					this.clearSessionStats(session.id);
					this.clearPendingMessage(session.id);
					this.replayedSessions.delete(session.id);
					this.replayingSessions.delete(session.id);
					this.context.sessionGraph.clearParent(session.id);
					this.context.cleanupSessionRestore?.(session.id);
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

		const savedModel = this.context.extensionContext.workspaceState.get<string>(
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
			tabId => tabId !== activeTab && !this.replayedSessions.has(tabId),
		);
		if (preloadIds.length === 0) return;

		void Promise.all(
			preloadIds.map(async sessionId => {
				try {
					await this.replaySessionFromCLI(sessionId, config, allSessions);
					this.replayedSessions.add(sessionId);
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

	/** Check if a tool name corresponds to a file-editing operation */
	private isFileEditTool(toolName: string): boolean {
		return isFileEditTool(toolName);
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
	): void {
		if (sessionId) {
			this.context.bridge.queue.update('cancelled', sessionId, [], text, attachments, agent);
			this.context.bridge.emit(sessionId, 'notification', {
				notification: {
					id: `error-${Date.now()}`,
					type: 'error',
					content,
					timestamp: new Date().toISOString(),
				},
			});
		} else {
			// No active session — push directly via bridge so the notification overlay still fires.
			this.context.bridge.send({
				type: 'session_event',
				targetId: '',
				sessionId: '',
				eventType: 'notification',
				payload: {
					eventType: 'notification',
					notification: {
						id: `error-${Date.now()}`,
						type: 'error',
						content,
						timestamp: new Date().toISOString(),
					},
				},
				timestamp: Date.now(),
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

	private syncSessionRuntimeState(sessionId: string): void {
		this.context.bridge.emit(sessionId, 'session_info', {
			data: {
				sessionId,
				autoAccept: this.context.getSessionAutoAccept?.(sessionId) ?? false,
			},
		});
		const config = this.buildBaseConfig();
		void this.restoreSessionCounterStateFromHistory(sessionId, config).catch(error =>
			logger.warn('[SessionHandler] Failed to sync session counter state', { sessionId, error }),
		);
		void this.restoreSessionRuntimeStateFromServer(sessionId, config).catch(error =>
			logger.warn('[SessionHandler] Failed to sync session runtime state', { sessionId, error }),
		);
		void this.restoreSessionDiffFromServer(sessionId, config).catch(error =>
			logger.warn('[SessionHandler] Failed to sync session diff', { sessionId, error }),
		);
	}

	private postStats(
		sessionId: string,
		payload: { totalStats?: Partial<TotalStats>; modelID?: string; providerID?: string },
	): void {
		this.context.bridge.emit(sessionId, 'stats', payload);
	}

	private async restoreSessionCounterStateFromHistory(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<void> {
		const history = await this.context.cli.getHistory(sessionId, config);
		const sdkClient = this.context.cli.getSdkClient?.();
		const entriesResult = sdkClient
			? await sdkClient.session.messages({ sessionID: sessionId, directory: config.workspaceRoot })
			: { data: [], error: undefined };
		const entries = entriesResult.data ?? [];
		const turnTokensByUser = this.buildTurnTokenMap(history, entriesResult.data ?? []);

		for (const [userMessageId, turn] of turnTokensByUser) {
			this.context.bridge.emit(sessionId, 'turn_tokens', {
				userMessageId,
				inputTokens: turn.inputTokens,
				outputTokens: turn.outputTokens,
				totalTokens: turn.totalTokens,
				cacheReadTokens: turn.cacheReadTokens,
				...(typeof turn.durationMs === 'number' ? { durationMs: turn.durationMs } : {}),
			});
		}

		const assistantEntries = entries.filter(
			(entry): entry is (typeof entries)[number] => entry.info.role === 'assistant',
		);
		const totalDuration = assistantEntries.reduce((sum, entry) => {
			const created = entry.info.time?.created;
			const completed = 'completed' in entry.info.time ? entry.info.time.completed : undefined;
			if (typeof created === 'number' && typeof completed === 'number' && completed >= created) {
				return sum + (completed - created);
			}
			return sum;
		}, 0);
		const requestCount = assistantEntries.length;
		const totalCost = assistantEntries.reduce(
			(sum, entry) =>
				sum + ('cost' in entry.info && typeof entry.info.cost === 'number' ? entry.info.cost : 0),
			0,
		);
		const subagentCount = history.reduce((count, ev) => {
			if (ev.type !== 'tool_result') return count;
			const data = ev.data as { tool?: string; metadata?: { sessionId?: string } };
			return data.tool === 'task' && data.metadata?.sessionId ? count + 1 : count;
		}, 0);

		this.postStats(sessionId, {
			totalStats: {
				requestCount,
				totalDuration,
				totalCost,
				subagentCount,
			},
		});

		await this.restoreSessionDiffMembershipFromServer(sessionId, config);
	}

	private buildTurnTokenMap(
		history: CLIEvent[],
		entries: Array<{
			info: {
				id: string;
				role: string;
				parentID?: string;
				time?: { created?: number; completed?: number };
				tokens?: {
					input?: number;
					output?: number;
					total?: number;
					reasoning?: number;
					cache?: { read?: number; write?: number };
				};
			};
		}>,
	): Map<
		string,
		{
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadTokens: number;
			durationMs?: number;
		}
	> {
		const result = new Map<
			string,
			{
				inputTokens: number;
				outputTokens: number;
				totalTokens: number;
				cacheReadTokens: number;
				durationMs?: number;
			}
		>();

		for (const entry of entries) {
			if (entry.info.role !== 'assistant') continue;
			const parentID = entry.info.parentID;
			const tokens = entry.info.tokens;
			if (!parentID || !tokens) continue;
			const normalizedInput = Math.max(0, tokens.input ?? 0);
			const normalizedOutput = Math.max(0, tokens.output ?? 0);
			const normalizedReasoning = Math.max(0, tokens.reasoning ?? 0);
			const normalizedCacheRead = Math.max(0, tokens.cache?.read ?? 0);

			const totalTokens =
				typeof tokens.total === 'number' && tokens.total > 0
					? tokens.total
					: normalizedInput + normalizedOutput + normalizedReasoning + normalizedCacheRead;
			if (totalTokens <= 0) continue;

			const existing = result.get(parentID);
			const created = entry.info.time?.created;
			const completed = entry.info.time?.completed;
			const durationMs =
				typeof created === 'number' && typeof completed === 'number' && completed >= created
					? completed - created
					: 0;

			result.set(parentID, {
				inputTokens: normalizedInput || existing?.inputTokens || 0,
				outputTokens: normalizedOutput + normalizedReasoning || existing?.outputTokens || 0,
				totalTokens,
				cacheReadTokens: normalizedCacheRead || existing?.cacheReadTokens || 0,
				durationMs: (existing?.durationMs ?? 0) + durationMs,
			});
		}

		if (result.size > 0) {
			return result;
		}

		let lastUserMessageId: string | undefined;
		for (const ev of history) {
			if (ev.type === 'normalized_log' && (ev.data as { role?: string }).role === 'user') {
				lastUserMessageId = (ev.data as { messageId?: string }).messageId || lastUserMessageId;
				continue;
			}
			if (ev.type === 'turn_tokens' && lastUserMessageId) {
				const d = ev.data as {
					inputTokens?: number;
					outputTokens?: number;
					totalTokens?: number;
					cacheReadTokens?: number;
					durationMs?: number;
				};
				result.set(lastUserMessageId, {
					inputTokens: d.inputTokens ?? 0,
					outputTokens: d.outputTokens ?? 0,
					totalTokens: d.totalTokens ?? 0,
					cacheReadTokens: d.cacheReadTokens ?? 0,
					...(typeof d.durationMs === 'number' ? { durationMs: d.durationMs } : {}),
				});
			}
		}

		return result;
	}

	private findReplayedUserMessageIdInHistory(
		history: CLIEvent[],
		revertMessageId: string,
	): string | undefined {
		for (let i = history.length - 1; i >= 0; i--) {
			const ev = history[i];
			if (ev.type !== 'normalized_log' || (ev.data as { role?: string }).role !== 'user') {
				continue;
			}
			const eventMessageId = (ev.data as { messageId?: string }).messageId;
			if (eventMessageId === revertMessageId) {
				return eventMessageId;
			}
		}
		return undefined;
	}

	private hasCanonicalUserMessage(
		entries: Array<{ info: CanonicalSdkMessage; parts: CanonicalSdkPart[] }>,
		revertMessageId: string,
	): boolean {
		return entries.some(entry => entry.info.role === 'user' && entry.info.id === revertMessageId);
	}

	private emitCheckpointForUserMessage(
		sessionId: string,
		messageId: string,
		timestamp: string,
		isOpenCode: boolean,
	): void {
		const commitId = generateId('checkpoint');
		this.context.registerCheckpoint?.(commitId, {
			sessionId,
			messageId,
			associatedMessageId: messageId,
			isOpenCode,
		});

		this.context.bridge.emit(sessionId, 'restore', {
			action: 'add_commit',
			commit: {
				id: commitId,
				sha: commitId,
				message: 'Checkpoint before message',
				timestamp,
				associatedMessageId: messageId,
			},
		});
	}

	private async restoreSessionDiffMembershipFromServer(
		sessionId: string,
		config: { provider: 'opencode'; workspaceRoot: string },
	): Promise<void> {
		const sdkClient = this.context.cli.getSdkClient?.();
		if (!sdkClient) return;
		const { data } = await sdkClient.session.diff({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});
		for (const entry of data || []) {
			this.context.bridge.emit(sessionId, 'file', {
				action: 'changed',
				filePath: entry.file,
				fileName: entry.file.split(/[/\\]/).pop() || entry.file,
				linesAdded: entry.additions || 0,
				linesRemoved: entry.deletions || 0,
				toolUseId: `restore:${entry.file}`,
			});
		}
	}
}
