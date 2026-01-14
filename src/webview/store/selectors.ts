/**
 * @file Zustand store selectors with shallow comparison optimization
 * @description High-performance selectors that derive active chat state from `sessionsById`.
 * Uses `sessionOrder` for stable session lists without scanning maps.
 * IMPORTANT: All fallback arrays must use stable references to prevent infinite re-renders.
 */

import { useShallow } from 'zustand/react/shallow';
import {
	type ChangedFile,
	type ChatSession,
	type ChatState,
	type CommitInfo,
	DEFAULT_TOKEN_STATS,
	DEFAULT_TOTAL_STATS,
	type Message,
	useChatStore,
} from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import { type UIState, useUIStore } from './uiStore';

// Stable empty array references to prevent infinite re-renders with useShallow
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];

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
	useChatStore(state => getActiveSession(state)?.messages ?? EMPTY_MESSAGES);

/** Select processing state for active session */
export const useIsProcessing = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isProcessing ?? false);

/** Select auto-retrying state for active session */
export const useIsAutoRetrying = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isAutoRetrying ?? false);

/** Select retry info for active session */
export const useRetryInfo = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.retryInfo ?? null);

/** Select loading state for active session */
export const useIsLoading = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isLoading ?? false);

/** Select active session ID */
export const useActiveSessionId = () => useChatStore((state: ChatState) => state.activeSessionId);

/** Select sessions list with stable order */
export const useSessions = () =>
	useChatStore(
		useShallow((state: ChatState) =>
			state.sessionOrder.map(id => state.sessionsById[id]).filter((s): s is ChatSession => !!s),
		),
	);

/** Select input value for active session */
export const useChatInput = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.input ?? '');

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

/** Select chat processing state (active session) */
export const useChatProcessingState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			isProcessing: getActiveSession(state)?.isProcessing ?? false,
			isLoading: getActiveSession(state)?.isLoading ?? false,
			status: getActiveSession(state)?.status ?? 'Ready',
		})),
	);

/** Select message editing state (active session) */
export const useMessageEditingState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			editingMessageId: state.editingMessageId,
			setEditingMessageId: state.actions.setEditingMessageId,
			deleteMessagesFromId: state.actions.deleteMessagesFromId,
			isProcessing: getActiveSession(state)?.isProcessing ?? false,
			messages: getActiveSession(state)?.messages ?? EMPTY_MESSAGES,
		})),
	);

/** Select chat actions only (stable references) */
export const useChatActions = () => useChatStore(state => state.actions);

/** Select token stats for active session */
export const useTokenStats = () =>
	useChatStore(
		useShallow((state: ChatState) => getActiveSession(state)?.tokenStats ?? DEFAULT_TOKEN_STATS),
	);

/** Select total stats for active session */
export const useTotalStats = () =>
	useChatStore(
		useShallow((state: ChatState) => getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS),
	);

/** Select restore commits for active session */
export const useRestoreCommits = () =>
	useChatStore(state => getActiveSession(state)?.restoreCommits ?? EMPTY_COMMITS);

/** Select changed files for active session */
export const useChangedFiles = () =>
	useChatStore(state => getActiveSession(state)?.changedFiles ?? EMPTY_CHANGED_FILES);

/** Select unrevert available state for active session */
export const useUnrevertAvailable = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.unrevertAvailable ?? false);

/** Select prompt improver loading state */
export const useIsImprovingPrompt = () =>
	useChatStore((state: ChatState) => state.isImprovingPrompt);

/** Select prompt improver request ID */
export const useImprovingPromptRequestId = () =>
	useChatStore((state: ChatState) => state.improvingPromptRequestId);

/** Select changed files panel state (active session) */
export const useChangedFilesState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			changedFiles: getActiveSession(state)?.changedFiles ?? EMPTY_CHANGED_FILES,
			totalStats: getActiveSession(state)?.totalStats ?? DEFAULT_TOTAL_STATS,
			tokenStats: getActiveSession(state)?.tokenStats ?? DEFAULT_TOKEN_STATS,
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

/** Select last user message index (active session) */
export const useLastUserMessageIndex = () =>
	useChatStore((state: ChatState) => {
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].type === 'user') return i;
		}
		return -1;
	});

// ============================================
// Tool-specific Selectors (active session)
// ============================================

export const useAccessRequestByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		return messages.find(
			m => m.type === 'access_request' && !m.resolved && m.toolUseId === toolUseId,
		) as
			| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'access_request' }>
			| undefined;
	});

export const useToolResultByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		return messages.find(m => m.type === 'tool_result' && m.toolUseId === toolUseId) as
			| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'tool_result' }>
			| undefined;
	});

export const useToolResults = (toolUseIds: string[]) =>
	useChatStore(
		useShallow((state: ChatState) => {
			const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
			const results: Record<
				string,
				| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'tool_result' }>
				| undefined
			> = {};
			for (const id of toolUseIds) {
				results[id] = messages.find(m => m.type === 'tool_result' && m.toolUseId === id) as
					| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'tool_result' }>
					| undefined;
			}
			return results;
		}),
	);

export const useToolUseByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		const messages = getActiveSession(state)?.messages ?? EMPTY_MESSAGES;
		return messages.find(m => m.type === 'tool_use' && m.toolUseId === toolUseId) as
			| Extract<ChatState['sessionsById'][string]['messages'][number], { type: 'tool_use' }>
			| undefined;
	});

/** Select session stats for display (stats from chatStore, sessionInfo from uiStore) */
export const useSessionStats = () => {
	const chatStats = useChatStore(
		useShallow((state: ChatState) => ({
			tokenStats: getActiveSession(state)?.tokenStats,
			totalStats: getActiveSession(state)?.totalStats,
		})),
	);
	const sessionInfo = useUIStore((state: UIState) => state.sessionInfo);
	return { ...chatStats, sessionInfo };
};

// ============================================
// UI Store Selectors
// ============================================

export const useActiveModal = () => useUIStore((state: UIState) => state.activeModal);

export const useModalActions = () => useUIStore(state => state.actions);

export const useWorkspaceFiles = () =>
	useUIStore(useShallow((state: UIState) => state.workspaceFiles));

export const useConversationList = () =>
	useUIStore(useShallow((state: UIState) => state.conversationList));

export const useSessionInfo = () => useUIStore((state: UIState) => state.sessionInfo);

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

export const useWorkspaceName = () =>
	useSettingsStore((state: SettingsState) => state.workspaceName);

export const useSelectedModel = () =>
	useSettingsStore((state: SettingsState) => state.selectedModel);

export const usePlatformInfo = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.platformInfo));

export const useProxyModels = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.proxyModels));

export const useAccess = () => useSettingsStore(useShallow((state: SettingsState) => state.access));

export const useCommands = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.commands));

export const useMcpServers = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.mcpServers));

export const useModelSelection = () =>
	useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			selectedModel: state.selectedModel,
			proxyModels: state.proxyModels,
			anthropicModels: state.anthropicModels,
			anthropicModelsStatus: state.anthropicModelsStatus,
			enabledProxyModels: state.enabledProxyModels,
			opencodeProviders: state.opencodeProviders,
			enabledOpenCodeModels: state.enabledOpenCodeModels,
			disabledProviders: state.disabledProviders,
			setSelectedModel: state.actions.setSelectedModel,
		})),
	);

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
