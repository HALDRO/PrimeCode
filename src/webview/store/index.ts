/**
 * @file Store barrel export
 * @description Central export point for all Zustand stores and optimized selectors.
 *              Import selectors from here for optimized re-render behavior.
 */

// Base stores (use sparingly - prefer selectors)
export {
	type ChangedFile,
	isSessionProcessing,
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
export type { MessageSection, SectionStats, SessionDerivedView } from './derived';
// Projection layer types
export { clearSessionViewCache, deriveSessionView } from './derived';
// Optimized selectors (preferred)
export * from './selectors';
export { useSettingsStore } from './settingsStore';
export { type ConversationIndexEntry, useUIStore, type WorkspaceFile } from './uiStore';
