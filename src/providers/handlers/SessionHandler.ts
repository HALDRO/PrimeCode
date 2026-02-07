import * as vscode from 'vscode';
import type {
	SessionEventMessage,
	SessionLifecycleMessage,
	SessionMessageData,
	TokenStats,
	TotalStats,
} from '../../common';
import type { CLIEvent } from '../../core/executor/types';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class SessionHandler implements WebviewMessageHandler {
	private sessionTotalsByUiSession = new Map<
		string,
		{
			startedAtMs: number;
			totalTokensInput: number;
			totalTokensOutput: number;
			totalReasoningTokens: number;
			requestCount: number;
			totalDuration: number;
		}
	>();

	// Improve Prompt State
	private improvePromptController: AbortController | null = null;
	private improvePromptActiveRequestId: string | null = null;

	constructor(private context: HandlerContext) {
		// Inject CLI runner into ConversationService
		if (this.context.services.conversationService) {
			this.context.services.conversationService.setCLIRunner(this.context.cli);
		}
	}

	async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'webviewDidLaunch':
				await this.onWebviewDidLaunch(msg);
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

		logger.debug('[SessionHandler] postSessionMessage', {
			messageType: message.type,
			messageId: message.id,
			targetSessionId: targetId,
		});

		this.context.view.postMessage({
			type: 'session_event',
			targetId,
			eventType: 'message',
			payload: { eventType: 'message', message },
			timestamp: Date.now(),
			sessionId: targetId,
			normalizedEntry: message.normalizedEntry,
		} satisfies SessionEventMessage);
	}

	public postStatus(
		sessionId: string | undefined,
		status: import('../../common').SessionStatus,
		statusText?: string,
	): void {
		if (!sessionId) return;

		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'status',
			payload: { eventType: 'status', status, statusText },
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}

	public postComplete(partId: string, toolUseId?: string, sessionId?: string): void {
		const targetId = sessionId || this.context.sessionState.activeSessionId;
		if (!targetId) return;

		this.context.view.postMessage({
			type: 'session_event',
			targetId,
			eventType: 'complete',
			payload: { eventType: 'complete', partId, toolUseId },
			timestamp: Date.now(),
			sessionId: targetId,
		} satisfies SessionEventMessage);
	}

	public handleSessionUpdatedEvent(data: unknown, eventSessionId?: string): void {
		const record = (
			data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
		) as Record<string, unknown>;

		// Resolve target session: event-level sessionId > data.sessionId > activeSessionId
		const backendSessionId =
			eventSessionId ||
			(typeof record.sessionId === 'string' ? (record.sessionId as string) : undefined);
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
			this.postStatus(targetSessionId, 'busy', 'Working...');
		} else if (status?.type === 'idle') {
			this.postStatus(targetSessionId, 'idle', 'Ready');
		} else if (status?.type === 'retry') {
			this.context.view.postMessage({
				type: 'session_event',
				targetId: targetSessionId,
				eventType: 'status',
				payload: {
					eventType: 'status',
					status: 'retrying',
					statusText: 'Retrying…',
					retryInfo: {
						attempt: typeof status.attempt === 'number' ? status.attempt : 1,
						message: typeof status.message === 'string' ? status.message : 'Retrying…',
						nextRetryAt:
							typeof status.next === 'number' ? new Date(status.next).toISOString() : undefined,
					},
				},
				timestamp: Date.now(),
				sessionId: targetSessionId,
			} satisfies SessionEventMessage);
		}

		const tokenStats = record.tokenStats as Partial<TokenStats> | undefined;
		const totalStatsPatch = record.totalStats as Partial<TotalStats> | undefined;

		// Aggregate per-session totals
		this.initializeSessionStats(targetSessionId);
		const totals = this.sessionTotalsByUiSession.get(targetSessionId);
		if (!totals) return;

		let totalTokensPatch: Partial<TotalStats> | undefined;
		if (tokenStats) {
			totals.totalTokensInput += tokenStats.currentInputTokens ?? 0;
			totals.totalTokensOutput += tokenStats.currentOutputTokens ?? 0;
			totals.totalReasoningTokens += tokenStats.reasoningTokens ?? 0;

			totalTokensPatch = {
				totalTokensInput: totals.totalTokensInput,
				totalTokensOutput: totals.totalTokensOutput,
				totalReasoningTokens: totals.totalReasoningTokens,
			};
		}

		let durationPatch: Partial<TotalStats> | undefined;
		if (totalStatsPatch?.currentDuration) {
			totals.totalDuration += totalStatsPatch.currentDuration;
			durationPatch = { totalDuration: totals.totalDuration };
		}

		if (typeof totalStatsPatch?.requestCount === 'number') {
			totals.requestCount += totalStatsPatch.requestCount;
		}

		this.postStats(targetSessionId, {
			tokenStats,
			totalStats: {
				...(totalStatsPatch ?? {}),
				...(totalTokensPatch ?? {}),
				...(durationPatch ?? {}),
				requestCount: totals.requestCount,
			},
		});

		this.context.view.postMessage({
			type: 'session_event',
			targetId: targetSessionId,
			eventType: 'session_info',
			payload: {
				eventType: 'session_info',
				data: { sessionId: targetSessionId, tools: [], mcpServers: [] },
			},
			timestamp: Date.now(),
			sessionId: targetSessionId,
		} satisfies SessionEventMessage);
	}

	// =============================================================================
	// Private Handlers
	// =============================================================================

	private async onWebviewDidLaunch(msg: WebviewMessage): Promise<void> {
		const restoredSessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;

		if (restoredSessionId) {
			this.context.sessionState.activeSessionId = restoredSessionId;
			logger.info('[SessionHandler] Restoring session', { sessionId: restoredSessionId });
			this.postLifecycle('created', restoredSessionId);
			this.postLifecycle('switched', restoredSessionId, { isProcessing: false });
			this.postStatus(restoredSessionId, 'idle', 'Ready');
			this.initializeSessionStats(restoredSessionId);
		} else {
			logger.info('[SessionHandler] No active session to restore');
			// Do NOT auto-create logic here. Let the UI stay in EmptyState until user interaction.
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
		} catch (error) {
			logger.error('[SessionHandler] Failed to create session:', error);
			this.context.sessionState.activeSessionId = undefined;
		}
	}

	private async onSwitchSession(msg: WebviewMessage): Promise<void> {
		const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
		if (!sessionId) return;
		logger.info('[SessionHandler] Switching session', {
			from: this.context.sessionState.activeSessionId,
			to: sessionId,
		});
		this.context.sessionState.activeSessionId = sessionId;
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.postStatus(sessionId, 'idle', 'Ready');
		this.initializeSessionStats(sessionId);
	}

	private async onCloseSession(msg: WebviewMessage): Promise<void> {
		const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
		if (!sessionId) return;
		logger.info('[SessionHandler] Closing session', { sessionId });

		this.context.sessionState.startedSessions.delete(sessionId);
		this.clearSessionStats(sessionId);

		// If closing active session, clear backend reference
		if (this.context.sessionState.activeSessionId === sessionId) {
			this.context.sessionState.activeSessionId = undefined;
		}

		this.postLifecycle('closed', sessionId);
	}

	private async onSendMessage(msg: WebviewMessage): Promise<void> {
		const text = msg.text as string;
		const uiModel = typeof msg.model === 'string' ? (msg.model as string) : undefined;
		const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined;
		await this.handleSendMessage(text, uiModel, sessionId);
	}

	private async onStopRequest(_msg: WebviewMessage): Promise<void> {
		const activeId = this.context.sessionState.activeSessionId;

		// Only process stop request if there's an active session
		if (!activeId) {
			logger.warn('[SessionHandler] Stop request ignored - no active session');
			return;
		}

		await this.context.cli.abort();
		this.postSessionMessage(
			{
				id: `interrupted-${Date.now()}`,
				type: 'interrupted',
				content: 'Stopped by user',
				timestamp: new Date().toISOString(),
			},
			activeId,
		);
		this.postStatus(activeId, 'idle', 'Stopped');
	}

	private async handleSendMessage(
		text: string,
		uiModel?: string,
		explicitSessionId?: string,
	): Promise<void> {
		const config = this.buildSendConfig(uiModel);

		// Resolve active session
		let activeId = this.context.sessionState.activeSessionId;

		if (explicitSessionId && explicitSessionId !== activeId) {
			logger.info('[SessionHandler] Switching context to explicit session', {
				from: activeId,
				to: explicitSessionId,
			});
			activeId = explicitSessionId;
			this.context.sessionState.activeSessionId = activeId;
		}

		const isNewSession = !activeId || !this.context.sessionState.startedSessions.has(activeId);

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

			// Post user message and send to CLI
			const userMessage = {
				id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
				type: 'user' as const,
				content: text,
				model: config.model,
				timestamp: new Date().toISOString(),
			};
			this.postSessionMessage(userMessage, activeId);
			this.postStatus(activeId, 'busy', 'Working...');
			this.initializeSessionStats(activeId);

			await this.context.cli.spawnFollowUp(text, config);
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
			const conversations = await this.context.services.conversationService.listConversations();
			logger.info('[SessionHandler] Sending conversation list to webview', {
				count: conversations.length,
				titles: conversations.slice(0, 5).map(c => c.customTitle || c.firstUserMessage),
			});
			this.context.view.postMessage({
				type: 'conversationList',
				data: conversations,
			});
		} catch (error) {
			logger.error('[SessionHandler] Failed to get conversation list:', error);
			this.context.view.postMessage({
				type: 'conversationList',
				data: [],
			});
		}
	}

	private async onLoadConversation(msg: WebviewMessage): Promise<void> {
		const filename = typeof msg.filename === 'string' ? msg.filename : undefined;
		if (!filename) return;

		// For OpenCode, filename IS the sessionId
		const sessionId = filename;

		logger.info('[SessionHandler] Loading conversation', { sessionId });

		// Set active session
		this.context.sessionState.activeSessionId = sessionId;
		this.postLifecycle('created', sessionId); // Ensure UI knows about it
		this.postLifecycle('switched', sessionId, { isProcessing: false });
		this.initializeSessionStats(sessionId);

		// Initialize connection to this session in OpenCode
		try {
			const config = {
				provider: 'opencode' as const,
				workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
			};

			// Load child subagent sessions (parentID === sessionId) and preload their messages.
			const allSessions = await this.context.cli.listSessions(config);
			logger.info('[SessionHandler] Found child sessions', {
				parentSessionId: sessionId,
				childCount: allSessions.filter(s => s.parentID === sessionId).length,
			});
			const childSessions = allSessions
				.filter(s => s.parentID === sessionId)
				.sort((a, b) => (a.created || 0) - (b.created || 0)); // Sort by creation time
			const childSessionIds = childSessions.map(s => s.id);

			// Map task toolUseId -> child session id (best-effort: order match)
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
			const taskToChildSessionId = new Map<string, string>();
			for (let i = 0; i < taskToolUseIds.length; i++) {
				const childId = childSessionIds[i];
				if (childId) taskToChildSessionId.set(taskToolUseIds[i], childId);
			}

			for (const child of childSessions) {
				// Preload child messages as a normal session_event stream.
				// Do NOT send 'created' lifecycle event, otherwise it will appear in the session tabs.
				// It will be auto-created in store by dispatch() when the first message arrives.
				const childHistory = await this.context.cli.getHistory(child.id, config);
				this.replayHistoryIntoSession(child.id, childHistory);
			}

			// If parent history is compacted (no task tool_use), still surface child sessions as subtask cards.
			if (taskToolUseIds.length === 0 && childSessions.length > 0) {
				for (const child of childSessions) {
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
						},
						sessionId,
					);
				}
			}

			// Replay parent history (create subtask cards for task tool_use)
			if (parentHistory && parentHistory.length > 0) {
				logger.info(
					`[SessionHandler] Replaying ${parentHistory.length} events for session ${sessionId}`,
				);
				this.replayHistoryIntoSession(sessionId, parentHistory, {
					mode: 'parent',
					taskToChildSessionId,
				});
			} else {
				logger.info('[SessionHandler] No history found for session', { sessionId });
			}
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
			taskToChildSessionId?: Map<string, string>;
		},
	): void {
		for (const event of history) {
			if (event.type === 'message') {
				const data = event.data as { content?: string; partId?: string; isDelta?: boolean };
				this.postSessionMessage(
					{
						id: data.partId ? `msg-${data.partId}` : `hist-msg-${Math.random()}`,
						type: 'assistant',
						content: data.content || '',
						isDelta: false,
						timestamp: new Date().toISOString(),
					},
					sessionId,
				);
				continue;
			}

			if (event.type === 'normalized_log') {
				const data = event.data as { role?: string; content?: string; timestamp?: string };
				if (data.role === 'user') {
					this.postSessionMessage(
						{
							id: `user-hist-${Math.random()}`,
							type: 'user',
							content: data.content || '',
							timestamp: data.timestamp || new Date().toISOString(),
						},
						sessionId,
					);
				}
				continue;
			}

			if (event.type === 'thinking') {
				const data = event.data as { content?: string; partId?: string; timestamp?: string };
				this.postSessionMessage(
					{
						id: data.partId ? `thinking-${data.partId}` : `hist-thinking-${Math.random()}`,
						type: 'thinking',
						content: data.content || '',
						isDelta: false,
						timestamp: data.timestamp || new Date().toISOString(),
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

				if (options?.mode === 'parent' && toolName === 'task') {
					const childSessionId = options.taskToChildSessionId?.get(toolUseId);
					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							agent: typeof input.subagent_type === 'string' ? input.subagent_type : 'subagent',
							prompt: typeof input.prompt === 'string' ? input.prompt : '',
							description: typeof input.description === 'string' ? input.description : 'Subtask',
							status: 'running',
							contextId: childSessionId,
							metadata: childSessionId ? { childSessionId } : undefined,
							timestamp: data.timestamp || new Date().toISOString(),
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
						timestamp: data.timestamp || new Date().toISOString(),
					},
					sessionId,
				);
				continue;
			}

			if (event.type === 'tool_result') {
				const data = event.data as {
					tool?: string;
					content?: string;
					isError?: boolean;
					toolUseId?: string;
					timestamp?: string;
				};
				const toolName = data.tool || 'unknown';
				const toolUseId = data.toolUseId || `hist-tool-${Math.random()}`;

				if (options?.mode === 'parent' && toolName === 'task') {
					const childSessionId = options.taskToChildSessionId?.get(toolUseId);
					this.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask',
							status: data.isError ? 'error' : 'completed',
							result: data.content || '',
							contextId: childSessionId,
							metadata: childSessionId ? { childSessionId } : undefined,
							timestamp: data.timestamp || new Date().toISOString(),
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
						timestamp: data.timestamp || new Date().toISOString(),
					},
					sessionId,
				);
			}
		}
	}

	private async onDeleteConversation(msg: WebviewMessage): Promise<void> {
		const sessionId = typeof msg.filename === 'string' ? msg.filename : undefined;
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

	private async onRenameConversation(msg: WebviewMessage): Promise<void> {
		const sessionId = typeof msg.filename === 'string' ? msg.filename : undefined;
		const newTitle = typeof msg.newTitle === 'string' ? msg.newTitle : undefined;
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

	private async onImprovePromptRequest(msg: WebviewMessage): Promise<void> {
		const data = (msg.data ?? {}) as {
			text?: unknown;
			requestId?: unknown;
			model?: unknown;
			timeoutMs?: unknown;
		};

		const text = typeof data.text === 'string' ? data.text : '';
		const requestId = typeof data.requestId === 'string' ? data.requestId : '';
		const timeoutMsRaw = typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined;
		const timeoutMs =
			timeoutMsRaw && Number.isFinite(timeoutMsRaw)
				? Math.max(1000, Math.round(timeoutMsRaw))
				: 30_000;

		if (!text.trim() || !requestId) {
			this.context.view.postMessage({
				type: 'improvePromptError',
				data: { requestId: requestId || '', error: 'Missing text or requestId' },
			});
			return;
		}

		this.improvePromptController?.abort();
		this.improvePromptController = new AbortController();
		this.improvePromptActiveRequestId = requestId;

		const timeout = setTimeout(() => this.improvePromptController?.abort(), timeoutMs);

		try {
			const modelFromSettings = this.context.settings.get('promptImprove.model');
			const templateFromSettings = this.context.settings.get('promptImprove.template');
			const model =
				typeof data.model === 'string'
					? data.model
					: typeof modelFromSettings === 'string'
						? modelFromSettings
						: undefined;

			const template = typeof templateFromSettings === 'string' ? templateFromSettings : undefined;

			const improvedText = await this.improvePromptViaOpenAICompatible({
				text,
				model,
				template,
				signal: this.improvePromptController.signal,
			});

			if (this.improvePromptActiveRequestId !== requestId) return;

			this.context.view.postMessage({
				type: 'improvePromptResult',
				data: { requestId, improvedText },
			});
		} catch (error) {
			if (this.improvePromptActiveRequestId !== requestId) return;

			const err = error instanceof Error ? error.message : String(error);
			const aborted = err.toLowerCase().includes('abort');
			this.context.view.postMessage({
				type: aborted ? 'improvePromptCancelled' : 'improvePromptError',
				data: aborted ? { requestId } : { requestId, error: err },
			});
		} finally {
			clearTimeout(timeout);
			if (this.improvePromptActiveRequestId === requestId) {
				this.improvePromptActiveRequestId = null;
				this.improvePromptController = null;
			}
		}
	}

	private async onCancelImprovePrompt(msg: WebviewMessage): Promise<void> {
		const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
		if (requestId && this.improvePromptActiveRequestId !== requestId) {
			return;
		}

		this.improvePromptController?.abort();
		this.improvePromptController = null;
		this.improvePromptActiveRequestId = null;

		this.context.view.postMessage({
			type: 'improvePromptCancelled',
			data: { requestId: requestId || '' },
		});
	}

	private async improvePromptViaOpenAICompatible(params: {
		text: string;
		model?: string;
		template?: string;
		signal: AbortSignal;
	}): Promise<string> {
		const baseUrlRaw = this.context.settings.get('proxy.baseUrl');
		const apiKeyRaw = this.context.settings.get('proxy.apiKey');
		const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim().replace(/\/+$/g, '') : '';
		const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';

		if (!baseUrl) {
			throw new Error('Proxy baseUrl is not configured');
		}

		const url = new URL(`${baseUrl}/v1/chat/completions`);

		const systemPrompt =
			params.template?.trim() ||
			'Rewrite the user message to be clearer, more specific, and more actionable for an AI coding agent. Preserve intent and constraints. Return only the rewritten prompt.';

		const model = params.model?.trim() || 'gpt-4o-mini';

		const resp = await fetch(url, {
			method: 'POST',
			signal: params.signal,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: params.text },
				],
				temperature: 0.2,
			}),
		});

		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(
				`Prompt improver failed: ${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`,
			);
		}

		let json: unknown;
		try {
			json = JSON.parse(text) as unknown;
		} catch {
			throw new Error('Prompt improver returned non-JSON response');
		}

		const choice0 =
			json &&
			typeof json === 'object' &&
			'choices' in json &&
			Array.isArray((json as { choices?: unknown }).choices)
				? (json as { choices: unknown[] }).choices[0]
				: undefined;

		const content =
			choice0 &&
			typeof choice0 === 'object' &&
			'message' in choice0 &&
			(choice0 as { message?: unknown }).message &&
			typeof (choice0 as { message: { content?: unknown } }).message.content === 'string'
				? ((choice0 as { message: { content: string } }).message.content as string)
				: undefined;

		const improved = (content ?? '').trim();
		if (!improved) {
			throw new Error('Prompt improver returned empty result');
		}
		return improved;
	}

	// =============================================================================
	// Utils
	// =============================================================================

	private buildBaseConfig(): { provider: 'claude' | 'opencode'; workspaceRoot: string } {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error('No workspace root');
		}
		return {
			provider: (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode',
			workspaceRoot,
		};
	}

	private buildSendConfig(uiModel?: string) {
		const { provider, workspaceRoot } = this.buildBaseConfig();

		const savedModel =
			this.context.extensionContext.globalState.get<string>('primecode.selectedModel');
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
			startedAtMs: Date.now(),
			totalTokensInput: 0,
			totalTokensOutput: 0,
			totalReasoningTokens: 0,
			requestCount: 0,
			totalDuration: 0,
		});

		this.postStats(sessionId, {
			tokenStats: {
				totalTokensInput: 0,
				totalTokensOutput: 0,
				currentInputTokens: 0,
				currentOutputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				reasoningTokens: 0,
				totalReasoningTokens: 0,
				subagentTokensInput: 0,
				subagentTokensOutput: 0,
			},
			totalStats: {
				totalCost: 0,
				totalTokensInput: 0,
				totalTokensOutput: 0,
				totalReasoningTokens: 0,
				requestCount: 0,
				totalDuration: 0,
				currentCost: 0,
				currentDuration: 0,
				currentTurns: 0,
			},
		});
	}

	private clearSessionStats(sessionId: string): void {
		this.sessionTotalsByUiSession.delete(sessionId);
	}

	private postLifecycle(
		action: SessionLifecycleMessage['action'],
		sessionId: string,
		data?: SessionLifecycleMessage['data'],
	): void {
		this.context.view.postMessage({
			type: 'session_lifecycle',
			action,
			sessionId,
			data,
		} satisfies SessionLifecycleMessage);
	}

	private postStats(
		sessionId: string,
		payload: { tokenStats?: Partial<TokenStats>; totalStats?: Partial<TotalStats> },
	): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'stats',
			payload: { eventType: 'stats', ...payload },
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}
}
