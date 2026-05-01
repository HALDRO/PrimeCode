import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { ExtensionMessage } from '../../common';
import { useChatStore } from '../store';
import type { WebviewSdkEvent } from '../store/eventReducer';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { proxyFetch } from '../utils/proxyFetch';
import { openCodeRuntime } from './opencodeRuntime';

interface StreamEnvelope {
	directory?: string;
	payload?: WebviewSdkEvent;
	type?: string;
}

interface GlobalStreamEnvelope {
	directory?: string;
	payload?: { type?: string };
}

type QueuedEvent = WebviewSdkEvent;

const STREAM_YIELD_MS = 8;
const RECONNECT_DELAY_MS = 250;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const RECONCILE_DEBOUNCE_MS = 1000;

const queue: QueuedEvent[] = [];
const coalesced = new Map<string, number>();
const staleDeltas = new Set<string>();
let flushTimer: number | null = null;

let rootAbort: AbortController | null = null;
let attemptAbort: AbortController | null = null;
let runPromise: Promise<void> | null = null;
let currentKey: string | null = null;
let streamErrorLogged = false;
let lastEventAt = Date.now();
let heartbeatTimer: number | null = null;
let hasSeenConnected = false;
let reconcileInFlight: Promise<void> | null = null;
let lastReconcileAt = 0;

function normalizeDriveLetter(dir: string): string {
	return dir.length >= 2 && dir[1] === ':' ? dir[0].toUpperCase() + dir.slice(1) : dir;
}

function deltaKey(messageID: string, partID: string): string {
	return `${messageID}:${partID}`;
}

function coalescingKey(event: WebviewSdkEvent): string | null {
	switch (event.type) {
		case 'session.status':
			return `session.status:${event.properties.sessionID}`;
		case 'message.part.updated':
			return `message.part.updated:${event.properties.part.messageID}:${event.properties.part.id}`;
		default:
			return null;
	}
}

function flushQueuedEvents(): void {
	flushTimer = null;

	if (queue.length === 0) return;

	const events = queue.slice();
	queue.length = 0;
	const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : null;
	coalesced.clear();
	staleDeltas.clear();

	const filtered =
		skip === null
			? events
			: events.filter(event => {
					if (event.type !== 'message.part.delta') return true;
					return !skip.has(deltaKey(event.properties.messageID, event.properties.partID));
				});

	try {
		if (filtered.length > 0) {
			useChatStore.getState().actions.applyBatch(filtered);
		}
	} catch (error) {
		console.error('[PrimeCode][EventRuntime] failed to apply event batch', error);
	}
}

function scheduleFlush(): void {
	if (flushTimer !== null) return;
	flushTimer = window.requestAnimationFrame(flushQueuedEvents);
}

function enqueue(event: WebviewSdkEvent): void {
	const key = coalescingKey(event);
	if (key) {
		const existing = coalesced.get(key);
		if (existing !== undefined) {
			queue[existing] = event;
			if (event.type === 'message.part.updated') {
				const part = event.properties.part;
				staleDeltas.add(deltaKey(part.messageID, part.id));
			}
			return;
		}
		coalesced.set(key, queue.length);
	}

	queue.push(event);
	scheduleFlush();
}

function clearHeartbeat(): void {
	if (heartbeatTimer === null) return;
	window.clearTimeout(heartbeatTimer);
	heartbeatTimer = null;
}

function resetHeartbeat(): void {
	lastEventAt = Date.now();
	clearHeartbeat();
	heartbeatTimer = window.setTimeout(() => {
		attemptAbort?.abort();
	}, HEARTBEAT_TIMEOUT_MS);
}

function aborted(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

function dispatchExtensionMessageToAuxStores(message: ExtensionMessage): void {
	useUIStore.getState().actions.handleExtensionMessage(message);
	useSettingsStore.getState().actions.handleExtensionMessage(message);
}

async function runReconcile(): Promise<void> {
	const now = Date.now();
	if (now - lastReconcileAt < RECONCILE_DEBOUNCE_MS) {
		return;
	}
	lastReconcileAt = now;
	await openCodeRuntime.reconcileOpenSessions();
}

function reconcile(reason: 'server.connected' | 'reconnect'): Promise<void> {
	if (reconcileInFlight) {
		return reconcileInFlight;
	}

	reconcileInFlight = runReconcile()
		.catch(error => {
			console.warn('[PrimeCode][EventRuntime] reconcile failed', { reason, error });
			throw error;
		})
		.finally(() => {
			reconcileInFlight = null;
		});

	return reconcileInFlight;
}

function handleGlobalEnvelope(
	event: GlobalStreamEnvelope | StreamEnvelope | WebviewSdkEvent,
): void {
	const maybeEnvelope = event as GlobalStreamEnvelope;
	if (maybeEnvelope?.payload && typeof maybeEnvelope.payload === 'object') {
		if (maybeEnvelope.payload.type === 'sync') return;
		if (maybeEnvelope.payload.type === 'server.connected') {
			void reconcile('server.connected').catch(() => {
				useUIStore.getState().actions.setServerStatus('error');
			});
			return;
		}
		enqueue(maybeEnvelope.payload as WebviewSdkEvent);
		return;
	}

	const parsed = event as StreamEnvelope | WebviewSdkEvent;
	if (parsed && typeof parsed === 'object' && 'type' in parsed) {
		if (parsed.type === 'server.connected') {
			void reconcile('server.connected').catch(() => {
				useUIStore.getState().actions.setServerStatus('error');
			});
			return;
		}
		enqueue(parsed as WebviewSdkEvent);
	}
}

async function runStream(
	serverUrl: string,
	workspaceRoot: string,
	signal: AbortSignal,
): Promise<void> {
	const actions = useUIStore.getState().actions;
	const client = createOpencodeClient({
		baseUrl: serverUrl,
		directory: workspaceRoot,
		fetch: proxyFetch,
	});

	while (!signal.aborted) {
		attemptAbort = new AbortController();
		const onAbort = () => attemptAbort?.abort();
		signal.addEventListener('abort', onAbort);

		try {
			lastEventAt = Date.now();
			const events = await client.event.subscribe(
				{ directory: workspaceRoot },
				{
					signal: attemptAbort.signal,
					onSseError: () => {
						actions.setServerStatus('error');
					},
				},
			);

			actions.setServerStatus('connected');
			if (hasSeenConnected) {
				void reconcile('reconnect').catch(() => {
					actions.setServerStatus('error');
				});
			}
			hasSeenConnected = true;
			resetHeartbeat();

			let yieldedAt = Date.now();
			for await (const event of events.stream as AsyncGenerator<
				GlobalStreamEnvelope | WebviewSdkEvent
			>) {
				if (signal.aborted) break;
				resetHeartbeat();
				streamErrorLogged = false;
				handleGlobalEnvelope(event);
				if (Date.now() - yieldedAt < STREAM_YIELD_MS) continue;
				yieldedAt = Date.now();
				await wait(0);
			}

			if (signal.aborted) break;
			actions.setServerStatus('disconnected');
		} catch (error) {
			if (!aborted(error) && !streamErrorLogged) {
				streamErrorLogged = true;
				console.error('[PrimeCode][EventRuntime] stream failed', { serverUrl, error });
			}
			if (!signal.aborted) {
				actions.setServerStatus('error');
			}
		} finally {
			signal.removeEventListener('abort', onAbort);
			attemptAbort = null;
			clearHeartbeat();
		}

		if (signal.aborted) break;
		await wait(RECONNECT_DELAY_MS);
	}
}

export const eventRuntime = {
	handleExtensionMessage(message: unknown): void {
		useChatStore.getState().actions.handleExtensionMessage(message);
		dispatchExtensionMessageToAuxStores(message as ExtensionMessage);
	},

	start(serverUrl: string, workspaceRoot: string): void {
		const normalizedWorkspaceRoot = normalizeDriveLetter(workspaceRoot);
		const nextKey = `${serverUrl}::${normalizedWorkspaceRoot}`;
		if (currentKey === nextKey && runPromise) return;

		this.stop();
		currentKey = nextKey;
		hasSeenConnected = false;
		rootAbort = new AbortController();
		runPromise = runStream(serverUrl, normalizedWorkspaceRoot, rootAbort.signal).finally(() => {
			runPromise = null;
			attemptAbort = null;
			clearHeartbeat();
			flushQueuedEvents();
		});
	},

	stop(): void {
		rootAbort?.abort();
		rootAbort = null;
		attemptAbort?.abort();
		attemptAbort = null;
		clearHeartbeat();
		if (flushTimer !== null) {
			window.cancelAnimationFrame(flushTimer);
			flushTimer = null;
		}
		queue.length = 0;
		coalesced.clear();
		staleDeltas.clear();
		currentKey = null;
	},

	getLastEventAge(): number {
		return Date.now() - lastEventAt;
	},
};
