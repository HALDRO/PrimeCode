import type { ExtensionMessage } from '../../common';
import { normalizeDriveLetter } from '../../utils/path';
import { collectSessionLineageIds, useChatStore } from '../store';
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

const queue: QueuedEvent[] = [];
const coalesced = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let currentKey: string | null = null;
let lastEventAt = Date.now();

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
			const completedSessionIds = new Set<string>();
			for (const event of events) {
				if (event.type === 'session.idle') {
					for (const sessionId of collectSessionLineageIds(
						useChatStore.getState(),
						event.properties.sessionID,
					)) {
						completedSessionIds.add(sessionId);
					}
					continue;
				}
				if (event.type === 'session.status' && event.properties.status.type === 'idle') {
					for (const sessionId of collectSessionLineageIds(
						useChatStore.getState(),
						event.properties.sessionID,
					)) {
						completedSessionIds.add(sessionId);
					}
				}
			}
			for (const sessionId of completedSessionIds) {
				void openCodeRuntime.flushQueuedMessages(sessionId).catch(openCodeRuntime.showRuntimeError);
			}
		}
	} catch (error) {
		log.error('Failed to apply event batch', error);
	}
}

function scheduleFlush(): void {
	if (flushTimer !== null) return;
	flushTimer = globalThis.setTimeout(flushQueuedEvents, 16);
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

function handleGlobalEnvelope(
	event: GlobalStreamEnvelope | StreamEnvelope | WebviewSdkEvent,
): void {
	lastEventAt = Date.now();
	const maybeEnvelope = event as GlobalStreamEnvelope;
	if (maybeEnvelope?.payload && typeof maybeEnvelope.payload === 'object') {
		if (maybeEnvelope.payload.type === 'sync') return;
		if (maybeEnvelope.payload.type === 'server.connected') {
			// server.connected is a heartbeat signal — no action needed.
			// Session data arrives via individual SSE events (message.updated, session.status, etc.)
			// Full reconcile only happens on bootstrap or explicit user reload.
			return;
		}
		enqueue(maybeEnvelope.payload as WebviewSdkEvent);
		return;
	}

	const parsed = event as StreamEnvelope | WebviewSdkEvent;
	if (parsed && typeof parsed === 'object' && 'type' in parsed) {
		if (parsed.type === 'server.connected') {
			return;
		}
		enqueue(parsed as WebviewSdkEvent);
	}
}

export const eventRuntime = {
	handleExtensionMessage(message: unknown): void {
		const extensionMessage = message as ExtensionMessage;
		if (extensionMessage.type === 'opencodeEvent') {
			const before = useUIStore.getState().serverStatus;
			handleGlobalEnvelope(extensionMessage.data as GlobalStreamEnvelope | WebviewSdkEvent);
			const eventType =
				typeof (extensionMessage.data as { type?: unknown })?.type === 'string'
					? (extensionMessage.data as { type: string }).type
					: typeof (extensionMessage.data as { payload?: { type?: unknown } })?.payload?.type ===
							'string'
						? ((extensionMessage.data as { payload: { type: string } }).payload.type ?? 'unknown')
						: 'unknown';
			log.debug('Received opencodeEvent', {
				eventType,
				serverStatusBefore: before,
				serverStatusAfter: useUIStore.getState().serverStatus,
				lastEventAgeMs: this.getLastEventAge(),
			});
			return;
		}

		useChatStore.getState().actions.handleExtensionMessage(extensionMessage);
		dispatchExtensionMessageToAuxStores(extensionMessage);
	},

	start(serverUrl: string, workspaceRoot: string): void {
		const normalizedWorkspaceRoot = normalizeDriveLetter(workspaceRoot);
		const nextKey = `${serverUrl}::${normalizedWorkspaceRoot}`;
		if (currentKey === nextKey) return;

		log.info('Event runtime starting', { serverUrl, workspaceRoot: normalizedWorkspaceRoot });
		this.stop();
		currentKey = nextKey;
		lastEventAt = Date.now();
	},

	stop(): void {
		if (flushTimer !== null) {
			globalThis.clearTimeout(flushTimer);
			flushTimer = null;
		}
		queue.length = 0;
		coalesced.clear();
		if (currentKey) {
			log.info('Event runtime stopped', {
				key: currentKey,
				lastEventAgeMs: Date.now() - lastEventAt,
			});
		}
		currentKey = null;
		useUIStore.getState().actions.setServerStatus('disconnected');
	},

	getLastEventAge(): number {
		return Date.now() - lastEventAt;
	},
};
