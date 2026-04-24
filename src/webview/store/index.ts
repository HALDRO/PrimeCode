/**
 * @file Store barrel export
 * @description Central export point for all Zustand stores and optimized selectors.
 *              Import selectors from here for optimized re-render behavior.
 */

// Base stores (use sparingly - prefer selectors)
export {
	type ChangedFile,
	type MaterializedView,
	type Message,
	type Part,
	type RenderAssistantMessage,
	type RenderNode,
	type RenderTaskCardNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type Session,
	type SessionStore,
	type TokenUsage,
	type ToolResultView,
	useChatStore,
} from './chatStore';
// Projection layer types
export type { MessageSection, SectionStats } from './projector';
// Optimized selectors (preferred)
export * from './selectors';
export { useSettingsStore } from './settingsStore';
export { type ConversationIndexEntry, useUIStore, type WorkspaceFile } from './uiStore';
