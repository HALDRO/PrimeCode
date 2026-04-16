import { vscode } from './vscode';

type SSEEventHandler = (data: string) => void;
type SSEErrorHandler = (error: Error) => void;

interface ProxySSESubscription {
	id: string;
	url: string;
	onMessage: SSEEventHandler;
	onError?: SSEErrorHandler;
	disposed: boolean;
	hasConnected: boolean;
	retryCount: number;
	retryTimer: number | null;
}

const activeSubscriptions = new Map<string, ProxySSESubscription>();

let isListening = false;

const MAX_SSE_RETRIES = 3;
const SSE_RETRY_BASE_MS = 750;
const SSE_RETRY_JITTER_RATIO = 0.2;

function createSubscriptionId(): string {
	if (typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function clearRetryTimer(sub: ProxySSESubscription) {
	if (sub.retryTimer !== null) {
		window.clearTimeout(sub.retryTimer);
		sub.retryTimer = null;
	}
}

function subscribe(sub: ProxySSESubscription) {
	if (sub.disposed) return;
	vscode.postMessage({
		type: 'sseSubscribe',
		id: sub.id,
		url: sub.url,
	});
}

function scheduleReconnect(sub: ProxySSESubscription, reason?: string) {
	if (sub.disposed) return;
	if (sub.retryTimer !== null) return;

	if (sub.retryCount >= MAX_SSE_RETRIES) {
		sub.onError?.(new Error(reason ?? 'SSE connection error'));
		activeSubscriptions.delete(sub.id);
		return;
	}

	const baseDelay = SSE_RETRY_BASE_MS * 2 ** sub.retryCount;
	const jitter = baseDelay * SSE_RETRY_JITTER_RATIO * Math.random();
	const delay = baseDelay + jitter;
	sub.retryCount += 1;
	sub.retryTimer = window.setTimeout(() => {
		sub.retryTimer = null;
		subscribe(sub);
	}, delay);
}

function ensureListener() {
	if (isListening) return;
	isListening = true;

	// Listen for SSE events from extension
	window.addEventListener('message', event => {
		const message = event.data;

		if (message?.type === 'sseEvent') {
			const { id, data } = message.data;
			const sub = activeSubscriptions.get(id);
			if (sub) {
				sub.hasConnected = true;
				sub.retryCount = 0;
				clearRetryTimer(sub);
				sub.onMessage(data);
			}
		} else if (message?.type === 'sseError') {
			const { id, error } = message.data;
			const sub = activeSubscriptions.get(id);
			if (sub) {
				scheduleReconnect(sub, error ?? 'SSE connection error');
			}
		} else if (message?.type === 'sseClosed') {
			const { id } = message.data;
			const sub = activeSubscriptions.get(id);
			if (sub) {
				scheduleReconnect(sub, sub.hasConnected ? 'SSE stream closed' : 'SSE connection closed');
			}
		}
	});

	// Clean up subscriptions when webview unloads
	window.addEventListener('beforeunload', () => {
		for (const id of activeSubscriptions.keys()) {
			vscode.postMessage({ type: 'sseClose', id });
		}
		activeSubscriptions.clear();
	});
}

/**
 * Subscribe to SSE events through the VS Code extension proxy.
 * Returns an unsubscribe function.
 */
export function proxyEventSource(
	url: string,
	onMessage: SSEEventHandler,
	onError?: SSEErrorHandler,
): () => void {
	ensureListener();

	const id = createSubscriptionId();
	const sub: ProxySSESubscription = {
		id,
		url,
		onMessage,
		onError,
		disposed: false,
		hasConnected: false,
		retryCount: 0,
		retryTimer: null,
	};

	activeSubscriptions.set(id, sub);
	subscribe(sub);

	return () => {
		sub.disposed = true;
		clearRetryTimer(sub);
		activeSubscriptions.delete(id);
		vscode.postMessage({ type: 'sseClose', id });
	};
}
