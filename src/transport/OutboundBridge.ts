/**
 * @file OutboundBridge
 * @description Typed facade for all Extension → Webview messages.
 *              Replaces raw `view.postMessage({...})` calls scattered across handlers
 *              with a single, type-safe API surface.
 *
 *              This is the ONLY place that touches `view.postMessage()`.
 */

import type {
	QueuedMessageData,
	QueueEventMessage,
	SendMessageAttachments,
	ShowNotificationMessage,
	TabStateMessage,
} from '../common';
import type { IView } from '../core/contracts';
import { logger } from '../utils/logger';

// =============================================================================
// OutboundBridge
// =============================================================================

export class OutboundBridge {
	private static readonly MAX_QUEUE_SIZE = 5000;

	private _view: IView | null = null;
	private _queue: unknown[] = [];

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
		if (!this._view) {
			if (this._queue.length >= OutboundBridge.MAX_QUEUE_SIZE) {
				logger.warn('[OutboundBridge] Queue full, dropping oldest message', {
					droppedType: (this._queue[0] as { type?: string })?.type,
				});
				this._queue.shift();
			}
			this._queue.push(msg);
			return;
		}
		this._view.postMessage(msg);
	}

	/** Flush queued messages after webview connects. */
	private flush(): void {
		if (!this._view || this._queue.length === 0) return;
		const pending = this._queue;
		this._queue = [];
		for (const msg of pending) {
			this.send(msg);
		}
	}

	public tabState(
		openTabs: string[],
		activeTab?: string,
		autoAcceptBySession?: Record<string, boolean>,
	): void {
		this.send({
			type: 'tabState',
			data: { openTabs, activeTab, autoAcceptBySession },
		} satisfies TabStateMessage);
	}

	// =========================================================================
	// Generic data messages (settings, providers, MCP, etc.)
	// =========================================================================

	/** Send a typed data message. Covers all non-session Extension → Webview messages. */
	public data<T extends string>(type: T, data?: unknown): void {
		this.send({ type, data });
	}

	public showNotification(data: ShowNotificationMessage['data']): void {
		this.send({ type: 'showNotification', data } satisfies ShowNotificationMessage);
	}

	public queueUpdate(
		action: 'enqueued' | 'dequeued' | 'cancelled' | 'cleared',
		sessionId: string,
		queue: QueuedMessageData[],
		cancelledText?: string,
		cancelledAttachments?: Pick<NonNullable<SendMessageAttachments>, 'images'>,
		cancelledAgent?: string,
	): void {
		this.send({
			type: 'messageQueue',
			data: { action, sessionId, queue, cancelledText, cancelledAttachments, cancelledAgent },
		} satisfies QueueEventMessage);
	}
}
