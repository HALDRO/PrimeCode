/**
 * @file Zustand store selectors — chat, UI, and settings
 * @description Optimized selectors for deriving per-session chat state, UI dropdowns, and settings.
 * Only selectors actually consumed by components are exported here (dead code removed).
 * Uses stable empty-array refs (EMPTY_MESSAGES, etc.) to prevent infinite re-renders with useShallow.
 */

import { useShallow } from 'zustand/react/shallow';
import { parseModelId } from '../../common';
import {
	type ChangedFile,
	type ChatSession,
	type ChatState,
	type CommitInfo,
	DEFAULT_TOTAL_STATS,
	type Message,
	useChatStore,
} from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import type { TransientNotification } from './uiStore';
import { type UIState, useUIStore } from './uiStore';

// Stable empty array references to prevent infinite re-renders with useShallow
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];
const EMPTY_NOTIFICATIONS: TransientNotification[] = [];

function getActiveSession(state: ChatState): ChatSession | undefined {
	const sid = state.activeSessionId;
	if (!sid) return undefined;
	return state.sessionsById[sid];
}

// ============================================
// Chat Store Selectors
// ============================================

/** Select messages array for active session */
export const useMessages = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.messages ?? EMPTY_MESSAGES);

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

/** Select editing message ID */
export const useEditingMessageId = () => useChatStore((state: ChatState) => state.editingMessageId);

/** Select chat input state and setter (active session) */
export const useChatInputState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			input: getActiveSession(state)?.input ?? '',
			setInput: state.actions.setInput,
		})),
	);

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
const subagentTotalsCache = { messages: null as Message[] | null, result: 0 };
export const useSubagentTokenTotals = () =>
	useChatStore((state: ChatState) => {
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		if (messages === subagentTotalsCache.messages) return subagentTotalsCache.result;
		subagentTotalsCache.messages = messages;
		let total = 0;
		for (const msg of messages) {
			if (msg.type === 'subtask') {
				const ct = (msg as Record<string, unknown>).childTokens as { total?: number } | undefined;
				if (ct?.total) total += ct.total;
			}
		}
		subagentTotalsCache.result = total;
		return total;
	});

/** Select active model ID reported by the backend */
export const useActiveModelID = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.activeModelID);

/** Select per-turn token data for active session */
const EMPTY_TURN_TOKENS: Record<
	string,
	{ input: number; output: number; total: number; cacheRead: number; durationMs?: number }
> = {};
export const useTurnTokens = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.turnTokens ?? EMPTY_TURN_TOKENS);

/** Select turn tokens for a specific message ID (avoids full-map subscription) */
export const useMessageTurnTokens = (messageId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!messageId) return undefined;
		return getActiveSession(state)?.turnTokens[messageId];
	});

/** Whether the last message is an assistant message that is actively streaming */
export const useIsLastMessageStreaming = () =>
	useChatStore((state: ChatState) => {
		const session = getActiveSession(state);
		if (!session || !session.isProcessing) return false;
		const msgs = session.messages;
		// Walk backwards to find the last assistant message (skip tool_result, access_request, etc.)
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i];
			if (msg.type === 'assistant') {
				return !!(msg as { isStreaming?: boolean }).isStreaming;
			}
			// Stop searching if we hit a user message — no assistant streaming in this turn
			if (msg.type === 'user') return false;
		}
		return false;
	});

/** Context usage percentage, rounded to 1% to reduce rerender frequency */
export const useContextPercentage = () => {
	const contextLimit = useModelContextWindow();
	return useChatStore((state: ChatState) => {
		const stats = getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS;
		const contextTokens = stats.contextTokens ?? 0;
		return Math.min(Math.floor((contextTokens / contextLimit) * 100), 100);
	});
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
		})),
	);

/** Lightweight boolean check — does the session have any todos?
 * Memoized by messages ref to avoid O(N) scan on every store change (e.g. keystrokes). */
const hasTodosCache = { messages: null as Message[] | null, result: false };
export const useHasTodos = () =>
	useChatStore((state: ChatState) => {
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		if (messages === hasTodosCache.messages) return hasTodosCache.result;
		hasTodosCache.messages = messages;
		let result = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (
				msg.type === 'tool_use' &&
				'toolName' in msg &&
				msg.toolName?.toLowerCase() === 'todowrite' &&
				'rawInput' in msg &&
				msg.rawInput
			) {
				const todos = (msg.rawInput as { todos?: unknown }).todos;
				if (Array.isArray(todos) && todos.length > 0) {
					result = true;
					break;
				}
			}
		}
		hasTodosCache.result = result;
		return result;
	});

/** Select only todo-related data from active session messages */
export const useTodoState = () =>
	useChatStore(
		useShallow((state: ChatState) => {
			const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (
					msg.type === 'tool_use' &&
					'toolName' in msg &&
					msg.toolName?.toLowerCase() === 'todowrite' &&
					'rawInput' in msg &&
					msg.rawInput
				) {
					const todos = (msg.rawInput as { todos?: unknown }).todos;
					if (Array.isArray(todos)) {
						return todos as Array<{
							id?: string;
							content: string;
							status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
						}>;
					}
				}
			}
			return null;
		}),
	);

// ============================================
// Tool-specific Selectors (active session)
// ============================================

export const useToolResultByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		return messages.find(m => m.type === 'tool_result' && m.toolUseId === toolUseId) as
			| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'tool_result' }>
			| undefined;
	});

export const useAccessRequestByToolUseId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.type === 'access_request' && message.toolUseId === toolUseId) {
				return message as Extract<
					ChatState['sessionsById'][string]['messages'][number],
					{ type: 'access_request' }
				>;
			}
		}
		return undefined;
	});

/**
 * Find the first unresolved access_request related to a subtask.
 * Matches by:
 *  1. toolUseId — permission on the `task` tool itself (before child session exists)
 *  2. childSessionId — permission from inside the running child session
 */
export const useSubtaskAccessRequest = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.type !== 'access_request' || m.resolved) continue;
			// Match by toolUseId (permission on the task tool or routed from child)
			if (m.toolUseId === toolUseId) {
				return m as Extract<
					ChatState['sessionsById'][string]['messages'][number],
					{ type: 'access_request' }
				>;
			}
		}
		return undefined;
	});

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

	return useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			selectedModel: state.selectedModel,
			proxyModels: state.proxyModels,
			enabledProxyModels: state.enabledProxyModels,
			opencodeProviders: state.opencodeProviders,
			enabledOpenCodeModels: state.enabledOpenCodeModels,
			disabledProviders: state.disabledProviders,
			setSelectedModel: state.actions.setSelectedModel,
			getSessionModel: chatActions.getSessionModel,
			setSessionModel: chatActions.setSessionModel,
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

const STANDARD_MODEL_CONTEXT: Record<string, number> = {
	'claude-sonnet-4-5': 200000,
	'claude-haiku-4-5': 200000,
	'claude-opus-4-5': 200000,
};

export const useModelContextWindow = () =>
	useSettingsStore((state: SettingsState) => {
		const { selectedModel, opencodeProviders, proxyModels } = state;
		const parsed = parseModelId(selectedModel);
		if (parsed) {
			if (parsed.providerId === 'proxy' || parsed.providerId === 'oai') {
				const proxyModel = proxyModels.find(m => m.id === parsed.modelId);
				if (proxyModel?.contextLength) return proxyModel.contextLength;
			}
			const provider = opencodeProviders.find(p => p.id === parsed.providerId);
			if (provider) {
				const model = provider.models.find(m => m.id === parsed.modelId);
				if (model?.limit?.context) return model.limit.context;
			}
		}
		const proxyModel = proxyModels.find(m => m.id === selectedModel);
		if (proxyModel?.contextLength) return proxyModel.contextLength;
		if (STANDARD_MODEL_CONTEXT[selectedModel]) return STANDARD_MODEL_CONTEXT[selectedModel];
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
