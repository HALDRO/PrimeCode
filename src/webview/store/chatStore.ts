/**
 * @file chatStore.ts
 * @description High-performance single source of truth for chat state keyed by session.
 * Stores all per-chat UI state (messages, input, status, streaming/tool state, stats) in `sessionsById`.
 * Uses `sessionOrder` to preserve tab ordering without O(n) lookups.
 * This design prevents cross-session leaks and enables fully parallel independent sessions.
 * Supports unified session event protocol for simplified message routing.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
	CommitInfo,
	ConversationMessage,
	SessionAccessPayload,
	SessionDeleteMessagesAfterPayload,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionMessagePayload,
	SessionMessageRemovedPayload,
	SessionMessagesReloadPayload,
	SessionRestorePayload,
	SessionStatsPayload,
	SessionStatusPayload,
	SessionTerminalPayload,
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
	// ==========================================================================
	// Unified Session Event Dispatch (new architecture)
	// ==========================================================================

	/**
	 * Unified event dispatcher for session events from the extension.
	 * Routes events to the correct session based on targetId.
	 * Auto-creates child sessions if they don't exist.
	 */
	dispatch: (targetId: string, eventType: SessionEventType, payload: SessionEventPayload) => void;

	// ==========================================================================
	// Session-aware message actions
	// ==========================================================================

	addMessage: (msg: MessageInput, sessionId?: string) => void;
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
	completeSubtask: (subtaskId: string, result?: string) => void;
	errorSubtask: (subtaskId: string, error: string) => void;

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
	return sessionsById;
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
				// ==========================================================================
				// Unified Session Event Dispatch (new architecture)
				// ==========================================================================

				dispatch: (targetId, eventType, payload) => {
					set(state => {
						// Get or create target session
						let targetSession = state.sessionsById[targetId];
						let newState = state;

						// Auto-create session if it doesn't exist.
						// Do NOT infer child/parent by activeSessionId: that heuristic breaks
						// for background sessions and during initialization races.
						if (!targetSession) {
							const newSession: ChatSession = {
								...createEmptySession(targetId),
							};
							newState = upsertSession(state, newSession, { ensureOrder: true });
							targetSession = newState.sessionsById[targetId];
						}

						switch (eventType) {
							case 'message': {
								const msgPayload = payload as SessionMessagePayload;
								const msgData = msgPayload.message;

								// Build message from payload
								const message: Message = {
									id: msgData.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
									type: msgData.type,
									content: msgData.content,
									timestamp: msgData.timestamp || new Date().toISOString(),
									partId: msgData.partId,
									isStreaming: msgData.isStreaming,
									isDelta: msgData.isDelta,
									hidden: msgData.hidden,
									// Tool fields
									toolName: msgData.toolName,
									toolUseId: msgData.toolUseId,
									toolInput: msgData.toolInput,
									rawInput: msgData.rawInput,
									filePath: msgData.filePath,
									isError: msgData.isError,
									isRunning: msgData.isRunning,
									streamingOutput: msgData.streamingOutput,
									estimatedTokens: msgData.estimatedTokens,
									title: msgData.title,
									durationMs: msgData.durationMs,
									// Subtask fields
									agent: msgData.agent,
									prompt: msgData.prompt,
									description: msgData.description,
									command: msgData.command,
									status: msgData.status,
									result: msgData.result,
									messageID: msgData.messageID,
									contextId: msgData.contextId,
									startTime: msgData.startTime,
									// Thinking fields
									reasoningTokens: msgData.reasoningTokens,
									// Access request fields
									requestId: msgData.requestId,
									tool: msgData.tool,
									input: msgData.input,
									pattern: msgData.pattern,
									resolved: msgData.resolved,
									approved: msgData.approved,
									// Error fields
									reason: msgData.reason,
									// Model info
									model: msgData.model,
									// Attachments
									attachments: msgData.attachments,
									metadata: msgData.metadata,
								} as Message;

								// Merge or append message
								// Use type assertion for partId since it's not in all message types
								const msgPartId = (message as { partId?: string }).partId;
								const existingIdx = targetSession.messages.findIndex(m => {
									const mPartId = (m as { partId?: string }).partId;
									return m.id === message.id || (msgPartId && mPartId === msgPartId);
								});
								const newMessages = [...targetSession.messages];

								if (existingIdx !== -1) {
									// Merge with existing message
									newMessages[existingIdx] = {
										...newMessages[existingIdx],
										...message,
										id: newMessages[existingIdx].id,
									} as Message;
								} else {
									newMessages.push(message);
								}

								return updateSessionById(newState, targetId, s => ({
									...s,
									messages: newMessages,
									lastActive: Date.now(),
								}));
							}

							case 'status': {
								const statusPayload = payload as SessionStatusPayload;
								return updateSessionById(newState, targetId, s => {
									const nextStatus =
										statusPayload.status === 'retrying'
											? statusPayload.retryInfo?.message || s.status
											: statusPayload.statusText || s.status;
									return {
										...s,
										isProcessing: statusPayload.status === 'busy',
										isAutoRetrying: statusPayload.status === 'retrying',
										retryInfo: statusPayload.retryInfo || null,
										status: nextStatus,
										isLoading: Boolean(statusPayload.loadingMessage),
										lastActive: Date.now(),
									};
								});
							}

							case 'stats': {
								const statsPayload = payload as SessionStatsPayload;
								return updateSessionById(newState, targetId, s => ({
									...s,
									tokenStats: statsPayload.tokenStats
										? { ...s.tokenStats, ...statsPayload.tokenStats }
										: s.tokenStats,
									totalStats: statsPayload.totalStats
										? { ...s.totalStats, ...statsPayload.totalStats }
										: s.totalStats,
									lastActive: Date.now(),
								}));
							}

							case 'complete': {
								// Mark streaming as complete for a part
								// Find message by partId and mark as not streaming
								const completePartId = (payload as { partId?: string }).partId;
								return updateSessionById(newState, targetId, s => ({
									...s,
									messages: s.messages.map(m => {
										const mPartId = (m as { partId?: string }).partId;
										return mPartId === completePartId ? { ...m, isStreaming: false } : m;
									}),
									lastActive: Date.now(),
								}));
							}

							case 'restore': {
								const restorePayload = payload as SessionRestorePayload;
								switch (restorePayload.action) {
									case 'add_commit':
										if (restorePayload.commit) {
											const existingCommits = targetSession.restoreCommits || [];
											const commitToAdd = restorePayload.commit;
											const alreadyExists = existingCommits.some(c => c.sha === commitToAdd.sha);
											if (!alreadyExists) {
												return updateSessionById(newState, targetId, s => ({
													...s,
													restoreCommits: [...existingCommits, commitToAdd],
													lastActive: Date.now(),
												}));
											}
										}
										return newState;

									case 'set_commits':
										return updateSessionById(newState, targetId, s => ({
											...s,
											restoreCommits: restorePayload.commits || [],
											lastActive: Date.now(),
										}));

									case 'clear_commits':
										return updateSessionById(newState, targetId, s => ({
											...s,
											restoreCommits: [],
											lastActive: Date.now(),
										}));

									case 'unrevert_available':
										return updateSessionById(newState, targetId, s => ({
											...s,
											unrevertAvailable: restorePayload.available ?? false,
											lastActive: Date.now(),
										}));

									case 'restore_input':
										return updateSessionById(newState, targetId, s => ({
											...s,
											input: restorePayload.text || '',
											lastActive: Date.now(),
										}));

									case 'success':
										// Update unrevert availability if provided
										if (restorePayload.canUnrevert !== undefined) {
											return updateSessionById(newState, targetId, s => ({
												...s,
												unrevertAvailable: restorePayload.canUnrevert ?? false,
												lastActive: Date.now(),
											}));
										}
										return newState;

									case 'error':
									case 'progress':
										// These are informational, no state change needed
										return newState;

									default:
										return newState;
								}
							}

							case 'file': {
								const filePayload = payload as SessionFilePayload;
								switch (filePayload.action) {
									case 'changed':
										if (filePayload.filePath) {
											const fileName =
												filePayload.fileName ||
												filePayload.filePath.split(/[/\\]/).pop() ||
												filePayload.filePath;
											const newFile = {
												filePath: filePayload.filePath,
												fileName,
												linesAdded: filePayload.linesAdded || 0,
												linesRemoved: filePayload.linesRemoved || 0,
												toolUseId: filePayload.toolUseId || '',
												timestamp: Date.now(),
											};
											const existingFiles = targetSession.changedFiles || [];
											const existingIdx = existingFiles.findIndex(
												f => f.filePath === filePayload.filePath,
											);
											const newFiles =
												existingIdx !== -1
													? existingFiles.map((f, i) => (i === existingIdx ? newFile : f))
													: [...existingFiles, newFile];
											return updateSessionById(newState, targetId, s => ({
												...s,
												changedFiles: newFiles,
												lastActive: Date.now(),
											}));
										}
										return newState;

									case 'undone':
										if (filePayload.filePath) {
											return updateSessionById(newState, targetId, s => ({
												...s,
												changedFiles: (s.changedFiles || []).filter(
													f => f.filePath !== filePayload.filePath,
												),
												lastActive: Date.now(),
											}));
										}
										return newState;

									case 'all_undone':
										return updateSessionById(newState, targetId, s => ({
											...s,
											changedFiles: [],
											lastActive: Date.now(),
										}));

									default:
										return newState;
								}
							}

							case 'access': {
								const accessPayload = payload as SessionAccessPayload;
								if (accessPayload.action === 'response') {
									// Find and update the access_request message
									const updatedMessages = targetSession.messages.map(m => {
										if (
											m.type === 'access_request' &&
											(m as { requestId?: string }).requestId === accessPayload.requestId
										) {
											return {
												...m,
												resolved: true,
												approved: accessPayload.approved,
											};
										}
										return m;
									});
									return updateSessionById(newState, targetId, s => ({
										...s,
										messages: updatedMessages,
										lastActive: Date.now(),
									}));
								}
								return newState;
							}

							case 'messages_reload': {
								const reloadPayload = payload as SessionMessagesReloadPayload;
								const messages = (reloadPayload.messages || []).map(
									(m: { id?: string; timestamp?: string }) => ({
										...m,
										id: m.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
										timestamp: m.timestamp || new Date().toISOString(),
									}),
								) as Message[];
								return updateSessionById(newState, targetId, s => ({
									...s,
									messages,
									lastActive: Date.now(),
								}));
							}

							case 'delete_messages_after': {
								const deletePayload = payload as SessionDeleteMessagesAfterPayload;
								const messageId = deletePayload.messageId;
								if (!messageId) return newState;

								const idx = targetSession.messages.findIndex(m => m.id === messageId);
								if (idx === -1) return newState;

								// Keep messages up to and including the target message
								const newMessages = targetSession.messages.slice(0, idx + 1);
								return updateSessionById(newState, targetId, s => ({
									...s,
									messages: newMessages,
									revertedFromMessageId: messageId,
									lastActive: Date.now(),
								}));
							}

							case 'message_removed': {
								const removedPayload = payload as SessionMessageRemovedPayload;
								if (removedPayload.partId || removedPayload.messageId) {
									const newMessages = targetSession.messages.filter(m => {
										const mPartId = (m as { partId?: string }).partId;
										return mPartId !== removedPayload.partId && m.id !== removedPayload.messageId;
									});
									return updateSessionById(newState, targetId, s => ({
										...s,
										messages: newMessages,
										lastActive: Date.now(),
									}));
								}
								return newState;
							}

							case 'terminal': {
								const terminalPayload = payload as SessionTerminalPayload;
								if (terminalPayload.action === 'opened' && terminalPayload.content) {
									const message: Message = {
										id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
										type: 'system_notice',
										content: terminalPayload.content,
										timestamp: new Date().toISOString(),
									};
									const newMessages = [...targetSession.messages, message];
									return updateSessionById(newState, targetId, s => ({
										...s,
										messages: newMessages,
										lastActive: Date.now(),
									}));
								}
								return newState;
							}

							case 'auth':
							case 'session_info':
								// These events are informational and don't require state changes
								// They may be handled by other listeners (e.g., useExtensionMessages)
								return newState;

							default:
								console.warn(`[chatStore] Unknown event type: ${eventType}`);
								return newState;
						}
					});
				},

				// ==========================================================================
				// Direct actions (used by dispatch and external callers)
				// ==========================================================================

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

						const updated = {
							...msg,
							status: 'completed' as const,
							result,
							transcript: msg.contextId
								? (state.sessionsById[msg.contextId]?.messages ?? [])
								: (msg as unknown as { transcript?: Message[] }).transcript,
							// Child session is archived into transcript; clear it to avoid keeping references.
							contextId: undefined,
						};
						const newMessages = [...session.messages];
						newMessages[idx] = updated;

						// Release context session memory after subtask completion.
						// Messages are archived into transcript field.
						const nextState = msg.contextId ? removeSession(state, msg.contextId) : state;
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

						const updated = {
							...msg,
							status: 'error' as const,
							result: error,
							transcript: msg.contextId
								? (state.sessionsById[msg.contextId]?.messages ?? [])
								: (msg as unknown as { transcript?: Message[] }).transcript,
							// Child session is archived into transcript; clear it to avoid keeping references.
							contextId: undefined,
						};
						const newMessages = [...session.messages];
						newMessages[idx] = updated;

						// Release context session memory after subtask error.
						const nextState = msg.contextId ? removeSession(state, msg.contextId) : state;
						return updateSessionById(nextState, sid, s => ({ ...s, messages: newMessages }));
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
			version: 11,
			migrate: (persistedState, version) => {
				// Version 11: Remove child-session heuristics and persist all sessions.
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
