/**
 * @file Store barrel export
 * @description Central export point for all Zustand stores and optimized selectors.
 *              Import selectors from here for optimized re-render behavior.
 */

// Base stores (use sparingly - prefer selectors)
export { type ChatState, type Message, type MessageInput, useChatStore } from './chatStore';
// Optimized selectors (preferred)
export * from './selectors';
export {
	type Access,
	type MCPServersMap,
	type PlatformInfo,
	type SettingsState,
	useSettingsStore,
} from './settingsStore';
export {
	type ChangedFile,
	type CommitInfo,
	type ConversationIndexEntry,
	type ModalType,
	type SessionInfo,
	type TokenStats,
	type TotalStats,
	type UIState,
	useUIStore,
	type WorkspaceFile,
} from './uiStore';
