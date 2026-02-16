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
	SessionTurnTokensPayload,
	SubtaskMessage,
	TotalStats,
} from '../../common';
import { generateId } from '../../common';
import type { NormalizedEntry } from '../../common/normalizedTypes';
import { useUIStore } from './uiStore';

export type { CommitInfo, ConversationMessage, SubtaskMessage, TotalStats };

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

export type Message = ConversationMessage & { normalizedEntry?: NormalizedEntry };

type MessageInput = Partial<ConversationMessage> & {
	type: ConversationMessage['type'];
};

export interface ChatSession {
	id: string;
	/** Per-session model override. Undefined means "use workspace default". */
	model?: string;
	/** Model ID reported by the backend for the current/last request. */
	activeModelID?: string;
	/** Provider ID reported by the backend for the current/last request. */
	activeProviderID?: string;
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
	totalStats: TotalStats;
	turnTokens: Record<
		string,
		{ input: number; output: number; total: number; cacheRead: number; durationMs?: number }
	>;
}

export interface ChatState {
	sessionsById: Record<string, ChatSession>;
	sessionOrder: string[];
	activeSessionId: string | undefined;
	editingMessageId: string | null;
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
	handleExtensionMessage: (message: ExtensionMessage) => void;

	// ==========================================================================
	// Session-aware message actions
	// ==========================================================================

	addMessage: (msg: MessageInput, sessionId?: string) => void;
	clearMessages: (sessionId?: string) => void;
	updateMessage: (id: string, updates: Partial<Message>, sessionId?: string) => void;
	/** Deletes all messages AFTER the given id, keeping the message itself. */
	deleteMessagesAfterId: (id: string, sessionId?: string) => void;
	removeMessageByPartId: (partId: string, sessionId?: string) => void;
	setEditingMessageId: (id: string | null) => void;

	// Per-session UI state — universal setter + convenience wrappers
	updateSession: (updates: Partial<ChatSession>, sessionId?: string) => void;
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
	setTotalStats: (stats: Partial<TotalStats>, sessionId?: string) => void;

	// Subtask actions (active session)
	startSubtask: (subtask: SubtaskMessage) => void;
	updateSubtask: (subtaskId: string, status: 'completed' | 'error', result?: string) => void;

	// Active session revert marker
	markRevertedFromMessageId: (id: string | null) => void;
	clearRevertedMessages: () => void;

	// Prompt Improver actions
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;
	/** Clear the stored prompt versions (e.g. after sending or discarding). */
	clearPromptVersions: () => void;
	/** Toggle between original and improved prompt text. */
	togglePromptVersion: () => void;

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
	totalStats: { ...DEFAULT_TOTAL_STATS },
	turnTokens: {},
});

function resolveTargetSessionId(state: ChatState, sessionId?: string): string | undefined {
	return sessionId || state.activeSessionId;
}

// =============================================================================
// Helpers — eliminate per-action boilerplate
// =============================================================================

type ZustandSet = (
	partial: ChatState | Partial<ChatState> | ((state: ChatState) => ChatState | Partial<ChatState>),
) => void;

/** Mutate a target session inside produce(). Resolves sessionId, guards null, updates lastActive. */
function mutateSession(
	set: ZustandSet,
	sessionId: string | undefined,
	mutator: (session: ChatSession, state: ChatState) => void,
): void {
	set(
		produce((state: ChatState) => {
			const sid = resolveTargetSessionId(state, sessionId);
			if (!sid || !state.sessionsById[sid]) return;
			mutator(state.sessionsById[sid], state);
			state.sessionsById[sid].lastActive = Date.now();
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
									lifecycle.data.messages as Message[],
								);
							}
							if (lifecycle.data?.isProcessing !== undefined) {
								actions.setProcessing(lifecycle.data.isProcessing, lifecycle.sessionId);
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
					actions.setInput(improvedText);
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
						timestamp: new Date().toISOString(),
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
		},

		dispatch: (targetId, eventType, payload) => {
			set(
				produce((state: ChatState) => {
					// Auto-create session if it doesn't exist (for sub-sessions receiving events).
					// Sessions intended for the tab bar are created via handleSessionCreated.
					if (!state.sessionsById[targetId]) {
						state.sessionsById[targetId] = createEmptySession(targetId);
					}

					const targetSession = state.sessionsById[targetId];
					targetSession.lastActive = Date.now();

					switch (eventType) {
						case 'message': {
							const msgData = (payload as SessionMessagePayload).message;

							const message: Message = {
								...msgData,
								id: msgData.id || generateId('msg'),
								timestamp: msgData.timestamp || new Date().toISOString(),
							} as Message;

							// Notification-like messages are transient UI overlays,
							// and should not be stored in chat history/persistence.
							if (
								message.type === 'error' ||
								message.type === 'interrupted' ||
								message.type === 'system_notice'
							) {
								break;
							}

							const storageSession = targetSession;

							// Merge or append
							const existingIdx = storageSession.messages.findIndex(m => {
								if (m.id === message.id) return true;
								// Safe check for partId existence
								const mPartId = 'partId' in m ? m.partId : undefined;
								const msgPartId = 'partId' in message ? message.partId : undefined;

								return msgPartId !== undefined && mPartId === msgPartId && m.type === message.type;
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
									// Preserve startTime from the first chunk — don't let subsequent deltas overwrite it
									const preservedStartTime =
										'startTime' in existing ? existing.startTime : undefined;
									Object.assign(existing, { ...message, content: existing.content });
									if (preservedStartTime !== undefined && 'startTime' in existing) {
										(existing as { startTime: number }).startTime = preservedStartTime as number;
									}
								} else {
									// For non-delta merges, also preserve startTime if already set
									const preservedStartTime =
										'startTime' in existing ? existing.startTime : undefined;
									const preservedSubtaskMeta =
										existing.type === 'subtask'
											? {
													description: existing.description,
													prompt: existing.prompt,
													agent: existing.agent,
													startTime: existing.startTime,
												}
											: undefined;
									Object.assign(existing, message);
									if (existing.type === 'subtask' && preservedSubtaskMeta) {
										if (!existing.description && preservedSubtaskMeta.description) {
											existing.description = preservedSubtaskMeta.description;
										}
										if (!existing.prompt && preservedSubtaskMeta.prompt) {
											existing.prompt = preservedSubtaskMeta.prompt;
										}
										if (!existing.agent && preservedSubtaskMeta.agent) {
											existing.agent = preservedSubtaskMeta.agent;
										}
										if (!existing.startTime && preservedSubtaskMeta.startTime) {
											existing.startTime = preservedSubtaskMeta.startTime;
										}
									}
									if (preservedStartTime !== undefined && 'startTime' in existing) {
										(existing as { startTime: number }).startTime = preservedStartTime as number;
									}
								}
							} else {
								storageSession.messages.push(message);
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
							if (s.totalStats) Object.assign(targetSession.totalStats, s.totalStats);
							if (s.modelID) targetSession.activeModelID = s.modelID;
							if (s.providerID) targetSession.activeProviderID = s.providerID;
							break;
						}

						case 'turn_tokens': {
							const t = payload as SessionTurnTokensPayload;
							// Use explicit userMessageId from history replay, or fall back to last user message
							const turnMsgId =
								t.userMessageId ||
								[...targetSession.messages].reverse().find(m => m.type === 'user')?.id;
							if (turnMsgId) {
								const existing = targetSession.turnTokens[turnMsgId];
								targetSession.turnTokens[turnMsgId] = {
									input: t.inputTokens,
									output: t.outputTokens,
									total: t.totalTokens,
									cacheRead: t.cacheReadTokens,
									// Accumulate duration for live streaming (multiple turn_tokens per turn)
									durationMs: t.durationMs
										? (existing?.durationMs ?? 0) + t.durationMs
										: existing?.durationMs,
								};
							}
							break;
						}

						case 'complete': {
							const completePartId = (payload as { partId?: string }).partId;
							targetSession.messages.forEach(m => {
								if ('partId' in m && m.partId === completePartId) {
									if (m.type === 'thinking') {
										m.isStreaming = false;
										// Compute duration from startTime if not already set
										if (!m.durationMs && m.startTime && typeof m.startTime === 'number') {
											m.durationMs = Date.now() - m.startTime;
										}
									} else if (m.type === 'assistant') {
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
								// When unrevert becomes unavailable (after unrevert action), clear the reverted marker
								if (!r.available) {
									targetSession.revertedFromMessageId = null;
								}
							} else if (r.action === 'restore_input') {
								targetSession.input = r.text || '';
							} else if (r.action === 'success') {
								if (r.canUnrevert !== undefined) targetSession.unrevertAvailable = r.canUnrevert;
								// Mark the revert point so the UI dims messages after it
								if (r.revertedFromMessageId) {
									targetSession.revertedFromMessageId = r.revertedFromMessageId;
								}
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
										const oldLineCount = oldContent ? oldContent.split('\n').length : 0;
										const newLineCount = newContent ? newContent.split('\n').length : 0;
										linesAdded = Math.max(0, newLineCount - oldLineCount);
										linesRemoved = Math.max(0, oldLineCount - newLineCount);
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
								id: m.id || generateId('msg'),
								timestamp: m.timestamp || new Date().toISOString(),
							})) as Message[];
							break;
						}

						case 'delete_messages_after': {
							const d = payload as SessionDeleteMessagesAfterPayload;
							if (d.messageId) {
								const idx = targetSession.messages.findIndex(m => m.id === d.messageId);
								if (idx !== -1) {
									// Don't delete messages — just mark them as reverted so they can be
									// restored on unrevert. The UI will dim everything after this ID.
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

						case 'terminal':
							// Terminal notifications are transient UI overlays; ignore in chat history.
							break;
					}
				}),
			);
		},

		addMessage: (msgInput, sessionId) =>
			mutateSession(set, sessionId, s => {
				const message = {
					...msgInput,
					id: msgInput.id || `msg-${Date.now()}-${Math.random()}`,
					timestamp:
						typeof msgInput.timestamp === 'string'
							? msgInput.timestamp
							: new Date(msgInput.timestamp || Date.now()).toISOString(),
				} as Message;
				const idx = s.messages.findIndex(m => m.id === message.id);
				if (idx !== -1) {
					Object.assign(s.messages[idx], message);
				} else {
					s.messages.push(message);
				}
			}),

		updateSession: (updates, sessionId) =>
			mutateSession(set, sessionId, s => Object.assign(s, updates)),

		setProcessing: (isProcessing, sessionId) =>
			get().actions.updateSession({ isProcessing }, sessionId),

		setAutoRetrying: (isRetrying, retryInfo, sessionId) =>
			get().actions.updateSession(
				{ isAutoRetrying: isRetrying, retryInfo: isRetrying && retryInfo ? retryInfo : null },
				sessionId,
			),

		setLoading: (isLoading, sessionId) => get().actions.updateSession({ isLoading }, sessionId),

		setInput: (input, sessionId) => get().actions.updateSession({ input }, sessionId),

		appendInput: (text, sessionId) =>
			mutateSession(set, sessionId, s => {
				s.input += text;
			}),

		setStatus: (status, sessionId) => get().actions.updateSession({ status }, sessionId),

		setStreamingToolId: (toolId, sessionId) =>
			get().actions.updateSession({ streamingToolId: toolId }, sessionId),

		clearMessages: sessionId =>
			mutateSession(set, sessionId, s => {
				s.messages = [];
				s.turnTokens = {};
			}),

		updateMessage: (id, updates, sessionId) =>
			mutateSession(set, sessionId, s => {
				const msg = s.messages.find(m => m.id === id);
				if (msg) Object.assign(msg, updates);
			}),

		setEditingMessageId: id => set({ editingMessageId: id }),

		deleteMessagesAfterId: (id, sessionId) =>
			mutateSession(set, sessionId, s => {
				const idx = s.messages.findIndex(m => m.id === id);
				if (idx !== -1) {
					// Clean up turnTokens for removed user messages
					const removed = s.messages.slice(idx + 1);
					for (const msg of removed) {
						if (msg.type === 'user' && msg.id) {
							delete s.turnTokens[msg.id];
						}
					}
					// Keep the message itself, delete everything AFTER it
					s.messages = s.messages.slice(0, idx + 1);
					// Also clear any revertedFromMessageId since we are actively editing
					s.revertedFromMessageId = null;
				}
			}),

		removeMessageByPartId: (partId, sessionId) =>
			mutateSession(set, sessionId, s => {
				s.messages = s.messages.filter(m => {
					if (m.id === partId) return false;
					const mPartId = 'partId' in m ? m.partId : undefined;
					if (mPartId === partId) return false;
					const mToolUseId = 'toolUseId' in m ? m.toolUseId : undefined;
					return mToolUseId !== partId;
				});
			}),

		markRevertedFromMessageId: id =>
			mutateSession(set, undefined, s => {
				s.revertedFromMessageId = id;
			}),

		clearRevertedMessages: () =>
			mutateSession(set, undefined, s => {
				if (!s.revertedFromMessageId) return;
				const idx = s.messages.findIndex(m => m.id === s.revertedFromMessageId);
				if (idx !== -1) {
					s.messages = s.messages.slice(0, idx);
				} else {
					s.revertedFromMessageId = null;
				}
			}),

		handleSessionCreated: sessionId => {
			set(
				produce((state: ChatState) => {
					if (!state.sessionsById[sessionId]) {
						state.sessionsById[sessionId] = createEmptySession(sessionId);
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

		addChangedFile: file =>
			mutateSession(set, undefined, s => {
				const idx = s.changedFiles.findIndex(f => f.toolUseId === file.toolUseId);
				if (idx !== -1) {
					s.changedFiles[idx] = { ...s.changedFiles[idx], ...file };
				} else {
					s.changedFiles.push(file);
				}
			}),

		removeChangedFile: filePath =>
			mutateSession(set, undefined, s => {
				s.changedFiles = s.changedFiles.filter(f => f.filePath !== filePath);
			}),

		clearChangedFiles: () =>
			mutateSession(set, undefined, s => {
				s.changedFiles = [];
			}),

		addRestoreCommit: (commit, sessionId) =>
			mutateSession(set, sessionId, s => {
				if (!s.restoreCommits.some(c => c.sha === commit.sha)) s.restoreCommits.push(commit);
			}),

		clearRestoreCommits: sessionId =>
			get().actions.updateSession({ restoreCommits: [] }, sessionId),

		setRestoreCommits: (commits, sessionId) =>
			get().actions.updateSession({ restoreCommits: commits }, sessionId),

		setUnrevertAvailable: (available, sessionId) =>
			get().actions.updateSession({ unrevertAvailable: available }, sessionId),

		setTotalStats: (stats, sessionId) =>
			mutateSession(set, sessionId, s => Object.assign(s.totalStats, stats)),

		startSubtask: subtask =>
			mutateSession(set, undefined, s => {
				if (!s.messages.some(m => m.id === subtask.id)) s.messages.push(subtask);
			}),

		updateSubtask: (subtaskId, status, result) => {
			set(
				produce((state: ChatState) => {
					const sid = state.activeSessionId;
					if (!sid || !state.sessionsById[sid]) return;
					const msg = state.sessionsById[sid].messages.find(m => m.id === subtaskId);
					if (!msg || msg.type !== 'subtask') return;
					msg.status = status;
					msg.result = result;
					// Compute duration from startTime if available
					if (!msg.durationMs && msg.startTime) {
						const start =
							typeof msg.startTime === 'number' ? msg.startTime : new Date(msg.startTime).getTime();
						if (start > 0) msg.durationMs = Date.now() - start;
					}
					// Archive context transcript
					const contextId = msg.contextId;
					if (contextId && state.sessionsById[contextId]) {
						msg.transcript = state.sessionsById[contextId].messages;
						msg.contextId = undefined;
						delete state.sessionsById[contextId];
					}
					state.sessionsById[sid].lastActive = Date.now();
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
				state.actions.setInput(next ? improved : original);
				set({ promptVersions: { original, improved, showingImproved: next } });
			}
		},

		setSessionMessages: (sessionId, messages) =>
			mutateSession(set, sessionId, s => {
				s.messages = messages;
			}),

		deleteMessagesAfterMessageId: (sessionId, messageId) =>
			mutateSession(set, sessionId, s => {
				const idx = s.messages.findIndex(m => m.id === messageId);
				if (idx !== -1) s.messages = s.messages.slice(0, idx + 1);
			}),

		setSessionModel: (model, sessionId) => get().actions.updateSession({ model }, sessionId),

		getSessionModel: (sessionId): string | undefined => {
			const state = get();
			const sid = resolveTargetSessionId(state, sessionId);
			if (!sid) return undefined;
			return state.sessionsById[sid]?.model;
		},
	},
}));
