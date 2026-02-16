/**
 * @file OutboundBridge
 * @description Typed facade for all Extension → Webview messages.
 *              Replaces raw `view.postMessage({...})` calls scattered across handlers
 *              with a single, type-safe API surface. Handlers call `bridge.session.status()`
 *              instead of manually assembling SessionEventMessage objects.
 *
 *              This is the ONLY place that touches `view.postMessage()`.
 */

import type {
	CommitInfo,
	PermissionPolicies,
	SessionEventMessage,
	SessionLifecycleMessage,
	SessionMessageData,
	SessionRestorePayload,
	SessionStatus,
	TotalStats,
} from '../common';
import type { IView } from '../core/contracts';
import { logger } from '../utils/logger';

// =============================================================================
// OutboundBridge
// =============================================================================

export class OutboundBridge {
	private _view: IView | null = null;
	private _queue: unknown[] = [];

	/** Wire up the actual webview. Called once from ChatProvider.resolveWebviewView(). */
	public setView(view: IView): void {
		this._view = view;
		this.flush();
	}

	/** Returns true when the webview is connected and ready to receive messages. */
	public get isReady(): boolean {
		return this._view !== null;
	}

	// =========================================================================
	// Low-level send (single exit point)
	// =========================================================================

	public send(msg: unknown): void {
		if (!this._view) {
			logger.debug('[OutboundBridge] view not ready, queuing message', {
				type: (msg as { type?: string })?.type,
				queueSize: this._queue.length,
			});
			this._queue.push(msg);
			return;
		}
		const msgType = (msg as { type?: string })?.type;
		if (msgType !== 'session_event') {
			logger.debug('[OutboundBridge] send', { type: msgType });
		}
		this._view.postMessage(msg);
	}

	/** Flush queued messages after webview connects. */
	private flush(): void {
		if (!this._view || this._queue.length === 0) return;
		logger.info(`[OutboundBridge] Flushing ${this._queue.length} queued messages`);
		const pending = this._queue;
		this._queue = [];
		for (const msg of pending) {
			this.send(msg);
		}
	}

	// =========================================================================
	// Session Events — typed helpers
	// =========================================================================

	public readonly session = {
		/** Post a session message (assistant, user, tool_use, tool_result, etc.) */
		message: (targetId: string, message: SessionMessageData, sessionId?: string): void => {
			const sid = sessionId ?? targetId;
			this.send({
				type: 'session_event',
				targetId,
				eventType: 'message',
				payload: { eventType: 'message', message },
				timestamp: Date.now(),
				sessionId: sid,
				normalizedEntry: message.normalizedEntry,
			} satisfies SessionEventMessage);
		},

		/** Post session status (idle / busy / error / retrying). */
		status: (
			sessionId: string,
			status: SessionStatus,
			statusText?: string,
			retryInfo?: { attempt: number; message: string; nextRetryAt?: string },
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'status',
				payload: {
					eventType: 'status',
					status,
					statusText,
					...(retryInfo ? { retryInfo } : {}),
				},
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post aggregated token / model stats. */
		stats: (
			sessionId: string,
			payload: { totalStats?: Partial<TotalStats>; modelID?: string; providerID?: string },
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'stats',
				payload: { eventType: 'stats', ...payload },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Mark a part (assistant message, thinking block, tool) as complete. */
		complete: (sessionId: string, partId: string, toolUseId?: string): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'complete',
				payload: { eventType: 'complete', partId, toolUseId },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post per-turn token usage. */
		turnTokens: (
			sessionId: string,
			data: {
				inputTokens: number;
				outputTokens: number;
				totalTokens: number;
				cacheReadTokens: number;
				durationMs?: number;
				userMessageId?: string;
			},
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'turn_tokens',
				payload: { eventType: 'turn_tokens', ...data },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post a file change event. */
		fileChanged: (
			sessionId: string,
			data: {
				filePath: string;
				fileName: string;
				linesAdded: number;
				linesRemoved: number;
				toolUseId?: string;
			},
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'file',
				payload: { eventType: 'file', action: 'changed', ...data },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post an access response event. */
		accessResponse: (
			sessionId: string,
			data: { requestId: string; approved: boolean; alwaysAllow?: boolean },
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'access',
				payload: { eventType: 'access', action: 'response', ...data },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post session info (tools, mcp servers). */
		info: (sessionId: string, tools: string[], mcpServers: string[]): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'session_info',
				payload: {
					eventType: 'session_info',
					data: { sessionId, tools, mcpServers },
				},
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post a restore event (checkpoint add, success, error, unrevert). */
		restore: (
			sessionId: string,
			payload: {
				action: SessionRestorePayload['action'];
				commit?: CommitInfo;
				commits?: CommitInfo[];
				message?: string;
				canUnrevert?: boolean;
				available?: boolean;
				text?: string;
				revertedFromMessageId?: string;
			},
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'restore',
				payload: { eventType: 'restore', ...payload },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},

		/** Post a question request from OpenCode's question tool. */
		question: (
			sessionId: string,
			data: {
				requestId: string;
				questions: import('../common/protocol').QuestionInfo[];
				tool?: { messageID: string; callID: string };
			},
		): void => {
			this.send({
				type: 'session_event',
				targetId: sessionId,
				eventType: 'question',
				payload: { eventType: 'question', ...data },
				timestamp: Date.now(),
				sessionId,
			} satisfies SessionEventMessage);
		},
	};

	// =========================================================================
	// Session Lifecycle
	// =========================================================================

	public readonly lifecycle = {
		created: (sessionId: string): void => {
			this.send({
				type: 'session_lifecycle',
				action: 'created',
				sessionId,
			} satisfies SessionLifecycleMessage);
		},

		switched: (sessionId: string, isProcessing = false): void => {
			this.send({
				type: 'session_lifecycle',
				action: 'switched',
				sessionId,
				data: { isProcessing },
			} satisfies SessionLifecycleMessage);
		},

		closed: (sessionId: string): void => {
			this.send({
				type: 'session_lifecycle',
				action: 'closed',
				sessionId,
			} satisfies SessionLifecycleMessage);
		},

		cleared: (sessionId?: string): void => {
			this.send({
				type: 'session_lifecycle',
				action: 'cleared',
				sessionId,
			} satisfies SessionLifecycleMessage);
		},
	};

	// =========================================================================
	// Generic data messages (settings, providers, MCP, etc.)
	// =========================================================================

	/** Send a typed data message. Covers all non-session Extension → Webview messages. */
	public data<T extends string>(type: T, data?: unknown): void {
		this.send({ type, data });
	}

	/** Shorthand for permission policies update. */
	public permissionsUpdated(policies: PermissionPolicies): void {
		this.send({ type: 'permissionsUpdated', data: { policies } });
	}
}
