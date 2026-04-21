/**
 * @file Store barrel export
 * @description Central export point for all Zustand stores and optimized selectors.
 *              Import selectors from here for optimized re-render behavior.
 */

// Base stores (use sparingly - prefer selectors)
export {
	type ChatSession,
	type RenderAssistantMessage,
	type RenderNode,
	type RenderTaskCardNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type RuntimeMessagePart,
	type RuntimeMessageRecord,
	type StoredMessage,
	type TokenUsage,
	type ToolResultView,
	type UserMessage,
	useChatStore,
} from './chatStore';
// Optimized selectors (preferred)
export * from './selectors';
export { useSettingsStore } from './settingsStore';
export {
	type ChangedFile,
	type CommitInfo,
	type ConversationIndexEntry,
	useUIStore,
	type WorkspaceFile,
} from './uiStore';
