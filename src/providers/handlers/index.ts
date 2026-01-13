/**
 * @file Handlers Index
 * @description Re-exports all handler classes and their dependency interfaces for convenient imports.
 * Centralizes handler exports to simplify imports in ChatProvider and other consumers.
 */

export { AccessHandler, type AccessHandlerDeps } from './AccessHandler';
export { CommandsHandler } from './CommandsHandler';
export { DiagnosticsHandler, type DiagnosticsHandlerDeps } from './DiagnosticsHandler';
export { DiscoveryHandler, type DiscoveryHandlerDeps } from './DiscoveryHandler';
export { GitHandler, type GitHandlerDeps } from './GitHandler';
export { HistoryHandler, type HistoryHandlerDeps } from './HistoryHandler';
export { HooksHandler } from './HooksHandler';
export { ImageHandler, type ImageHandlerDeps } from './ImageHandler';
export { MessageHandler, type MessageHandlerDeps } from './MessageHandler';
export { OpenCodeHandler } from './OpenCodeHandler';
export { PermissionsHandler, type PermissionsHandlerDeps } from './PermissionsHandler';
export { PromptImproverHandler } from './PromptImproverHandler';
export { RestoreHandler, type RestoreHandlerDeps } from './RestoreHandler';
export { RulesHandler, type RulesHandlerDeps } from './RulesHandler';
export { SessionHandler, type SessionHandlerDeps } from './SessionHandler';
export { SettingsHandler, type SettingsHandlerDeps } from './SettingsHandler';
export { SkillsHandler } from './SkillsHandler';
export { StreamHandler, type StreamHandlerDeps } from './StreamHandler';
export { SubagentsHandler } from './SubagentsHandler';
export {
	WebviewMessageRouter,
	type WebviewMessageRouterDeps,
	type WebviewMessageRouterHandlers,
} from './WebviewMessageRouter';
