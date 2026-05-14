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
} from '@opencode-ai/sdk/v2/client';
import { produce } from 'immer';
import { create } from 'zustand';
import type { NormalizedEntry } from '../../common/normalizedTypes';
import type { SessionMessageEntry } from '../services/opencodeRuntime';
import { eventReducer, reconcileSessionGraph, type WebviewSdkEvent } from './eventReducer';
import { rebuildSessionOwnedFiles } from './fileOwnership';
import { useSettingsStore } from './settingsStore';
import { useUIStore } from './uiStore';

function createMessageDomainState() {
	return {
		messages: {},
		parts: {},
		sessionStatus: {},
		sessionDiff: {},
		sessionOwnedFiles: {},
		todos: {},
		permissions: {},
		questions: {},
		lastError: null,
	};
}

function createDraftDomainState() {
	return {
		editingMessageId: null,
		editDrafts: {},
		sessionInput: {},
		queuedMessagesBySession: {},
		draftAttachments: {},
		draftAgent: {},
		isImprovingPrompt: false,
		improvingPromptRequestId: null,
		promptVersions: null,
	};
}

function createSessionMetaDomainState() {
	return {
		sessions: [],
		activeSessionId: undefined,
		sessionOrder: [],
		childSessionIdsByParentId: {},
		originatingToolCallBySessionId: {},
		sessionAgent: {},
		sessionModel: {},
		sessionModelSource: {},
		sessionAutoAccept: {},
	};
}

function getNewSessionSeedModel(state?: SessionStore): string | undefined {
	const activeSessionModel = state?.activeSessionId
		? state.sessionModel[state.activeSessionId]
		: undefined;
	if (activeSessionModel) return activeSessionModel;
	const model = useSettingsStore.getState().lastSelectedModel;
	return model && model !== 'default' ? model : undefined;
}

function getSessionErrorMessage(error: unknown): string | null {
	if (typeof error === 'string') return error.trim() || 'Unknown error';
	if (!error || typeof error !== 'object') return 'Unknown error';
	const record = error as Record<string, unknown>;
	if (record.name === 'MessageAbortedError') return null;
	if (typeof record.message === 'string' && record.message.trim()) return record.message.trim();
	const data = record.data;
	if (data && typeof data === 'object') {
		const dataMessage = (data as Record<string, unknown>).message;
		if (typeof dataMessage === 'string' && dataMessage.trim()) return dataMessage.trim();
	}
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}

function syncSessionModelFromMessages(state: SessionStore, sessionId: string): void {
	const messages = state.messages[sessionId] ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Record<string, unknown> & { role?: string };
		if (message.role !== 'user') continue;
		const directModelId = typeof message.modelID === 'string' ? message.modelID.trim() : '';
		const directProviderId =
			typeof message.providerID === 'string' ? message.providerID.trim() : '';
		if (directModelId) {
			if (state.sessionModelSource[sessionId] === 'user') return;
			state.sessionModel[sessionId] = directProviderId
				? `${directProviderId}/${directModelId}`
				: directModelId;
			state.sessionModelSource[sessionId] = 'history';
			return;
		}
		const nestedModel =
			typeof message.model === 'object' && message.model !== null
				? (message.model as Record<string, unknown>)
				: undefined;
		const nestedModelId =
			typeof nestedModel?.modelID === 'string' ? nestedModel.modelID.trim() : '';
		const nestedProviderId =
			typeof nestedModel?.providerID === 'string' ? nestedModel.providerID.trim() : '';
		if (nestedModelId) {
			if (state.sessionModelSource[sessionId] === 'user') return;
			state.sessionModel[sessionId] = nestedProviderId
				? `${nestedProviderId}/${nestedModelId}`
				: nestedModelId;
			state.sessionModelSource[sessionId] = 'history';
			return;
		}
	}
	if (state.sessionModelSource[sessionId] === 'user') return;
	delete state.sessionModel[sessionId];
	delete state.sessionModelSource[sessionId];
}

function normalizeTopLevelTabs(state: SessionStore): void {
	const childSessionIds = new Set(
		state.sessions.filter(session => Boolean(session.parentID)).map(session => session.id),
	);
	state.sessionOrder = state.sessionOrder.filter(
		(sessionId, index, order) =>
			!childSessionIds.has(sessionId) && order.indexOf(sessionId) === index,
	);
	if (
		state.activeSessionId &&
		(childSessionIds.has(state.activeSessionId) ||
			!state.sessionOrder.includes(state.activeSessionId))
	) {
		state.activeSessionId = state.sessionOrder.at(-1);
	}
}

function pushSessionErrorNotification(error: unknown, sessionId?: string): void {
	const errorMsg = getSessionErrorMessage(error);
	if (!errorMsg) return;
	useUIStore.getState().actions.pushNotification({
		type: 'error',
		content: errorMsg,
		sessionId,
		timestamp: new Date().toISOString(),
		autoDismissMs: 8000,
	});
}

export type {
	AssistantMessage,
	Message,
	Part,
	PermissionRequest,
	QuestionRequest,
	Session,
	SessionStatus,
	SnapshotFileDiff,
	Todo,
};

export interface TokenUsage {
	input: number;
	output: number;
	total?: number;
	usage?: number;
	cacheRead?: number;
	cacheWrite?: number;
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
	isBackgroundLaunch?: boolean;
	agent?: string;
	description?: string;
	prompt?: string;
	category?: string;
	command?: string;
	taskId?: string;
	result?: string;
	startTime?: string | number;
	retryInfo?: { attempt: number; message: string; nextRetryAt?: string };
	childSessionId?: string;
	childSummary: {
		title?: string;
		modelId?: string;
		durationMs?: number;
		tokens?: TokenUsage;
		childCount: number;
	};
}

export interface RenderTaskResultNode {
	kind: 'task_result';
	id: string;
	type: 'task_result';
	parentSessionId: string;
	parentMessageId?: string;
	toolCallId: string;
	childSessionId?: string;
	timestamp: string;
	content: string;
	taskIdLine?: string;
	source: {
		parentToolPartId?: string;
		childAssistantMessageId?: string;
		childAssistantPartId?: string;
	};
}

export interface RenderSystemEventNode {
	kind: 'system_event';
	id: string;
	type: 'system_event';
	timestamp: string;
	title: string;
	content: string;
	source: 'ohmy' | 'generic';
	parentMessageId?: string;
	messageId?: string;
	partId?: string;
}

export interface RenderAssistantMessage {
	kind: 'assistant';
	id: string;
	type: 'assistant';
	parentMessageId?: string;
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
	parentMessageId?: string;
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
	parentMessageId?: string;
	toolName: string;
	toolUseId: string;
	rawInput?: Record<string, unknown>;
	rawOutput?: string;
	isRunning?: boolean;
	status?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
	title?: string;
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
	| RenderTaskResultNode
	| RenderSystemEventNode
	| RenderAssistantMessage
	| RenderThinkingMessage
	| RenderToolUseMessage;

export interface SessionStore {
	sessions: Session[];
	sessionStatus: Record<string, SessionStatus>;
	sessionDiff: Record<string, SnapshotFileDiff[]>;
	sessionOwnedFiles: Record<string, string[]>;
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
	sessionInput: Record<string, string>;
	queuedMessagesBySession: Record<
		string,
		Array<{
			queueId: string;
			messageId?: string;
			sessionId: string;
			text: string;
			attachments?: {
				files?: string[];
				codeSnippets?: Array<{
					filePath: string;
					content: string;
					startLine?: number;
					endLine?: number;
				}>;
				images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
			};
			agent?: string;
			model?: string;
			variant?: string;
			createdAt: number;
		}>
	>;
	sessionAgent: Record<string, string | undefined>;
	sessionModel: Record<string, string | undefined>;
	sessionModelSource: Record<string, 'history' | 'user' | undefined>;
	sessionAutoAccept: Record<string, boolean>;
	draftAttachments: Record<
		string,
		{ images?: Array<{ id: string; name: string; dataUrl: string; path?: string }> }
	>;
	draftAgent: Record<string, string | undefined>;
	lastError: { sessionID: string; error: unknown } | null;
	actions: SessionActions;
}

export interface SessionActions {
	applyEvent: (event: WebviewSdkEvent) => void;
	applyBatch: (events: WebviewSdkEvent[]) => void;
	handleExtensionMessage: (message: unknown) => void;
	applyTabState: (
		openTabs: string[],
		activeTab?: string,
		autoAcceptBySession?: Record<string, boolean>,
	) => void;
	updateSessionInput: (input: string, sessionId?: string) => void;
	appendInput: (text: string, sessionId?: string) => void;
	updateSessionAgent: (agent: string | undefined, sessionId?: string) => void;
	updateSessionModel: (model: string | undefined, sessionId?: string) => void;
	syncProjectModel: (model: string | undefined) => void;
	addOptimisticMessage: (input: { sessionId: string; message: Message; parts: Part[] }) => void;
	removeOptimisticMessage: (input: { sessionId: string; messageId: string }) => void;
	truncateSessionMessages: (sessionId: string, messageId: string, includeTarget?: boolean) => void;
	setEditingMessageId: (id: string | null) => void;
	setEditDraft: (messageId: string, text: string) => void;
	clearEditDraft: (messageId: string) => void;
	clearAllEditDrafts: () => void;
	setImprovingPrompt: (isImproving: boolean, requestId?: string | null) => void;
	clearPromptVersions: () => void;
	togglePromptVersion: () => void;
	clearDraftState: (sessionId?: string) => void;
	getSessionAgent: (sessionId?: string) => string | undefined;
	getSessionModel: (sessionId?: string) => string | undefined;
	getSessionAutoAccept: (sessionId?: string) => boolean;
	removePendingQuestion: (requestId: string, sessionId: string) => void;
	removePendingPermission: (requestId: string, sessionId: string) => void;
	enqueueMessage: (input: {
		sessionId: string;
		text: string;
		messageId?: string;
		attachments?: SessionStore['queuedMessagesBySession'][string][number]['attachments'];
		agent?: string;
		model?: string;
		variant?: string;
	}) => string;
	dequeueMessage: (
		sessionId: string,
	) => SessionStore['queuedMessagesBySession'][string][number] | undefined;
	prependQueuedMessage: (
		sessionId: string,
		entry: SessionStore['queuedMessagesBySession'][string][number],
	) => void;
	reorderQueuedMessages: (sessionId: string, queueIds: string[]) => void;
	cancelQueuedMessage: (sessionId: string, queueId: string) => void;
	hydrateSessionSnapshot: (params: SessionSnapshotInput | SessionSnapshotInput[]) => void;
	replaySessionSnapshots: (params: SessionSnapshotInput | SessionSnapshotInput[]) => void;
}

export interface SessionSnapshotInput {
	session: Session;
	messageEntries: SessionMessageEntry[];
	todos: Todo[];
	diff: SnapshotFileDiff[];
	activate: boolean;
}

function sessionSnapshotsToEvents(
	params: SessionSnapshotInput | SessionSnapshotInput[],
): WebviewSdkEvent[] {
	const snapshots = Array.isArray(params) ? params : [params];
	const events: WebviewSdkEvent[] = [];

	for (const { session } of snapshots) {
		events.push({ type: 'session.updated', properties: { info: session } } as WebviewSdkEvent);
	}

	for (const { session, activate } of snapshots) {
		if (activate) {
			events.push({
				type: 'session.idle',
				properties: { sessionID: session.id },
			} as WebviewSdkEvent);
		}
	}

	for (const { session, messageEntries } of snapshots) {
		for (const entry of messageEntries) {
			events.push({
				type: 'message.updated',
				properties: { sessionID: session.id, info: entry.info },
			} as WebviewSdkEvent);
			for (const part of entry.parts) {
				events.push({ type: 'message.part.updated', properties: { part } } as WebviewSdkEvent);
			}
		}
	}

	return events;
}

function resolveSessionId(state: SessionStore, sessionId?: string): string | undefined {
	return sessionId || state.activeSessionId;
}

function isProcessingStatus(status: SessionStatus | undefined): boolean {
	return status?.type === 'busy' || status?.type === 'retry';
}

function collectSessionSubtreeIds(
	state: Pick<SessionStore, 'childSessionIdsByParentId'>,
	sessionId: string,
): string[] {
	const queue = [sessionId];
	const visited = new Set<string>();
	const sessionIds: string[] = [];
	let head = 0;

	while (head < queue.length) {
		const current = queue[head++];
		if (!current || visited.has(current)) continue;
		visited.add(current);
		sessionIds.push(current);
		queue.push(...(state.childSessionIdsByParentId[current] ?? []));
	}

	return sessionIds;
}

export function collectSessionLineageIds(
	state: Pick<SessionStore, 'sessions'>,
	sessionId: string,
): string[] {
	const lineage: string[] = [];
	const visited = new Set<string>();
	let currentSessionId: string | undefined = sessionId;

	while (currentSessionId && !visited.has(currentSessionId)) {
		visited.add(currentSessionId);
		lineage.push(currentSessionId);
		currentSessionId = state.sessions.find(session => session.id === currentSessionId)?.parentID;
	}

	return lineage;
}

export function getProcessingSessionIds(
	state: Pick<SessionStore, 'sessionStatus' | 'childSessionIdsByParentId'>,
	sessionId: string,
): string[] {
	return collectSessionSubtreeIds(state, sessionId).filter(currentSessionId =>
		isProcessingStatus(state.sessionStatus[currentSessionId]),
	);
}

export function getSessionRuntimeStatus(
	state: Pick<SessionStore, 'sessionStatus' | 'childSessionIdsByParentId'>,
	sessionId: string,
): SessionStatus | undefined {
	const processingSessionIds = getProcessingSessionIds(state, sessionId);
	if (processingSessionIds.length > 0) {
		const retryStatus = processingSessionIds
			.map(currentSessionId => state.sessionStatus[currentSessionId])
			.find(status => status?.type === 'retry');
		if (retryStatus) return retryStatus;
		return { type: 'busy' };
	}

	return state.sessionStatus[sessionId];
}

export function isSessionProcessing(
	state: Pick<SessionStore, 'sessionStatus' | 'childSessionIdsByParentId'>,
	sessionId: string,
): boolean {
	return getProcessingSessionIds(state, sessionId).length > 0;
}

export const useChatStore = create<SessionStore>()((set, get) => ({
	// Domain state factories
	...createMessageDomainState(),
	...createDraftDomainState(),
	...createSessionMetaDomainState(),
	actions: {
		applyEvent: event => {
			if (event.type === 'session.error') {
				pushSessionErrorNotification(event.properties.error, event.properties.sessionID);
			}
			set(
				produce((state: SessionStore) => {
					eventReducer(state, event);
					reconcileSessionGraph(state);
				}),
			);
		},

		applyBatch: events => {
			for (const event of events) {
				if (event.type === 'session.error') {
					pushSessionErrorNotification(event.properties.error, event.properties.sessionID);
				}
			}

			set(
				produce((state: SessionStore) => {
					for (let index = 0; index < events.length; index++) {
						const event = events[index];
						eventReducer(state, event);
					}
					reconcileSessionGraph(state);
				}),
			);
		},

		handleExtensionMessage: message => {
			const msg = message as Record<string, unknown>;
			const msgType = msg.type as string | undefined;
			const msgData = msg.data as Record<string, unknown> | undefined;

			if (msgType === 'tabState' && msgData) {
				get().actions.applyTabState(
					Array.isArray(msgData.openTabs) ? (msgData.openTabs as string[]) : [],
					typeof msgData.activeTab === 'string' ? msgData.activeTab : undefined,
					typeof msgData.autoAcceptBySession === 'object' && msgData.autoAcceptBySession
						? (msgData.autoAcceptBySession as Record<string, boolean>)
						: undefined,
				);
				return;
			}

			if (msgType === 'sessionAutoAccept' && msgData) {
				set(
					produce((state: SessionStore) => {
						if (msgData.states && typeof msgData.states === 'object') {
							for (const [sessionId, autoAccept] of Object.entries(msgData.states)) {
								state.sessionAutoAccept[sessionId] = Boolean(autoAccept);
							}
						}
						if (typeof msgData.sessionId === 'string') {
							state.sessionAutoAccept[msgData.sessionId] = Boolean(msgData.autoAccept);
						}
					}),
				);
				return;
			}
		},

		applyTabState: (
			openTabs: string[],
			activeTab?: string,
			autoAcceptBySession?: Record<string, boolean>,
		) => {
			set(
				produce((state: SessionStore) => {
					state.sessionOrder = openTabs;
					for (const sessionId of openTabs) {
						if (!state.messages[sessionId]) state.messages[sessionId] = [];
						state.sessionModel[sessionId] ??= getNewSessionSeedModel(state);
					}
					state.activeSessionId = activeTab;
					state.editingMessageId = null;
					state.editDrafts = {};
					normalizeTopLevelTabs(state);
					const retainedSessionIds = new Set(state.sessionOrder);
					for (const session of state.sessions) {
						if (session.parentID) retainedSessionIds.add(session.id);
					}
					for (const sessionId of Object.keys(state.messages)) {
						if (!retainedSessionIds.has(sessionId)) {
							delete state.sessionInput[sessionId];
							delete state.sessionAgent[sessionId];
							delete state.sessionModel[sessionId];
							delete state.sessionModelSource[sessionId];
							delete state.sessionAutoAccept[sessionId];
							delete state.draftAttachments[sessionId];
							delete state.draftAgent[sessionId];
							delete state.childSessionIdsByParentId[sessionId];
							delete state.originatingToolCallBySessionId[sessionId];
							delete state.sessionOwnedFiles[sessionId];
						}
					}
					if (autoAcceptBySession) {
						for (const [sessionId, autoAccept] of Object.entries(autoAcceptBySession)) {
							state.sessionAutoAccept[sessionId] = Boolean(autoAccept);
						}
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
						if (!agent || agent === 'build') {
							delete s.sessionAgent[sid];
							return;
						}
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
						if (model) {
							s.sessionModel[sid] = model;
							s.sessionModelSource[sid] = 'user';
						} else {
							delete s.sessionModel[sid];
							delete s.sessionModelSource[sid];
						}
					}),
				);
			}
		},

		syncProjectModel: model => {
			const projectModel = model && model !== 'default' ? model : undefined;
			set(
				produce((s: SessionStore) => {
					const sessionIds = new Set<string>(s.sessionOrder);
					if (s.activeSessionId) sessionIds.add(s.activeSessionId);
					for (const sessionId of sessionIds) {
						if (s.sessionModelSource[sessionId] === 'user') continue;
						if (projectModel) {
							s.sessionModel[sessionId] = projectModel;
							delete s.sessionModelSource[sessionId];
						} else {
							delete s.sessionModel[sessionId];
							delete s.sessionModelSource[sessionId];
						}
					}
				}),
			);
		},
		addOptimisticMessage: ({ sessionId, message, parts }) => {
			set(
				produce((state: SessionStore) => {
					if (!state.messages[sessionId]) state.messages[sessionId] = [];
					const existingIndex = state.messages[sessionId].findIndex(item => item.id === message.id);
					if (existingIndex >= 0) {
						state.messages[sessionId][existingIndex] = message;
					} else {
						state.messages[sessionId].push(message);
					}
					state.parts[message.id] = parts;
				}),
			);
		},

		removeOptimisticMessage: ({ sessionId, messageId }) => {
			set(
				produce((state: SessionStore) => {
					const messages = state.messages[sessionId];
					if (messages) {
						state.messages[sessionId] = messages.filter(message => message.id !== messageId);
					}
					delete state.parts[messageId];
				}),
			);
		},

		truncateSessionMessages: (sessionId, messageId, includeTarget = false) => {
			set(
				produce((state: SessionStore) => {
					const messages = state.messages[sessionId] ?? [];
					const targetIndex = messages.findIndex(message => message.id === messageId);
					if (targetIndex === -1) return;
					const nextLength = includeTarget ? targetIndex : targetIndex + 1;
					const removedMessages = messages.slice(nextLength);
					state.messages[sessionId] = messages.slice(0, nextLength);
					for (const removed of removedMessages) {
						delete state.parts[removed.id];
					}
					const owned = rebuildSessionOwnedFiles(
						state.messages[sessionId] ?? [],
						state.parts,
						sessionId,
					);
					if (owned.length > 0) state.sessionOwnedFiles[sessionId] = owned;
					else delete state.sessionOwnedFiles[sessionId];
					syncSessionModelFromMessages(state, sessionId);
				}),
			);
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

		removePendingPermission: (requestId, sessionId) => {
			set(
				produce((s: SessionStore) => {
					const perms = s.permissions[sessionId];
					if (perms) {
						s.permissions[sessionId] = perms.filter(permission => permission.id !== requestId);
					}
				}),
			);
		},

		enqueueMessage: input => {
			const queueId = `q-${Date.now()}-${crypto.randomUUID()}`;
			set(
				produce((state: SessionStore) => {
					const queue = state.queuedMessagesBySession[input.sessionId] ?? [];
					queue.push({
						queueId,
						messageId: input.messageId,
						sessionId: input.sessionId,
						text: input.text,
						attachments: input.attachments,
						agent: input.agent,
						model: input.model,
						variant: input.variant,
						createdAt: Date.now(),
					});
					state.queuedMessagesBySession[input.sessionId] = queue;
				}),
			);
			return queueId;
		},

		dequeueMessage: sessionId => {
			let removed: SessionStore['queuedMessagesBySession'][string][number] | undefined;
			set(
				produce((state: SessionStore) => {
					const queue = state.queuedMessagesBySession[sessionId] ?? [];
					const next = queue.shift();
					removed = next
						? {
								...next,
								attachments: next.attachments
									? {
											...next.attachments,
											files: next.attachments.files ? [...next.attachments.files] : undefined,
											codeSnippets: next.attachments.codeSnippets
												? next.attachments.codeSnippets.map(snippet => ({ ...snippet }))
												: undefined,
											images: next.attachments.images
												? next.attachments.images.map(image => ({ ...image }))
												: undefined,
										}
									: undefined,
							}
						: undefined;
					if (queue.length === 0) delete state.queuedMessagesBySession[sessionId];
				}),
			);
			return removed;
		},

		prependQueuedMessage: (sessionId, entry) => {
			set(
				produce((state: SessionStore) => {
					const queue = state.queuedMessagesBySession[sessionId] ?? [];
					state.queuedMessagesBySession[sessionId] = [entry, ...queue];
				}),
			);
		},

		reorderQueuedMessages: (sessionId, queueIds) => {
			set(
				produce((state: SessionStore) => {
					const queue = state.queuedMessagesBySession[sessionId];
					if (!queue || queue.length < 2) return;
					const byId = new Map(queue.map(item => [item.queueId, item]));
					const reordered = queueIds
						.map(id => byId.get(id))
						.filter((item): item is SessionStore['queuedMessagesBySession'][string][number] =>
							Boolean(item),
						);
					for (const item of queue) {
						if (!queueIds.includes(item.queueId)) reordered.push(item);
					}
					state.queuedMessagesBySession[sessionId] = reordered;
				}),
			);
		},

		cancelQueuedMessage: (sessionId, queueId) => {
			set(
				produce((state: SessionStore) => {
					const queue = state.queuedMessagesBySession[sessionId] ?? [];
					const index = queue.findIndex(item => item.queueId === queueId);
					if (index === -1) return;
					const [removed] = queue.splice(index, 1);
					if (queue.length === 0) delete state.queuedMessagesBySession[sessionId];
					state.sessionInput[sessionId] = removed.text;
					state.draftAttachments[sessionId] = removed.attachments?.images
						? { images: removed.attachments.images }
						: {};
					state.draftAgent[sessionId] = removed.agent;
				}),
			);
		},

		replaySessionSnapshots: params => {
			const snapshots = Array.isArray(params) ? params : [params];
			set(
				produce((state: SessionStore) => {
					for (const { session, todos, diff, activate } of snapshots) {
						const sessionIndex = state.sessions.findIndex(item => item.id === session.id);
						if (sessionIndex >= 0) state.sessions[sessionIndex] = session;
						else state.sessions.push(session);

						if (!session.parentID && !state.sessionOrder.includes(session.id)) {
							state.sessionOrder.push(session.id);
						}
						if (activate && !session.parentID) {
							state.activeSessionId = session.id;
						}

						state.todos[session.id] = todos;
						state.sessionDiff[session.id] = diff;
						delete state.sessionOwnedFiles[session.id];
						state.sessionModel[session.id] ??= getNewSessionSeedModel(state);

						const previousMessages = state.messages[session.id] ?? [];
						for (const message of previousMessages) {
							delete state.parts[message.id];
						}
						state.messages[session.id] = [];
					}
					normalizeTopLevelTabs(state);
				}),
			);

			get().actions.applyBatch(sessionSnapshotsToEvents(snapshots));
		},

		hydrateSessionSnapshot: params => {
			get().actions.replaySessionSnapshots(params);
		},
	},
}));
