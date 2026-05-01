/**
 * @file eventReducer.ts
 * @description Single-switch event reducer for SDK events.
 * Replaces 17 DISPATCH_HANDLERS with one pure function.
 * All mutations are Immer-safe (direct property assignment on draft).
 *
 * SDK events flow: server SSE (webview-owned) or extension synthetic reconcile events
 * → coalescing → eventReducer → Zustand store.
 */

import type {
	AssistantMessage,
	EventMessagePartDelta,
	EventMessagePartRemoved,
	EventMessagePartUpdated,
	EventMessageRemoved,
	EventMessageUpdated,
	EventPermissionAsked,
	EventPermissionReplied,
	EventQuestionAsked,
	EventQuestionRejected,
	EventQuestionReplied,
	EventSessionCreated,
	EventSessionDeleted,
	EventSessionDiff,
	EventSessionError,
	EventSessionIdle,
	EventSessionStatus,
	EventSessionUpdated,
	EventTodoUpdated,
	Message,
} from '@opencode-ai/sdk/v2/client';
import type { SessionStore } from './chatStore';

// Part types we skip — they're internal to the CLI and not useful for UI rendering.
const SKIP_PARTS = new Set(['patch', 'step-start', 'step-finish', 'snapshot']);

function upsertMessage(messages: Message[], nextMessage: Message): void {
	const idx = messages.findIndex(message => message.id === nextMessage.id);
	if (idx >= 0) messages[idx] = nextMessage;
	else messages.push(nextMessage);
}

function ensureSessionMessages(state: SessionStore, sessionId: string): Message[] {
	if (!state.messages[sessionId]) state.messages[sessionId] = [];
	return state.messages[sessionId];
}

function extractCompositeModelId(message: Message): string | undefined {
	const record = message as Record<string, unknown>;
	const directModelId = typeof record.modelID === 'string' ? record.modelID.trim() : '';
	const directProviderId = typeof record.providerID === 'string' ? record.providerID.trim() : '';
	if (directModelId) {
		return directProviderId ? `${directProviderId}/${directModelId}` : directModelId;
	}

	const model =
		typeof record.model === 'object' && record.model !== null
			? (record.model as Record<string, unknown>)
			: undefined;
	const nestedModelId = typeof model?.modelID === 'string' ? model.modelID.trim() : '';
	const nestedProviderId = typeof model?.providerID === 'string' ? model.providerID.trim() : '';
	if (!nestedModelId) return undefined;
	return nestedProviderId ? `${nestedProviderId}/${nestedModelId}` : nestedModelId;
}

function syncSessionModelFromMessages(state: SessionStore, sessionId: string): void {
	const messages = state.messages[sessionId] ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'user') continue;
		const model = extractCompositeModelId(message);
		if (model) {
			state.sessionModel[sessionId] = model;
			return;
		}
	}
	delete state.sessionModel[sessionId];
}

function ensureCompactionParentMessage(
	state: SessionStore,
	sessionId: string,
	messageId: string,
	createdAt?: number,
): void {
	const messages = ensureSessionMessages(state, sessionId);
	const existing = messages.find(message => message.id === messageId);
	if (existing) return;
	upsertMessage(messages, {
		id: messageId,
		sessionID: sessionId,
		role: 'user',
		time: { created: createdAt ?? Date.now() },
	} as Message);
}

function syncCompactionParentFromAssistant(
	state: SessionStore,
	sessionId: string,
	info: AssistantMessage,
): void {
	if (info.mode !== 'compaction' || !info.parentID) return;
	ensureCompactionParentMessage(state, sessionId, info.parentID, info.time.created);
}

function shouldKeepAccumulatedTextPart(existingPart: unknown, nextPart: unknown): boolean {
	if (
		!existingPart ||
		!nextPart ||
		typeof existingPart !== 'object' ||
		typeof nextPart !== 'object'
	) {
		return false;
	}

	const existing = existingPart as { type?: string; text?: unknown };
	const next = nextPart as { type?: string; text?: unknown };
	if (existing.type !== next.type) return false;
	if (existing.type !== 'text' && existing.type !== 'reasoning') return false;
	if (typeof existing.text !== 'string' || typeof next.text !== 'string') return false;

	return existing.text.length > next.text.length && existing.text.startsWith(next.text);
}

// ─── Subset of SDK Event types that the webview cares about ─────────────────
export type WebviewSdkEvent =
	| EventSessionCreated
	| EventSessionUpdated
	| EventSessionDeleted
	| EventSessionStatus
	| EventSessionIdle
	| EventSessionDiff
	| EventSessionError
	| EventMessageUpdated
	| EventMessageRemoved
	| EventMessagePartUpdated
	| EventMessagePartRemoved
	| EventMessagePartDelta
	| EventTodoUpdated
	| EventPermissionAsked
	| EventPermissionReplied
	| EventQuestionAsked
	| EventQuestionReplied
	| EventQuestionRejected;

/**
 * Pure event reducer. Mutates Immer draft state based on SDK events.
 * Called inside `produce()` — all assignments are safe.
 */
export function eventReducer(state: SessionStore, event: WebviewSdkEvent): void {
	switch (event.type) {
		// ─── Session lifecycle ─────────────────────────────────────────────
		case 'session.created': {
			const { info } = event.properties;
			const idx = state.sessions.findIndex(session => session.id === info.id);
			if (idx >= 0) state.sessions[idx] = info;
			else state.sessions.push(info);
			if (!state.messages[info.id]) state.messages[info.id] = [];
			// Register parent→child relationship
			if (info.parentID) {
				const siblings = state.childSessionIdsByParentId[info.parentID] || [];
				if (!siblings.includes(info.id)) {
					state.childSessionIdsByParentId[info.parentID] = [...siblings, info.id];
				}
			}
			break;
		}

		case 'session.updated': {
			const { info } = event.properties;
			const idx = state.sessions.findIndex(session => session.id === info.id);
			if (idx >= 0) state.sessions[idx] = info;
			else state.sessions.push(info);
			break;
		}

		case 'session.deleted': {
			const { sessionID, info } = event.properties;
			state.sessions = state.sessions.filter(session => session.id !== info.id);
			// Clean up parts keyed by messageID for all messages in this session
			const msgs = state.messages[sessionID];
			if (msgs) {
				for (const msg of msgs) {
					delete state.parts[msg.id];
				}
			}
			delete state.messages[sessionID];
			delete state.sessionStatus[sessionID];
			delete state.sessionDiff[sessionID];
			delete state.todos[sessionID];
			delete state.permissions[sessionID];
			delete state.questions[sessionID];
			break;
		}

		// ─── Session status ───────────────────────────────────────────────
		case 'session.status': {
			const { sessionID, status } = event.properties;
			state.sessionStatus[sessionID] = status;
			break;
		}

		case 'session.idle': {
			const { sessionID } = event.properties;
			state.sessionStatus[sessionID] = { type: 'idle' };
			break;
		}

		case 'session.error': {
			const { sessionID, error } = event.properties;
			if (sessionID && error) {
				// Store error as a transient notification — handled by the coalescing layer.
				// The store itself doesn't need to persist errors; they're shown as overlays.
				state.lastError = { sessionID, error };
			}
			break;
		}

		// ─── Session diffs ────────────────────────────────────────────────
		case 'session.diff': {
			const { sessionID, diff } = event.properties;
			state.sessionDiff[sessionID] = diff;
			break;
		}

		// ─── Messages ─────────────────────────────────────────────────────
		case 'message.updated': {
			const { sessionID, info } = event.properties;
			const msgs = ensureSessionMessages(state, sessionID);
			upsertMessage(msgs, info);
			if (info.role === 'user') {
				const model = extractCompositeModelId(info);
				if (model) {
					state.sessionModel[sessionID] = model;
				}
			}
			if (info.role === 'assistant') {
				syncCompactionParentFromAssistant(state, sessionID, info as AssistantMessage);
			}
			break;
		}

		case 'message.removed': {
			const { sessionID, messageID } = event.properties;
			const msgs = state.messages[sessionID];
			if (msgs) state.messages[sessionID] = msgs.filter(message => message.id !== messageID);
			// Clean up parts for this message
			if (state.parts[messageID]) delete state.parts[messageID];
			syncSessionModelFromMessages(state, sessionID);
			break;
		}

		// ─── Message parts ────────────────────────────────────────────────
		case 'message.part.updated': {
			const { part } = event.properties;
			if (SKIP_PARTS.has(part.type)) break;
			const messageID = part.messageID;
			if (!state.parts[messageID]) state.parts[messageID] = [];
			const parts = state.parts[messageID];
			const idx = parts.findIndex(existingPart => existingPart.id === part.id);
			if (idx >= 0) {
				if (!shouldKeepAccumulatedTextPart(parts[idx], part)) {
					parts[idx] = part;
				}
			} else parts.push(part);

			// Track task tool → child session mapping
			if (part.type === 'tool' && part.tool.toLowerCase() === 'task') {
				const metadata = part.metadata as { sessionId?: string } | undefined;
				if (metadata?.sessionId) {
					state.originatingToolCallBySessionId[metadata.sessionId] = part.callID;
					const siblings = state.childSessionIdsByParentId[part.sessionID] || [];
					if (!siblings.includes(metadata.sessionId)) {
						state.childSessionIdsByParentId[part.sessionID] = [...siblings, metadata.sessionId];
					}
				}
			}

			if (part.type === 'compaction') {
				ensureCompactionParentMessage(state, part.sessionID, messageID);
			}
			break;
		}

		case 'message.part.removed': {
			const { messageID, partID } = event.properties;
			const parts = state.parts[messageID];
			if (parts) {
				const nextParts = parts.filter(part => part.id !== partID);
				if (nextParts.length === 0) delete state.parts[messageID];
				else state.parts[messageID] = nextParts;
			}
			break;
		}

		// ─── Message part delta (streaming) ───────────────────────────────
		case 'message.part.delta': {
			const { messageID, partID, field, delta } = event.properties;
			const parts = state.parts[messageID];
			if (!parts) break;
			const part = parts.find(p => p.id === partID);
			if (!part) break;
			const existing =
				typeof (part as Record<string, unknown>)[field] === 'string'
					? ((part as Record<string, unknown>)[field] as string)
					: '';
			(part as Record<string, unknown>)[field] = existing + delta;
			break;
		}

		// ─── Todos ────────────────────────────────────────────────────────
		case 'todo.updated': {
			const { sessionID, todos } = event.properties;
			state.todos[sessionID] = todos;
			break;
		}

		// ─── Permissions ──────────────────────────────────────────────────
		case 'permission.asked': {
			const req = event.properties;
			const sessionID = req.sessionID;
			if (!state.permissions[sessionID]) state.permissions[sessionID] = [];
			// Upsert by request ID
			const perms = state.permissions[sessionID];
			const idx = perms.findIndex(p => p.id === req.id);
			if (idx >= 0) perms[idx] = req;
			else perms.push(req);
			break;
		}

		case 'permission.replied': {
			const { sessionID, requestID } = event.properties;
			const perms = state.permissions[sessionID];
			if (perms) {
				state.permissions[sessionID] = perms.filter(p => p.id !== requestID);
			}
			break;
		}

		// ─── Questions ────────────────────────────────────────────────────
		case 'question.asked': {
			const req = event.properties;
			const sessionID = req.sessionID;
			if (!state.questions[sessionID]) state.questions[sessionID] = [];
			const qs = state.questions[sessionID];
			const idx = qs.findIndex(q => q.id === req.id);
			if (idx >= 0) qs[idx] = req;
			else qs.push(req);
			break;
		}

		case 'question.replied':
		case 'question.rejected': {
			const { sessionID, requestID } = event.properties;
			const qs = state.questions[sessionID];
			if (qs) {
				state.questions[sessionID] = qs.filter(q => q.id !== requestID);
			}
			break;
		}
	}
}
