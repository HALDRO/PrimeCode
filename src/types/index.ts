/**
 * @file Type definitions re-export
 * @description Re-exports all types from TypeBox schemas. This file serves as the main
 * entry point for type imports throughout the codebase. All types are derived from
 * TypeBox schemas ensuring consistency between extension and webview.
 */

// Extension message types for typed communication
export {
	type AccessRequestData,
	type AccessResponseData,
	type ExtensionMessage,
	type FileChangedData,
	type FileChangedMessage,
	isSessionSpecificMessage,
	type Rule,
	type SetProcessingMessage,
	type SubtaskExtensionMessage,
	type ToolResultData,
	type ToolUseData,
} from './extensionMessages';
// Re-export all types and schemas from the unified schema file
export {
	// Access types
	type Access,
	type AccessRequest,
	AccessRequestSchema,
	type AccessResponse,
	AccessResponseSchema,
	AccessSchema,
	type AccessStore,
	AccessStoreSchema,
	// Agents config types
	type AgentsMcpConfig,
	AgentsMcpConfigSchema,
	type AgentsMcpServer,
	AgentsMcpServerSchema,
	apiTokensToStats,
	// CLI Provider types
	type CLIProviderType,
	CLIProviderTypeSchema,
	// Settings
	type ClaudeSettings,
	ClaudeSettingsSchema,
	// Message attachments
	type CodeSnippetAttachment,
	CodeSnippetAttachmentSchema,
	// Git & commits
	type CommitInfo,
	CommitInfoSchema,
	type ConversationData,
	ConversationDataSchema,
	type ConversationIndexEntry,
	ConversationIndexEntrySchema,
	// Conversation history
	type ConversationMessage,
	ConversationMessageSchema,
	// Discovery
	type DiscoveryStatus,
	DiscoveryStatusSchema,
	type ImageAttachment,
	ImageAttachmentSchema,
	type InstalledMcpServerMetadata,
	InstalledMcpServerMetadataSchema,
	// MCP Server types
	type MCPServerConfig,
	MCPServerConfigSchema,
	type MCPServersMap,
	MCPServersMapSchema,
	type MCPServerType,
	MCPServerTypeSchema,
	// Marketplace
	type McpMarketplaceCatalog,
	McpMarketplaceCatalogSchema,
	type McpMarketplaceItem,
	McpMarketplaceItemSchema,
	type MessageAttachments,
	MessageAttachmentsSchema,
	type OpenCodeAccess,
	type OpenCodeAccessResponse,
	OpenCodeAccessResponseSchema,
	OpenCodeAccessSchema,
	// OpenCode types
	type OpenCodeAgent,
	type OpenCodeAgentMode,
	OpenCodeAgentModeSchema,
	OpenCodeAgentSchema,
	type OpenCodeModelData,
	OpenCodeModelDataSchema,
	type OpenCodeProviderData,
	OpenCodeProviderDataSchema,
	type OpenCodeSession,
	OpenCodeSessionSchema,
	// Agents / Commands / Skills / Hooks
	type ParsedCommand,
	ParsedCommandSchema,
	type ParsedHook,
	ParsedHookSchema,
	type ParsedSkill,
	ParsedSkillSchema,
	// Platform info
	type PlatformInfo,
	PlatformInfoSchema,
	// Session info
	type SessionInfo,
	SessionInfoSchema,
	type SubtaskMessage,
	SubtaskMessageSchema,
	type TokenStats,
	TokenStatsSchema,
	// Token types
	type TokenUsageAPI,
	TokenUsageAPISchema,
	type TotalStats,
	TotalStatsSchema,
	// Unified MCP
	type UnifiedMcpMetadata,
	UnifiedMcpMetadataSchema,
	type UnifiedMcpRegistry,
	UnifiedMcpRegistrySchema,
	type UnifiedMcpServer,
	UnifiedMcpServerSchema,
	type UnifiedMcpTransport,
	UnifiedMcpTransportSchema,
	// VS Code API
	type VSCodeApi,
	// Webview message
	type WebviewMessage,
	WebviewMessageSchema,
	// Workspace & files
	type WorkspaceFile,
	WorkspaceFileSchema,
} from './schemas';
