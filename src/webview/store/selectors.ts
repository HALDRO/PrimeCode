/**
 * @file Zustand store selectors with shallow comparison optimization
 * @description Provides optimized selectors for all stores using useShallow to prevent
 *              unnecessary re-renders. Each selector returns only the specific state slice
 *              needed by a component. For primitive values, direct selectors are used.
 *              For objects/arrays, useShallow ensures shallow comparison.
 *              Session-specific data (changedFiles, restoreCommits, stats) now comes from chatStore.
 */

import { useShallow } from 'zustand/react/shallow';
import { type ChatState, useChatStore } from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import { type UIState, useUIStore } from './uiStore';

// ============================================
// Chat Store Selectors
// ============================================

/** Select messages array with shallow comparison */
export const useMessages = () => useChatStore(useShallow((state: ChatState) => state.messages));

/** Select processing state (primitive - no shallow needed) */
export const useIsProcessing = () => useChatStore((state: ChatState) => state.isProcessing);

/** Select auto-retrying state (primitive - no shallow needed) */
export const useIsAutoRetrying = () => useChatStore((state: ChatState) => state.isAutoRetrying);

/** Select retry info (object but small - no shallow needed) */
export const useRetryInfo = () => useChatStore((state: ChatState) => state.retryInfo);

/** Select loading state (primitive - no shallow needed) */
export const useIsLoading = () => useChatStore((state: ChatState) => state.isLoading);

/** Select active session ID (primitive - no shallow needed) */
export const useActiveSessionId = () => useChatStore((state: ChatState) => state.activeSessionId);

/** Select sessions list with shallow comparison */
export const useSessions = () => useChatStore(useShallow((state: ChatState) => state.sessions));

/** Select input value (primitive - no shallow needed) */
export const useChatInput = () => useChatStore((state: ChatState) => state.input);

/** Select status (primitive - no shallow needed) */
export const useChatStatus = () => useChatStore((state: ChatState) => state.status);

/** Select streaming tool ID (primitive - no shallow needed) */
export const useStreamingToolId = () => useChatStore((state: ChatState) => state.streamingToolId);

/** Select editing message ID (primitive - no shallow needed) */
export const useEditingMessageId = () => useChatStore((state: ChatState) => state.editingMessageId);

/** Select chat input state and setter */
export const useChatInputState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			input: state.input,
			setInput: state.actions.setInput,
		})),
	);

/** Select chat processing state */
export const useChatProcessingState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			isProcessing: state.isProcessing,
			isLoading: state.isLoading,
			status: state.status,
		})),
	);

/** Select message editing state */
export const useMessageEditingState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			editingMessageId: state.editingMessageId,
			setEditingMessageId: state.actions.setEditingMessageId,
			deleteMessagesFromId: state.actions.deleteMessagesFromId,
			isProcessing: state.isProcessing,
			messages: state.messages,
		})),
	);

/** Select chat actions only (stable references) */
export const useChatActions = () => useChatStore(state => state.actions);

/** Select token stats with shallow comparison (now from chatStore) */
export const useTokenStats = () => useChatStore(useShallow((state: ChatState) => state.tokenStats));

/** Select total stats with shallow comparison (now from chatStore) */
export const useTotalStats = () => useChatStore(useShallow((state: ChatState) => state.totalStats));

/** Select restore commits with shallow comparison (now from chatStore) */
export const useRestoreCommits = () =>
	useChatStore(useShallow((state: ChatState) => state.restoreCommits));

/** Select changed files with shallow comparison (now from chatStore) */
export const useChangedFiles = () =>
	useChatStore(useShallow((state: ChatState) => state.changedFiles));

/** Select unrevert available state (primitive - no shallow needed) */
export const useUnrevertAvailable = () =>
	useChatStore((state: ChatState) => state.unrevertAvailable);

/** Select prompt improver loading state (primitive - no shallow needed) */
export const useIsImprovingPrompt = () =>
	useChatStore((state: ChatState) => state.isImprovingPrompt);

/** Select prompt improver request ID (primitive - no shallow needed) */
export const useImprovingPromptRequestId = () =>
	useChatStore((state: ChatState) => state.improvingPromptRequestId);

/** Select changed files panel state (now from chatStore) */
export const useChangedFilesState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			changedFiles: state.changedFiles,
			totalStats: state.totalStats,
			tokenStats: state.tokenStats,
		})),
	);

/** Select only todo-related data from messages (optimized for ChangedFilesPanel) */
export const useTodoState = () =>
	useChatStore(
		useShallow((state: ChatState) => {
			// Find the latest TodoWrite tool_use message
			for (let i = state.messages.length - 1; i >= 0; i--) {
				const msg = state.messages[i];
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

/** Select last user message index (for copy operations) */
export const useLastUserMessageIndex = () =>
	useChatStore((state: ChatState) => {
		for (let i = state.messages.length - 1; i >= 0; i--) {
			if (state.messages[i].type === 'user') {
				return i;
			}
		}
		return -1;
	});

// ============================================
// Tool-specific Selectors (optimized for ToolMessage/ToolResultMessage)
// ============================================

/**
 * Select access request by toolUseId - returns undefined if not found or resolved
 * Uses reference equality on the found message to prevent unnecessary rerenders
 */
export const useAccessRequestByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) {
			return undefined;
		}
		return state.messages.find(
			m => m.type === 'access_request' && !m.resolved && m.toolUseId === toolUseId,
		) as Extract<ChatState['messages'][number], { type: 'access_request' }> | undefined;
	});

/**
 * Select tool_result by toolUseId - returns undefined if not found
 * Uses reference equality on the found message to prevent unnecessary rerenders
 */
export const useToolResultByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) {
			return undefined;
		}
		return state.messages.find(m => m.type === 'tool_result' && m.toolUseId === toolUseId) as
			| Extract<ChatState['messages'][number], { type: 'tool_result' }>
			| undefined;
	});

/**
 * Select multiple tool_results by toolUseIds - returns a map of toolUseId -> result
 * Optimized for ToolGroup to check completion status of multiple tools
 */
export const useToolResults = (toolUseIds: string[]) =>
	useChatStore(
		useShallow((state: ChatState) => {
			const results: Record<
				string,
				Extract<ChatState['messages'][number], { type: 'tool_result' }> | undefined
			> = {};
			for (const id of toolUseIds) {
				results[id] = state.messages.find(m => m.type === 'tool_result' && m.toolUseId === id) as
					| Extract<ChatState['messages'][number], { type: 'tool_result' }>
					| undefined;
			}
			return results;
		}),
	);

/**
 * Select tool_use by toolUseId - returns undefined if not found
 * Uses reference equality on the found message to prevent unnecessary rerenders
 */
export const useToolUseByToolId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) {
			return undefined;
		}
		return state.messages.find(m => m.type === 'tool_use' && m.toolUseId === toolUseId) as
			| Extract<ChatState['messages'][number], { type: 'tool_use' }>
			| undefined;
	});

/** Select session stats for display (stats from chatStore, sessionInfo from uiStore) */
export const useSessionStats = () => {
	const chatStats = useChatStore(
		useShallow((state: ChatState) => ({
			tokenStats: state.tokenStats,
			totalStats: state.totalStats,
		})),
	);
	const sessionInfo = useUIStore((state: UIState) => state.sessionInfo);
	return { ...chatStats, sessionInfo };
};

// ============================================
// UI Store Selectors
// ============================================

/** Select active modal (primitive - no shallow needed) */
export const useActiveModal = () => useUIStore((state: UIState) => state.activeModal);

/** Select modal actions */
export const useModalActions = () => {
	const actions = useUIStore(state => state.actions);
	return actions;
};

/** Select workspace files with shallow comparison */
export const useWorkspaceFiles = () =>
	useUIStore(useShallow((state: UIState) => state.workspaceFiles));

/** Select conversation list with shallow comparison */
export const useConversationList = () =>
	useUIStore(useShallow((state: UIState) => state.conversationList));

/** Select session info */
export const useSessionInfo = () => useUIStore((state: UIState) => state.sessionInfo);

/** Select file picker state */
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

/** Select slash commands state */
export const useSlashCommandsState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showSlashCommands: state.showSlashCommands,
			slashFilter: state.slashFilter,
			setShowSlashCommands: state.actions.setShowSlashCommands,
			setSlashFilter: state.actions.setSlashFilter,
		})),
	);

/** Select model dropdown state */
export const useModelDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showModelDropdown: state.showModelDropdown,
			setShowModelDropdown: state.actions.setShowModelDropdown,
		})),
	);

/** Select history dropdown state */
export const useHistoryDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showHistoryDropdown: state.showHistoryDropdown,
			setShowHistoryDropdown: state.actions.setShowHistoryDropdown,
			conversationList: state.conversationList,
		})),
	);

/** Select UI actions only (stable references) */
export const useUIActions = () => useUIStore(state => state.actions);

// ============================================
// Settings Store Selectors
// ============================================

/** Select workspace name (primitive - no shallow needed) */
export const useWorkspaceName = () =>
	useSettingsStore((state: SettingsState) => state.workspaceName);

/** Select selected model (primitive - no shallow needed) */
export const useSelectedModel = () =>
	useSettingsStore((state: SettingsState) => state.selectedModel);

/** Select platform info with shallow comparison */
export const usePlatformInfo = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.platformInfo));

/** Select proxy models with shallow comparison */
export const useProxyModels = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.proxyModels));

/** Select access rules with shallow comparison */
export const useAccess = () => useSettingsStore(useShallow((state: SettingsState) => state.access));

/** Select commands with shallow comparison */
export const useCommands = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.commands));

/** Select MCP servers with shallow comparison */
export const useMcpServers = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.mcpServers));

/** Select model dropdown data */
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

/** Select all main settings for settings page */
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

/** Select settings actions only (stable references) */
export const useSettingsActions = () => useSettingsStore(state => state.actions);

/** Default context window fallback */
const DEFAULT_CONTEXT_WINDOW = 200000;

/** Standard Claude models context windows */
const STANDARD_MODEL_CONTEXT: Record<string, number> = {
	'claude-sonnet-4-5': 200000,
	'claude-haiku-4-5': 200000,
	'claude-opus-4-5': 200000,
};

/** Select context window for currently selected model (reactive) */
export const useModelContextWindow = () =>
	useSettingsStore((state: SettingsState) => {
		const { selectedModel, opencodeProviders, proxyModels } = state;

		// Check OpenCode providers first (format: "providerId/modelId")
		if (selectedModel.includes('/')) {
			const slashIndex = selectedModel.indexOf('/');
			const providerId = selectedModel.substring(0, slashIndex);
			const modelId = selectedModel.substring(slashIndex + 1);

			// Check if it's a proxy model (providerId = "proxy" or "oai" for OpenCode)
			if (providerId === 'proxy' || providerId === 'oai') {
				const proxyModel = proxyModels.find(m => m.id === modelId);
				if (proxyModel?.contextLength) {
					return proxyModel.contextLength;
				}
			}

			// Check OpenCode providers
			const provider = opencodeProviders.find(p => p.id === providerId);
			if (provider) {
				const model = provider.models.find(m => m.id === modelId);
				if (model?.limit?.context) {
					return model.limit.context;
				}
			}
		}

		// Check proxy models directly (for Claude CLI)
		const proxyModel = proxyModels.find(m => m.id === selectedModel);
		if (proxyModel?.contextLength) {
			return proxyModel.contextLength;
		}

		// Check standard Claude models
		if (STANDARD_MODEL_CONTEXT[selectedModel]) {
			return STANDARD_MODEL_CONTEXT[selectedModel];
		}

		// Default fallback
		return DEFAULT_CONTEXT_WINDOW;
	});
