/**
 * @file Zustand store selectors — chat, UI, and settings
 * @description Optimized selectors for deriving per-session chat state, UI dropdowns, and settings.
 * Only selectors actually consumed by components are exported here (dead code removed).
 * Uses stable empty-array refs (EMPTY_MESSAGES, etc.) to prevent infinite re-renders with useShallow.
 */

import { useShallow } from 'zustand/react/shallow';
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

/** Select chat actions only (stable references) */
export const useChatActions = () => useChatStore((state: ChatState) => state.actions);

/** Select total stats for active session */
export const useTotalStats = () =>
	useChatStore(
		useShallow((state: ChatState) => getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS),
	);

/** Aggregate subagent token totals from subtask messages in active session */
export const useSubagentTokenTotals = () =>
	useChatStore((state: ChatState) => {
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		let total = 0;
		for (const msg of messages) {
			if (msg.type === 'subtask') {
				const ct = (msg as Record<string, unknown>).childTokens as { total?: number } | undefined;
				if (ct?.total) total += ct.total;
			}
		}
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

/** Select changed files panel state (active session) */
export const useChangedFilesState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			changedFiles: getActiveSession(state)?.changedFiles ?? EMPTY_CHANGED_FILES,
			totalStats: getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS,
		})),
	);

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

export const useModelSelection = () => {
	const chatActions = useChatStore(state => state.actions);

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
		if (selectedModel.includes('/')) {
			const slashIndex = selectedModel.indexOf('/');
			const providerId = selectedModel.substring(0, slashIndex);
			const modelId = selectedModel.substring(slashIndex + 1);
			if (providerId === 'proxy' || providerId === 'oai') {
				const proxyModel = proxyModels.find(m => m.id === modelId);
				if (proxyModel?.contextLength) return proxyModel.contextLength;
			}
			const provider = opencodeProviders.find(p => p.id === providerId);
			if (provider) {
				const model = provider.models.find(m => m.id === modelId);
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
