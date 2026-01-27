import * as vscode from 'vscode';
import type {
	SessionEventMessage,
	SessionLifecycleMessage,
	SessionMessageData,
	TokenStats,
	TotalStats,
} from '../../common';
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

	constructor(private context: HandlerContext) {}

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
		}
	}

	// =============================================================================
	// Public Methods for ChatProvider interaction (Event Reflection)
	// =============================================================================

	public postSessionMessage(message: SessionMessageData): void {
		logger.debug('[SessionHandler] postSessionMessage', {
			messageType: message.type,
			messageId: message.id,
			targetSessionId: this.context.sessionState.activeSessionId,
		});

		this.context.view.postMessage({
			type: 'session_event',
			targetId: this.context.sessionState.activeSessionId,
			eventType: 'message',
			payload: { eventType: 'message', message },
			timestamp: Date.now(),
			sessionId: this.context.sessionState.activeSessionId,
			normalizedEntry: message.normalizedEntry,
		} satisfies SessionEventMessage);
	}

	public postStatus(
		sessionId: string,
		status: import('../../common').SessionStatus,
		statusText?: string,
	): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'status',
			payload: { eventType: 'status', status, statusText },
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}

	public postComplete(partId: string, toolUseId?: string): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: this.context.sessionState.activeSessionId,
			eventType: 'complete',
			payload: { eventType: 'complete', partId, toolUseId },
			timestamp: Date.now(),
			sessionId: this.context.sessionState.activeSessionId,
		} satisfies SessionEventMessage);
	}

	public postSessionInfo(): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: this.context.sessionState.activeSessionId,
			eventType: 'session_info',
			payload: {
				eventType: 'session_info',
				data: {
					sessionId: this.context.sessionState.activeSessionId,
					tools: [],
					mcpServers: [],
				},
			},
			timestamp: Date.now(),
			sessionId: this.context.sessionState.activeSessionId,
		} satisfies SessionEventMessage);
	}

	public handleSessionUpdatedEvent(data: unknown): void {
		const record = (
			data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
		) as Record<string, unknown>;

		const sessionId =
			typeof record.sessionId === 'string'
				? (record.sessionId as string)
				: this.context.cli.getSessionId();
		if (!sessionId) {
			return;
		}

		// Update active session stats if matched
		const activeId = this.context.sessionState.activeSessionId;

		const status = record.status as
			| { type?: string; attempt?: number; message?: string; next?: number }
			| undefined;
		if (status?.type === 'busy') {
			this.postStatus(activeId, 'busy', 'Working...');
		} else if (status?.type === 'idle') {
			this.postStatus(activeId, 'idle', 'Ready');
		} else if (status?.type === 'retry') {
			this.context.view.postMessage({
				type: 'session_event',
				targetId: activeId,
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
				sessionId: activeId,
			} satisfies SessionEventMessage);
		}

		const tokenStats = record.tokenStats as Partial<TokenStats> | undefined;
		const totalStatsPatch = record.totalStats as Partial<TotalStats> | undefined;

		// Aggregate per-UI-session totals
		this.initializeSessionStats(activeId);
		const totals = this.sessionTotalsByUiSession.get(activeId);
		if (!totals) {
			return;
		}

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

		this.postStats(activeId, {
			tokenStats,
			totalStats: {
				...(totalStatsPatch ?? {}),
				...(totalTokensPatch ?? {}),
				...(durationPatch ?? {}),
				requestCount: totals.requestCount,
			},
		});

		// Reflect provider session id in UI session lifecycle
		this.context.view.postMessage({
			type: 'session_event',
			targetId: activeId,
			eventType: 'session_info',
			payload: {
				eventType: 'session_info',
				data: { sessionId: activeId, tools: [], mcpServers: [] },
			},
			timestamp: Date.now(),
			sessionId: activeId,
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
			this.postSessionInfo();
			this.initializeSessionStats(restoredSessionId);
		} else {
			logger.info('[SessionHandler] No active session to restore');
			// Do NOT auto-create logic here. Let the UI stay in EmptyState until user interaction.
		}
	}

	private async onCreateSession(): Promise<void> {
		const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		logger.info('[SessionHandler] Creating new session', { sessionId: newSessionId });
		this.context.sessionState.activeSessionId = newSessionId; // Update backend state
		this.postLifecycle('created', newSessionId);
		// Force switch to the new session
		this.postLifecycle('switched', newSessionId, { isProcessing: false });
		this.initializeSessionStats(newSessionId);
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
		this.postSessionInfo();
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
			this.context.sessionState.activeSessionId = undefined as unknown as string; // Allow undefined
		}

		this.postLifecycle('closed', sessionId);
	}

	private async onSendMessage(msg: WebviewMessage): Promise<void> {
		const text = msg.text as string;
		const uiModel = typeof msg.model === 'string' ? (msg.model as string) : undefined;
		await this.handleSendMessage(text, uiModel);
	}

	private async onStopRequest(_msg: WebviewMessage): Promise<void> {
		await this.context.cli.kill();
		this.postSessionMessage({
			id: `interrupted-${Date.now()}`,
			type: 'interrupted',
			content: 'Stopped by user',
			timestamp: new Date().toISOString(),
		});
		// activeSessionId check
		if (this.context.sessionState.activeSessionId) {
			this.postStatus(this.context.sessionState.activeSessionId, 'idle', 'Stopped');
		}
		this.postSessionInfo();
	}

	private async handleSendMessage(text: string, uiModel?: string): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error('No workspace root');
		}

		const settingsModel = this.context.settings.get('model');
		const model =
			uiModel ?? (typeof settingsModel === 'string' ? (settingsModel as string) : undefined);

		const opencodeAgent = this.context.settings.get('opencode.agent');
		const opencodeServerTimeout = this.context.settings.get('opencode.serverTimeout');

		const config = {
			provider: (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode',
			model,
			workspaceRoot,
			yoloMode: Boolean(this.context.settings.get('yoloMode') || false),
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			serverTimeoutMs:
				typeof opencodeServerTimeout === 'number' && Number.isFinite(opencodeServerTimeout)
					? Math.max(0, opencodeServerTimeout) * 1000
					: undefined,
		};

		// Lazy creation: If no active session, create one now
		if (!this.context.sessionState.activeSessionId) {
			const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
			logger.info('[SessionHandler] Lazy creating session for message', {
				sessionId: newSessionId,
			});
			this.context.sessionState.activeSessionId = newSessionId;
			this.postLifecycle('created', newSessionId);
			this.postLifecycle('switched', newSessionId, { isProcessing: false });
			this.initializeSessionStats(newSessionId);
		}

		const activeId = this.context.sessionState.activeSessionId;
		const isNewSession = !this.context.sessionState.startedSessions.has(activeId);

		logger.info('[SessionHandler] handleSendMessage called', {
			text: text.slice(0, 50),
			model,
			provider: config.provider,
			sessionId: activeId,
			isNewSession,
			hasCliSession: !!this.context.cli.getSessionId(),
		});

		// CRITICAL: Post user message to UI immediately
		// Frontend does NOT optimistically add user messages (ChatInput.tsx:522-523)
		// It expects backend to echo the message back via session_event
		this.postSessionMessage({
			id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			type: 'user',
			content: text,
			model: model,
			timestamp: new Date().toISOString(),
		});

		this.postStatus(activeId, 'busy', 'Working...');

		try {
			if (isNewSession) {
				logger.info('[SessionHandler] Spawning new session');
				this.initializeSessionStats(activeId);

				if (config.provider === 'opencode' && this.context.cli.getSessionId()) {
					logger.info('[SessionHandler] OpenCode server already running, creating new session');
					await this.context.cli.createNewSession(text, config);
				} else {
					await this.context.cli.spawn(text, config);
				}

				this.context.sessionState.startedSessions.add(activeId);
			} else {
				logger.info('[SessionHandler] Spawning follow-up message');
				this.initializeSessionStats(activeId);
				await this.context.cli.spawnFollowUp(text, config);
			}
		} catch (error) {
			logger.error('[SessionHandler] Failed to spawn CLI:', error);

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

	// =============================================================================
	// Prompt Improvement
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

	private initializeSessionStats(sessionId: string): void {
		if (this.sessionTotalsByUiSession.has(sessionId)) {
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
			parentId: undefined,
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
