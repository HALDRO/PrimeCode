/**
 * @file chatStore.ts
 * @description High-performance single source of truth for chat state keyed by session.
 * Stores all per-chat UI state (messages, input, status, streaming/tool state, stats) in `sessionsById`.
 * Uses `sessionOrder` to preserve tab ordering without O(n) lookups.
 * This design prevents cross-session leaks and enables fully parallel independent sessions.
 * Supports unified session event protocol for simplified message routing.
 */

import { produce } from 'immer';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
	CommitInfo,
	ConversationMessage,
	ExtensionMessage,
	SessionAccessPayload,
	SessionDeleteMessagesAfterPayload,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionLifecycleMessage,
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
} from '../../common';
import { computeDiffStats } from '../../common/diffStats';

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
	/** Per-session model override. Undefined means "use workspace default". */
	model?: string;
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
	handleExtensionMessage: (message: ExtensionMessage) => void;

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

	// Per-session model selection
	setSessionModel: (model: string | undefined, sessionId?: string) => void;
	getSessionModel: (sessionId?: string) => string | undefined;
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
	model: undefined,
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

// =============================================================================
// Store
// =============================================================================

export const useChatStore = create<ChatState>()(
	persist(
		(set, get) => ({
			sessionsById: {},
			sessionOrder: [],
			activeSessionId: undefined,
			editingMessageId: null,
			isImprovingPrompt: false,
			improvingPromptRequestId: null,

			actions: {
				handleExtensionMessage: (message: ExtensionMessage) => {
					// Handle session lifecycle events
					if (message.type === 'session_lifecycle') {
						const lifecycle = message as SessionLifecycleMessage;
						const actions = get().actions;

						switch (lifecycle.action) {
							case 'created':
								actions.handleSessionCreated(lifecycle.sessionId);
								break;
							case 'closed':
								actions.closeSession(lifecycle.sessionId);
								break;
							case 'switched':
								actions.switchSession(lifecycle.sessionId);
								if (lifecycle.data?.messages) {
									actions.setSessionMessages(
										lifecycle.sessionId,
										lifecycle.data.messages as Message[],
									);
								}
								if (lifecycle.data?.isProcessing !== undefined) {
									actions.setProcessing(lifecycle.data.isProcessing, lifecycle.sessionId);
								}
								if (lifecycle.data?.totalStats) {
									actions.setTotalStats(lifecycle.data.totalStats, lifecycle.sessionId);
								}
								break;
							case 'cleared':
								actions.clearMessages(lifecycle.sessionId);
								break;
						}
						return;
					}

					// Handle unified session events
					if (message.type === 'session_event') {
						const event = message as SessionEventMessage;
						// Handle sessionInfo locally if possible, or delegate
						if (event.eventType === 'session_info') {
							// session_info is typically UI state, but if we need it here...
							// For now, let's just delegate everything to dispatch
						}

						get().actions.dispatch(event.targetId, event.eventType, event.payload);
						return;
					}
				},

				dispatch: (targetId, eventType, payload) => {
					set(
						produce((state: ChatState) => {
							// Auto-create session if it doesn't exist
							if (!state.sessionsById[targetId]) {
								const newSession = createEmptySession(targetId);
								state.sessionsById[targetId] = newSession;
								if (!state.sessionOrder.includes(targetId)) {
									state.sessionOrder.push(targetId);
								}
								if (!state.activeSessionId) {
									state.activeSessionId = targetId;
								}
							}

							const targetSession = state.sessionsById[targetId];
							targetSession.lastActive = Date.now();

							switch (eventType) {
								case 'message': {
									const msgPayload = payload as SessionMessagePayload;
									const msgData = msgPayload.message;

									// Build message
									const message: Message = {
										id: msgData.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
										type: msgData.type,
										content: msgData.content,
										timestamp: msgData.timestamp || new Date().toISOString(),
										partId: msgData.partId,
										isStreaming: msgData.isStreaming,
										isDelta: msgData.isDelta,
										hidden: msgData.hidden,
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
										agent: msgData.agent,
										prompt: msgData.prompt,
										description: msgData.description,
										command: msgData.command,
										status: msgData.status,
										result: msgData.result,
										messageID: msgData.messageID,
										contextId: msgData.contextId,
										startTime: msgData.startTime,
										reasoningTokens: msgData.reasoningTokens,
										requestId: msgData.requestId,
										tool: msgData.tool,
										input: msgData.input,
										pattern: msgData.pattern,
										resolved: msgData.resolved,
										approved: msgData.approved,
										reason: msgData.reason,
										model: msgData.model,
										attachments: msgData.attachments,
										metadata: msgData.metadata,
										normalizedEntry: msgData.normalizedEntry,
									} as Message;

									const isSubtaskMessage = message.type === 'subtask';
									const hasContext = !!msgData.contextId && !isSubtaskMessage;

									// Determine storage target
									let storageSession = targetSession;
									if (hasContext) {
										const ctxId = msgData.contextId as string;
										if (!state.sessionsById[ctxId]) {
											state.sessionsById[ctxId] = createEmptySession(ctxId);
											// Hidden context buckets are not added to sessionOrder
										}
										storageSession = state.sessionsById[ctxId];
										storageSession.lastActive = Date.now();
									}

									// Merge or append
									const existingIdx = storageSession.messages.findIndex(m => {
										if (m.id === message.id) return true;
										// Safe check for partId existence
										const mPartId = 'partId' in m ? m.partId : undefined;
										const msgPartId = 'partId' in message ? message.partId : undefined;

										return (
											msgPartId !== undefined && mPartId === msgPartId && m.type === message.type
										);
									});

									if (existingIdx !== -1) {
										const existing = storageSession.messages[existingIdx];
										if (
											'isDelta' in message &&
											message.isDelta &&
											'content' in existing &&
											'content' in message
										) {
											existing.content = (existing.content || '') + (message.content || '');
											Object.assign(existing, { ...message, content: existing.content });
										} else {
											Object.assign(existing, message);
										}
									} else {
										storageSession.messages.push(message);
									}

									// Handle subtask completion/archiving
									if (
										isSubtaskMessage &&
										(message.status === 'completed' || message.status === 'error')
									) {
										const subtaskContextId = msgData.contextId as string | undefined;
										if (subtaskContextId && state.sessionsById[subtaskContextId]) {
											const contextMessages = state.sessionsById[subtaskContextId].messages;
											const subtaskMsg = storageSession.messages.find(m => m.id === message.id);
											if (subtaskMsg && subtaskMsg.type === 'subtask') {
												subtaskMsg.transcript = contextMessages;
												subtaskMsg.contextId = undefined;
											}
											delete state.sessionsById[subtaskContextId];
											// No need to update sessionOrder as context buckets aren't in it
										}
									}

									// Clear retry info on success
									if (message.type === 'assistant') {
										storageSession.retryInfo = null;
									}
									break;
								}

								case 'status': {
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
									break;
								}

								case 'stats': {
									const s = payload as SessionStatsPayload;
									if (s.tokenStats) Object.assign(targetSession.tokenStats, s.tokenStats);
									if (s.totalStats) Object.assign(targetSession.totalStats, s.totalStats);
									break;
								}

								case 'complete': {
									const completePartId = (payload as { partId?: string }).partId;
									targetSession.messages.forEach(m => {
										if ('partId' in m && m.partId === completePartId) {
											// We need to check if the message supports isStreaming
											if ((m.type === 'assistant' || m.type === 'thinking') && 'isStreaming' in m) {
												m.isStreaming = false;
											}
										}
									});
									break;
								}

								case 'restore': {
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
									} else if (r.action === 'restore_input') {
										targetSession.input = r.text || '';
									} else if (r.action === 'success') {
										if (r.canUnrevert !== undefined)
											targetSession.unrevertAvailable = r.canUnrevert;
									}
									break;
								}

								case 'file': {
									const f = payload as SessionFilePayload;
									if (f.action === 'changed' && f.filePath) {
										const fileName = f.fileName || f.filePath.split(/[/\\]/).pop() || f.filePath;

										// Recalculate diff stats logic inline or keep helper? Keeping logic inline for now to match original behavior roughly
										let linesAdded = f.linesAdded || 0;
										let linesRemoved = f.linesRemoved || 0;

										if (f.toolUseId && linesAdded === 0 && linesRemoved === 0) {
											const toolMsg = targetSession.messages.find(
												m => m.type === 'tool_use' && m.toolUseId === f.toolUseId,
											);

											if (toolMsg && toolMsg.type === 'tool_use' && toolMsg.rawInput) {
												const raw = toolMsg.rawInput as Record<string, string>;
												const oldContent = raw.old_string || raw.old_str || raw.oldString || '';
												const newContent =
													raw.new_string || raw.new_str || raw.newString || raw.content || '';
												const stats = computeDiffStats(oldContent, newContent);
												linesAdded = stats.added;
												linesRemoved = stats.removed;
											}
										}

										const newFile = {
											filePath: f.filePath,
											fileName,
											linesAdded,
											linesRemoved,
											toolUseId: f.toolUseId || '',
											timestamp: Date.now(),
										};

										const existingIdx = targetSession.changedFiles.findIndex(
											file => file.filePath === f.filePath,
										);
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
									}
									break;
								}

								case 'access': {
									const a = payload as SessionAccessPayload;
									if (a.action === 'response') {
										const msg = targetSession.messages.find(
											m => m.type === 'access_request' && m.requestId === a.requestId,
										);
										if (msg && msg.type === 'access_request') {
											msg.resolved = true;
											msg.approved = a.approved;
										}
									}
									break;
								}

								case 'messages_reload': {
									const r = payload as SessionMessagesReloadPayload;
									targetSession.messages = (r.messages || []).map(m => ({
										...m,
										id: m.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
										timestamp: m.timestamp || new Date().toISOString(),
									})) as Message[];
									break;
								}

								case 'delete_messages_after': {
									const d = payload as SessionDeleteMessagesAfterPayload;
									if (d.messageId) {
										const idx = targetSession.messages.findIndex(m => m.id === d.messageId);
										if (idx !== -1) {
											targetSession.messages = targetSession.messages.slice(0, idx + 1);
											targetSession.revertedFromMessageId = d.messageId;
										}
									}
									break;
								}

								case 'message_removed': {
									const rm = payload as SessionMessageRemovedPayload;
									if (rm.partId || rm.messageId) {
										targetSession.messages = targetSession.messages.filter(m => {
											const mPartId = 'partId' in m ? m.partId : undefined;
											return mPartId !== rm.partId && m.id !== rm.messageId;
										});
									}
									break;
								}

								case 'terminal': {
									const t = payload as SessionTerminalPayload;
									if (t.action === 'opened' && t.content) {
										targetSession.messages.push({
											id: `sys-${Date.now()}-${Math.random()}`,
											type: 'system_notice',
											content: t.content,
											timestamp: new Date().toISOString(),
										});
									}
									break;
								}
							}
						}),
					);
				},

				addMessage: (msgInput, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (!sid || !state.sessionsById[sid]) return;
							const session = state.sessionsById[sid];
							session.lastActive = Date.now();

							const messageId = msgInput.id || `msg-${Date.now()}-${Math.random()}`;
							const message = {
								...msgInput,
								id: messageId,
								timestamp:
									typeof msgInput.timestamp === 'string'
										? msgInput.timestamp
										: new Date(msgInput.timestamp || Date.now()).toISOString(),
							} as Message;

							const idx = session.messages.findIndex(m => m.id === message.id);
							if (idx !== -1) {
								Object.assign(session.messages[idx], message);
							} else {
								session.messages.push(message);
							}
						}),
					);
				},

				setProcessing: (isProcessing, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].isProcessing = isProcessing;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				setAutoRetrying: (isRetrying, retryInfo, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const s = state.sessionsById[sid];
								s.isAutoRetrying = isRetrying;
								s.retryInfo = isRetrying && retryInfo ? retryInfo : null;
								s.lastActive = Date.now();
							}
						}),
					);
				},

				setLoading: (isLoading, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].isLoading = isLoading;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				setInput: (input, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].input = input;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				appendInput: (text, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].input += text;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				setStatus: (status, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].status = status;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				setStreamingToolId: (toolId, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].streamingToolId = toolId;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				clearMessages: sessionId => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].messages = [];
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				updateMessage: (id, updates, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								const msg = session.messages.find(m => m.id === id);
								if (msg) Object.assign(msg, updates);
								session.lastActive = Date.now();
							}
						}),
					);
				},

				setEditingMessageId: id => set({ editingMessageId: id }),

				deleteMessagesFromId: (id, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								const idx = session.messages.findIndex(m => m.id === id);
								if (idx !== -1) {
									session.messages = session.messages.slice(0, idx);
									session.lastActive = Date.now();
								}
							}
						}),
					);
				},

				removeMessageByPartId: (partId, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								session.messages = session.messages.filter(m => {
									if (m.id === partId) return false;
									const mPartId = 'partId' in m ? m.partId : undefined;
									if (mPartId === partId) return false;
									const mToolUseId = 'toolUseId' in m ? m.toolUseId : undefined;
									if (mToolUseId === partId) return false;
									return true;
								});
								session.lastActive = Date.now();
							}
						}),
					);
				},

				markRevertedFromMessageId: id => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].revertedFromMessageId = id;
							}
						}),
					);
				},

				clearRevertedMessages: () => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								if (session.revertedFromMessageId) {
									const idx = session.messages.findIndex(
										m => m.id === session.revertedFromMessageId,
									);
									if (idx !== -1) {
										session.messages = session.messages.slice(0, idx);
									} else {
										session.revertedFromMessageId = null;
									}
									session.lastActive = Date.now();
								}
							}
						}),
					);
				},

				requestCreateSession: () => {}, // Handled by VSCode

				handleSessionCreated: sessionId => {
					set(
						produce((state: ChatState) => {
							if (!state.sessionsById[sessionId]) {
								state.sessionsById[sessionId] = createEmptySession(sessionId);
								if (!state.sessionOrder.includes(sessionId)) {
									state.sessionOrder.push(sessionId);
								}
								if (!state.activeSessionId) {
									state.activeSessionId = sessionId;
								}
							}
						}),
					);
				},

				switchSession: sessionId => {
					set(
						produce((state: ChatState) => {
							if (!state.sessionsById[sessionId]) {
								state.sessionsById[sessionId] = createEmptySession(sessionId);
								if (!state.sessionOrder.includes(sessionId)) {
									state.sessionOrder.push(sessionId);
								}
							}
							state.activeSessionId = sessionId;
							state.editingMessageId = null;
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
								}
							}
						}),
					);
				},

				addChangedFile: file => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								const idx = session.changedFiles.findIndex(f => f.toolUseId === file.toolUseId);
								if (idx !== -1) {
									session.changedFiles[idx] = { ...session.changedFiles[idx], ...file };
								} else {
									session.changedFiles.push(file);
								}
							}
						}),
					);
				},

				removeChangedFile: filePath => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].changedFiles = state.sessionsById[sid].changedFiles.filter(
									f => f.filePath !== filePath,
								);
							}
						}),
					);
				},

				clearChangedFiles: () => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].changedFiles = [];
							}
						}),
					);
				},

				addRestoreCommit: (commit, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								if (!session.restoreCommits.some(c => c.sha === commit.sha)) {
									session.restoreCommits.push(commit);
								}
							}
						}),
					);
				},

				clearRestoreCommits: sessionId => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].restoreCommits = [];
							}
						}),
					);
				},

				setRestoreCommits: (commits, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].restoreCommits = commits;
							}
						}),
					);
				},

				setUnrevertAvailable: (available, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].unrevertAvailable = available;
							}
						}),
					);
				},

				setTokenStats: (stats, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								Object.assign(session.tokenStats, stats);
								session.lastActive = Date.now();
							}
						}),
					);
				},

				setTotalStats: (stats, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								Object.assign(session.totalStats, stats);
								session.lastActive = Date.now();
							}
						}),
					);
				},

				startSubtask: subtask => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								if (!session.messages.some(m => m.id === subtask.id)) {
									session.messages.push(subtask);
									session.lastActive = Date.now();
								}
							}
						}),
					);
				},

				completeSubtask: (subtaskId, result) => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								const msg = session.messages.find(m => m.id === subtaskId);
								if (msg && msg.type === 'subtask') {
									msg.status = 'completed';
									msg.result = result;

									// Handle transcript/context archiving
									const contextId = msg.contextId;
									if (contextId && state.sessionsById[contextId]) {
										msg.transcript = state.sessionsById[contextId].messages;
										msg.contextId = undefined;
										delete state.sessionsById[contextId];
									}
								}
							}
						}),
					);
				},

				errorSubtask: (subtaskId, error) => {
					set(
						produce((state: ChatState) => {
							const sid = state.activeSessionId;
							if (sid && state.sessionsById[sid]) {
								const session = state.sessionsById[sid];
								const msg = session.messages.find(m => m.id === subtaskId);
								if (msg && msg.type === 'subtask') {
									msg.status = 'error';
									msg.result = error;

									const contextId = msg.contextId;
									if (contextId && state.sessionsById[contextId]) {
										msg.transcript = state.sessionsById[contextId].messages;
										msg.contextId = undefined;
										delete state.sessionsById[contextId];
									}
								}
							}
						}),
					);
				},

				setImprovingPrompt: (isImproving, requestId = null) => {
					set({ isImprovingPrompt: isImproving, improvingPromptRequestId: requestId });
				},

				setSessionMessages: (sessionId, messages) => {
					set(
						produce((state: ChatState) => {
							if (sessionId && state.sessionsById[sessionId]) {
								state.sessionsById[sessionId].messages = messages;
								state.sessionsById[sessionId].lastActive = Date.now();
							}
						}),
					);
				},

				deleteMessagesAfterMessageId: (sessionId, messageId) => {
					set(
						produce((state: ChatState) => {
							if (sessionId && state.sessionsById[sessionId]) {
								const session = state.sessionsById[sessionId];
								const idx = session.messages.findIndex(m => m.id === messageId);
								if (idx !== -1) {
									session.messages = session.messages.slice(0, idx + 1);
									session.lastActive = Date.now();
								}
							}
						}),
					);
				},

				setSessionModel: (model, sessionId) => {
					set(
						produce((state: ChatState) => {
							const sid = resolveTargetSessionId(state, sessionId);
							if (sid && state.sessionsById[sid]) {
								state.sessionsById[sid].model = model;
								state.sessionsById[sid].lastActive = Date.now();
							}
						}),
					);
				},

				getSessionModel: (sessionId): string | undefined => {
					const state = get();
					const sid = resolveTargetSessionId(state, sessionId);
					if (!sid) return undefined;
					return state.sessionsById[sid]?.model;
				},
			},
		}),
		{
			name: 'chat-storage',
			partialize: state => ({
				activeSessionId: state.activeSessionId,
				editingMessageId: state.editingMessageId,
				sessionOrder: state.sessionOrder,
				sessionsById: filterPersistedSessions(state.sessionsById, state.sessionOrder),
			}),
			version: 12,
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

function filterPersistedSessions(
	sessionsById: Record<string, ChatSession>,
	sessionOrder: string[],
): Record<string, ChatSession> {
	const filtered: Record<string, ChatSession> = {};
	for (const sid of sessionOrder) {
		if (sessionsById[sid]) {
			filtered[sid] = sessionsById[sid];
		}
	}
	return filtered;
}
