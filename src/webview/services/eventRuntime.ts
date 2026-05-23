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
const staleDeltas = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let currentKey: string | null = null;
let lastEventAt = Date.now();

function deltaKey(messageID: string, partID: string): string {
	return `${messageID}:${partID}`;
}

function coalescingKey(event: WebviewSdkEvent): string | null {
	switch (event.type) {
		case 'session.status':
			return `session.status:${event.properties.sessionID}`;
		case 'message.part.updated': {
			const part = (event.properties as { part?: { messageID?: string; id?: string } }).part;
			if (part?.messageID && part?.id) {
				return `message.part.updated:${part.messageID}:${part.id}`;
			}
			return null;
		}
		default:
			return null;
	}
}

function flushQueuedEvents(): void {
	flushTimer = null;

	if (queue.length === 0) return;

	const events = queue.slice();
	const skip = staleDeltas.size > 0 ? new Set(staleDeltas) : undefined;
	queue.length = 0;
	coalesced.clear();
	staleDeltas.clear();

	try {
		// Filter out stale delta events that have been superseded by message.part.updated
		const filtered = skip
			? events.filter(event => {
					if (event.type !== 'message.part.delta') return true;
					const props = event.properties as { messageID?: string; partID?: string };
					if (props.messageID && props.partID) {
						return !skip.has(deltaKey(props.messageID, props.partID));
					}
					return true;
				})
			: events;

		if (filtered.length > 0) {
			useChatStore.getState().actions.applyBatch(filtered);
			const completedSessionIds = new Set<string>();
			for (const event of filtered) {
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
			// When message.part.updated coalesces, mark its delta as stale
			if (event.type === 'message.part.updated') {
				const part = (event.properties as { part?: { messageID?: string; id?: string } }).part;
				if (part?.messageID && part?.id) {
					staleDeltas.add(deltaKey(part.messageID, part.id));
				}
			}
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
			// After SSE reconnect, resync all active session statuses AND messages.
			// Events may have been lost during the disconnect window
			// (e.g. session.idle, message.updated), leaving the UI in stale state.
			const state = useChatStore.getState();
			const activeIds = state.sessionOrder.filter(Boolean);
			if (activeIds.length > 0) {
				void openCodeRuntime.refreshRuntimeState(activeIds[0], activeIds).catch(() => {});
				void openCodeRuntime.syncMessagesAfterReconnect(activeIds).catch(() => {});
			}
			return;
		}
		enqueue(maybeEnvelope.payload as WebviewSdkEvent);
		return;
	}

	const parsed = event as StreamEnvelope | WebviewSdkEvent;
	if (parsed && typeof parsed === 'object' && 'type' in parsed) {
		if (parsed.type === 'server.connected') {
			// Same resync logic as the envelope path above
			const state = useChatStore.getState();
			const activeIds = state.sessionOrder.filter(Boolean);
			if (activeIds.length > 0) {
				void openCodeRuntime.refreshRuntimeState(activeIds[0], activeIds).catch(() => {});
			}
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
