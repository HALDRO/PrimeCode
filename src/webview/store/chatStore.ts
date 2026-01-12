/**
 * @file chatStore.ts
 * @description Global state management for chat sessions using Zustand.
 * Handles messages, session lifecycle, processing state, and UI-specific session data.
 * Implements streaming message deduplication for OpenCode's cumulative text/reasoning updates.
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
	lastActive: number;
	changedFiles: ChangedFile[];
	restoreCommits: CommitInfo[];
	unrevertAvailable: boolean;
	revertedFromMessageId: string | null;
	tokenStats: TokenStats;
	totalStats: TotalStats;
}

export interface ChatState {
	sessions: ChatSession[];
	activeSessionId: string | undefined;
	messages: Message[];
	isProcessing: boolean;
	isAutoRetrying: boolean;
	retryInfo: { attempt: number; message: string; nextRetryAt?: string } | null;
	isLoading: boolean;
	input: string;
	status: string;
	streamingToolId: string | null;
	editingMessageId: string | null;
	changedFiles: ChangedFile[];
	restoreCommits: CommitInfo[];
	unrevertAvailable: boolean; // Active session derived state
	revertedFromMessageId: string | null; // Messages from this ID onwards are marked for deletion on next send
	tokenStats: TokenStats;
	totalStats: TotalStats;
	// Prompt Improver state (not persisted)
	isImprovingPrompt: boolean;
	improvingPromptRequestId: string | null;
	actions: ChatActions;
}

export interface ChatActions {
	addMessage: (msg: MessageInput) => void;
	setProcessing: (isProcessing: boolean) => void;
	setAutoRetrying: (
		isRetrying: boolean,
		retryInfo?: { attempt: number; message: string; nextRetryAt?: string },
	) => void;
	setLoading: (isLoading: boolean) => void;
	setInput: (input: string) => void;
	appendInput: (text: string) => void;
	setStatus: (status: string) => void;
	setStreamingToolId: (toolId: string | null) => void;
	clearMessages: () => void;
	updateMessage: (id: string, updates: Partial<Message>) => void;
	setEditingMessageId: (id: string | null) => void;
	deleteMessagesFromId: (id: string) => void;
	removeMessageByPartId: (partId: string) => void;
	markRevertedFromMessageId: (id: string | null) => void;
	clearRevertedMessages: () => void;
	requestCreateSession: () => void;
	handleSessionCreated: (sessionId: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => void;
	addChangedFile: (file: ChangedFile) => void;
	removeChangedFile: (filePath: string) => void;
	clearChangedFiles: () => void;
	addRestoreCommit: (commit: CommitInfo, sessionId?: string) => void;
	clearRestoreCommits: (sessionId?: string) => void;
	setRestoreCommits: (commits: CommitInfo[], sessionId?: string) => void;
	setUnrevertAvailable: (available: boolean, sessionId?: string) => void;
	setTokenStats: (stats: Partial<TokenStats>) => void;
	setTotalStats: (stats: Partial<TotalStats>) => void;
	// Subtask actions
	startSubtask: (subtask: SubtaskMessage) => void;
	addChildToSubtask: (subtaskId: string, childMessageId: string) => void;
	completeSubtask: (subtaskId: string, result?: string) => void;
	errorSubtask: (subtaskId: string, error: string) => void;
	linkChildSessionToSubtask: (childSessionId: string, subtaskId: string) => void;
	// Prompt Improver actions
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;
}

// =============================================================================
// Initial State & Helpers
// =============================================================================

const DEFAULT_TOKEN_STATS: TokenStats = {
	totalTokensInput: 0,
	totalTokensOutput: 0,
	currentInputTokens: 0,
	currentOutputTokens: 0,
	cacheCreationTokens: 0,
	cacheReadTokens: 0,
	reasoningTokens: 0,
	totalReasoningTokens: 0,
};

const DEFAULT_TOTAL_STATS: TotalStats = {
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
	lastActive: Date.now(),
	changedFiles: [],
	restoreCommits: [],
	unrevertAvailable: false,
	revertedFromMessageId: null,
	tokenStats: { ...DEFAULT_TOKEN_STATS },
	totalStats: { ...DEFAULT_TOTAL_STATS },
});

// =============================================================================
// Store Implementation
// =============================================================================

export const useChatStore = create<ChatState>()(
	persist(
		set => ({
			// Initial State - empty, will be populated by backend via sessionCreated message
			sessions: [],
			activeSessionId: undefined,
			// Messages are loaded from backend on demand, not persisted in global state
			messages: [],
			isProcessing: false,
			isAutoRetrying: false,
			retryInfo: null,
			isLoading: false,
			input: '',
			status: 'Ready',
			streamingToolId: null,
			editingMessageId: null,
			changedFiles: [],
			restoreCommits: [],
			unrevertAvailable: false,
			revertedFromMessageId: null,
			tokenStats: { ...DEFAULT_TOKEN_STATS },
			totalStats: { ...DEFAULT_TOTAL_STATS },
			// Prompt Improver state (not persisted)
			isImprovingPrompt: false,
			improvingPromptRequestId: null,

			actions: {
				addMessage: msgInput => {
					set(state => {
						const messageId = msgInput.id || `msg-${Date.now()}-${Math.random()}`;
						const message: Message = {
							...msgInput,
							id: messageId,
							timestamp:
								typeof msgInput.timestamp === 'string'
									? msgInput.timestamp
									: new Date(msgInput.timestamp || Date.now()).toISOString(),
						} as Message;

						const existingIdx = state.messages.findIndex(m => m.id === message.id);
						const newMessages = [...state.messages];

						if (existingIdx !== -1) {
							newMessages[existingIdx] = {
								...newMessages[existingIdx],
								...message,
								id: newMessages[existingIdx].id,
							} as Message;
						} else {
							newMessages.push(message);
						}

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				startSubtask: subtask => {
					set(state => {
						const exists = state.messages.some(m => m.id === subtask.id);
						if (exists) {
							return state;
						} // Already exists

						const newMessages = [...state.messages, subtask];
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);
						return { messages: newMessages, sessions };
					});
				},

				addChildToSubtask: (subtaskId, childMessageId) => {
					set(state => {
						const subtaskIndex = state.messages.findIndex(m => m.id === subtaskId);
						if (subtaskIndex === -1) {
							return state;
						}

						const subtask = state.messages[subtaskIndex];
						if (subtask.type !== 'subtask') {
							return state;
						}

						// Avoid duplicates
						if (subtask.childMessages?.includes(childMessageId)) {
							return state;
						}

						const newSubtask = {
							...subtask,
							childMessages: [...(subtask.childMessages || []), childMessageId],
						};

						const newMessages = [...state.messages];
						newMessages[subtaskIndex] = newSubtask;

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				completeSubtask: (subtaskId, result) => {
					set(state => {
						const subtaskIndex = state.messages.findIndex(m => m.id === subtaskId);
						if (subtaskIndex === -1) {
							return state;
						}

						const subtask = state.messages[subtaskIndex];
						if (subtask.type !== 'subtask') {
							return state;
						}

						const newSubtask = {
							...subtask,
							status: 'completed' as const,
							result,
						};

						const newMessages = [...state.messages];
						newMessages[subtaskIndex] = newSubtask;

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				errorSubtask: (subtaskId, error) => {
					set(state => {
						const subtaskIndex = state.messages.findIndex(m => m.id === subtaskId);
						if (subtaskIndex === -1) {
							return state;
						}

						const subtask = state.messages[subtaskIndex];
						if (subtask.type !== 'subtask') {
							return state;
						}

						const newSubtask = {
							...subtask,
							status: 'error' as const,
							result: error,
						};

						const newMessages = [...state.messages];
						newMessages[subtaskIndex] = newSubtask;

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				linkChildSessionToSubtask: (childSessionId, subtaskId) => {
					set(state => {
						const subtaskIndex = state.messages.findIndex(m => m.id === subtaskId);
						if (subtaskIndex === -1) {
							return state;
						}

						const subtask = state.messages[subtaskIndex];
						if (subtask.type !== 'subtask') {
							return state;
						}

						const newSubtask = {
							...subtask,
							childSessionId,
						};

						const newMessages = [...state.messages];
						newMessages[subtaskIndex] = newSubtask;

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				setProcessing: isProcessing => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, lastActive: Date.now() } : s,
						);
						return { isProcessing, sessions };
					});
				},

				setAutoRetrying: (isRetrying, retryInfo) => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, lastActive: Date.now() } : s,
						);
						return {
							isAutoRetrying: isRetrying,
							retryInfo: isRetrying && retryInfo ? retryInfo : null,
							sessions,
						};
					});
				},

				setLoading: isLoading => set({ isLoading }),

				setInput: input => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, input, lastActive: Date.now() } : s,
						);
						return { input, sessions };
					});
				},

				appendInput: text => {
					set(state => {
						const newInput = state.input + text;
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, input: newInput, lastActive: Date.now() }
								: s,
						);
						return { input: newInput, sessions };
					});
				},

				setStatus: (status: string) => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, status, lastActive: Date.now() } : s,
						);
						return { status, sessions };
					});
				},

				setStreamingToolId: toolId => set({ streamingToolId: toolId }),

				clearMessages: () => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, messages: [], lastActive: Date.now() } : s,
						);
						return { messages: [], sessions };
					});
				},

				updateMessage: (id, updates) => {
					set(state => {
						const newMessages = state.messages.map(msg =>
							msg.id === id ? { ...msg, ...updates } : msg,
						) as Message[];

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				setEditingMessageId: id => set({ editingMessageId: id }),

				deleteMessagesFromId: id => {
					set(state => {
						const index = state.messages.findIndex(m => m.id === id);
						if (index === -1) {
							return state;
						}

						const newMessages = state.messages.slice(0, index);
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				removeMessageByPartId: partId => {
					set(state => {
						// Filter out messages that match the partId (checking id, partId, toolUseId)
						const newMessages = state.messages.filter(m => {
							if (m.id === partId) {
								return false;
							}
							if ('partId' in m && m.partId === partId) {
								return false;
							}
							if ('toolUseId' in m && m.toolUseId === partId) {
								return false;
							}
							return true;
						});

						if (newMessages.length === state.messages.length) {
							return state;
						}

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? { ...s, messages: newMessages, lastActive: Date.now() }
								: s,
						);

						return { messages: newMessages, sessions };
					});
				},

				markRevertedFromMessageId: id => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, revertedFromMessageId: id } : s,
						);
						return { revertedFromMessageId: id, sessions };
					});
				},

				clearRevertedMessages: () => {
					set(state => {
						if (!state.revertedFromMessageId) {
							return state;
						}

						const index = state.messages.findIndex(m => m.id === state.revertedFromMessageId);
						if (index === -1) {
							const sessions = state.sessions.map(s =>
								s.id === state.activeSessionId ? { ...s, revertedFromMessageId: null } : s,
							);
							return { revertedFromMessageId: null, sessions };
						}

						const newMessages = state.messages.slice(0, index);
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? {
										...s,
										messages: newMessages,
										revertedFromMessageId: null,
										lastActive: Date.now(),
									}
								: s,
						);

						return { messages: newMessages, sessions, revertedFromMessageId: null };
					});
				},

				requestCreateSession: () => {
					// Placeholder - actual implementation handled via VS Code message passing
				},

				handleSessionCreated: sessionId => {
					set(state => {
						// Only return state if session already exists, prevent unnecessary updates
						if (state.sessions.some(s => s.id === sessionId)) {
							return state;
						}

						const newSession = createEmptySession(sessionId);

						// If there's no active session yet, make this one active
						if (!state.activeSessionId) {
							console.debug(`[ChatStore] Setting initial active session: ${sessionId}`);
							return {
								sessions: [...state.sessions, newSession],
								activeSessionId: sessionId,
								...getEmptySessionState(newSession),
							};
						}

						// Otherwise just add it to the background sessions list
						console.debug(`[ChatStore] Adding background session: ${sessionId}`);
						return {
							sessions: [...state.sessions, newSession],
						};
					});
				},

				switchSession: sessionId => {
					set(state => {
						const targetSession = state.sessions.find(s => s.id === sessionId);
						if (!targetSession) {
							console.warn(`[ChatStore] Cannot switch to non-existent session: ${sessionId}`);
							return state;
						}

						console.debug(`[ChatStore] Switching to session: ${sessionId}`);

						// Save current session state
						const updatedSessions = state.sessions.map(s =>
							s.id === state.activeSessionId
								? {
										...s,
										messages: state.messages,
										input: state.input,
										status: state.status,
										changedFiles: state.changedFiles,
										restoreCommits: state.restoreCommits,
										unrevertAvailable: state.unrevertAvailable,
										revertedFromMessageId: state.revertedFromMessageId,
										tokenStats: state.tokenStats,
										totalStats: state.totalStats,
										lastActive: Date.now(),
									}
								: s,
						);

						return {
							sessions: updatedSessions,
							activeSessionId: sessionId,
							messages: targetSession.messages,
							input: targetSession.input,
							status: targetSession.status,
							changedFiles: targetSession.changedFiles,
							restoreCommits: targetSession.restoreCommits,
							unrevertAvailable: targetSession.unrevertAvailable,
							revertedFromMessageId: targetSession.revertedFromMessageId,
							tokenStats: targetSession.tokenStats,
							totalStats: targetSession.totalStats,
							editingMessageId: null,
							streamingToolId: null,
						};
					});
				},

				closeSession: sessionId => {
					set(state => {
						if (state.sessions.length <= 1) {
							return state;
						}

						const newSessions = state.sessions.filter(s => s.id !== sessionId);
						const isActive = state.activeSessionId === sessionId;
						const nextSession = isActive ? newSessions[newSessions.length - 1] : undefined;

						if (isActive && nextSession) {
							return {
								sessions: newSessions,
								activeSessionId: nextSession.id,
								messages: nextSession.messages,
								input: nextSession.input,
								status: nextSession.status,
								changedFiles: nextSession.changedFiles,
								restoreCommits: nextSession.restoreCommits,
								unrevertAvailable: nextSession.unrevertAvailable,
								revertedFromMessageId: nextSession.revertedFromMessageId,
								tokenStats: nextSession.tokenStats,
								totalStats: nextSession.totalStats,
							};
						}

						return { sessions: newSessions };
					});
				},

				addChangedFile: file => {
					set(state => {
						// Find by toolUseId first (same edit event), then by filePath without toolUseId
						const existingByToolUseId = state.changedFiles.findIndex(
							f => f.toolUseId && f.toolUseId === file.toolUseId,
						);

						let newFiles: ChangedFile[];
						if (existingByToolUseId >= 0) {
							// Same toolUseId - replace values (same edit event, e.g. streaming update)
							newFiles = state.changedFiles.map((f, i) =>
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
							// Different toolUseId - add as new entry (separate edit to same or different file)
							// This allows tracking each edit separately for per-message stats
							newFiles = [...state.changedFiles, file];
						}

						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, changedFiles: newFiles } : s,
						);

						return { changedFiles: newFiles, sessions };
					});
				},

				removeChangedFile: filePath => {
					set(state => {
						const newFiles = state.changedFiles.filter(f => f.filePath !== filePath);
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, changedFiles: newFiles } : s,
						);
						return { changedFiles: newFiles, sessions };
					});
				},

				clearChangedFiles: () => {
					set(state => {
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, changedFiles: [] } : s,
						);
						return { changedFiles: [], sessions };
					});
				},

				addRestoreCommit: (commit, targetSessionId) => {
					set(state => {
						const sessionId = targetSessionId || state.activeSessionId;
						const targetSession = state.sessions.find(s => s.id === sessionId);
						if (!targetSession) {
							return state;
						}

						const existingCommits =
							sessionId === state.activeSessionId
								? state.restoreCommits
								: targetSession.restoreCommits;
						if (existingCommits.some(c => c.sha === commit.sha)) {
							return state;
						}

						const newCommits = [...existingCommits, commit];
						const sessions = state.sessions.map(s =>
							s.id === sessionId ? { ...s, restoreCommits: newCommits } : s,
						);

						return sessionId === state.activeSessionId
							? { restoreCommits: newCommits, sessions }
							: { sessions };
					});
				},

				clearRestoreCommits: targetSessionId => {
					set(state => {
						const sessionId = targetSessionId || state.activeSessionId;
						const targetSession = state.sessions.find(s => s.id === sessionId);
						if (!targetSession) {
							return state;
						}

						const sessions = state.sessions.map(s =>
							s.id === sessionId ? { ...s, restoreCommits: [] } : s,
						);

						return sessionId === state.activeSessionId
							? { restoreCommits: [], sessions }
							: { sessions };
					});
				},

				setRestoreCommits: (commits, targetSessionId) => {
					set(state => {
						const sessionId = targetSessionId || state.activeSessionId;
						const targetSession = state.sessions.find(s => s.id === sessionId);
						if (!targetSession) {
							return state;
						}

						const sessions = state.sessions.map(s =>
							s.id === sessionId ? { ...s, restoreCommits: commits } : s,
						);

						return sessionId === state.activeSessionId
							? { restoreCommits: commits, sessions }
							: { sessions };
					});
				},

				setUnrevertAvailable: (available, targetSessionId) => {
					set(state => {
						const sessionId = targetSessionId || state.activeSessionId;
						const targetSession = state.sessions.find(s => s.id === sessionId);
						if (!targetSession) {
							return state;
						}

						const sessions = state.sessions.map(s =>
							s.id === sessionId ? { ...s, unrevertAvailable: available } : s,
						);

						return sessionId === state.activeSessionId
							? { unrevertAvailable: available, sessions }
							: { sessions };
					});
				},

				setTokenStats: stats => {
					set(state => {
						const newStats = { ...state.tokenStats, ...stats };
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, tokenStats: newStats } : s,
						);
						return { tokenStats: newStats, sessions };
					});
				},

				setTotalStats: stats => {
					set(state => {
						const newStats = { ...state.totalStats, ...stats };
						const sessions = state.sessions.map(s =>
							s.id === state.activeSessionId ? { ...s, totalStats: newStats } : s,
						);
						return { totalStats: newStats, sessions };
					});
				},

				setImprovingPrompt: (isImproving, requestId = null) => {
					set({ isImprovingPrompt: isImproving, improvingPromptRequestId: requestId });
				},
			},
		}),
		{
			name: 'chat-storage',
			partialize: state => ({
				// Persist UI state that isn't managed by the backend
				input: state.input,
				activeSessionId: state.activeSessionId,
				changedFiles: state.changedFiles,
				tokenStats: state.tokenStats,
				totalStats: state.totalStats,
			}),
			version: 7,
			migrate: (persistedState, version) => {
				if (version === 1) {
					// Migration logic for v1 to v2 if needed
					return persistedState as ChatState;
				}
				// Remove old thinkingIntensity fields from persisted state
				if (version <= 6) {
					const s = persistedState as ChatState & {
						thinkingIntensity?: string;
						thinkingIntensityByModel?: Record<string, string>;
					};
					delete s.thinkingIntensity;
					delete s.thinkingIntensityByModel;
					return s as ChatState;
				}
				return persistedState as ChatState;
			},
		},
	),
);

// =============================================================================
// Helper Functions
// =============================================================================

function getEmptySessionState(session: ChatSession) {
	return {
		messages: session.messages,
		input: session.input,
		status: session.status,
		changedFiles: session.changedFiles,
		restoreCommits: session.restoreCommits,
		unrevertAvailable: session.unrevertAvailable,
		revertedFromMessageId: session.revertedFromMessageId,
		tokenStats: session.tokenStats,
		totalStats: session.totalStats,
		editingMessageId: null,
		streamingToolId: null,
	};
}

// =============================================================================
// Selectors
// =============================================================================

export const useChatActions = () => useChatStore(state => state.actions);
export const useMessages = () => useChatStore(state => state.messages);
export const useChatInputState = () =>
	useChatStore(state => ({ input: state.input, isLoading: state.isLoading }));
export const useIsProcessing = () => useChatStore(state => state.isProcessing);
export const useIsAutoRetrying = () => useChatStore(state => state.isAutoRetrying);
export const useRetryInfo = () => useChatStore(state => state.retryInfo);
export const useStreamingToolId = () => useChatStore(state => state.streamingToolId);
export const useSessionState = () =>
	useChatStore(state => ({
		sessions: state.sessions,
		activeSessionId: state.activeSessionId,
	}));

// Prompt Improver selectors
export const useIsImprovingPrompt = () => useChatStore(state => state.isImprovingPrompt);
export const useImprovingPromptRequestId = () =>
	useChatStore(state => state.improvingPromptRequestId);
