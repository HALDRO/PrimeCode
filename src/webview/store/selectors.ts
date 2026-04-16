/**
 * @file Zustand store selectors — chat, UI, and settings
 * @description Optimized selectors for deriving per-session chat state, UI dropdowns, and settings.
 * Only selectors actually consumed by components are exported here (dead code removed).
 * Uses stable empty-array refs (EMPTY_MESSAGES, etc.) to prevent infinite re-renders with useShallow.
 */

import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { parseModelId } from '../../common';
import {
	type ChangedFile,
	type ChatSession,
	type ChatState,
	type CommitInfo,
	DEFAULT_TOTAL_STATS,
	type RenderMessage,
	type RenderSubtaskMessage,
	type RenderUserMessage,
	type TokenUsage,
	type ToolResultView,
	useChatStore,
} from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import type { TransientNotification } from './uiStore';
import { type UIState, useUIStore } from './uiStore';

// Stable empty array references to prevent infinite re-renders with useShallow
const EMPTY_MESSAGES: RenderMessage[] = [];
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];
const EMPTY_CUMULATIVE_DIFFS: ChatSession['cumulativeDiffs'] = [];
const EMPTY_NOTIFICATIONS: TransientNotification[] = [];
const EMPTY_PERMISSIONS: import('../../common').SessionPermissionRequest[] = [];
const EMPTY_QUESTIONS: import('../../common').SessionQuestionRequest[] = [];

export function projectRuntimeMessages(session: ChatSession | undefined): RenderMessage[] {
	if (!session) return EMPTY_MESSAGES;

	const runtimeUserMessageIds = new Set(
		session.runtimeMessageRecords
			.filter(message => message.role === 'user')
			.map(message => message.id),
	);

	const passthrough: RenderMessage[] = [];
	for (const message of Object.values(session.userMessagesById)) {
		if (typeof message.id === 'string' && !runtimeUserMessageIds.has(message.id)) {
			const renderUser: RenderUserMessage = {
				...message,
				id: message.id,
				kind: 'user' as const,
			};
			passthrough.push(renderUser);
		}
	}
	for (const message of Object.values(session.subtasksById)) {
		if (message.id) {
			const renderSubtask: RenderSubtaskMessage = {
				...message,
				id: message.id,
				kind: 'subtask' as const,
			};
			passthrough.push(renderSubtask);
		}
	}
	const userMessagesById = session.userMessagesById;

	const runtimeProjected: RenderMessage[] = [];
	const seenMessageIds = new Set<string>();
	const projectParts = (
		messageId: string,
		record?: ChatSession['runtimeMessageRecords'][number],
	): void => {
		seenMessageIds.add(messageId);
		const parts = [...(session.runtimeMessagePartsById[messageId] || [])].sort((a, b) => {
			const aCreated = typeof a.createdAt === 'number' ? a.createdAt : Number.MAX_SAFE_INTEGER;
			const bCreated = typeof b.createdAt === 'number' ? b.createdAt : Number.MAX_SAFE_INTEGER;
			if (aCreated !== bCreated) return aCreated - bCreated;
			return a.id.localeCompare(b.id);
		});
		for (const part of parts) {
			const partCompleted = typeof part.completedAt === 'number';
			const recordCompleted = typeof record?.completedAt === 'number';
			const timestamp =
				typeof part.createdAt === 'number'
					? new Date(part.createdAt).toISOString()
					: typeof record?.createdAt === 'number'
						? new Date(record.createdAt).toISOString()
						: '1970-01-01T00:00:00.000Z';

			if (part.type === 'text' && part.text && !part.synthetic) {
				runtimeProjected.push({
					kind: 'assistant',
					id: `msg-${part.id}`,
					type: 'assistant',
					content: part.text,
					partId: part.id,
					isStreaming: record
						? !recordCompleted
						: !partCompleted && part.state?.status !== 'completed',
					timestamp,
					...(record?.agent ? { agent: record.agent } : {}),
				});
				continue;
			}

			if (part.type === 'reasoning' && part.text) {
				runtimeProjected.push({
					kind: 'thinking',
					id: `thinking-${part.id}`,
					type: 'thinking',
					content: part.text,
					partId: part.id,
					isStreaming: !partCompleted && part.state?.status !== 'completed',
					startTime: part.createdAt,
					durationMs:
						typeof part.createdAt === 'number' && typeof part.completedAt === 'number'
							? part.completedAt - part.createdAt
							: undefined,
					timestamp,
				});
				continue;
			}

			if (part.type === 'tool' && part.callId) {
				const isRunning =
					!partCompleted &&
					(part.state?.status === 'pending' ||
						part.state?.status === 'running' ||
						part.state?.status === undefined);
				runtimeProjected.push({
					kind: 'tool_use',
					id: part.callId,
					type: 'tool_use',
					toolName: part.toolName || 'unknown',
					toolUseId: part.callId,
					toolInput: JSON.stringify(part.state?.input || {}),
					rawInput: (part.state?.input as Record<string, unknown>) ?? {},
					streamingOutput: part.state?.output,
					isRunning,
					timestamp,
					...(part.state?.status ? { status: part.state.status } : {}),
					...(part.state?.title ? { title: part.state.title } : {}),
					...(part.state?.output ? { resultContent: part.state.output } : {}),
					...(part.state?.metadata
						? { metadata: part.state.metadata as Record<string, unknown> }
						: {}),
					...(part.normalizedEntry ? { normalizedEntry: part.normalizedEntry } : {}),
				});
			}
		}
	};

	for (const record of session.runtimeMessageRecords) {
		if (record.role === 'user') {
			const user = userMessagesById[record.id];
			if (user?.id) {
				const renderUser = {
					...user,
					id: user.id,
					kind: 'user',
				} satisfies RenderUserMessage;
				runtimeProjected.push(renderUser);
			}
			seenMessageIds.add(record.id);
			continue;
		}

		projectParts(record.id, record);
	}

	for (const messageId of Object.keys(session.runtimeMessagePartsById)) {
		if (seenMessageIds.has(messageId)) continue;
		projectParts(messageId);
	}

	return [...passthrough, ...runtimeProjected].sort((a, b) => {
		const timeDiff = new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
		if (timeDiff !== 0) return timeDiff;
		// Stable fallback when timestamps match
		return (a.id || '').localeCompare(b.id || '');
	});
}

function getActiveSession(state: ChatState): ChatSession | undefined {
	const sid = state.activeSessionId;
	if (!sid) return undefined;
	return state.sessionsById[sid];
}

export const useSessionContextMetrics = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	const contextLimit = useModelContextWindow();

	return useMemo(() => {
		if (!session) {
			return {
				context: undefined,
				totalCost: 0,
			};
		}

		let lastAssistantWithTokens: ChatSession['runtimeMessageRecords'][number] | undefined;
		let totalCost = 0;
		for (const message of session.runtimeMessageRecords) {
			if (message.role !== 'assistant') continue;
			if (typeof message.cost === 'number') totalCost += message.cost;
			const total =
				typeof message.tokens?.total === 'number'
					? message.tokens.total
					: (message.tokens?.input ?? 0) +
						(message.tokens?.output ?? 0) +
						(message.tokens?.reasoning ?? 0) +
						(message.tokens?.cacheRead ?? 0) +
						(message.tokens?.cacheWrite ?? 0);
			if (total > 0) lastAssistantWithTokens = message;
		}

		if (!lastAssistantWithTokens?.tokens) {
			return { context: undefined, totalCost };
		}

		const tokens = lastAssistantWithTokens.tokens;
		const total =
			typeof tokens.total === 'number'
				? tokens.total
				: (tokens.input ?? 0) +
					(tokens.output ?? 0) +
					(tokens.reasoning ?? 0) +
					(tokens.cacheRead ?? 0) +
					(tokens.cacheWrite ?? 0);

		return {
			totalCost,
			context: {
				limit: contextLimit,
				input: tokens.input ?? 0,
				output: tokens.output ?? 0,
				reasoning: tokens.reasoning ?? 0,
				cacheRead: tokens.cacheRead ?? 0,
				cacheWrite: tokens.cacheWrite ?? 0,
				total,
				usage: contextLimit > 0 ? Math.min((total / contextLimit) * 100, 100) : null,
			},
		};
	}, [session, contextLimit]);
};

// ============================================
// Chat Store Selectors
// ============================================

/** Select messages array for active session */
export const useMessages = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	return useMemo(() => projectRuntimeMessages(session), [session]);
};

/** Select whether active session has any messages (lightweight — avoids subscribing to full array) */
export const useHasMessages = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	return useMemo(() => projectRuntimeMessages(session).length > 0, [session]);
};

/** Select processing state for active session */
export const useIsProcessing = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isProcessing ?? false);

/** Select auto-retrying state for active session */
export const useIsAutoRetrying = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isAutoRetrying ?? false);

/** Select retry info for active session */
export const useRetryInfo = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.retryInfo ?? null);

/** Select active session ID */
export const useActiveSessionId = () => useChatStore((state: ChatState) => state.activeSessionId);

/** Select status for active session */
export const useChatStatus = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.status ?? 'Ready');

/** Select streaming tool ID for active session */
export const useStreamingToolId = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.streamingToolId ?? null);

/** Select current tool activity for active session */
export const useToolActivity = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.toolActivity ?? null);

/** Select editing message ID */
export const useEditingMessageId = () => useChatStore((state: ChatState) => state.editingMessageId);

/** Select edit draft for a specific message (returns undefined if no draft) */
export const useEditDraft = (messageId: string | undefined) =>
	useChatStore((state: ChatState) => (messageId ? state.editDrafts[messageId] : undefined));

/** Select chat input state and setter (active session) */
export const useChatInputState = () => {
	const updateSession = useChatStore((state: ChatState) => state.actions.updateSession);
	const input = useChatStore((state: ChatState) => getActiveSession(state)?.input ?? '');
	const setInput = useCallback((value: string) => updateSession({ input: value }), [updateSession]);
	return { input, setInput };
};

/** Select only the input string (primitive — no unnecessary re-renders) */
export const useStoreInput = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.input ?? '');

/** Select chat actions only (stable references) */
export const useChatActions = () => useChatStore((state: ChatState) => state.actions);

/** Select total stats for active session */
export const useTotalStats = () =>
	useChatStore(
		useShallow((state: ChatState) => getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS),
	);

/** Aggregate subagent token totals from subtask messages in active session.
 * Memoized by messages ref to avoid O(N) scan on every store change. */
const subagentTotalsCache = { messages: null as RenderMessage[] | null, result: 0 };
export const useSubagentTokenTotals = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	return useMemo(() => {
		const messages = projectRuntimeMessages(session);
		if (messages === subagentTotalsCache.messages) return subagentTotalsCache.result;
		subagentTotalsCache.messages = messages;
		let total = 0;
		for (const msg of messages) {
			if (msg.kind === 'subtask') {
				const ct = msg.childTokens;
				if (ct?.total) total += ct.total;
			}
		}
		subagentTotalsCache.result = total;
		return total;
	}, [session]);
};

/** Select active model ID reported by the backend */
export const useActiveModelID = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.activeModelID);

/** Select per-turn token data for active session */
const EMPTY_TURN_TOKENS: Record<string, TokenUsage> = {};
export const useTurnTokens = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.turnTokens ?? EMPTY_TURN_TOKENS);

/** Select turn tokens for a specific message ID (avoids full-map subscription) */
export const useMessageTurnTokens = (messageId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!messageId) return undefined;
		return getActiveSession(state)?.turnTokens[messageId];
	});

/** Whether the last message is an assistant message that is actively streaming */
export const useIsLastMessageStreaming = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	return useMemo(() => {
		if (!session || !session.isProcessing) return false;
		const msgs = projectRuntimeMessages(session);
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i];
			if (msg.kind === 'assistant') {
				return !!msg.isStreaming;
			}
			if (msg.kind === 'user') return false;
		}
		return false;
	}, [session]);
};

/** Context usage percentage, rounded to 1% to reduce rerender frequency */
export const useContextPercentage = () => {
	const metrics = useSessionContextMetrics();
	return Math.floor(metrics.context?.usage ?? 0);
};

/** Select restore commits for active session */
export const useRestoreCommits = () =>
	useChatStore(state => getActiveSession(state)?.restoreCommits ?? EMPTY_COMMITS);

/** Select unrevert available state for active session */
export const useUnrevertAvailable = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.unrevertAvailable ?? false);

/** Select the message ID from which subsequent messages are reverted (dimmed) */
export const useRevertedFromMessageId = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.revertedFromMessageId ?? null);

/** Select prompt improver loading state */
export const useIsImprovingPrompt = () =>
	useChatStore((state: ChatState) => state.isImprovingPrompt);

/** Select prompt improver request ID */
export const useImprovingPromptRequestId = () =>
	useChatStore((state: ChatState) => state.improvingPromptRequestId);

/** Select prompt versions (original + improved) for toggle support */
export const usePromptVersions = () => useChatStore((state: ChatState) => state.promptVersions);

/** Select changed files panel state (active session) — totalStats removed to prevent cascading rerenders */
export const useChangedFilesState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			changedFiles: getActiveSession(state)?.changedFiles ?? EMPTY_CHANGED_FILES,
			cumulativeDiffs: getActiveSession(state)?.cumulativeDiffs ?? EMPTY_CUMULATIVE_DIFFS,
		})),
	);

/** Lightweight boolean check — does the session have any canonical todos? */
const hasTodosCache = {
	todos: null as ChatState['sessionsById'][string]['todos'] | null,
	result: false,
};
export const useHasTodos = () =>
	useChatStore((state: ChatState) => {
		const todos = getActiveSession(state)?.todos ?? null;
		if (todos === hasTodosCache.todos) return hasTodosCache.result;
		hasTodosCache.todos = todos;
		const result = Array.isArray(todos) && todos.length > 0;
		hasTodosCache.result = result;
		return result;
	});

/** Select canonical todo state from the active session */
export const useTodoState = () =>
	useChatStore(useShallow((state: ChatState) => getActiveSession(state)?.todos ?? null));

export const usePendingPermissions = () =>
	useChatStore(
		useShallow(
			(state: ChatState) => getActiveSession(state)?.pendingPermissions ?? EMPTY_PERMISSIONS,
		),
	);

export const usePendingQuestions = () =>
	useChatStore(
		useShallow((state: ChatState) => getActiveSession(state)?.pendingQuestions ?? EMPTY_QUESTIONS),
	);

// ============================================
// Tool-specific Selectors (active session)
// ============================================

export const useToolResultByToolId = (toolUseId: string | undefined) => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));

	return useMemo(() => {
		if (!session || !toolUseId) return undefined;

		for (const parts of Object.values(session.runtimeMessagePartsById)) {
			for (const part of parts) {
				if (part.type !== 'tool' || part.callId !== toolUseId) continue;
				const status = part.state?.status;
				if (status !== 'completed' && status !== 'error') continue;
				return {
					id: `res-${toolUseId}`,
					type: 'tool_result' as const,
					toolUseId,
					toolName: part.toolName || 'unknown',
					content: part.state?.output || '',
					isError: status === 'error',
					title: part.state?.title,
					metadata:
						part.state?.metadata && typeof part.state.metadata === 'object'
							? (part.state.metadata as Record<string, unknown>)
							: undefined,
					timestamp:
						typeof part.completedAt === 'number'
							? new Date(part.completedAt).toISOString()
							: typeof part.createdAt === 'number'
								? new Date(part.createdAt).toISOString()
								: undefined,
				} satisfies ToolResultView;
			}
		}

		return undefined;
	}, [session, toolUseId]);
};

export const useAccessRequestByToolUseId = (toolUseId: string | undefined) => {
	const pending = useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		return getActiveSession(state)?.pendingPermissions.find(
			request => request.tool?.callID === toolUseId,
		);
	});

	return useMemo(() => {
		if (!pending) return undefined;
		return {
			id: `access-${pending.id}`,
			type: 'access_request' as const,
			requestId: pending.id,
			tool: pending.permission,
			input: pending.metadata,
			pattern: pending.patterns[0],
			toolUseId: pending.tool?.callID,
			resolved: false,
			approved: false,
			metadata: pending.metadata,
			timestamp:
				typeof pending.metadata?.timestamp === 'string'
					? pending.metadata.timestamp
					: new Date().toISOString(),
		} as const;
	}, [pending]);
};

/**
 * Find the first unresolved access_request related to a subtask.
 * Matches by:
 *  1. toolUseId — permission on the `task` tool itself (before child session exists)
 *  2. childSessionId — permission from inside the running child session
 */
export const useSubtaskAccessRequest = useAccessRequestByToolUseId;

// ============================================
// UI Store Selectors
// ============================================

export const useActiveModal = () => useUIStore((state: UIState) => state.activeModal);

export const useFilePickerState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showFilePicker: state.showFilePicker,
			fileFilter: state.fileFilter,
			workspaceFiles: state.workspaceFiles,
			setShowFilePicker: state.actions.setShowFilePicker,
			setFileFilter: state.actions.setFileFilter,
		})),
	);

/** Lightweight file picker controls — excludes workspaceFiles to avoid re-renders */
export const useFilePickerControls = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showFilePicker: state.showFilePicker,
			setShowFilePicker: state.actions.setShowFilePicker,
			setFileFilter: state.actions.setFileFilter,
		})),
	);

export const useSlashCommandsState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showSlashCommands: state.showSlashCommands,
			slashFilter: state.slashFilter,
			setShowSlashCommands: state.actions.setShowSlashCommands,
			setSlashFilter: state.actions.setSlashFilter,
		})),
	);

export const useModelDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showModelDropdown: state.showModelDropdown,
			setShowModelDropdown: state.actions.setShowModelDropdown,
		})),
	);

export const useHistoryDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showHistoryDropdown: state.showHistoryDropdown,
			setShowHistoryDropdown: state.actions.setShowHistoryDropdown,
			conversationList: state.conversationList,
		})),
	);

export const useUIActions = () => useUIStore(state => state.actions);

// ============================================
// Settings Store Selectors
// ============================================

export const useMcpServers = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.mcpServers));

// PERF: chatStore.actions is a stable reference (created once in zustand create()),
// so we read it once outside the hook to avoid subscribing to chatStore on every render.
const _chatActions = () => useChatStore.getState().actions;

export const useModelSelection = () => {
	const chatActions = _chatActions();

	const setSessionAgent = useCallback(
		(agent: string | undefined, sessionId?: string) =>
			chatActions.updateSession({ agent }, sessionId),
		[chatActions],
	);
	const setSessionModel = useCallback(
		(model: string | undefined, sessionId?: string) =>
			chatActions.updateSession({ model }, sessionId),
		[chatActions],
	);

	return useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			selectedModel: state.selectedModel,
			proxyEndpoints: state.proxyEndpoints,
			opencodeProviders: state.opencodeProviders,
			enabledOpenCodeModels: state.enabledOpenCodeModels,
			disabledProviders: state.disabledProviders,
			getModelVariant: state.actions.getModelVariant,
			setModelVariant: state.actions.setModelVariant,
			setSelectedModel: state.actions.setSelectedModel,
			getSessionAgent: chatActions.getSessionAgent,
			setSessionAgent,
			getSessionModel: chatActions.getSessionModel,
			setSessionModel,
		})),
	);
};

export const useMainSettings = () =>
	useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			workspaceName: state.workspaceName,
			platformInfo: state.platformInfo,
			selectedModel: state.selectedModel,
			setSettings: state.actions.setSettings,
		})),
	);

export const useSettingsActions = () => useSettingsStore(state => state.actions);

const DEFAULT_CONTEXT_WINDOW = 200000;

export const useModelContextWindow = () =>
	useSettingsStore((state: SettingsState) => {
		const { selectedModel, opencodeProviders, proxyEndpoints } = state;
		const parsed = parseModelId(selectedModel);
		if (parsed) {
			// Check proxy endpoint models
			if (
				parsed.providerId === 'proxy' ||
				parsed.providerId === 'oai' ||
				parsed.providerId.startsWith('oai-')
			) {
				for (const endpoint of proxyEndpoints) {
					const epModel = endpoint.models.find(m => m.id === parsed.modelId);
					if (epModel?.contextLength) return epModel.contextLength;
				}
			}
			// Check OpenCode providers (includes models.dev metadata)
			const provider = opencodeProviders.find(p => p.id === parsed.providerId);
			if (provider) {
				const model = provider.models.find(m => m.id === parsed.modelId);
				if (model?.limit?.context) return model.limit.context;
			}
		}
		// Fallback: check proxy endpoint models by raw ID
		for (const endpoint of proxyEndpoints) {
			const epModel = endpoint.models.find(m => m.id === selectedModel);
			if (epModel?.contextLength) return epModel.contextLength;
		}
		return DEFAULT_CONTEXT_WINDOW;
	});

/** All transient notifications (top overlay) */
export const useTransientNotifications = () =>
	useUIStore((state: UIState) => state.notifications ?? EMPTY_NOTIFICATIONS);

// ============================================
// Message Queue Selectors
// ============================================

import type { QueuedMessageData } from '../../common/protocol';

const EMPTY_QUEUE: QueuedMessageData[] = [];

/** Select queued messages for active session */
export const useQueuedMessages = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.queuedMessages ?? EMPTY_QUEUE);

/** Whether the active session has queued messages */
export const useHasQueuedMessages = () =>
	useChatStore((state: ChatState) => (getActiveSession(state)?.queuedMessages?.length ?? 0) > 0);

/** Draft attachments restored from a cancelled queued message */
export const useDraftAttachments = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.draftAttachments);

/** Draft agent restored from a cancelled queued message */
export const useDraftAgent = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.draftAgent);

/** Reactive selector for the active session's agent (build = undefined, plan = 'plan', etc.) */
export const useSessionAgent = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.agent);

/** Reactive selector for the effective model's thinking effort variant. */
export const useSessionVariant = () => {
	const activeSessionModel = useChatStore((state: ChatState) => getActiveSession(state)?.model);
	return useSettingsStore((state: SettingsState) => {
		const effectiveModel = activeSessionModel ?? state.selectedModel;
		if (!effectiveModel || effectiveModel === 'default') return undefined;
		return state.modelVariants[effectiveModel];
	});
};

/** Reactive selector for the active session's auto-accept permissions toggle. */
export const useSessionAutoAccept = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.autoAccept ?? false);
