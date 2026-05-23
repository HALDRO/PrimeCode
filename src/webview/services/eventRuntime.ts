/**
 * @file Event Runtime - Direct SSE Connection
 * @description Manages a direct SSE connection from webview to OpenCode server (bypassing extension host).
 *              Handles event coalescing, batched dispatch to stores, heartbeat-based reconnect,
 *              and forwards extension-relevant events (permissions, session status) back to extension host.
 *              Architecture mirrors official OpenCode app's global-sdk.tsx pattern.
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { ExtensionMessage } from '../../common';
import { normalizeDriveLetter } from '../../utils/path';
import { collectSessionLineageIds, useChatStore } from '../store';
import type { WebviewSdkEvent } from '../store/eventReducer';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { webviewLogger } from '../utils/logger';
import { proxyFetch } from '../utils/proxyFetch';
import { vscode } from '../utils/vscode';
import { openCodeRuntime } from './opencodeRuntime';

const log = webviewLogger.forComponent('EventRuntime');

interface StreamEnvelope {
	directory?: string;
	payload?: WebviewSdkEvent;
	type?: string;
}

interface GlobalStreamEnvelope {
	directory?: string;
	payload?: { type?: string; properties?: Record<string, unknown> };
}

type QueuedEvent = WebviewSdkEvent;

const queue: QueuedEvent[] = [];
const coalesced = new Map<string, number>();
const staleDeltas = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

let currentKey: string | null = null;
let lastEventAt = Date.now();

// SSE connection state
let sseAbort: AbortController | null = null;
let sseStarted = false;

const HEARTBEAT_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 250;
const FLUSH_FRAME_MS = 16;

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
			const errorSessionIds = new Set<string>();
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
				// On session.error (non-abort), resync status — the server may already
				// consider the session idle but we never received a session.idle event.
				if (event.type === 'session.error') {
					const errorProps = event.properties as {
						sessionID?: string;
						error?: { name?: string };
					};
					if (errorProps.sessionID && errorProps.error?.name !== 'MessageAbortedError') {
						errorSessionIds.add(errorProps.sessionID);
					}
				}
			}
			for (const sessionId of completedSessionIds) {
				void openCodeRuntime.flushQueuedMessages(sessionId).catch(openCodeRuntime.showRuntimeError);
			}
			// For error sessions: refresh status from server, then flush if now idle
			for (const sessionId of errorSessionIds) {
				if (completedSessionIds.has(sessionId)) continue;
				void openCodeRuntime
					.refreshRuntimeState(sessionId)
					.then(() => {
						// Flush the errored session and its parent lineage
						for (const lineageId of collectSessionLineageIds(useChatStore.getState(), sessionId)) {
							void openCodeRuntime
								.flushQueuedMessages(lineageId)
								.catch(openCodeRuntime.showRuntimeError);
						}
					})
					.catch(() => {});
			}
		}
	} catch (error) {
		log.error('Failed to apply event batch', error);
	}
}

function scheduleFlush(): void {
	if (flushTimer !== null) return;
	flushTimer = globalThis.setTimeout(flushQueuedEvents, FLUSH_FRAME_MS);
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

// Events that extension host needs to react to (auto-permission, session tracking, etc.)
const EXTENSION_RELEVANT_EVENTS = new Set([
	'permission.asked',
	'session.status',
	'session.deleted',
	'session.error',
]);

function forwardToExtensionHost(event: {
	type: string;
	properties: Record<string, unknown>;
}): void {
	if (!EXTENSION_RELEVANT_EVENTS.has(event.type)) return;
	vscode.postMessage({
		type: 'forwardedEvent',
		event: { type: event.type, properties: event.properties },
	});
}

function handleServerConnected(): void {
	useUIStore.getState().actions.setServerStatus('connected');
	// After SSE reconnect, resync all active session statuses AND messages.
	const state = useChatStore.getState();
	const activeIds = state.sessionOrder.filter(Boolean);
	if (activeIds.length > 0) {
		void openCodeRuntime.refreshRuntimeState(activeIds[0], activeIds).catch(() => {});
		void openCodeRuntime.syncMessagesAfterReconnect(activeIds).catch(() => {});
	}
}

function handleGlobalEnvelope(
	event: GlobalStreamEnvelope | StreamEnvelope | WebviewSdkEvent,
): void {
	lastEventAt = Date.now();
	const maybeEnvelope = event as GlobalStreamEnvelope;
	if (maybeEnvelope?.payload && typeof maybeEnvelope.payload === 'object') {
		if (maybeEnvelope.payload.type === 'sync') return;
		if (maybeEnvelope.payload.type === 'server.heartbeat') return;
		if (maybeEnvelope.payload.type === 'server.connected') {
			handleServerConnected();
			return;
		}
		const payload = maybeEnvelope.payload as WebviewSdkEvent;
		forwardToExtensionHost(payload as { type: string; properties: Record<string, unknown> });
		enqueue(payload);
		return;
	}

	const parsed = event as StreamEnvelope | WebviewSdkEvent;
	if (parsed && typeof parsed === 'object' && 'type' in parsed) {
		if (parsed.type === 'server.connected') {
			handleServerConnected();
			return;
		}
		if (parsed.type === 'server.heartbeat') return;
		forwardToExtensionHost(parsed as { type: string; properties: Record<string, unknown> });
		enqueue(parsed as WebviewSdkEvent);
	}
}

// =============================================================================
// SSE Connection Loop (mirrors official app global-sdk.tsx)
// =============================================================================

async function runSseLoop(
	serverUrl: string,
	workspaceRoot: string,
	signal: AbortSignal,
): Promise<void> {
	let streamErrorLogged = false;

	while (!signal.aborted && sseStarted) {
		const attempt = new AbortController();
		const onParentAbort = () => attempt.abort();
		signal.addEventListener('abort', onParentAbort);

		// Heartbeat timer: abort stream if no events within timeout
		let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
		const resetHeartbeat = () => {
			lastEventAt = Date.now();
			if (heartbeatTimer) clearTimeout(heartbeatTimer);
			heartbeatTimer = setTimeout(() => {
				attempt.abort();
			}, HEARTBEAT_TIMEOUT_MS);
		};
		const clearHeartbeat = () => {
			if (heartbeatTimer) {
				clearTimeout(heartbeatTimer);
				heartbeatTimer = null;
			}
		};

		try {
			const client = createOpencodeClient({
				baseUrl: serverUrl,
				directory: workspaceRoot,
				fetch: proxyFetch,
			});

			log.info('SSE connecting', { serverUrl });
			const subscription = await client.global.event({
				signal: attempt.signal,
				onSseError: (error: unknown) => {
					if (signal.aborted) return;
					if (streamErrorLogged) return;
					streamErrorLogged = true;
					log.error('SSE stream error', { serverUrl, error });
				},
			});

			if (signal.aborted) {
				await (subscription.stream as AsyncGenerator<unknown>).return?.(undefined);
				break;
			}

			const stream = subscription.stream as AsyncGenerator<unknown>;
			const closeStream = () => {
				void stream.return?.(undefined);
			};
			attempt.signal.addEventListener('abort', closeStream, { once: true });

			useUIStore.getState().actions.setServerStatus('connected');
			resetHeartbeat();

			for await (const event of stream) {
				if (signal.aborted) break;
				streamErrorLogged = false;
				resetHeartbeat();
				handleGlobalEnvelope(event as GlobalStreamEnvelope | WebviewSdkEvent);
			}

			attempt.signal.removeEventListener('abort', closeStream);
		} catch (error) {
			if (signal.aborted) break;
			useUIStore.getState().actions.setServerStatus('error');
			if (!streamErrorLogged) {
				streamErrorLogged = true;
				log.warn('SSE connection failed', { serverUrl, error });
			}
		} finally {
			signal.removeEventListener('abort', onParentAbort);
			clearHeartbeat();
			attempt.abort();
		}

		if (signal.aborted || !sseStarted) break;

		log.info('SSE scheduling reconnect', { serverUrl, backoff: RECONNECT_DELAY_MS });
		useUIStore.getState().actions.setServerStatus('disconnected');

		// Abortable sleep
		await new Promise<void>(resolve => {
			if (signal.aborted) return resolve();
			const timer = setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, RECONNECT_DELAY_MS);
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal.addEventListener('abort', onAbort);
		});
	}
}

function startSse(serverUrl: string, workspaceRoot: string): void {
	stopSse();
	sseStarted = true;
	sseAbort = new AbortController();
	runSseLoop(serverUrl, workspaceRoot, sseAbort.signal);
}

function stopSse(): void {
	sseStarted = false;
	sseAbort?.abort();
	sseAbort = null;
}

// =============================================================================
// Public API
// =============================================================================

export const eventRuntime = {
	handleExtensionMessage(message: unknown): void {
		const extensionMessage = message as ExtensionMessage;

		// opencodeEvent from extension host is no longer used — webview has direct SSE.
		// Ignore silently to avoid duplicate event processing.
		if (extensionMessage.type === 'opencodeEvent') return;

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

		// Start direct SSE connection to OpenCode server
		startSse(serverUrl, normalizedWorkspaceRoot);
	},

	stop(): void {
		stopSse();

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

	/** @internal Exposed for unit tests only. */
	_injectEvent(event: GlobalStreamEnvelope | StreamEnvelope | WebviewSdkEvent): void {
		handleGlobalEnvelope(event);
	},
};
