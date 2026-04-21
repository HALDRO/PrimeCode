/**
 * @file chatStore.ts
 * @description Session-keyed chat state with `mutateSession` helper to eliminate per-action boilerplate.
 * All per-session fields (messages, input, status, stats, restore, changed files) live in `sessionsById`.
 * `updateSession(partial, sessionId?)` is the universal setter; named wrappers delegate to it.
 * `dispatch` routes unified session_event payloads from the extension into the correct session.
 * `sessionOrder` preserves tab ordering without O(n) lookups.
 */

import { produce } from 'immer';
import { create } from 'zustand';
import type {
	CommitInfo,
	ExtensionMessage,
	SessionDeleteMessagesAfterPayload,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionLifecycleMessage,
	SessionMessagePartPayload,
	SessionMessageRecordPayload,
	SessionMessageRemovedPayload,
	SessionMessagesReloadPayload,
	SessionNotificationPayload,
	SessionRestorePayload,
	SessionStatusPayload,
	SessionTurnTokensPayload,
	SessionUserMessagePayload,
} from '../../common';
import { generateId } from '../../common';
import type { NormalizedEntry } from '../../common/normalizedTypes';
import type { QueuedMessageData } from '../../common/protocol';
import { useUIStore } from './uiStore';

export type { CommitInfo };

// =============================================================================
// Types
// =============================================================================

export interface ChangedFile {
	filePath: string;
	fileName: string;
	linesAdded: number;
	linesRemoved: number;
	toolUseId: string;
	timestamp: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total?: number;
	usage?: number;
	cacheRead?: number;
	durationMs?: number;
}

export type RuntimeMessageRecord = SessionMessageRecordPayload['message'];
export type RuntimeMessagePart = SessionMessagePartPayload['part'];
export type UserMessage = Omit<SessionUserMessagePayload['message'], 'id' | 'timestamp'> & {
	id: string;
	timestamp: string;
	type: 'user';
};

export type StoredMessage = UserMessage;

export type RenderUserMessage = Omit<UserMessage, 'id'> & {
	id: string;
	kind: 'user';
	compaction?: RenderCompactionMessage;
};

export interface RenderCompactionMessage {
	type: 'compaction';
	messageId: string;
	auto?: boolean;
	summary?: string;
	partId?: string;
	assistantMessageId?: string;
	isStreaming?: boolean;
	completedAt?: number;
}

export interface RenderTaskCardNode {
	kind: 'task_card';
	id: string;
	toolCallId: string;
	parentSessionId: string;
	parentMessageId?: string;
	timestamp: string;
	status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
	agent?: string;
	description?: string;
	prompt?: string;
	result?: string;
	startTime?: string | number;
	retryInfo?: { attempt: number; message: string; nextRetryAt?: string };
	/** Child session ID — used by TaskCardItem to subscribe to child session independently. */
	childSessionId?: string;
	childSummary: {
		title?: string;
		modelId?: string;
		durationMs?: number;
		tokens?: TokenUsage;
		diffStats: { added: number; removed: number };
		childCount: number;
	};
}

export interface RenderAssistantMessage {
	kind: 'assistant';
	id: string;
	type: 'assistant';
	content: string;
	partId: string;
	isStreaming?: boolean;
	timestamp: string;
	agent?: string;
	normalizedEntry?: NormalizedEntry;
}

export interface RenderThinkingMessage {
	kind: 'thinking';
	id: string;
	type: 'thinking';
	content: string;
	partId: string;
	isStreaming?: boolean;
	startTime?: number;
	durationMs?: number;
	timestamp: string;
}

export interface RenderToolUseMessage {
	kind: 'tool_use';
	id: string;
	type: 'tool_use';
	toolName: string;
	toolUseId: string;
	toolInput: string;
	rawInput: Record<string, unknown>;
	streamingOutput?: string;
	isRunning?: boolean;
	status?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
	title?: string;
	resultContent?: string;
	metadata?: Record<string, unknown>;
	timestamp: string;
	normalizedEntry?: NormalizedEntry;
	filePath?: string;
}

export interface ToolResultView {
	id: string;
	type: 'tool_result';
	toolUseId: string;
	toolName: string;
	content: string;
	isError: boolean;
	title?: string;
	metadata?: Record<string, unknown>;
	timestamp?: string;
}

export type RenderNode =
	| RenderUserMessage
	| RenderTaskCardNode
	| RenderAssistantMessage
	| RenderThinkingMessage
	| RenderToolUseMessage;

type MessageInput = Partial<StoredMessage> & {
	type: StoredMessage['type'];
};

export interface ChatSession {
	id: string;
	title?: string;
	parentSessionId?: string;
	/** Per-session primary agent override. Undefined means "build". */
	agent?: string;
	/** Per-session model override. Undefined means "use workspace default". */
	model?: string;
	userMessagesById: Record<string, UserMessage>;
	runtimeMessageRecords: RuntimeMessageRecord[];
	runtimeMessagePartsById: Record<string, RuntimeMessagePart[]>;
	input: string;
	status: string;
	streamingToolId: string | null;
	isProcessing: boolean;
	isAutoRetrying: boolean;
	retryInfo: { attempt: number; message: string; nextRetryAt?: string } | null;
	isLoading: boolean;
	/** Current tool activity — tracks what tool is running with a human-readable label. */
	toolActivity: { toolName: string; label: string; filePath?: string; toolUseId?: string } | null;
	lastActive: number;
	changedFiles: ChangedFile[];
	/** Cumulative diffs from CLI session.diff — original→current per file. */
	cumulativeDiffs: Array<{
		file: string;
		additions: number;
		deletions: number;
		status?: 'added' | 'deleted' | 'modified';
	}>;
	restoreCommits: CommitInfo[];
	unrevertAvailable: boolean;
	revertedFromMessageId: string | null;
	turnTokens: Record<string, TokenUsage>;
	/** Queued messages waiting to be sent when generation completes. */
	queuedMessages: QueuedMessageData[];
	/** Draft attachments restored from a cancelled queued message. */
	draftAttachments?: { files?: string[]; images?: unknown[]; codeSnippets?: unknown[] };
	/** Draft agent restored from a cancelled queued message (e.g. 'plan', 'build'). */
	draftAgent?: string;
	/** Session-scoped tool names advertised by the backend. */
	availableTools?: string[];
	/** Session-scoped MCP server names advertised by the backend. */
	availableMcpServers?: string[];
	/** Per-session auto-accept permissions toggle. */
	autoAccept?: boolean;
	permissionAutoAcceptMode?: 'default' | 'on' | 'off';
	todos: import('../../common').SessionTodoItem[];
	pendingPermissions: import('../../common').SessionPermissionRequest[];
	pendingQuestions: import('../../common').SessionQuestionRequest[];
}

export interface ChatState {
	sessionsById: Record<string, ChatSession>;
	sessionOrder: string[];
	activeSessionId: string | undefined;
	editingMessageId: string | null;
	/** Temporary drafts for edited messages — survives cancel, cleared on send/session close */
	editDrafts: Record<string, string>;
	// Prompt Improver state (not persisted)
	isImprovingPrompt: boolean;
	improvingPromptRequestId: string | null;
	/** Stores both prompt versions (original + improved) for toggle support. */
	promptVersions: { original: string; improved: string; showingImproved: boolean } | null;

	/** parentSessionId → child session IDs. Lightweight derived index. */
	childSessionIdsByParentId: Record<string, string[]>;
	/** childSessionId → toolCallId. Lightweight derived index. */
	originatingToolCallBySessionId: Record<string, string>;

	actions: ChatActions;
}

export interface ChatActions {
	// ==========================================================================
	// Unified Session Event Dispatch (new architecture)
	// ==========================================================================

	/**
	 * Unified event dispatcher for session events from the extension.
	 * Routes events to the correct session based on targetId.
	 * Auto-creates child sessions if they don't exist.
	 */
	dispatch: (targetId: string, eventType: SessionEventType, payload: SessionEventPayload) => void;
	/**
	 * Process a batch of session events in a single Immer produce() call.
	 * Used by RAF-coalesced streaming to avoid per-token re-renders.
	 */
	dispatchBatch: (events: SessionEventMessage[]) => void;
	handleExtensionMessage: (message: ExtensionMessage) => void;

	// ==========================================================================
	// Session-aware message actions
	// ==========================================================================

	addMessage: (msg: MessageInput, sessionId?: string) => void;
	clearMessages: (sessionId?: string) => void;
	updateMessage: (id: string, updates: Partial<StoredMessage>, sessionId?: string) => void;
	/** Deletes all messages AFTER the given id, keeping the message itself. */
	deleteMessagesAfterId: (id: string, sessionId?: string) => void;
	removeMessageByPartId: (partId: string, sessionId?: string) => void;
	setEditingMessageId: (id: string | null) => void;
	/** Save a draft for a message being edited (survives cancel) */
	setEditDraft: (messageId: string, text: string) => void;
	/** Clear a single edit draft (e.g. after successful send) */
	clearEditDraft: (messageId: string) => void;
	/** Clear all edit drafts (e.g. on session switch/close) */
	clearAllEditDrafts: () => void;

	// Per-session UI state — universal setter + convenience wrappers
	updateSession: (updates: Partial<ChatSession>, sessionId?: string) => void;
	appendInput: (text: string, sessionId?: string) => void;
	clearDraftState: (sessionId?: string) => void;

	// Session lifecycle
	handleSessionCreated: (sessionId: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => void;

	// File & restore data (session-explicit — no activeSessionId fallback)
	addChangedFile: (file: ChangedFile, sessionId?: string) => void;
	removeChangedFile: (filePath: string, sessionId?: string) => void;
	clearChangedFiles: (sessionId?: string) => void;
	addRestoreCommit: (commit: CommitInfo, sessionId?: string) => void;
	clearRestoreCommits: (sessionId?: string) => void;
	setRestoreCommits: (commits: CommitInfo[], sessionId?: string) => void;
	setUnrevertAvailable: (available: boolean, sessionId?: string) => void;

	// Revert marker (session-explicit — no activeSessionId fallback)
	markRevertedFromMessageId: (id: string | null, sessionId?: string) => void;
	clearRevertedMessages: (sessionId?: string) => void;

	// Prompt Improver actions
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;
	/** Clear the stored prompt versions (e.g. after sending or discarding). */
	clearPromptVersions: () => void;
	/** Toggle between original and improved prompt text. */
	togglePromptVersion: () => void;

	// Bulk message operations (for extension message handlers)
	setSessionMessages: (sessionId: string, messages: StoredMessage[]) => void;
	deleteMessagesAfterMessageId: (sessionId: string, messageId: string) => void;

	// Per-session model selection
	getSessionAgent: (sessionId?: string) => string | undefined;
	getSessionModel: (sessionId?: string) => string | undefined;

	// Per-session auto-accept permissions
	getSessionAutoAccept: (sessionId?: string) => boolean;
	removePendingQuestion: (requestId: string, sessionId?: string) => void;
}

function upsertUserMessage(targetSession: ChatSession, incoming: UserMessage): void {
	if (!incoming.id) return;
	targetSession.userMessagesById[incoming.id] = {
		...(targetSession.userMessagesById[incoming.id] || {}),
		...incoming,
	};
}

function normalizeUserMessage(content: string): NormalizedEntry {
	return {
		timestamp: new Date().toISOString(),
		entryType: 'UserMessage',
		content,
	};
}

function getCanonicalCompactionCommand(
	targetSession: ChatSession,
	messageId: string,
): string | undefined {
	const parts = targetSession.runtimeMessagePartsById[messageId] || [];
	const hasCompaction = parts.some(part => part.type === 'compaction');
	if (!hasCompaction) return undefined;

	const text = parts
		.filter(part => part.type === 'text' && typeof part.text === 'string' && !part.synthetic)
		.map(part => part.text?.trim() || '')
		.filter(Boolean)
		.join('\n\n');

	return text || '/compact';
}

function syncSessionModelFromUserMessages(targetSession: ChatSession): void {
	const lastUserWithModel = Object.values(targetSession.userMessagesById)
		.reverse()
		.find(message => typeof message.model === 'string' && message.model.trim().length > 0);
	if (!lastUserWithModel?.model) return;
	targetSession.model = lastUserWithModel.model;
}

function getOrderedUserMessageIds(targetSession: ChatSession): string[] {
	const entries: Array<{ id: string; timestampMs: number }> = [];
	for (const message of Object.values(targetSession.userMessagesById)) {
		entries.push({ id: message.id, timestampMs: Date.parse(message.timestamp) || 0 });
	}
	entries.sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
	return entries.map(entry => entry.id);
}

// =============================================================================
// Dispatch event handlers — extracted to reduce cognitive complexity of dispatch()
// =============================================================================

function handleUserMessageEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const msgData = (payload as SessionUserMessagePayload).message;
	const messageId = msgData.id ?? '';
	const messageTimestamp = msgData.timestamp ?? '';
	const message: UserMessage = {
		type: 'user',
		...msgData,
		id: messageId,
		timestamp: messageTimestamp,
	};
	upsertUserMessage(targetSession, message);
	if (message.model?.trim()) {
		targetSession.model = message.model;
	}
	if (message.agent) {
		targetSession.agent = message.agent === 'build' ? undefined : message.agent;
	}
}

function handleStatusEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const s = payload as SessionStatusPayload;
	targetSession.status =
		s.status === 'retrying'
			? s.retryInfo?.message || targetSession.status
			: s.statusText || targetSession.status;
	targetSession.isProcessing = s.status === 'busy' || s.status === 'retrying';
	targetSession.isAutoRetrying = s.status === 'retrying';
	if (s.status === 'retrying') targetSession.retryInfo = s.retryInfo || null;
	else if (s.status === 'idle') targetSession.retryInfo = null;
	targetSession.isLoading = Boolean(s.loadingMessage);
	// Update tool activity: explicit null clears, undefined preserves current value.
	if (s.toolActivity !== undefined) {
		targetSession.toolActivity = s.toolActivity;
	}
	// Always clear tool activity when session goes idle.
	if (s.status === 'idle') {
		targetSession.toolActivity = null;
	}
}

function handleTurnTokensEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const t = payload as SessionTurnTokensPayload;
	const turnMsgId = t.userMessageId;

	if (turnMsgId) {
		const existing = targetSession.turnTokens[turnMsgId];
		// turn_tokens carries the latest snapshot total plus the authoritative
		// per-turn token usage for this user message.
		// Skip zero-total events (empty/aborted messages) to avoid overwriting real data.
		// Duration is still summed across steps (each step = separate API call).
		const hasRealTokens = t.totalTokens > 0;
		targetSession.turnTokens[turnMsgId] = {
			input: hasRealTokens ? t.inputTokens : (existing?.input ?? 0),
			output: hasRealTokens ? t.outputTokens : (existing?.output ?? 0),
			total: hasRealTokens ? t.totalTokens : (existing?.total ?? 0),
			usage: typeof t.usageTokens === 'number' ? t.usageTokens : existing?.usage,
			cacheRead: hasRealTokens ? t.cacheReadTokens : (existing?.cacheRead ?? 0),
			durationMs: t.durationMs ?? existing?.durationMs,
		};
	}
}

function handleCompleteEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const complete = payload as import('../../common').SessionCompletePayload;
	const completePartId = complete.partId;
	const completedAt = complete.completedAt;
	targetSession.streamingToolId =
		targetSession.streamingToolId === complete.toolUseId ? null : targetSession.streamingToolId;

	for (const parts of Object.values(targetSession.runtimeMessagePartsById)) {
		for (const part of parts) {
			if (part.id !== completePartId) continue;
			part.completedAt = completedAt ?? part.completedAt;
			part.state = {
				...(part.state || {}),
				status: part.state?.status === 'error' ? 'error' : 'completed',
			};
		}
	}

	const hasRunningParts = Object.values(targetSession.runtimeMessagePartsById).some(parts =>
		parts.some(part => {
			if (part.type === 'tool') {
				const status = part.state?.status;
				return status === 'pending' || status === 'running' || status === undefined;
			}
			return typeof part.completedAt !== 'number' && part.state?.status !== 'completed';
		}),
	);

	if (!hasRunningParts) {
		targetSession.isProcessing = false;
		targetSession.isAutoRetrying = false;
		targetSession.retryInfo = null;
		targetSession.toolActivity = null;
		if (
			!targetSession.status ||
			targetSession.status === 'Working...' ||
			targetSession.status === 'Retrying…'
		) {
			targetSession.status = 'Ready';
		}
	}
}

function handleRestoreEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const r = payload as SessionRestorePayload;
	if (r.action === 'add_commit' && r.commit) {
		if (!targetSession.restoreCommits.some(c => c.sha === r.commit?.sha)) {
			targetSession.restoreCommits.push(r.commit);
		}
	} else if (r.action === 'set_commits') {
		targetSession.restoreCommits = r.commits || [];
	} else if (r.action === 'clear_commits') {
		targetSession.restoreCommits = [];
	} else if (r.action === 'unrevert_available') {
		targetSession.unrevertAvailable = r.available ?? false;
		// When unrevert becomes unavailable (after unrevert action), clear the reverted marker
		if (!r.available) {
			targetSession.revertedFromMessageId = null;
		}
	} else if (r.action === 'restore_input') {
		targetSession.input = r.text || '';
	} else if (r.action === 'success') {
		if (r.canUnrevert !== undefined) targetSession.unrevertAvailable = r.canUnrevert;
		// Mark the revert point so the UI dims messages after it
		// Defensive: if unrevert is no longer available, clear the revert marker
		// unconditionally. Otherwise, apply the revert point. Using else-if prevents
		// a theoretical edge case where both fields arrive in one payload.
		if (r.canUnrevert === false) {
			targetSession.revertedFromMessageId = null;
		} else if (r.revertedFromMessageId) {
			targetSession.revertedFromMessageId = r.revertedFromMessageId;
		}
	}
}

function handleFileEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const f = payload as SessionFilePayload;
	if (f.action === 'changed' && f.filePath) {
		const fileName = f.fileName || f.filePath.split(/[/\\]/).pop() || f.filePath;

		// Use stats from the backend directly. Do NOT recompute from rawInput —
		// old_string/new_string are just snippets, not full file content, producing
		// wildly wrong numbers. The CLI session.diff event (cumulativeDiffs) will
		// provide authoritative git-level stats shortly after.
		const linesAdded = f.linesAdded || 0;
		const linesRemoved = f.linesRemoved || 0;

		const newFile = {
			filePath: f.filePath,
			fileName,
			linesAdded,
			linesRemoved,
			toolUseId: f.toolUseId || '',
			timestamp: targetSession.lastActive,
		};

		// Deduplicate by toolUseId + filePath so multiple edits to the
		// same file are preserved as separate entries, while tools like
		// apply_patch that touch multiple files with one toolUseId keep
		// all their entries.  The panel groups and aggregates them by
		// filePath for display.
		const toolId = f.toolUseId || '';
		const existingIdx = toolId
			? targetSession.changedFiles.findIndex(
					file => file.toolUseId === toolId && file.filePath === f.filePath,
				)
			: -1;
		if (existingIdx !== -1) {
			targetSession.changedFiles[existingIdx] = newFile;
		} else {
			targetSession.changedFiles.push(newFile);
		}
	} else if (f.action === 'undone' && f.filePath) {
		targetSession.changedFiles = targetSession.changedFiles.filter(
			file => file.filePath !== f.filePath,
		);
	} else if (f.action === 'all_undone') {
		targetSession.changedFiles = [];
		targetSession.cumulativeDiffs = [];
	}
}

function handleFileDiffEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const fd = payload as import('../../common/protocol').SessionFileDiffPayload;
	targetSession.cumulativeDiffs = fd.diffs || [];
}

function handleMessageRecordEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const evt = payload as import('../../common').SessionMessageRecordPayload;
	if (evt.message.role === 'user') {
		const existing = targetSession.userMessagesById[evt.message.id];
		const canonicalContent =
			existing?.content || getCanonicalCompactionCommand(targetSession, evt.message.id) || '';
		upsertUserMessage(targetSession, {
			...(existing || {}),
			id: evt.message.id,
			type: 'user',
			content: canonicalContent,
			model: existing?.model || evt.message.modelId || targetSession.model || 'default',
			...(existing?.agent || evt.message.agent
				? { agent: existing?.agent || evt.message.agent }
				: {}),
			timestamp:
				existing?.timestamp ||
				(typeof evt.message.createdAt === 'number'
					? new Date(evt.message.createdAt).toISOString()
					: new Date().toISOString()),
			...(existing?.attachments ? { attachments: existing.attachments } : {}),
			...(canonicalContent ? { normalizedEntry: normalizeUserMessage(canonicalContent) } : {}),
		});
	}

	const existingIdx = targetSession.runtimeMessageRecords.findIndex(m => m.id === evt.message.id);
	if (existingIdx >= 0) {
		targetSession.runtimeMessageRecords[existingIdx] = {
			...targetSession.runtimeMessageRecords[existingIdx],
			...evt.message,
		};
	} else targetSession.runtimeMessageRecords.push(evt.message);
	if (
		targetSession.runtimeMessageRecords.length > 1 &&
		!(targetSession as ChatSession & { __deferRecordSort?: boolean }).__deferRecordSort
	) {
		targetSession.runtimeMessageRecords.sort(
			(a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
		);
	}

	// Do not derive per-turn totals from message_record in live mode.
	// The authoritative live snapshot comes from turn_tokens, while restored
	// sessions already provide precomputed turnTokens via messages_reload.
}

function handleMessageRecordRemovedEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
): void {
	const evt = payload as import('../../common').SessionMessageRecordRemovedPayload;
	targetSession.runtimeMessageRecords = targetSession.runtimeMessageRecords.filter(
		m => m.id !== evt.messageId,
	);
	delete targetSession.userMessagesById[evt.messageId];
	delete targetSession.turnTokens[evt.messageId];
	delete targetSession.runtimeMessagePartsById[evt.messageId];
}

function _handleMessagePartEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
	state?: ChatState,
): void {
	const evt = payload as import('../../common').SessionMessagePartPayload;
	const list = targetSession.runtimeMessagePartsById[evt.part.messageId] || [];
	const idx = list.findIndex(
		p =>
			p.id === evt.part.id ||
			(evt.part.type === 'tool' &&
				p.type === 'tool' &&
				p.callId &&
				evt.part.callId &&
				p.callId === evt.part.callId),
	);
	if (idx >= 0) {
		const existing = list[idx];
		const nextPart = {
			...existing,
			...evt.part,
			state: {
				...(existing.state || {}),
				...(evt.part.state || {}),
			},
		};
		list[idx] = nextPart;
	} else {
		const nextPart = { ...evt.part };
		list.push(nextPart);
	}
	targetSession.runtimeMessagePartsById[evt.part.messageId] = list;

	if (
		state &&
		evt.part.type === 'tool' &&
		evt.part.callId &&
		evt.part.toolName?.toLowerCase() === 'task'
	) {
		const metadata = evt.part.state?.metadata as { sessionId?: string } | undefined;
		if (metadata?.sessionId) {
			state.originatingToolCallBySessionId[metadata.sessionId] = evt.part.callId;
		}
	}

	if (evt.part.type === 'compaction') {
		const existing = targetSession.userMessagesById[evt.part.messageId];
		const canonicalContent = getCanonicalCompactionCommand(targetSession, evt.part.messageId);
		if (canonicalContent) {
			upsertUserMessage(targetSession, {
				...(existing || {}),
				id: evt.part.messageId,
				type: 'user',
				content: canonicalContent,
				model: existing?.model || targetSession.model || 'default',
				timestamp: existing?.timestamp || new Date().toISOString(),
				normalizedEntry: normalizeUserMessage(canonicalContent),
				...(existing?.agent ? { agent: existing.agent } : {}),
				...(existing?.attachments ? { attachments: existing.attachments } : {}),
			});
		}
	}
}

function handleMessagePartDeltaEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
): void {
	const evt = payload as import('../../common').SessionMessagePartDeltaPayload;
	const list = targetSession.runtimeMessagePartsById[evt.messageId];
	if (!list) return;
	const part = list.find(p => p.id === evt.partId);
	if (!part) return;
	const field = evt.field as keyof RuntimeMessagePart;
	const existing = typeof part[field] === 'string' ? (part[field] as string) : '';
	if (evt.delta && existing.endsWith(evt.delta)) {
		return;
	}
	(part as unknown as Record<string, unknown>)[field] = existing + evt.delta;
}

function handleMessagePartRemovedEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
): void {
	const evt = payload as import('../../common').SessionMessagePartRemovedPayload;
	const list = targetSession.runtimeMessagePartsById[evt.messageId];
	if (!list) return;
	const next = list.filter(p => p.id !== evt.partId);
	if (next.length === 0) delete targetSession.runtimeMessagePartsById[evt.messageId];
	else targetSession.runtimeMessagePartsById[evt.messageId] = next;
}

function handleTodoEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const todo = payload as import('../../common').SessionTodoPayload;
	targetSession.todos = todo.todos || [];
}

function applyCollectionAction<T extends { id: string }>(
	collection: T[],
	action: 'set' | 'upsert' | 'remove',
	payload: { requests?: T[]; request?: T; requestId?: string },
): T[] {
	if (action === 'set') return payload.requests || [];
	if (action === 'upsert' && payload.request) {
		const req = payload.request;
		const idx = collection.findIndex(item => item.id === req.id);
		const newCol = [...collection];
		if (idx >= 0) {
			newCol[idx] = req;
		} else {
			newCol.push(req);
		}
		return newCol;
	}
	if (action === 'remove' && payload.requestId) {
		const reqId = payload.requestId;
		return collection.filter(item => item.id !== reqId);
	}
	return collection;
}

function handlePermissionEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const permission = payload as import('../../common').SessionPermissionPayload;
	targetSession.pendingPermissions = applyCollectionAction(
		targetSession.pendingPermissions,
		permission.action,
		permission,
	);
}

function handleQuestionEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const question = payload as import('../../common').SessionQuestionPayload;
	if (question.action === 'remove' && question.requestId) {
		targetSession.pendingQuestions = targetSession.pendingQuestions.filter(
			request => request.id !== question.requestId,
		);
		return;
	}
	targetSession.pendingQuestions = applyCollectionAction(
		targetSession.pendingQuestions,
		question.action,
		question,
	);
}

function handleMessagesReloadEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
	state?: ChatState,
): void {
	const r = payload as SessionMessagesReloadPayload;
	targetSession.runtimeMessageRecords = [];
	targetSession.runtimeMessagePartsById = {};
	targetSession.userMessagesById = {};
	targetSession.changedFiles = r.changedFiles || [];
	targetSession.cumulativeDiffs = r.cumulativeDiffs || [];
	targetSession.turnTokens = {};
	targetSession.restoreCommits = r.restoreCommits || [];
	const displayMessages = (r.messages || []).map(m => ({
		...m,
		id: m.id || generateId('msg'),
		timestamp: m.timestamp || new Date().toISOString(),
		type: 'user' as const,
	}));
	for (const message of displayMessages) {
		upsertUserMessage(targetSession, message as UserMessage);
	}
	for (const record of r.runtimeMessageRecords || []) {
		targetSession.runtimeMessageRecords.push(record);
	}
	if (targetSession.runtimeMessageRecords.length > 1) {
		targetSession.runtimeMessageRecords.sort(
			(a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
		);
	}
	for (const part of r.runtimeMessageParts || []) {
		const list = targetSession.runtimeMessagePartsById[part.messageId] || [];
		list.push({ ...part });
		targetSession.runtimeMessagePartsById[part.messageId] = list;

		if (state && part.type === 'tool' && part.callId && part.toolName?.toLowerCase() === 'task') {
			const metadata = part.state?.metadata as { sessionId?: string } | undefined;
			if (metadata?.sessionId) {
				state.originatingToolCallBySessionId[metadata.sessionId] = part.callId;
			}
		}
	}
	targetSession.turnTokens = r.turnTokens || {};
	syncSessionModelFromUserMessages(targetSession);
}

function handleDeleteMessagesAfterEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
): void {
	const d = payload as SessionDeleteMessagesAfterPayload;
	if (d.messageId) {
		const idx = getOrderedUserMessageIds(targetSession).indexOf(d.messageId);
		if (idx !== -1) {
			// Don't delete messages — just mark them as reverted so they can be
			// restored on unrevert. The UI will dim everything after this ID.
			targetSession.revertedFromMessageId = d.messageId;
		}
	}
}

function handleMessageRemovedEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const rm = payload as SessionMessageRemovedPayload;
	if (rm.messageId) {
		targetSession.runtimeMessageRecords = targetSession.runtimeMessageRecords.filter(
			m => m.id !== rm.messageId,
		);
		delete targetSession.runtimeMessagePartsById[rm.messageId];
	}
	if (rm.partId) {
		for (const messageId of Object.keys(targetSession.runtimeMessagePartsById)) {
			targetSession.runtimeMessagePartsById[messageId] = targetSession.runtimeMessagePartsById[
				messageId
			].filter(part => part.id !== rm.partId);
			if (targetSession.runtimeMessagePartsById[messageId].length === 0) {
				delete targetSession.runtimeMessagePartsById[messageId];
			}
		}
	}
	if (rm.partId || rm.messageId) {
		if (rm.messageId) delete targetSession.userMessagesById[rm.messageId];
	}
}

/**
 * Extract notification side-effect data from a message event payload.
 * Returns notification params if the message is a transient notification type,
 * or null if it should be handled normally by Immer.
 * This is a pure function — no side-effects.
 */
function extractNotification(
	eventType: SessionEventType,
	payload: SessionEventPayload,
): {
	type: 'error' | 'system_notice';
	content: string;
	timestamp: string;
	autoDismissMs: number;
} | null {
	if (eventType !== 'notification') return null;
	const msgData = (payload as SessionNotificationPayload).notification;
	if (
		msgData.type !== 'error' &&
		msgData.type !== 'interrupted' &&
		msgData.type !== 'system_notice'
	) {
		return null;
	}
	const content =
		'content' in msgData && typeof msgData.content === 'string' ? msgData.content : '';
	if (!content) return null;
	return {
		type: msgData.type === 'interrupted' ? 'system_notice' : msgData.type,
		content,
		timestamp: msgData.timestamp || new Date().toISOString(),
		autoDismissMs: msgData.type === 'error' ? 8000 : 5000,
	};
}

const DISPATCH_HANDLERS: Partial<
	Record<
		SessionEventType,
		(session: ChatSession, payload: SessionEventPayload, state?: ChatState) => void
	>
> = {
	user_message: handleUserMessageEvent,
	message_record: handleMessageRecordEvent,
	message_record_removed: handleMessageRecordRemovedEvent,
	message_part: _handleMessagePartEvent,
	message_part_delta: handleMessagePartDeltaEvent,
	message_part_removed: handleMessagePartRemovedEvent,
	status: handleStatusEvent,
	turn_tokens: handleTurnTokensEvent,
	complete: handleCompleteEvent,
	restore: handleRestoreEvent,
	file: handleFileEvent,
	file_diff: handleFileDiffEvent,
	todo: handleTodoEvent,
	permission: handlePermissionEvent,
	question: handleQuestionEvent,
	messages_reload: handleMessagesReloadEvent,
	delete_messages_after: handleDeleteMessagesAfterEvent,
	message_removed: handleMessageRemovedEvent,
};

/**
 * Route an event to the correct handler for a session. Pure function (Immer-safe).
 * Used by both single `dispatch` and `session_event_batch` to avoid duplication.
 */
function dispatchToSession(
	targetSession: ChatSession,
	eventType: SessionEventType,
	payload: SessionEventPayload,
	state?: ChatState,
): void {
	const handler = DISPATCH_HANDLERS[eventType];
	if (handler) {
		handler(targetSession, payload, state);
		return;
	}
	if (eventType === 'session_info') {
		const info = payload as {
			data?: {
				title?: string;
				parentSessionId?: string;
				tools?: string[];
				mcpServers?: string[];
				autoAccept?: boolean;
			};
			permissionAutoAccept?: { mode: 'default' | 'on' | 'off'; effective: boolean };
		};
		if (typeof info.data?.title === 'string') targetSession.title = info.data.title;
		if (typeof info.data?.parentSessionId === 'string') {
			targetSession.parentSessionId = info.data.parentSessionId;
			if (state) {
				const siblings = state.childSessionIdsByParentId[info.data.parentSessionId] || [];
				if (!siblings.includes(targetSession.id)) {
					state.childSessionIdsByParentId[info.data.parentSessionId] = [
						...siblings,
						targetSession.id,
					];
				}
			}
		}
		if (info.data?.tools) targetSession.availableTools = info.data.tools;
		if (info.data?.mcpServers) targetSession.availableMcpServers = info.data.mcpServers;
		if (typeof info.data?.autoAccept === 'boolean') {
			targetSession.autoAccept = info.data.autoAccept;
		}
		if (info.permissionAutoAccept) {
			targetSession.permissionAutoAcceptMode = info.permissionAutoAccept.mode;
			targetSession.autoAccept = info.permissionAutoAccept.effective;
		}
	}
}

const createEmptySession = (id: string, timestamp: number): ChatSession => ({
	id,
	title: undefined,
	agent: undefined,
	model: undefined,
	userMessagesById: {},
	runtimeMessageRecords: [],
	runtimeMessagePartsById: {},
	input: '',
	status: 'Ready',
	streamingToolId: null,
	isProcessing: false,
	isAutoRetrying: false,
	retryInfo: null,
	isLoading: false,
	toolActivity: null,
	lastActive: timestamp,
	changedFiles: [],
	cumulativeDiffs: [],
	restoreCommits: [],
	unrevertAvailable: false,
	revertedFromMessageId: null,
	turnTokens: {},
	queuedMessages: [],
	availableTools: [],
	availableMcpServers: [],
	autoAccept: false,
	permissionAutoAcceptMode: 'default',
	todos: [],
	pendingPermissions: [],
	pendingQuestions: [],
});

function resolveTargetSessionId(state: ChatState, sessionId?: string): string | undefined {
	return sessionId || state.activeSessionId;
}

function prepareEventPayload(
	eventType: SessionEventType,
	payload: SessionEventPayload,
	timestamp: number,
): SessionEventPayload {
	if (eventType === 'user_message') {
		const event = payload as SessionUserMessagePayload;
		return {
			...event,
			message: {
				...event.message,
				id: event.message.id || generateId('msg'),
				timestamp: event.message.timestamp || new Date(timestamp).toISOString(),
			},
		};
	}

	if (eventType === 'complete') {
		const event = payload as import('../../common').SessionCompletePayload;
		return {
			...event,
			completedAt: event.completedAt ?? timestamp,
		};
	}

	return payload;
}

// =============================================================================
// Helpers — eliminate per-action boilerplate
// =============================================================================

type ZustandSet = (
	partial: ChatState | Partial<ChatState> | ((state: ChatState) => ChatState | Partial<ChatState>),
) => void;

/** Mutate a target session inside produce(). Guards null, updates lastActive. */
function mutateSession(
	set: ZustandSet,
	sessionId: string | undefined,
	timestamp: number,
	mutator: (session: ChatSession, state: ChatState) => void,
): void {
	set(
		produce((state: ChatState) => {
			if (!sessionId || !state.sessionsById[sessionId]) return;
			mutator(state.sessionsById[sessionId], state);
			state.sessionsById[sessionId].lastActive = timestamp;
		}),
	);
}

// =============================================================================
// Store
// =============================================================================

export const useChatStore = create<ChatState>()((set, get) => ({
	sessionsById: {},
	sessionOrder: [],
	activeSessionId: undefined,
	editingMessageId: null,
	editDrafts: {},
	isImprovingPrompt: false,
	improvingPromptRequestId: null,
	promptVersions: null,

	// ─── Lightweight relation indices ─────────────────────────────────────
	childSessionIdsByParentId: {},
	originatingToolCallBySessionId: {},

	actions: {
		handleExtensionMessage: (message: ExtensionMessage) => {
			// Handle session lifecycle events
			if (message.type === 'session_lifecycle') {
				const lifecycle = message as SessionLifecycleMessage;
				const actions = get().actions;

				switch (lifecycle.action) {
					case 'created':
						if (lifecycle.sessionId) {
							actions.handleSessionCreated(lifecycle.sessionId);
						}
						break;
					case 'closed':
						if (lifecycle.sessionId) {
							actions.closeSession(lifecycle.sessionId);
						}
						break;
					case 'switched':
						if (lifecycle.sessionId) {
							actions.switchSession(lifecycle.sessionId);
							if (lifecycle.data?.messages) {
								actions.setSessionMessages(
									lifecycle.sessionId,
									lifecycle.data.messages as StoredMessage[],
								);
							}
							if (lifecycle.data?.isProcessing !== undefined) {
								actions.updateSession(
									{ isProcessing: lifecycle.data.isProcessing },
									lifecycle.sessionId,
								);
							}
						}
						break;
					case 'cleared':
						if (lifecycle.sessionId) {
							actions.clearMessages(lifecycle.sessionId);
						}
						break;
				}
				return;
			}

			// Handle unified session events
			if (message.type === 'session_event') {
				const event = message as SessionEventMessage;
				get().actions.dispatch(event.targetId, event.eventType, event.payload);
				return;
			}

			// Handle batched session events (history replay optimization).
			// Process all events in a single produce() to avoid intermediate states
			// visible to React selectors (e.g. a message without its completion marker).
			if (message.type === 'session_event_batch') {
				const batch = message as { type: string; messages: SessionEventMessage[] };
				// Side-effect: push transient notifications OUTSIDE of Immer produce.
				for (const event of batch.messages) {
					const notification = extractNotification(event.eventType, event.payload);
					if (notification) {
						useUIStore.getState().actions.pushNotification(notification);
					}
				}
				set(
					produce((state: ChatState) => {
						const now = Date.now();
						for (const event of batch.messages) {
							const targetId = event.targetId;
							if (!state.sessionsById[targetId]) {
								state.sessionsById[targetId] = createEmptySession(targetId, now);
							}
							const targetSession = state.sessionsById[targetId];
							targetSession.lastActive = now;
							dispatchToSession(
								targetSession,
								event.eventType,
								prepareEventPayload(event.eventType, event.payload, now),
								state,
							);
						}
					}),
				);
				return;
			}

			// Handle improve prompt responses
			if (message.type === 'improvePromptResult') {
				const { requestId, improvedText } = (
					message as { type: string; data: { requestId: string; improvedText: string } }
				).data;
				const state = get();
				if (state.improvingPromptRequestId === requestId) {
					// Save the original prompt before replacing with improved text
					const activeSession = state.activeSessionId
						? state.sessionsById[state.activeSessionId]
						: undefined;
					const currentInput = activeSession?.input || '';
					set({
						promptVersions: {
							original: currentInput,
							improved: improvedText,
							showingImproved: true,
						},
					});
					const actions = state.actions;
					actions.setImprovingPrompt(false, null);
					actions.updateSession({ input: improvedText });
				}
				return;
			}

			if (message.type === 'improvePromptError') {
				const { requestId, error } = (
					message as { type: string; data: { requestId: string; error: string } }
				).data;
				const state = get();
				if (state.improvingPromptRequestId === requestId) {
					state.actions.setImprovingPrompt(false, null);
					// Show error via transient notification overlay
					useUIStore.getState().actions.pushNotification({
						type: 'error',
						content: `Prompt Improve failed\n${error || 'Unknown error'}`,
						timestamp: new Date(Date.now()).toISOString(),
						autoDismissMs: 8000,
					});
				}
				return;
			}

			if (message.type === 'improvePromptCancelled') {
				const { requestId } = (message as { type: string; data: { requestId: string } }).data;
				const state = get();
				if (state.improvingPromptRequestId === requestId) {
					state.actions.setImprovingPrompt(false, null);
				}
				return;
			}

			// Handle message queue events
			if (message.type === 'messageQueue') {
				const { action, sessionId, queue, cancelledText, cancelledAttachments, cancelledAgent } = (
					message as {
						type: string;
						data: {
							action: string;
							sessionId: string;
							queue: QueuedMessageData[];
							cancelledText?: string;
							cancelledAttachments?: {
								files?: string[];
								images?: unknown[];
								codeSnippets?: unknown[];
							};
							cancelledAgent?: string;
						};
					}
				).data;
				set(
					produce((state: ChatState) => {
						const session = state.sessionsById[sessionId];
						if (!session) return;
						session.queuedMessages = queue;
						// On cancel, restore the text to the session input
						// Append if user already typed something to avoid losing their work
						if (action === 'cancelled' && cancelledText) {
							session.input = session.input.trim()
								? `${session.input}\n\n${cancelledText}`
								: cancelledText;
							// Restore attachments and agent so ChatInput can pick them up
							if (cancelledAttachments) {
								session.draftAttachments = cancelledAttachments;
							}
							if (cancelledAgent !== undefined) {
								session.draftAgent = cancelledAgent;
							}
						}
					}),
				);
				return;
			}
		},

		dispatch: (targetId, eventType, payload) => {
			// Side-effect: push transient notifications OUTSIDE of Immer produce.
			// handleMessageEvent is pure — it skips notification messages entirely.
			const notification = extractNotification(eventType, payload);
			if (notification) {
				useUIStore.getState().actions.pushNotification(notification);
			}

			const now = Date.now();
			const preparedPayload = prepareEventPayload(eventType, payload, now);
			set(
				produce((state: ChatState) => {
					if (!state.sessionsById[targetId]) {
						state.sessionsById[targetId] = createEmptySession(targetId, now);
					}

					const targetSession = state.sessionsById[targetId];
					targetSession.lastActive = now;

					dispatchToSession(targetSession, eventType, preparedPayload, state);
				}),
			);
		},

		dispatchBatch: events => {
			// Side-effect: push transient notifications OUTSIDE of Immer produce.
			for (const event of events) {
				const notification = extractNotification(event.eventType, event.payload);
				if (notification) {
					useUIStore.getState().actions.pushNotification(notification);
				}
			}

			const now = Date.now();
			set(
				produce((state: ChatState) => {
					const touchedSessions = new Set<string>();
					for (const event of events) {
						const targetId = event.targetId;
						if (!state.sessionsById[targetId]) {
							state.sessionsById[targetId] = createEmptySession(targetId, now);
						}
						const targetSession = state.sessionsById[targetId] as ChatSession & {
							__deferRecordSort?: boolean;
						};
						targetSession.__deferRecordSort = true;
						touchedSessions.add(targetId);
						targetSession.lastActive = now;
						dispatchToSession(
							targetSession,
							event.eventType,
							prepareEventPayload(event.eventType, event.payload, now),
							state,
						);
					}
					for (const sessionId of touchedSessions) {
						const targetSession = state.sessionsById[sessionId] as ChatSession & {
							__deferRecordSort?: boolean;
						};
						delete targetSession.__deferRecordSort;
						if (targetSession.runtimeMessageRecords.length > 1) {
							targetSession.runtimeMessageRecords.sort(
								(a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
							);
						}
					}
				}),
			);
		},

		addMessage: (msgInput, sessionId) =>
			mutateSession(set, sessionId, Date.now(), s => {
				const messageId = msgInput.id || generateId('msg');
				const messageTimestamp =
					typeof msgInput.timestamp === 'string'
						? msgInput.timestamp
						: new Date(msgInput.timestamp || Date.now()).toISOString();
				const message = {
					...msgInput,
					id: messageId,
					timestamp: messageTimestamp,
				} as StoredMessage;
				if (message.type === 'user') upsertUserMessage(s, message as UserMessage);
			}),

		updateSession: (updates, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s =>
				Object.assign(s, updates),
			),

		appendInput: (text, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.input += text;
			}),

		clearDraftState: sessionId =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.draftAttachments = undefined;
				s.draftAgent = undefined;
			}),

		clearMessages: sessionId =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.userMessagesById = {};
				s.runtimeMessageRecords = [];
				s.runtimeMessagePartsById = {};
				s.turnTokens = {};
			}),

		updateMessage: (id, updates, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				if (s.userMessagesById[id]) Object.assign(s.userMessagesById[id], updates);
			}),

		setEditingMessageId: id => set({ editingMessageId: id }),

		setEditDraft: (messageId, text) =>
			set(
				produce((state: ChatState) => {
					state.editDrafts[messageId] = text;
				}),
			),

		clearEditDraft: messageId =>
			set(
				produce((state: ChatState) => {
					delete state.editDrafts[messageId];
				}),
			),

		clearAllEditDrafts: () => set({ editDrafts: {} }),

		deleteMessagesAfterId: (id, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				const orderedIds = getOrderedUserMessageIds(s);
				const idx = orderedIds.indexOf(id);
				if (idx !== -1) {
					const idsToRemove = new Set(orderedIds.slice(idx + 1));
					const allIdsToRemove = new Set<string>(idsToRemove);

					s.runtimeMessageRecords = s.runtimeMessageRecords.filter(record => {
						if (
							idsToRemove.has(record.id) ||
							(record.parentId && idsToRemove.has(record.parentId))
						) {
							allIdsToRemove.add(record.id);
							return false;
						}
						return true;
					});

					for (const messageId of allIdsToRemove) {
						delete s.userMessagesById[messageId];
						delete s.runtimeMessagePartsById[messageId];
						delete s.turnTokens[messageId];
					}
					s.revertedFromMessageId = null;
				}
			}),

		removeMessageByPartId: (partId, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				for (const messageId of Object.keys(s.runtimeMessagePartsById)) {
					const next = s.runtimeMessagePartsById[messageId].filter(part => part.id !== partId);
					if (next.length === 0) delete s.runtimeMessagePartsById[messageId];
					else s.runtimeMessagePartsById[messageId] = next;
				}
				delete s.userMessagesById[partId];
			}),

		markRevertedFromMessageId: (id, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.revertedFromMessageId = id;
			}),

		clearRevertedMessages: sessionId =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				if (!s.revertedFromMessageId) return;
				const orderedIds = getOrderedUserMessageIds(s);
				const idx = orderedIds.indexOf(s.revertedFromMessageId);
				if (idx !== -1) {
					const idsToRemove = new Set(orderedIds.slice(idx));
					const allIdsToRemove = new Set<string>(idsToRemove);

					s.runtimeMessageRecords = s.runtimeMessageRecords.filter(record => {
						if (
							idsToRemove.has(record.id) ||
							(record.parentId && idsToRemove.has(record.parentId))
						) {
							allIdsToRemove.add(record.id);
							return false;
						}
						return true;
					});

					for (const messageId of allIdsToRemove) {
						delete s.userMessagesById[messageId];
						delete s.runtimeMessagePartsById[messageId];
						delete s.turnTokens[messageId];
					}
					s.revertedFromMessageId = null;
				} else {
					s.revertedFromMessageId = null;
				}
			}),

		handleSessionCreated: sessionId => {
			set(
				produce((state: ChatState) => {
					const now = Date.now();
					if (!state.sessionsById[sessionId]) {
						// Inherit model from the previously active session so the new
						// chat starts with the same model the user was already using.
						const prevSession = state.activeSessionId
							? state.sessionsById[state.activeSessionId]
							: undefined;
						const newSession = createEmptySession(sessionId, now);
						if (prevSession?.model) {
							newSession.model = prevSession.model;
						}
						state.sessionsById[sessionId] = newSession;
						if (!state.sessionOrder.includes(sessionId)) {
							state.sessionOrder.push(sessionId);
						}
						// Auto-switch to new session
						state.activeSessionId = sessionId;
					}
				}),
			);
		},

		switchSession: sessionId => {
			set(
				produce((state: ChatState) => {
					const now = Date.now();
					if (!state.sessionsById[sessionId]) {
						state.sessionsById[sessionId] = createEmptySession(sessionId, now);
						if (!state.sessionOrder.includes(sessionId)) {
							state.sessionOrder.push(sessionId);
						}
					}
					state.activeSessionId = sessionId;
					state.editingMessageId = null;
					state.editDrafts = {};
				}),
			);
		},

		closeSession: sessionId => {
			set(
				produce((state: ChatState) => {
					if (state.sessionOrder.length > 1) {
						const session = state.sessionsById[sessionId];
						const parentId = session?.parentSessionId;

						delete state.sessionsById[sessionId];
						delete state.childSessionIdsByParentId[sessionId];
						delete state.originatingToolCallBySessionId[sessionId];

						if (parentId && state.childSessionIdsByParentId[parentId]) {
							state.childSessionIdsByParentId[parentId] = state.childSessionIdsByParentId[
								parentId
							].filter(id => id !== sessionId);
							if (state.childSessionIdsByParentId[parentId].length === 0) {
								delete state.childSessionIdsByParentId[parentId];
							}
						}

						state.sessionOrder = state.sessionOrder.filter(id => id !== sessionId);
						if (state.activeSessionId === sessionId) {
							state.activeSessionId = state.sessionOrder[state.sessionOrder.length - 1];
							state.editingMessageId = null;
							state.editDrafts = {};
						}
					}
				}),
			);
		},

		addChangedFile: (file, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				const toolId = file.toolUseId || '';
				const idx = toolId
					? s.changedFiles.findIndex(f => f.toolUseId === toolId && f.filePath === file.filePath)
					: -1;
				if (idx !== -1) {
					s.changedFiles[idx] = { ...s.changedFiles[idx], ...file };
				} else {
					s.changedFiles.push(file);
				}
			}),

		removeChangedFile: (filePath, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.changedFiles = s.changedFiles.filter(f => f.filePath !== filePath);
				s.cumulativeDiffs = s.cumulativeDiffs.filter(d => d.file !== filePath);
			}),

		clearChangedFiles: sessionId =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.changedFiles = [];
				s.cumulativeDiffs = [];
			}),

		addRestoreCommit: (commit, sessionId) =>
			mutateSession(set, sessionId, Date.now(), s => {
				if (!s.restoreCommits.some(c => c.sha === commit.sha)) s.restoreCommits.push(commit);
			}),

		clearRestoreCommits: sessionId =>
			get().actions.updateSession({ restoreCommits: [] }, sessionId),

		setRestoreCommits: (commits, sessionId) =>
			get().actions.updateSession({ restoreCommits: commits }, sessionId),

		setUnrevertAvailable: (available, sessionId) =>
			get().actions.updateSession({ unrevertAvailable: available }, sessionId),

		setImprovingPrompt: (isImproving, requestId = null) => {
			set({ isImprovingPrompt: isImproving, improvingPromptRequestId: requestId });
		},

		clearPromptVersions: () => {
			set({ promptVersions: null });
		},

		togglePromptVersion: () => {
			const state = get();
			if (state.promptVersions) {
				const { original, improved, showingImproved } = state.promptVersions;
				const next = !showingImproved;
				state.actions.updateSession({ input: next ? improved : original });
				set({ promptVersions: { original, improved, showingImproved: next } });
			}
		},

		setSessionMessages: (sessionId, messages) =>
			mutateSession(set, sessionId, Date.now(), s => {
				const displayMessages = messages.filter(m => m.type === 'user');
				s.userMessagesById = {};
				for (const message of displayMessages) {
					if (message.type === 'user') upsertUserMessage(s, message as UserMessage);
				}
				const lastUserWithAgent = [...displayMessages]
					.reverse()
					.find((m): m is StoredMessage & { type: 'user'; agent?: string } => m.type === 'user');
				s.agent = lastUserWithAgent?.agent;
				syncSessionModelFromUserMessages(s);
			}),

		deleteMessagesAfterMessageId: (sessionId, messageId) =>
			mutateSession(set, sessionId, Date.now(), s => {
				const idx = getOrderedUserMessageIds(s).indexOf(messageId);
				if (idx !== -1) s.revertedFromMessageId = messageId;
			}),

		getSessionAgent: (sessionId): string | undefined => {
			const state = get();
			const sid = resolveTargetSessionId(state, sessionId);
			if (!sid) return undefined;
			return state.sessionsById[sid]?.agent;
		},

		getSessionModel: (sessionId): string | undefined => {
			const state = get();
			const sid = resolveTargetSessionId(state, sessionId);
			if (!sid) return undefined;
			return state.sessionsById[sid]?.model;
		},

		getSessionAutoAccept: (sessionId): boolean => {
			const state = get();
			const sid = resolveTargetSessionId(state, sessionId);
			if (!sid) return false;
			return state.sessionsById[sid]?.autoAccept ?? false;
		},

		removePendingQuestion: (requestId, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.pendingQuestions = s.pendingQuestions.filter(question => question.id !== requestId);
			}),
	},
}));
