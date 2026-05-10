import type { ExtensionMessage } from '../../common';
import { useChatStore } from '../store';
import type { WebviewSdkEvent } from '../store/eventReducer';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { webviewLogger } from '../utils/logger';
import { openCodeRuntime } from './opencodeRuntime';

const log = webviewLogger.forComponent('EventRuntime');

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

const RECONCILE_DEBOUNCE_MS = 1000;

const queue: QueuedEvent[] = [];
const coalesced = new Map<string, number>();
let flushTimer: number | null = null;

let currentKey: string | null = null;
let lastEventAt = Date.now();
let reconcileInFlight: Promise<void> | null = null;
let lastReconcileAt = 0;

function normalizeDriveLetter(dir: string): string {
	return dir.length >= 2 && dir[1] === ':' ? dir[0].toUpperCase() + dir.slice(1) : dir;
}

function coalescingKey(event: WebviewSdkEvent): string | null {
	switch (event.type) {
		case 'session.status':
			return `session.status:${event.properties.sessionID}`;
		default:
			return null;
	}
}

function flushQueuedEvents(): void {
	flushTimer = null;

	if (queue.length === 0) return;

	const events = queue.slice();
	queue.length = 0;
	coalesced.clear();

	try {
		if (events.length > 0) {
			useChatStore.getState().actions.applyBatch(events);
		}
	} catch (error) {
		log.error('Failed to apply event batch', error);
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
			return;
		}
		coalesced.set(key, queue.length);
	}

	queue.push(event);
	scheduleFlush();
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
			log.warn(`Reconcile failed (reason: ${reason})`, error);
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
	lastEventAt = Date.now();
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

export const eventRuntime = {
	handleExtensionMessage(message: unknown): void {
		const extensionMessage = message as ExtensionMessage;
		if (extensionMessage.type === 'opencodeEvent') {
			handleGlobalEnvelope(extensionMessage.data as GlobalStreamEnvelope | WebviewSdkEvent);
			useUIStore.getState().actions.setServerStatus('connected');
			return;
		}

		useChatStore.getState().actions.handleExtensionMessage(extensionMessage);
		dispatchExtensionMessageToAuxStores(extensionMessage);
	},

	start(serverUrl: string, workspaceRoot: string): void {
		const normalizedWorkspaceRoot = normalizeDriveLetter(workspaceRoot);
		const nextKey = `${serverUrl}::${normalizedWorkspaceRoot}`;
		if (currentKey === nextKey) return;

		this.stop();
		currentKey = nextKey;
		lastEventAt = Date.now();
		useUIStore.getState().actions.setServerStatus('connected');
	},

	stop(): void {
		if (flushTimer !== null) {
			window.cancelAnimationFrame(flushTimer);
			flushTimer = null;
		}
		queue.length = 0;
		coalesced.clear();
		currentKey = null;
		useUIStore.getState().actions.setServerStatus('disconnected');
	},

	getLastEventAge(): number {
		return Date.now() - lastEventAt;
	},
};
