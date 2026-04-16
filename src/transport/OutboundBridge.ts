/**
 * @file OutboundBridge
 * @description Typed facade for all Extension → Webview messages.
 *              Replaces raw `view.postMessage({...})` calls scattered across handlers
 *              with a single, type-safe API surface. Handlers call `bridge.emit()`
 *              instead of manually assembling SessionEventMessage objects.
 *
 *              This is the ONLY place that touches `view.postMessage()`.
 */

import type {
	PermissionPolicies,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionLifecycleMessage,
} from '../common';
import type { NormalizedEntry } from '../common/normalizedTypes';
import type { IView } from '../core/contracts';
import { logger } from '../utils/logger';

// =============================================================================
// OutboundBridge
// =============================================================================

export class OutboundBridge {
	private static readonly MAX_QUEUE_SIZE = 5000;

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
			if (this._queue.length >= OutboundBridge.MAX_QUEUE_SIZE) {
				logger.warn(
					`[OutboundBridge] Queue full (${OutboundBridge.MAX_QUEUE_SIZE}), dropping oldest message`,
					{ droppedType: (this._queue[0] as { type?: string })?.type },
				);
				this._queue.shift();
			}
			logger.debug('[OutboundBridge] view not ready, queuing message', {
				type: (msg as { type?: string })?.type,
				queueSize: this._queue.length,
			});
			this._queue.push(msg);
			return;
		}
		const msgType = (msg as { type?: string })?.type;
		if (msgType !== 'session_event') {
			logger.trace('[OutboundBridge] send', { type: msgType });
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
			// Route through send() to enforce MAX_QUEUE_SIZE limit
			for (const msg of messages) {
				this.send(msg);
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

	public emit<T extends SessionEventType>(
		targetId: string,
		eventType: T,
		payloadData: Omit<Extract<SessionEventPayload, { eventType: T }>, 'eventType'>,
		options?: { sessionId?: string; normalizedEntry?: NormalizedEntry },
	): void {
		this.send({
			type: 'session_event',
			targetId,
			eventType,
			payload: { eventType, ...payloadData } as SessionEventPayload,
			timestamp: Date.now(),
			sessionId: options?.sessionId ?? targetId,
			...(options?.normalizedEntry ? { normalizedEntry: options.normalizedEntry } : {}),
		} satisfies SessionEventMessage);
	}

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
