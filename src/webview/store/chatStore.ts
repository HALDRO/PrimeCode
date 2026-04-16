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
	SessionStatsPayload,
	SessionStatusPayload,
	SessionSubtaskPayload,
	SessionTurnTokensPayload,
	SessionUserMessagePayload,
	TotalStats,
} from '../../common';
import { generateId } from '../../common';
import type { NormalizedEntry } from '../../common/normalizedTypes';
import type { QueuedMessageData } from '../../common/protocol';
import { projectRuntimeMessages } from './selectors';
import { useUIStore } from './uiStore';

export type { CommitInfo, TotalStats };

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

export type SubtaskMessage = Omit<SessionSubtaskPayload['subtask'], 'id' | 'timestamp'> & {
	id: string;
	timestamp: string;
	type: 'subtask';
};

/** Only user messages and subtasks — assistant/tool content lives in runtimeParts. */
export type StoredMessage = UserMessage | SubtaskMessage;

export type RenderUserMessage = Omit<UserMessage, 'id'> & { id: string; kind: 'user' };

export type RenderSubtaskMessage = Omit<SubtaskMessage, 'id'> & {
	id: string;
	kind: 'subtask';
};

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
	status?: 'pending' | 'running' | 'completed' | 'error';
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

export type RenderMessage =
	| RenderUserMessage
	| RenderSubtaskMessage
	| RenderAssistantMessage
	| RenderThinkingMessage
	| RenderToolUseMessage;

type MessageInput = Partial<StoredMessage> & {
	type: StoredMessage['type'];
};

export interface ChatSession {
	id: string;
	/** Per-session primary agent override. Undefined means "build". */
	agent?: string;
	/** Per-session model override. Undefined means "use workspace default". */
	model?: string;
	/** Model ID reported by the backend for the current/last request. */
	activeModelID?: string;
	/** Provider ID reported by the backend for the current/last request. */
	activeProviderID?: string;
	userMessagesById: Record<string, UserMessage>;
	subtasksById: Record<string, SubtaskMessage>;
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
	totalStats: TotalStats;
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

	// Stats
	setTotalStats: (stats: Partial<TotalStats>, sessionId?: string) => void;

	// Subtask actions (session-aware — do NOT rely on activeSessionId)
	startSubtask: (subtask: SubtaskMessage, sessionId?: string) => void;
	updateSubtask: (
		subtaskId: string,
		status: 'completed' | 'error',
		result?: string,
		sessionId?: string,
	) => void;

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

// =============================================================================
// Defaults (exported for use in selectors)
// =============================================================================

export const DEFAULT_TOTAL_STATS: TotalStats = {
	contextTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	reasoningTokens: 0,
	requestCount: 0,
	totalDuration: 0,
	totalCost: 0,
	subagentTokensInput: 0,
	subagentTokensOutput: 0,
	subagentCount: 0,
	totalInputTokens: 0,
	totalOutputTokens: 0,
};

function upsertUserMessage(targetSession: ChatSession, incoming: UserMessage): void {
	if (!incoming.id) return;
	targetSession.userMessagesById[incoming.id] = {
		...(targetSession.userMessagesById[incoming.id] || {}),
		...incoming,
	};
}

function upsertSubtaskMessage(targetSession: ChatSession, incoming: SubtaskMessage): void {
	if (!incoming.id) return;
	const existing = targetSession.subtasksById[incoming.id];
	targetSession.subtasksById[incoming.id] = {
		...(existing || {}),
		...incoming,
		id: incoming.id,
		type: 'subtask',
		agent: incoming.agent || existing?.agent || 'subagent',
		prompt: incoming.prompt || existing?.prompt || '',
		description: incoming.description || existing?.description || 'Subtask',
		status: incoming.status || existing?.status || 'running',
		timestamp: incoming.timestamp || existing?.timestamp || new Date().toISOString(),
	};
}

function removeProjectedMessage(targetSession: ChatSession, message: RenderMessage): void {
	if (message.kind === 'user' || message.kind === 'subtask') {
		delete targetSession.userMessagesById[message.id];
		delete targetSession.subtasksById[message.id];
		delete targetSession.runtimeMessagePartsById[message.id];
		delete targetSession.turnTokens[message.id];
		targetSession.runtimeMessageRecords = targetSession.runtimeMessageRecords.filter(
			record => record.id !== message.id,
		);
		return;
	}

	if (message.kind === 'assistant' || message.kind === 'thinking') {
		for (const [messageId, parts] of Object.entries(targetSession.runtimeMessagePartsById)) {
			const nextParts = parts.filter(part => part.id !== message.partId);
			if (nextParts.length === parts.length) continue;
			if (nextParts.length === 0) {
				delete targetSession.runtimeMessagePartsById[messageId];
				targetSession.runtimeMessageRecords = targetSession.runtimeMessageRecords.filter(
					record => record.id !== messageId,
				);
			} else {
				targetSession.runtimeMessagePartsById[messageId] = nextParts;
			}
			break;
		}
		return;
	}

	if (message.kind === 'tool_use') {
		for (const [messageId, parts] of Object.entries(targetSession.runtimeMessagePartsById)) {
			const nextParts = parts.filter(part => part.callId !== message.toolUseId);
			if (nextParts.length === parts.length) continue;
			if (nextParts.length === 0) {
				delete targetSession.runtimeMessagePartsById[messageId];
				targetSession.runtimeMessageRecords = targetSession.runtimeMessageRecords.filter(
					record => record.id !== messageId,
				);
			} else {
				targetSession.runtimeMessagePartsById[messageId] = nextParts;
			}
		}
	}
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
	if (message.agent) {
		targetSession.agent = message.agent === 'build' ? undefined : message.agent;
	}
}

function handleSubtaskEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const subtaskData = (payload as SessionSubtaskPayload).subtask;
	const subtaskId = subtaskData.id ?? '';
	const subtaskTimestamp = subtaskData.timestamp ?? '';
	const subtask: SubtaskMessage = {
		type: 'subtask',
		...subtaskData,
		id: subtaskId,
		timestamp: subtaskTimestamp,
	};
	upsertSubtaskMessage(targetSession, subtask);
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

function handleStatsEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const s = payload as SessionStatsPayload;
	if (s.totalStats) {
		// Token snapshot fields must be updated atomically — only when a full
		// token snapshot arrives (totalTokens > 0).  Partial stats events
		// (e.g. requestCount-only) must NOT overwrite token fields, otherwise
		// cacheReadTokens and totalTokens become desynchronized.
		const patch = s.totalStats;
		const isTokenSnapshot = typeof patch.totalTokens === 'number' && patch.totalTokens > 0;
		if (isTokenSnapshot) {
			Object.assign(targetSession.totalStats, patch);
		} else {
			// Apply only non-token fields from the patch
			const {
				totalTokens,
				contextTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreationTokens,
				reasoningTokens,
				...nonTokenFields
			} = patch;
			Object.assign(targetSession.totalStats, nonTokenFields);
		}
	}
	if (s.modelID) {
		targetSession.activeModelID = s.modelID;
		// Stamp modelID on the last user message so it's preserved per-message
		// and doesn't change when the user switches models later.
		const lastUserMsg = projectRuntimeMessages(targetSession).findLast(m => m.kind === 'user');
		if (lastUserMsg?.id && !lastUserMsg.model) {
			const storedUser = targetSession.userMessagesById[lastUserMsg.id];
			if (storedUser && !storedUser.model) storedUser.model = s.modelID;
		}
	}
	if (s.providerID) targetSession.activeProviderID = s.providerID;
}

function handleTurnTokensEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const t = payload as SessionTurnTokensPayload;
	// Use explicit userMessageId from history replay, or fall back to last user message
	const turnMsgId =
		t.userMessageId || projectRuntimeMessages(targetSession).findLast(m => m.kind === 'user')?.id;

	if (turnMsgId) {
		const existing = targetSession.turnTokens[turnMsgId];
		// Snapshot overwrite: totalTokens from CLI is the context window size (last value wins).
		// Skip zero-total events (empty/aborted messages) to avoid overwriting real data.
		// Duration is summed across steps (each step = separate API call).
		const hasRealTokens = t.totalTokens > 0;
		targetSession.turnTokens[turnMsgId] = {
			input: hasRealTokens ? t.inputTokens : (existing?.input ?? 0),
			output: hasRealTokens ? t.outputTokens : (existing?.output ?? 0),
			total: hasRealTokens ? t.totalTokens : (existing?.total ?? 0),
			cacheRead: hasRealTokens ? t.cacheReadTokens : (existing?.cacheRead ?? 0),
			durationMs: t.durationMs ?? existing?.durationMs,
		};
	}
}

function handleCompleteEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const complete = payload as import('../../common').SessionCompletePayload;
	const completePartId = complete.partId;
	const completedAt = complete.completedAt;

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

	// Mark completed subtasks in a second pass.
	for (const msg of projectRuntimeMessages(targetSession)) {
		if (msg.kind !== 'subtask' || !msg.id) continue;
		const partId = (targetSession.subtasksById[msg.id] as { partId?: string } | undefined)?.partId;
		if (partId !== completePartId) continue;
		const stored = targetSession.subtasksById[msg.id];
		if (!stored || stored.type !== 'subtask') continue;
		stored.status = stored.status === 'running' ? 'completed' : stored.status;
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
	const existingIdx = targetSession.runtimeMessageRecords.findIndex(m => m.id === evt.message.id);
	if (existingIdx >= 0) {
		targetSession.runtimeMessageRecords[existingIdx] = {
			...targetSession.runtimeMessageRecords[existingIdx],
			...evt.message,
		};
	} else targetSession.runtimeMessageRecords.push(evt.message);
	if (targetSession.runtimeMessageRecords.length > 1) {
		targetSession.runtimeMessageRecords.sort(
			(a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
		);
	}
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
	delete targetSession.subtasksById[evt.messageId];
	delete targetSession.turnTokens[evt.messageId];
	delete targetSession.runtimeMessagePartsById[evt.messageId];
}

function _handleMessagePartEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const evt = payload as import('../../common').SessionMessagePartPayload;
	const list = targetSession.runtimeMessagePartsById[evt.part.messageId] || [];
	const idx = list.findIndex(p => p.id === evt.part.id);
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
	targetSession.pendingQuestions = applyCollectionAction(
		targetSession.pendingQuestions,
		question.action,
		question,
	);
}

function handleMessagesReloadEvent(targetSession: ChatSession, payload: SessionEventPayload): void {
	const r = payload as SessionMessagesReloadPayload;
	targetSession.runtimeMessageRecords = [];
	targetSession.runtimeMessagePartsById = {};
	targetSession.userMessagesById = {};
	targetSession.subtasksById = {};
	const displayMessages = (r.messages || [])
		.map(m => ({
			...m,
			id: m.id || generateId('msg'),
			timestamp: m.timestamp || new Date().toISOString(),
		}))
		.map(m =>
			'content' in m ? { type: 'user' as const, ...m } : { type: 'subtask' as const, ...m },
		);
	for (const message of displayMessages) {
		if (message.type === 'user') upsertUserMessage(targetSession, message as UserMessage);
		else if (message.type === 'subtask') {
			upsertSubtaskMessage(targetSession, message as SubtaskMessage);
		}
	}
}

function handleDeleteMessagesAfterEvent(
	targetSession: ChatSession,
	payload: SessionEventPayload,
): void {
	const d = payload as SessionDeleteMessagesAfterPayload;
	if (d.messageId) {
		const idx = projectRuntimeMessages(targetSession).findIndex(m => m.id === d.messageId);
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
		for (const [subtaskId, subtask] of Object.entries(targetSession.subtasksById)) {
			const partId = (subtask as { partId?: string }).partId;
			if (subtaskId === rm.messageId || partId === rm.partId) {
				delete targetSession.subtasksById[subtaskId];
			}
		}
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
	Record<SessionEventType, (session: ChatSession, payload: SessionEventPayload) => void>
> = {
	user_message: handleUserMessageEvent,
	subtask: handleSubtaskEvent,
	message_record: handleMessageRecordEvent,
	message_record_removed: handleMessageRecordRemovedEvent,
	message_part: _handleMessagePartEvent,
	message_part_delta: handleMessagePartDeltaEvent,
	message_part_removed: handleMessagePartRemovedEvent,
	status: handleStatusEvent,
	stats: handleStatsEvent,
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
): void {
	const handler = DISPATCH_HANDLERS[eventType];
	if (handler) {
		handler(targetSession, payload);
		return;
	}
	if (eventType === 'session_info') {
		const info = payload as {
			data?: { tools?: string[]; mcpServers?: string[]; autoAccept?: boolean };
		};
		if (info.data?.tools) targetSession.availableTools = info.data.tools;
		if (info.data?.mcpServers) targetSession.availableMcpServers = info.data.mcpServers;
		if (typeof info.data?.autoAccept === 'boolean') {
			targetSession.autoAccept = info.data.autoAccept;
		}
	}
}

const createEmptySession = (id: string, timestamp: number): ChatSession => ({
	id,
	agent: undefined,
	model: undefined,
	userMessagesById: {},
	subtasksById: {},
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
	totalStats: { ...DEFAULT_TOTAL_STATS },
	turnTokens: {},
	queuedMessages: [],
	availableTools: [],
	availableMcpServers: [],
	autoAccept: false,
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

	if (eventType === 'subtask') {
		const event = payload as SessionSubtaskPayload;
		return {
			...event,
			subtask: {
				...event.subtask,
				id: event.subtask.id || generateId('subtask'),
				timestamp: event.subtask.timestamp || new Date(timestamp).toISOString(),
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
							if (lifecycle.data?.totalStats) {
								actions.setTotalStats(lifecycle.data.totalStats, lifecycle.sessionId);
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

					dispatchToSession(targetSession, eventType, preparedPayload);
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
					for (const event of events) {
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
						);
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
				if (message.type === 'subtask') {
					upsertSubtaskMessage(s, message as SubtaskMessage);
				}
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
				s.subtasksById = {};
				s.runtimeMessageRecords = [];
				s.runtimeMessagePartsById = {};
				s.turnTokens = {};
			}),

		updateMessage: (id, updates, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				if (s.userMessagesById[id]) Object.assign(s.userMessagesById[id], updates);
				if (s.subtasksById[id]) Object.assign(s.subtasksById[id], updates);
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
				const projected = projectRuntimeMessages(s);
				const idx = projected.findIndex(m => m.id === id);
				if (idx !== -1) {
					const removed = projected.slice(idx + 1);
					for (const msg of removed) {
						if (!msg.id) continue;
						removeProjectedMessage(s, msg);
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
				for (const [subtaskId, subtask] of Object.entries(s.subtasksById)) {
					const subtaskPartId = (subtask as { partId?: string }).partId;
					if (subtaskPartId === partId || subtaskId === partId) delete s.subtasksById[subtaskId];
				}
			}),

		markRevertedFromMessageId: (id, sessionId) =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				s.revertedFromMessageId = id;
			}),

		clearRevertedMessages: sessionId =>
			mutateSession(set, sessionId ?? get().activeSessionId, Date.now(), s => {
				if (!s.revertedFromMessageId) return;
				const projected = projectRuntimeMessages(s);
				const idx = projected.findIndex(m => m.id === s.revertedFromMessageId);
				if (idx !== -1) {
					const removed = projected.slice(idx);
					for (const msg of removed) {
						if (!msg.id) continue;
						removeProjectedMessage(s, msg);
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
						state.sessionsById[sessionId] = createEmptySession(sessionId, now);
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
						delete state.sessionsById[sessionId];
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
				const idx = s.changedFiles.findIndex(f => f.toolUseId === file.toolUseId);
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

		setTotalStats: (stats, sessionId) =>
			mutateSession(set, sessionId, Date.now(), s => Object.assign(s.totalStats, stats)),

		startSubtask: (subtask, sessionId) =>
			mutateSession(set, sessionId, Date.now(), s => {
				upsertSubtaskMessage(s, subtask as SubtaskMessage);
			}),

		updateSubtask: (subtaskId, status, result, sessionId) => {
			set(
				produce((state: ChatState) => {
					const now = Date.now();
					// Use explicit sessionId when provided (avoids O(N) scan over all sessions)
					const sid = sessionId && state.sessionsById[sessionId] ? sessionId : undefined;
					if (!sid) return;
					const msg = state.sessionsById[sid].subtasksById[subtaskId];
					if (!msg || msg.type !== 'subtask') return;
					msg.status = status;
					msg.result = result;
					state.sessionsById[sid].lastActive = now;
				}),
			);
		},

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
				const displayMessages = messages.filter(m => m.type === 'user' || m.type === 'subtask');
				s.userMessagesById = {};
				s.subtasksById = {};
				for (const message of displayMessages) {
					if (message.type === 'user') upsertUserMessage(s, message as UserMessage);
					if (message.type === 'subtask') {
						upsertSubtaskMessage(s, message as SubtaskMessage);
					}
				}
				const lastUserWithAgent = [...displayMessages]
					.reverse()
					.find((m): m is StoredMessage & { type: 'user'; agent?: string } => m.type === 'user');
				s.agent = lastUserWithAgent?.agent;
			}),

		deleteMessagesAfterMessageId: (sessionId, messageId) =>
			mutateSession(set, sessionId, Date.now(), s => {
				const idx = projectRuntimeMessages(s).findIndex(m => m.id === messageId);
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
