/**
 * @file chatStore.ts
 * @description SDK-native Zustand store for the webview.
 */

import type {
	AssistantMessage,
	Message,
	Part,
	PermissionRequest,
	QuestionRequest,
	Session,
	SessionStatus,
	SnapshotFileDiff,
	Todo,
	ToolPart,
} from '@opencode-ai/sdk/v2/client';
import { produce } from 'immer';
import { create } from 'zustand';
import type { NormalizedEntry } from '../../common/normalizedTypes';
import type { QueuedMessageData } from '../../common/protocol';
import type { CommitInfo } from '../../common/schemas';
import { eventReducer, type WebviewSdkEvent } from './eventReducer';
import { applyDelta, applyToolDelta, type MaterializedView, projectSession } from './projector';
import { useSettingsStore } from './settingsStore';
import {
	createDraftDomainState,
	createMessageDomainState,
	createSessionMetaDomainState,
} from './storeState';
import { useUIStore } from './uiStore';

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
}

function getNewSessionSeedModel(): string | undefined {
	const model = useSettingsStore.getState().lastSelectedModel;
	return model && model !== 'default' ? model : undefined;
}

export type {
	AssistantMessage,
	CommitInfo,
	MaterializedView,
	Message,
	Part,
	PermissionRequest,
	QuestionRequest,
	Session,
	SessionStatus,
	SnapshotFileDiff,
	Todo,
	ToolPart,
};

export interface TokenUsage {
	input: number;
	output: number;
	total?: number;
	usage?: number;
	cacheRead?: number;
	durationMs?: number;
}

export interface ChangedFile {
	filePath: string;
	fileName: string;
	linesAdded: number;
	linesRemoved: number;
	toolUseId: string;
	timestamp: number;
}

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

export type RenderUserMessage = Message & {
	kind: 'user';
	message: Message;
	parts: Part[];
	attachments?: {
		files?: string[];
		images?: unknown[];
		codeSnippets?: unknown[];
	};
	compaction?: RenderCompactionMessage;
};

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

export interface SessionStore {
	sessions: Session[];
	sessionStatus: Record<string, SessionStatus>;
	sessionDiff: Record<string, SnapshotFileDiff[]>;
	messages: Record<string, Message[]>;
	parts: Record<string, Part[]>;
	todos: Record<string, Todo[]>;
	permissions: Record<string, PermissionRequest[]>;
	questions: Record<string, QuestionRequest[]>;
	activeSessionId: string | undefined;
	sessionOrder: string[];
	editingMessageId: string | null;
	editDrafts: Record<string, string>;
	isImprovingPrompt: boolean;
	improvingPromptRequestId: string | null;
	promptVersions: { original: string; improved: string; showingImproved: boolean } | null;
	childSessionIdsByParentId: Record<string, string[]>;
	originatingToolCallBySessionId: Record<string, string>;
	queuedMessages: Record<string, QueuedMessageData[]>;
	restoreCommits: Record<string, CommitInfo[]>;
	revertedFromMessageId: Record<string, string | null>;
	sessionCanUnrevert: Record<string, boolean>;
	sessionInput: Record<string, string>;
	sessionAgent: Record<string, string | undefined>;
	sessionModel: Record<string, string | undefined>;
	sessionAutoAccept: Record<string, boolean>;
	draftAttachments: Record<
		string,
		{ files?: string[]; images?: unknown[]; codeSnippets?: unknown[] }
	>;
	draftAgent: Record<string, string | undefined>;
	lastError: { sessionID: string; error: unknown } | null;
	/** Cached projection output per session — maintained by applyEvent/applyBatch */
	materializedViews: Record<string, MaterializedView>;
	actions: SessionActions;
}

export interface SessionActions {
	applyEvent: (event: WebviewSdkEvent) => void;
	applyBatch: (events: WebviewSdkEvent[]) => void;
	handleExtensionMessage: (message: unknown) => void;
	handleSessionCreated: (sessionId: string) => void;
	switchSession: (sessionId: string) => void;
	closeSession: (sessionId: string) => void;
	updateSessionInput: (input: string, sessionId?: string) => void;
	appendInput: (text: string, sessionId?: string) => void;
	updateSessionAgent: (agent: string | undefined, sessionId?: string) => void;
	updateSessionModel: (model: string | undefined, sessionId?: string) => void;
	setEditingMessageId: (id: string | null) => void;
	setEditDraft: (messageId: string, text: string) => void;
	clearEditDraft: (messageId: string) => void;
	clearAllEditDrafts: () => void;
	addRestoreCommit: (commit: CommitInfo, sessionId: string) => void;
	clearRestoreCommits: (sessionId: string) => void;
	setRestoreCommits: (commits: CommitInfo[], sessionId: string) => void;
	markRevertedFromMessageId: (id: string | null, sessionId: string) => void;
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;
	clearPromptVersions: () => void;
	togglePromptVersion: () => void;
	clearDraftState: (sessionId?: string) => void;
	getSessionAgent: (sessionId?: string) => string | undefined;
	getSessionModel: (sessionId?: string) => string | undefined;
	getSessionAutoAccept: (sessionId?: string) => boolean;
	removePendingQuestion: (requestId: string, sessionId: string) => void;
	restoreSession: (
		sessionId: string,
		data: { messages: Message[]; parts: Record<string, Part[]> },
	) => void;
}

function resolveSessionId(state: SessionStore, sessionId?: string): string | undefined {
	return sessionId || state.activeSessionId;
}

/** Extract the session ID from an SDK event, if applicable. */
function getEventSessionId(event: WebviewSdkEvent): string | undefined {
	const props = event.properties as Record<string, unknown>;
	if ('sessionID' in props && typeof props.sessionID === 'string') return props.sessionID;
	if ('part' in props && typeof props.part === 'object' && props.part !== null) {
		const part = props.part as { sessionID?: string };
		if (typeof part.sessionID === 'string') return part.sessionID;
	}
	if ('info' in props && typeof props.info === 'object' && props.info !== null) {
		const info = props.info as { id?: string };
		if (typeof info.id === 'string' && event.type.startsWith('session.')) return info.id;
	}
	return undefined;
}

export const useChatStore = create<SessionStore>()((set, get) => ({
	// Domain state factories
	...createMessageDomainState(),
	...createDraftDomainState(),
	...createSessionMetaDomainState(),
	actions: {
		applyEvent: event => {
			if (event.type === 'session.error') {
				const { error } = event.properties;
				if (error) {
					const errorMsg =
						'message' in (error as Record<string, unknown>)
							? String((error as { message?: string }).message)
							: 'Unknown error';
					useUIStore.getState().actions.pushNotification({
						type: 'error',
						content: errorMsg,
						timestamp: new Date().toISOString(),
						autoDismissMs: 8000,
					});
				}
			}
			set(
				produce((state: SessionStore) => {
					eventReducer(state, event);
					// Update materialized view for affected session
					const sid = getEventSessionId(event);
					if (sid) {
						// For delta events, try incremental path first
						if (event.type === 'message.part.delta') {
							const prev = state.materializedViews[sid];
							if (prev && prev.version > 0) {
								const { partID, field, delta } = event.properties;
								const textResult = applyDelta(prev, partID, field, delta);
								const result = textResult ?? applyToolDelta(prev, partID, field, delta);
								if (result) {
									state.materializedViews[sid] = result;
									return;
								}
							}
						}
						state.materializedViews[sid] = projectSession(state, sid);
					}
				}),
			);
		},

		applyBatch: events => {
			for (const event of events) {
				if (event.type === 'session.error') {
					const { error } = event.properties;
					if (error) {
						const errorMsg =
							'message' in (error as Record<string, unknown>)
								? String((error as { message?: string }).message)
								: 'Unknown error';
						useUIStore.getState().actions.pushNotification({
							type: 'error',
							content: errorMsg,
							timestamp: new Date().toISOString(),
							autoDismissMs: 8000,
						});
					}
				}
			}

			// Classify events: which sessions need full rebuild vs incremental delta
			const deltaOnlySessions = new Map<
				string,
				Array<{ partId: string; field: string; delta: string; messageId: string }>
			>();
			const structuralSessions = new Set<string>();

			for (const event of events) {
				const sid = getEventSessionId(event);
				if (!sid) continue;

				if (event.type === 'message.part.delta') {
					if (!structuralSessions.has(sid)) {
						const deltas = deltaOnlySessions.get(sid) ?? [];
						deltas.push({
							partId: event.properties.partID,
							field: event.properties.field,
							delta: event.properties.delta,
							messageId: event.properties.messageID,
						});
						deltaOnlySessions.set(sid, deltas);
					}
				} else {
					structuralSessions.add(sid);
					deltaOnlySessions.delete(sid);
				}
			}

			set(
				produce((state: SessionStore) => {
					const lastPartUpdateIndex = new Map<string, number>();
					for (let index = 0; index < events.length; index++) {
						const event = events[index];
						if (event.type !== 'message.part.updated') continue;
						const { part } = event.properties;
						lastPartUpdateIndex.set(`${part.messageID}:${part.id}`, index);
					}

					for (let index = 0; index < events.length; index++) {
						const event = events[index];
						if (event.type === 'message.part.delta') {
							const { messageID, partID } = event.properties;
							const lastUpdateIndex = lastPartUpdateIndex.get(`${messageID}:${partID}`);
							if (lastUpdateIndex !== undefined && index < lastUpdateIndex) {
								continue;
							}
						}
						eventReducer(state, event);
					}

					// Update materialized views:
					// 1. Full rebuild for sessions with structural changes
					for (const sid of structuralSessions) {
						state.materializedViews[sid] = projectSession(state, sid);
					}

					// 2. Incremental delta for sessions with only delta events
					for (const [sid, deltas] of deltaOnlySessions) {
						const prev = state.materializedViews[sid];
						if (!prev || prev.version === 0) {
							// No existing view — full rebuild
							state.materializedViews[sid] = projectSession(state, sid);
							continue;
						}

						let current: MaterializedView | null = prev;
						for (const d of deltas) {
							if (!current) break;
							// Try text/reasoning delta first, then tool delta
							const textResult = applyDelta(current, d.partId, d.field, d.delta);
							const result: MaterializedView | null =
								textResult ?? applyToolDelta(current, d.partId, d.field, d.delta);
							current = result;
						}

						if (current) {
							state.materializedViews[sid] = current;
						} else {
							// Incremental path failed — fall back to full rebuild
							state.materializedViews[sid] = projectSession(state, sid);
						}
					}
				}),
			);
		},

		handleExtensionMessage: message => {
			const msg = message as Record<string, unknown>;
			const msgType = msg.type as string | undefined;
			const msgData = msg.data as Record<string, unknown> | undefined;

			if (msgType === 'restore_session' && msgData) {
				const sessionId = msgData.sessionId as string;
				const messages = msgData.messages as Message[];
				const parts = msgData.parts as Record<string, Part[]>;
				get().actions.restoreSession(sessionId, { messages, parts });
				return;
			}

			if (msgType === 'addRestoreCommit' && msgData) {
				const sessionId = msgData.sessionId as string;
				const commit = msgData.commit as CommitInfo;
				get().actions.addRestoreCommit(commit, sessionId);
				return;
			}

			if (msgType === 'restoreState' && msgData) {
				const sessionId = msgData.sessionId as string;
				const action = msgData.action as string;
				set(
					produce((state: SessionStore) => {
						if (action === 'success') {
							state.revertedFromMessageId[sessionId] =
								(msgData.revertedFromMessageId as string | undefined) ?? null;
							state.sessionCanUnrevert[sessionId] = Boolean(msgData.canUnrevert);
						} else if (action === 'unrevert_available' && msgData.available === false) {
							state.revertedFromMessageId[sessionId] = null;
							state.sessionCanUnrevert[sessionId] = false;
						} else if (action === 'error') {
							useUIStore.getState().actions.pushNotification({
								type: 'error',
								content: String(msgData.message || 'Restore failed'),
								timestamp: new Date().toISOString(),
								autoDismissMs: 8000,
							});
						}
					}),
				);
				return;
			}

			if (msgType === 'syncSessionState' && msgData) {
				const sessionId = msgData.sessionId as string;
				set(
					produce((state: SessionStore) => {
						state.sessionAutoAccept[sessionId] = Boolean(msgData.autoAccept);
					}),
				);
				return;
			}

			if (msgType === 'showNotification' && msgData) {
				const notification = msgData.notification as {
					id?: string;
					type: 'error' | 'system_notice';
					content: string;
					timestamp?: string;
				};
				useUIStore.getState().actions.pushNotification({
					id: notification.id,
					type: notification.type,
					content: notification.content,
					timestamp: notification.timestamp ?? new Date().toISOString(),
					autoDismissMs: notification.type === 'system_notice' ? 6000 : 8000,
				});
				return;
			}

			if (msgType === 'session_lifecycle') {
				const lifecycle = msg as {
					action: string;
					sessionId?: string;
				};
				const actions = get().actions;
				switch (lifecycle.action) {
					case 'created':
						if (lifecycle.sessionId) actions.handleSessionCreated(lifecycle.sessionId);
						break;
					case 'closed':
						if (lifecycle.sessionId) actions.closeSession(lifecycle.sessionId);
						break;
					case 'switched':
						if (lifecycle.sessionId) actions.switchSession(lifecycle.sessionId);
						break;
					case 'cleared':
						if (lifecycle.sessionId) {
							const sid = lifecycle.sessionId;
							set(
								produce((state: SessionStore) => {
									const msgs = state.messages[sid];
									if (msgs) {
										for (const m of msgs) delete state.parts[m.id];
									}
									state.messages[sid] = [];
									// Rebuild materialized view after clear
									state.materializedViews[sid] = projectSession(state, sid);
								}),
							);
						}
						break;
				}
				return;
			}

			if (msgType === 'improvePromptResult' && msgData) {
				const requestId = msgData.requestId as string;
				const improvedText = msgData.improvedText as string;
				const state = get();
				if (state.improvingPromptRequestId === requestId) {
					const activeId = state.activeSessionId;
					const currentInput = activeId ? state.sessionInput[activeId] || '' : '';
					set({
						promptVersions: {
							original: currentInput,
							improved: improvedText,
							showingImproved: true,
						},
						isImprovingPrompt: false,
						improvingPromptRequestId: null,
					});
					if (activeId) {
						set(
							produce((s: SessionStore) => {
								s.sessionInput[activeId] = improvedText;
							}),
						);
					}
				}
				return;
			}

			if (msgType === 'improvePromptError' && msgData) {
				const requestId = msgData.requestId as string;
				const error = msgData.error as string;
				const state = get();
				if (state.improvingPromptRequestId === requestId) {
					set({ isImprovingPrompt: false, improvingPromptRequestId: null });
					useUIStore.getState().actions.pushNotification({
						type: 'error',
						content: `Prompt Improve failed\n${error || 'Unknown error'}`,
						timestamp: new Date().toISOString(),
						autoDismissMs: 8000,
					});
				}
				return;
			}

			if (msgType === 'improvePromptCancelled' && msgData) {
				const requestId = msgData.requestId as string;
				if (get().improvingPromptRequestId === requestId) {
					set({ isImprovingPrompt: false, improvingPromptRequestId: null });
				}
				return;
			}

			if (msgType === 'messageQueue' && msgData) {
				const action = msgData.action as string;
				const sessionId = msgData.sessionId as string;
				const queueData = msgData.queue as QueuedMessageData[];
				const cancelledText = msgData.cancelledText as string | undefined;
				const cancelledAttachments = msgData.cancelledAttachments as
					| { files?: string[]; images?: unknown[]; codeSnippets?: unknown[] }
					| undefined;
				const cancelledAgent = msgData.cancelledAgent as string | undefined;
				set(
					produce((state: SessionStore) => {
						state.queuedMessages[sessionId] = queueData;
						if (action === 'cancelled' && cancelledText) {
							const current = state.sessionInput[sessionId] || '';
							state.sessionInput[sessionId] = current.trim()
								? `${current}\n\n${cancelledText}`
								: cancelledText;
							if (cancelledAttachments) {
								state.draftAttachments[sessionId] = cancelledAttachments;
							}
							if (cancelledAgent !== undefined) {
								state.draftAgent[sessionId] = cancelledAgent;
							}
						}
					}),
				);
			}
		},

		handleSessionCreated: sessionId => {
			set(
				produce((state: SessionStore) => {
					if (!state.sessionOrder.includes(sessionId)) {
						state.sessionOrder.push(sessionId);
					}
					if (!state.messages[sessionId]) state.messages[sessionId] = [];
					state.sessionModel[sessionId] ??= getNewSessionSeedModel();
					state.activeSessionId = sessionId;
				}),
			);
		},

		switchSession: sessionId => {
			set(
				produce((state: SessionStore) => {
					if (!state.sessionOrder.includes(sessionId)) {
						state.sessionOrder.push(sessionId);
					}
					if (!state.messages[sessionId]) state.messages[sessionId] = [];
					state.sessionModel[sessionId] ??= getNewSessionSeedModel();
					state.activeSessionId = sessionId;
					state.editingMessageId = null;
					state.editDrafts = {};
				}),
			);
		},

		closeSession: sessionId => {
			set(
				produce((state: SessionStore) => {
					if (state.sessionOrder.length <= 1) return;
					state.sessionOrder = state.sessionOrder.filter(id => id !== sessionId);
					delete state.queuedMessages[sessionId];
					delete state.restoreCommits[sessionId];
					delete state.revertedFromMessageId[sessionId];
					delete state.sessionCanUnrevert[sessionId];
					delete state.sessionInput[sessionId];
					delete state.sessionAgent[sessionId];
					delete state.sessionModel[sessionId];
					delete state.sessionAutoAccept[sessionId];
					delete state.draftAttachments[sessionId];
					delete state.draftAgent[sessionId];
					delete state.childSessionIdsByParentId[sessionId];
					delete state.originatingToolCallBySessionId[sessionId];
					delete state.materializedViews[sessionId];
					if (state.activeSessionId === sessionId) {
						state.activeSessionId = state.sessionOrder[state.sessionOrder.length - 1];
						state.editingMessageId = null;
						state.editDrafts = {};
					}
				}),
			);
		},

		updateSessionInput: (input, sessionId) => {
			const sid = resolveSessionId(get(), sessionId);
			if (sid) {
				set(
					produce((s: SessionStore) => {
						s.sessionInput[sid] = input;
					}),
				);
			}
		},

		appendInput: (text, sessionId) => {
			const sid = resolveSessionId(get(), sessionId);
			if (sid) {
				set(
					produce((s: SessionStore) => {
						s.sessionInput[sid] = (s.sessionInput[sid] || '') + text;
					}),
				);
			}
		},

		updateSessionAgent: (agent, sessionId) => {
			const sid = resolveSessionId(get(), sessionId);
			if (sid) {
				set(
					produce((s: SessionStore) => {
						s.sessionAgent[sid] = agent;
					}),
				);
			}
		},

		updateSessionModel: (model, sessionId) => {
			const sid = resolveSessionId(get(), sessionId);
			if (sid) {
				set(
					produce((s: SessionStore) => {
						s.sessionModel[sid] = model;
					}),
				);
			}
		},

		setEditingMessageId: id => set({ editingMessageId: id }),
		setEditDraft: (messageId, text) =>
			set(
				produce((s: SessionStore) => {
					s.editDrafts[messageId] = text;
				}),
			),
		clearEditDraft: messageId =>
			set(
				produce((s: SessionStore) => {
					delete s.editDrafts[messageId];
				}),
			),
		clearAllEditDrafts: () => set({ editDrafts: {} }),

		addRestoreCommit: (commit, sessionId) => {
			set(
				produce((s: SessionStore) => {
					const commits = s.restoreCommits[sessionId] || [];
					if (!commits.some(c => c.sha === commit.sha)) {
						s.restoreCommits[sessionId] = [...commits, commit];
					}
				}),
			);
		},
		clearRestoreCommits: sessionId =>
			set(
				produce((s: SessionStore) => {
					s.restoreCommits[sessionId] = [];
				}),
			),
		setRestoreCommits: (commits, sessionId) =>
			set(
				produce((s: SessionStore) => {
					s.restoreCommits[sessionId] = commits;
				}),
			),
		markRevertedFromMessageId: (id, sessionId) =>
			set(
				produce((s: SessionStore) => {
					s.revertedFromMessageId[sessionId] = id;
				}),
			),

		setImprovingPrompt: (isImproving, requestId = null) =>
			set({ isImprovingPrompt: isImproving, improvingPromptRequestId: requestId }),
		clearPromptVersions: () => set({ promptVersions: null }),
		togglePromptVersion: () => {
			const state = get();
			if (state.promptVersions) {
				const { original, improved, showingImproved } = state.promptVersions;
				const next = !showingImproved;
				const sid = state.activeSessionId;
				if (sid) {
					set(
						produce((s: SessionStore) => {
							s.sessionInput[sid] = next ? improved : original;
						}),
					);
				}
				set({ promptVersions: { original, improved, showingImproved: next } });
			}
		},

		clearDraftState: sessionId => {
			const sid = resolveSessionId(get(), sessionId);
			if (sid) {
				set(
					produce((s: SessionStore) => {
						delete s.draftAttachments[sid];
						delete s.draftAgent[sid];
					}),
				);
			}
		},

		getSessionAgent: sessionId => {
			const sid = resolveSessionId(get(), sessionId);
			return sid ? get().sessionAgent[sid] : undefined;
		},
		getSessionModel: sessionId => {
			const sid = resolveSessionId(get(), sessionId);
			return sid ? get().sessionModel[sid] : undefined;
		},
		getSessionAutoAccept: sessionId => {
			const sid = resolveSessionId(get(), sessionId);
			return sid ? (get().sessionAutoAccept[sid] ?? false) : false;
		},
		removePendingQuestion: (requestId, sessionId) => {
			set(
				produce((s: SessionStore) => {
					const qs = s.questions[sessionId];
					if (qs) {
						s.questions[sessionId] = qs.filter(q => q.id !== requestId);
					}
				}),
			);
		},

		restoreSession: (sessionId, data) => {
			set(
				produce((s: SessionStore) => {
					s.sessionModel[sessionId] ??= getNewSessionSeedModel();
					s.messages[sessionId] = data.messages;
					for (const [messageId, messageParts] of Object.entries(data.parts)) {
						s.parts[messageId] = messageParts;
					}
					for (const messageParts of Object.values(data.parts)) {
						for (const part of messageParts) {
							if (part.type === 'tool' && (part as ToolPart).tool.toLowerCase() === 'task') {
								const metadata = (part as ToolPart).metadata as { sessionId?: string } | undefined;
								if (metadata?.sessionId) {
									s.originatingToolCallBySessionId[metadata.sessionId] = (part as ToolPart).callID;
								}
							}
						}
					}
					syncSessionModelFromMessages(s, sessionId);
					// Rebuild materialized view after restore
					s.materializedViews[sessionId] = projectSession(s, sessionId);
				}),
			);
		},
	},
}));
