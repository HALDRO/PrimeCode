/**
 * @file chatStore.ts
 * @description High-performance single source of truth for chat state keyed by session.
 * Stores all per-chat UI state (messages, input, status, streaming/tool state, stats) in `sessionsById`.
 * Uses `sessionOrder` to preserve tab ordering without O(n) lookups.
 * This design prevents cross-session leaks and enables fully parallel independent sessions.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
	CommitInfo,
	ConversationMessage,
	SubtaskMessage,
	TokenStats,
	TotalStats,
} from '../../types';

export type { CommitInfo, ConversationMessage, SubtaskMessage, TokenStats, TotalStats };

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

export type Message = ConversationMessage;

export type MessageInput = Partial<ConversationMessage> & {
	type: ConversationMessage['type'];
};

export interface ChatSession {
	id: string;
	messages: Message[];
	input: string;
	status: string;
	streamingToolId: string | null;
	isProcessing: boolean;
	isAutoRetrying: boolean;
	retryInfo: { attempt: number; message: string; nextRetryAt?: string } | null;
	isLoading: boolean;
	lastActive: number;
	changedFiles: ChangedFile[];
	restoreCommits: CommitInfo[];
	unrevertAvailable: boolean;
	revertedFromMessageId: string | null;
	tokenStats: TokenStats;
	totalStats: TotalStats;
	isChildSession?: boolean;
	parentSessionId?: string;
}

export interface ChatState {
	sessionsById: Record<string, ChatSession>;
	sessionOrder: string[];
	activeSessionId: string | undefined;
	editingMessageId: string | null;
	// Prompt Improver state (not persisted)
	isImprovingPrompt: boolean;
	improvingPromptRequestId: string | null;
	actions: ChatActions;
}

export interface ChatActions {
	// Session-aware message actions
	addMessage: (msg: MessageInput, sessionId?: string) => void;
	addMessageToSession: (sessionId: string, msg: MessageInput, parentSessionId?: string) => void;
	removeChildSession: (sessionId: string) => void;
	clearMessages: (sessionId?: string) => void;
	updateMessage: (id: string, updates: Partial<Message>, sessionId?: string) => void;
	deleteMessagesFromId: (id: string, sessionId?: string) => void;
	removeMessageByPartId: (partId: string, sessionId?: string) => void;
	setEditingMessageId: (id: string | null) => void;

	// Per-session UI state
	setProcessing: (isProcessing: boolean, sessionId?: string) => void;
	setAutoRetrying: (
		isRetrying: boolean,
		retryInfo?: { attempt: number; message: string; nextRetryAt?: string },
		sessionId?: string,
	) => void;
	setLoading: (isLoading: boolean, sessionId?: string) => void;
	setInput: (input: string, sessionId?: string) => void;
	appendInput: (text: string, sessionId?: string) => void;
	setStatus: (status: string, sessionId?: string) => void;
	setStreamingToolId: (toolId: string | null, sessionId?: string) => void;

	// Session lifecycle
	requestCreateSession: () => void;
	handleSessionCreated: (sessionId: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => void;

	// File & restore data (active session by default)
	addChangedFile: (file: ChangedFile) => void;
	removeChangedFile: (filePath: string) => void;
	clearChangedFiles: () => void;
	addRestoreCommit: (commit: CommitInfo, sessionId?: string) => void;
	clearRestoreCommits: (sessionId?: string) => void;
	setRestoreCommits: (commits: CommitInfo[], sessionId?: string) => void;
	setUnrevertAvailable: (available: boolean, sessionId?: string) => void;

	// Stats
	setTokenStats: (stats: Partial<TokenStats>, sessionId?: string) => void;
	setTotalStats: (stats: Partial<TotalStats>, sessionId?: string) => void;

	// Subtask actions (active session)
	startSubtask: (subtask: SubtaskMessage) => void;
	addChildToSubtask: (subtaskId: string, childMessageId: string) => void;
	completeSubtask: (subtaskId: string, result?: string) => void;
	errorSubtask: (subtaskId: string, error: string) => void;
	linkChildSessionToSubtask: (childSessionId: string, subtaskId: string) => void;

	// Active session revert marker
	markRevertedFromMessageId: (id: string | null) => void;
	clearRevertedMessages: () => void;

	// Prompt Improver actions
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;

	// Bulk message operations (for extension message handlers)
	setSessionMessages: (sessionId: string, messages: Message[]) => void;
	deleteMessagesAfterMessageId: (sessionId: string, messageId: string) => void;
}

// =============================================================================
// Defaults (exported for use in selectors)
// =============================================================================

export const DEFAULT_TOKEN_STATS: TokenStats = {
	totalTokensInput: 0,
	totalTokensOutput: 0,
	currentInputTokens: 0,
	currentOutputTokens: 0,
	cacheCreationTokens: 0,
	cacheReadTokens: 0,
	reasoningTokens: 0,
	totalReasoningTokens: 0,
	subagentTokensInput: 0,
	subagentTokensOutput: 0,
};

export const DEFAULT_TOTAL_STATS: TotalStats = {
	totalCost: 0,
	totalTokensInput: 0,
	totalTokensOutput: 0,
	totalReasoningTokens: 0,
	requestCount: 0,
	totalDuration: 0,
};

const createEmptySession = (id: string): ChatSession => ({
	id,
	messages: [],
	input: '',
	status: 'Ready',
	streamingToolId: null,
	isProcessing: false,
	isAutoRetrying: false,
	retryInfo: null,
	isLoading: false,
	lastActive: Date.now(),
	changedFiles: [],
	restoreCommits: [],
	unrevertAvailable: false,
	revertedFromMessageId: null,
	tokenStats: { ...DEFAULT_TOKEN_STATS },
	totalStats: { ...DEFAULT_TOTAL_STATS },
});

function resolveTargetSessionId(state: ChatState, sessionId?: string): string | undefined {
	return sessionId || state.activeSessionId;
}

function warnMissingSession(actionName: string): void {
	console.warn(`[chatStore] ${actionName} ignored: missing sessionId and no activeSessionId`);
}

function upsertSession(
	state: ChatState,
	session: ChatSession,
	options?: { ensureOrder?: boolean },
): ChatState {
	const exists = !!state.sessionsById[session.id];
	const ensureOrder = options?.ensureOrder !== false;
	const sessionOrder =
		ensureOrder && !exists && !state.sessionOrder.includes(session.id)
			? [...state.sessionOrder, session.id]
			: state.sessionOrder;
	return {
		...state,
		sessionsById: { ...state.sessionsById, [session.id]: session },
		sessionOrder,
	};
}

function updateSessionById(
	state: ChatState,
	sessionId: string,
	updater: (session: ChatSession) => ChatSession,
): ChatState {
	const existing = state.sessionsById[sessionId];
	if (!existing) {
		return state;
	}
	return {
		...state,
		sessionsById: { ...state.sessionsById, [sessionId]: updater(existing) },
	};
}

function removeSession(state: ChatState, sessionId: string): ChatState {
	if (!state.sessionsById[sessionId]) {
		return state;
	}
	const { [sessionId]: _removed, ...rest } = state.sessionsById;
	return {
		...state,
		sessionsById: rest,
		sessionOrder: state.sessionOrder.filter(id => id !== sessionId),
	};
}

function filterPersistedSessions(
	sessionsById: Record<string, ChatSession>,
): Record<string, ChatSession> {
	const next: Record<string, ChatSession> = {};
	for (const [id, session] of Object.entries(sessionsById)) {
		if (session.isChildSession) continue;
		next[id] = session;
	}
	return next;
}

// =============================================================================
// Store
// =============================================================================

export const useChatStore = create<ChatState>()(
	persist(
		set => ({
			sessionsById: {},
			sessionOrder: [],
			activeSessionId: undefined,
			editingMessageId: null,
			isImprovingPrompt: false,
			improvingPromptRequestId: null,

			actions: {
				addMessage: (msgInput, sessionId) => {
					set(state => {
						const targetSessionId = resolveTargetSessionId(state, sessionId);
						if (!targetSessionId) {
							warnMissingSession('addMessage');
							return state;
						}

						const targetSession = state.sessionsById[targetSessionId];
						if (!targetSession) {
							return state;
						}

						const messageId = msgInput.id || `msg-${Date.now()}-${Math.random()}`;
						const message: Message = {
							...msgInput,
							id: messageId,
							timestamp:
								typeof msgInput.timestamp === 'string'
									? msgInput.timestamp
									: new Date(msgInput.timestamp || Date.now()).toISOString(),
						} as Message;

						const existingIdx = targetSession.messages.findIndex(m => m.id === message.id);
						const newMessages = [...targetSession.messages];
						if (existingIdx !== -1) {
							newMessages[existingIdx] = {
								...newMessages[existingIdx],
								...message,
								id: newMessages[existingIdx].id,
							} as Message;
						} else {
							newMessages.push(message);
						}

						return updateSessionById(state, targetSessionId, s => ({
							...s,
							messages: newMessages,
							lastActive: Date.now(),
						}));
					});
				},

				addMessageToSession: (sessionId, msg, parentSessionId) => {
					set(state => {
						const message = {
							id: `msg-${Date.now()}-${Math.random()}`,
							timestamp: new Date().toISOString(),
							...msg,
						} as Message;

						const existing = state.sessionsById[sessionId];
						if (!existing) {
							const newSession: ChatSession = {
								...createEmptySession(sessionId),
								messages: [message],
								isChildSession: true,
								parentSessionId: parentSessionId || state.activeSessionId,
							};
							return upsertSession(state, newSession);
						}

						return updateSessionById(state, sessionId, s => ({
							...s,
							messages: [...s.messages, message],
							lastActive: Date.now(),
						}));
					});
				},

				removeChildSession: sessionId => {
					set(state => removeSession(state, sessionId));
				},

				setProcessing: (isProcessing, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setProcessing');
							return state;
						}
						return updateSessionById(state, sid, s => ({
							...s,
							isProcessing,
							lastActive: Date.now(),
						}));
					});
				},

				setAutoRetrying: (isRetrying, retryInfo, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setAutoRetrying');
							return state;
						}
						return updateSessionById(state, sid, s => ({
							...s,
							isAutoRetrying: isRetrying,
							retryInfo: isRetrying && retryInfo ? retryInfo : null,
							lastActive: Date.now(),
						}));
					});
				},

				setLoading: (isLoading, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setLoading');
							return state;
						}
						return updateSessionById(state, sid, s => ({
							...s,
							isLoading,
							lastActive: Date.now(),
						}));
					});
				},

				setInput: (input, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setInput');
							return state;
						}
						return updateSessionById(state, sid, s => ({ ...s, input, lastActive: Date.now() }));
					});
				},

				appendInput: (text, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('appendInput');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							input: session.input + text,
							lastActive: Date.now(),
						}));
					});
				},

				setStatus: (status, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setStatus');
							return state;
						}
						return updateSessionById(state, sid, s => ({ ...s, status, lastActive: Date.now() }));
					});
				},

				setStreamingToolId: (toolId, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setStreamingToolId');
							return state;
						}
						return updateSessionById(state, sid, s => ({
							...s,
							streamingToolId: toolId,
							lastActive: Date.now(),
						}));
					});
				},

				clearMessages: sessionId => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('clearMessages');
							return state;
						}
						return updateSessionById(state, sid, s => ({
							...s,
							messages: [],
							lastActive: Date.now(),
						}));
					});
				},

				updateMessage: (id, updates, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('updateMessage');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						const newMessages = session.messages.map(msg =>
							msg.id === id ? ({ ...msg, ...updates } as Message) : msg,
						);
						return updateSessionById(state, sid, s => ({
							...s,
							messages: newMessages,
							lastActive: Date.now(),
						}));
					});
				},

				setEditingMessageId: (id: string | null) => set({ editingMessageId: id }),

				deleteMessagesFromId: (id, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('deleteMessagesFromId');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						const index = session.messages.findIndex(m => m.id === id);
						if (index === -1) return state;
						const newMessages = session.messages.slice(0, index);
						return updateSessionById(state, sid, s => ({
							...s,
							messages: newMessages,
							lastActive: Date.now(),
						}));
					});
				},

				removeMessageByPartId: (partId, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('removeMessageByPartId');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						const newMessages = session.messages.filter(m => {
							if (m.id === partId) return false;
							if ('partId' in m && m.partId === partId) return false;
							if ('toolUseId' in m && m.toolUseId === partId) return false;
							return true;
						});
						if (newMessages.length === session.messages.length) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							messages: newMessages,
							lastActive: Date.now(),
						}));
					});
				},

				markRevertedFromMessageId: id => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) {
							warnMissingSession('markRevertedFromMessageId');
							return state;
						}
						return updateSessionById(state, sid, s => ({ ...s, revertedFromMessageId: id }));
					});
				},

				clearRevertedMessages: () => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session?.revertedFromMessageId) return state;

						const index = session.messages.findIndex(m => m.id === session.revertedFromMessageId);
						if (index === -1) {
							return updateSessionById(state, sid, s => ({ ...s, revertedFromMessageId: null }));
						}
						const newMessages = session.messages.slice(0, index);
						return updateSessionById(state, sid, s => ({
							...s,
							messages: newMessages,
							revertedFromMessageId: null,
							lastActive: Date.now(),
						}));
					});
				},

				requestCreateSession: () => {
					// Handled via VS Code message passing
				},

				handleSessionCreated: sessionId => {
					set(state => {
						if (state.sessionsById[sessionId]) return state;
						const newSession = createEmptySession(sessionId);
						const next = upsertSession(state, newSession);
						return { ...next, activeSessionId: state.activeSessionId ?? sessionId };
					});
				},

				switchSession: sessionId => {
					set(state => {
						if (!state.sessionsById[sessionId]) {
							console.warn(`[chatStore] Cannot switch to non-existent session: ${sessionId}`);
							return state;
						}
						return { ...state, activeSessionId: sessionId, editingMessageId: null };
					});
				},

				closeSession: sessionId => {
					set(state => {
						if (state.sessionOrder.length <= 1) return state;
						const nextState = removeSession(state, sessionId);
						const isActive = state.activeSessionId === sessionId;
						const nextActive = isActive
							? nextState.sessionOrder[nextState.sessionOrder.length - 1]
							: nextState.activeSessionId;
						return { ...nextState, activeSessionId: nextActive };
					});
				},

				addChangedFile: file => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) {
							warnMissingSession('addChangedFile');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;

						const existingByToolUseId = session.changedFiles.findIndex(
							f => f.toolUseId && f.toolUseId === file.toolUseId,
						);
						let newFiles: ChangedFile[];
						if (existingByToolUseId >= 0) {
							newFiles = session.changedFiles.map((f, i) =>
								i === existingByToolUseId
									? {
											...f,
											linesAdded: file.linesAdded,
											linesRemoved: file.linesRemoved,
											timestamp: file.timestamp,
										}
									: f,
							);
						} else {
							newFiles = [...session.changedFiles, file];
						}

						return updateSessionById(state, sid, s => ({ ...s, changedFiles: newFiles }));
					});
				},

				removeChangedFile: filePath => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						const newFiles = session.changedFiles.filter(f => f.filePath !== filePath);
						return updateSessionById(state, sid, s => ({ ...s, changedFiles: newFiles }));
					});
				},

				clearChangedFiles: () => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						return updateSessionById(state, sid, s => ({ ...s, changedFiles: [] }));
					});
				},

				addRestoreCommit: (commit, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('addRestoreCommit');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						if (session.restoreCommits.some(c => c.sha === commit.sha)) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							restoreCommits: [...s.restoreCommits, commit],
						}));
					});
				},

				clearRestoreCommits: sessionId => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) return state;
						return updateSessionById(state, sid, s => ({ ...s, restoreCommits: [] }));
					});
				},

				setRestoreCommits: (commits, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) return state;
						return updateSessionById(state, sid, s => ({ ...s, restoreCommits: commits }));
					});
				},

				setUnrevertAvailable: (available, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) return state;
						return updateSessionById(state, sid, s => ({ ...s, unrevertAvailable: available }));
					});
				},

				setTokenStats: (stats, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setTokenStats');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							tokenStats: { ...session.tokenStats, ...stats },
							lastActive: Date.now(),
						}));
					});
				},

				setTotalStats: (stats, sessionId) => {
					set(state => {
						const sid = resolveTargetSessionId(state, sessionId);
						if (!sid) {
							warnMissingSession('setTotalStats');
							return state;
						}
						const session = state.sessionsById[sid];
						if (!session) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							totalStats: { ...session.totalStats, ...stats },
							lastActive: Date.now(),
						}));
					});
				},

				startSubtask: subtask => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						if (session.messages.some(m => m.id === subtask.id)) return state;
						return updateSessionById(state, sid, s => ({
							...s,
							messages: [...s.messages, subtask],
							lastActive: Date.now(),
						}));
					});
				},

				addChildToSubtask: (subtaskId, childMessageId) => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						const idx = session.messages.findIndex(m => m.id === subtaskId);
						if (idx === -1) return state;
						const msg = session.messages[idx];
						if (msg.type !== 'subtask') return state;
						if (msg.childMessages?.includes(childMessageId)) return state;
						const updated = {
							...msg,
							childMessages: [...(msg.childMessages || []), childMessageId],
						};
						const newMessages = [...session.messages];
						newMessages[idx] = updated;
						return updateSessionById(state, sid, s => ({ ...s, messages: newMessages }));
					});
				},

				completeSubtask: (subtaskId, result) => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						const idx = session.messages.findIndex(m => m.id === subtaskId);
						if (idx === -1) return state;
						const msg = session.messages[idx];
						if (msg.type !== 'subtask') return state;

						const updated = { ...msg, status: 'completed' as const, result };
						const newMessages = [...session.messages];
						newMessages[idx] = updated;

						const nextState = msg.childSessionId ? removeSession(state, msg.childSessionId) : state;
						return updateSessionById(nextState, sid, s => ({ ...s, messages: newMessages }));
					});
				},

				errorSubtask: (subtaskId, error) => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						const idx = session.messages.findIndex(m => m.id === subtaskId);
						if (idx === -1) return state;
						const msg = session.messages[idx];
						if (msg.type !== 'subtask') return state;

						const updated = { ...msg, status: 'error' as const, result: error };
						const newMessages = [...session.messages];
						newMessages[idx] = updated;

						const nextState = msg.childSessionId ? removeSession(state, msg.childSessionId) : state;
						return updateSessionById(nextState, sid, s => ({ ...s, messages: newMessages }));
					});
				},

				linkChildSessionToSubtask: (childSessionId, subtaskId) => {
					set(state => {
						const sid = state.activeSessionId;
						if (!sid) return state;
						const session = state.sessionsById[sid];
						if (!session) return state;
						const idx = session.messages.findIndex(m => m.id === subtaskId);
						if (idx === -1) return state;
						const msg = session.messages[idx];
						if (msg.type !== 'subtask') return state;

						const updated = { ...msg, childSessionId };
						const newMessages = [...session.messages];
						newMessages[idx] = updated;
						return updateSessionById(state, sid, s => ({ ...s, messages: newMessages }));
					});
				},

				setImprovingPrompt: (isImproving, requestId = null) => {
					set({ isImprovingPrompt: isImproving, improvingPromptRequestId: requestId });
				},

				setSessionMessages: (sessionId, messages) => {
					set(state => {
						if (!sessionId) {
							warnMissingSession('setSessionMessages');
							return state;
						}
						const session = state.sessionsById[sessionId];
						if (!session) return state;
						return updateSessionById(state, sessionId, s => ({
							...s,
							messages,
							lastActive: Date.now(),
						}));
					});
				},

				deleteMessagesAfterMessageId: (sessionId, messageId) => {
					set(state => {
						if (!sessionId) {
							warnMissingSession('deleteMessagesAfterMessageId');
							return state;
						}
						const session = state.sessionsById[sessionId];
						if (!session) return state;
						const idx = session.messages.findIndex(m => m.id === messageId);
						if (idx === -1) return state;
						// Keep messages up to and including the target message
						const newMessages = session.messages.slice(0, idx + 1);
						return updateSessionById(state, sessionId, s => ({
							...s,
							messages: newMessages,
							lastActive: Date.now(),
						}));
					});
				},
			},
		}),
		{
			name: 'chat-storage',
			partialize: state => ({
				activeSessionId: state.activeSessionId,
				editingMessageId: state.editingMessageId,
				sessionOrder: state.sessionOrder,
				sessionsById: filterPersistedSessions(state.sessionsById),
			}),
			version: 9,
			migrate: (persistedState, version) => {
				if (version < 9) {
					return {
						sessionsById: {},
						sessionOrder: [],
						activeSessionId: undefined,
						editingMessageId: null,
					} as unknown as ChatState;
				}
				return persistedState as ChatState;
			},
		},
	),
);
