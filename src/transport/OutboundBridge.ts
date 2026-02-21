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
	SessionMessageUpdate,
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
	/**
	 * When non-null, send() collects session_event messages here instead of posting them.
	 * Used during history replay to batch hundreds of events into a single postMessage.
	 */
	private _collectBuffer: unknown[] | null = null;

	/** Wire up the actual webview. Called once from ChatProvider.resolveWebviewView(). */
	public setView(view: IView): void {
		this._view = view;
		this.flush();
	}

	/** Clear the view reference so messages are queued until a new view connects. */
	public clearView(): void {
		this._view = null;
	}

	/** Returns true when the webview is connected and ready to receive messages. */
	public get isReady(): boolean {
		return this._view !== null;
	}

	// =========================================================================
	// Low-level send (single exit point)
	// =========================================================================

	public send(msg: unknown): void {
		// In collect mode, buffer session_event messages for batch delivery
		if (this._collectBuffer !== null) {
			const msgType = (msg as { type?: string })?.type;
			if (msgType === 'session_event') {
				this._collectBuffer.push(msg);
				return;
			}
		}
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

	/**
	 * Start collecting session_event messages instead of sending them immediately.
	 * Call flushCollected() to send all collected messages as a single batch.
	 * Used during history replay to reduce postMessage overhead.
	 */
	public startCollect(): void {
		this._collectBuffer = [];
	}

	/**
	 * Flush all collected session_event messages as a single batch.
	 * Falls back to individual sends if no messages were collected.
	 */
	public flushCollected(): void {
		const buffer = this._collectBuffer;
		this._collectBuffer = null;
		if (!buffer || buffer.length === 0) return;
		this.sendBatch(buffer);
	}

	/**
	 * Send multiple messages as a single batch to reduce postMessage overhead.
	 * Used during history replay to avoid hundreds of individual postMessage calls.
	 * The webview unpacks the batch and processes each message individually.
	 */
	public sendBatch(messages: unknown[]): void {
		if (messages.length === 0) return;
		if (messages.length === 1) {
			this.send(messages[0]);
			return;
		}
		const batchMsg = { type: 'session_event_batch', messages };
		if (!this._view) {
			logger.debug('[OutboundBridge] view not ready, queuing batch', {
				count: messages.length,
				queueSize: this._queue.length,
			});
			// Queue individual messages so they can be flushed normally
			for (const msg of messages) {
				this._queue.push(msg);
			}
			return;
		}
		logger.info(`[OutboundBridge] sendBatch: ${messages.length} messages`);
		this._view.postMessage(batchMsg);
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
		message: (
			targetId: string,
			message: SessionMessageData | SessionMessageUpdate,
			sessionId?: string,
		): void => {
			const sid = sessionId ?? targetId;
			this.send({
				type: 'session_event',
				targetId,
				eventType: 'message',
				payload: { eventType: 'message', message: message as SessionMessageData },
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

		/** Append a child message to a subtask's transcript in the parent session. */
		subtaskTranscript: (
			parentSessionId: string,
			subtaskId: string,
			childMessage: SessionMessageData,
		): void => {
			this.send({
				type: 'session_event',
				targetId: parentSessionId,
				eventType: 'subtask_transcript',
				payload: {
					eventType: 'subtask_transcript',
					subtaskId,
					childMessage,
				},
				timestamp: Date.now(),
				sessionId: parentSessionId,
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
	// Message Queue
	// =========================================================================

	public readonly queue = {
		/** Notify webview of a queue state change (enqueued, dequeued, cancelled, cleared). */
		update: (
			action: 'enqueued' | 'dequeued' | 'cancelled' | 'cleared',
			sessionId: string,
			queue: import('../common/protocol').QueuedMessageData[],
			cancelledText?: string,
			cancelledAttachments?: import('../common/protocol').SendMessageCommand['attachments'],
			cancelledAgent?: string,
		): void => {
			this.send({
				type: 'messageQueue',
				data: { action, sessionId, queue, cancelledText, cancelledAttachments, cancelledAgent },
			});
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
