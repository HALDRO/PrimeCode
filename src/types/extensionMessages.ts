/**
 * @file Extension Message Types
 * @description Typed message definitions for communication between extension and webview.
 * Provides discriminated unions for type-safe message handling on both sides.
 * Replaces loose `{ type: string; data: unknown }` patterns with strict typing.
 */

import type {
	Access,
	CommitInfo,
	InstalledMcpServerMetadata,
	MCPServersMap,
	McpMarketplaceCatalog,
	OpenCodeProviderData,
	ParsedSubagent,
	PlatformInfo,
	TokenStats,
	TotalStats,
	WorkspaceFile,
} from './schemas';

// =============================================================================
// Base Message Type
// =============================================================================

interface BaseExtensionMessage<T extends string, D = undefined> {
	type: T;
	data?: D;
	sessionId?: string;
}

// =============================================================================
// Session Messages
// =============================================================================

export type SessionCreatedMessage = BaseExtensionMessage<'sessionCreated', { sessionId: string }>;
export type SessionClosedMessage = BaseExtensionMessage<'sessionClosed', { sessionId: string }>;
export type SessionClearedMessage = BaseExtensionMessage<'sessionCleared'>;
export type SessionSwitchedMessage = BaseExtensionMessage<
	'sessionSwitched',
	{
		sessionId: string;
		isProcessing?: boolean;
		totalStats?: TotalStats;
	}
>;
export type SessionProcessingCompleteMessage = BaseExtensionMessage<
	'sessionProcessingComplete',
	{
		sessionId: string;
		code: number | null;
		stats: TotalStats;
	}
>;

export interface SessionInfoData {
	sessionId: string;
	tools: string[];
	mcpServers: string[];
}
export type SessionInfoMessage = BaseExtensionMessage<'sessionInfo', SessionInfoData>;

// =============================================================================
// Processing State Messages
// =============================================================================

export type SetProcessingMessage = BaseExtensionMessage<
	'setProcessing',
	{ isProcessing: boolean; sessionId?: string }
>;
export type ReadyMessage = BaseExtensionMessage<'ready', string>;
export type LoadingMessage = BaseExtensionMessage<'loading', string>;
export type ClearLoadingMessage = BaseExtensionMessage<'clearLoading'>;
export type InterruptedMessage = BaseExtensionMessage<
	'interrupted',
	{ id?: string; timestamp?: string; content: string; reason?: string }
>;
export type ErrorMessage = BaseExtensionMessage<
	'error',
	{ id?: string; timestamp?: string; content: string }
>;
export type SessionRetryingMessage = BaseExtensionMessage<
	'sessionRetrying',
	{ sessionId: string; attempt: number; message: string; nextRetryAt?: string }
>;
export type SessionIdleMessage = BaseExtensionMessage<'sessionIdle', { sessionId: string }>;

// =============================================================================
// Content Messages
// =============================================================================

export type UserInputMessage = BaseExtensionMessage<
	'userInput',
	string | { text: string; messageId: string; model?: string }
>;
export type OutputMessage = BaseExtensionMessage<'output', string>;
export type ThinkingMessage = BaseExtensionMessage<'thinking', string>;

// =============================================================================
// Tool Messages
// =============================================================================

export interface ToolUseData {
	toolName: string;
	toolUseId: string;
	toolInput?: string;
	rawInput?: Record<string, unknown>;
	filePath?: string;
	/** Streaming output for running tools (e.g., Bash intermediate output) */
	streamingOutput?: string;
	/** Whether the tool is currently running */
	isRunning?: boolean;
	parentToolUseId?: string;
}

export interface ToolResultData {
	toolName: string;
	toolUseId: string;
	content: string;
	isError: boolean;
	parentToolUseId?: string;
	hidden?: boolean;
	estimatedTokens?: number;
	/** Human-readable title from SDK (e.g., "Reading file.ts") */
	title?: string;
	/** Tool execution time in milliseconds */
	durationMs?: number;
	/** Attached files (e.g., screenshots, generated images) */
	attachments?: Array<{
		id: string;
		mime: string;
		filename?: string;
		url?: string;
	}>;
	/** Tool metadata from SDK */
	metadata?: Record<string, unknown>;
}

export type ToolUseMessage = BaseExtensionMessage<'toolUse', ToolUseData>;
export type ToolResultMessage = BaseExtensionMessage<'toolResult', ToolResultData>;

// Unified message types (new format)
export type UnifiedUserMessage = BaseExtensionMessage<'user', never> & {
	content: string;
	model?: string;
	id?: string;
};
export type UnifiedAssistantMessage = BaseExtensionMessage<'assistant', never> & {
	content: string;
	id?: string;
	partId: string;
};
export type UnifiedThinkingMessage = BaseExtensionMessage<'thinking', never> & {
	content: string;
	id?: string;
	partId: string;
};
export type UnifiedToolUseMessage = BaseExtensionMessage<'tool_use', never> & ToolUseData;
export type UnifiedToolResultMessage = BaseExtensionMessage<'tool_result', never> & ToolResultData;
export type UnifiedAccessRequestMessage = BaseExtensionMessage<'access_request', never> & {
	requestId: string;
	tool: string;
	input: Record<string, unknown>;
	pattern?: string;
	timestamp?: string;
	toolUseId?: string;
};

export type SystemNoticeMessage = BaseExtensionMessage<'system_notice', never> & {
	id?: string;
	timestamp?: string;
	content?: string;
};

// =============================================================================
// Subtask Messages
// =============================================================================

export type SubtaskExtensionMessage = BaseExtensionMessage<'subtask', never> & {
	id: string;
	timestamp: string;
	agent: string;
	prompt: string;
	description: string;
	command?: string;
	status: 'running' | 'completed' | 'error';
	childMessages?: string[];
	childSessionId?: string;
	result?: string;
	messageID?: string;
};

export type ChildSessionCreatedMessage = BaseExtensionMessage<
	'child-session-created',
	{
		id: string;
		title: string;
		parentID: string;
	}
>;

// =============================================================================
// Access Messages
// =============================================================================

export interface AccessRequestData {
	id: string;
	tool: string;
	input: Record<string, unknown>;
	pattern?: string;
	timestamp?: number;
	toolUseId?: string;
}

export interface AccessResponseData {
	id: string;
	approved: boolean;
	alwaysAllow?: boolean;
}

export type AccessRequestMessage = BaseExtensionMessage<'accessRequest', AccessRequestData>;
export type AccessResponseMessage = BaseExtensionMessage<'accessResponse', AccessResponseData>;
export type AccessDataMessage = BaseExtensionMessage<'accessData', Access>;

// =============================================================================
// Rule Messages
// =============================================================================

export type Rule = import('./schemas').Rule;

export type RuleListMessage = BaseExtensionMessage<
	'ruleList',
	{ rules: Rule[]; meta?: { operation?: string; message?: string } }
>;
export type RuleUpdatedMessage = BaseExtensionMessage<'ruleUpdated', { rule: Rule }>;
export type CreateRuleMessage = BaseExtensionMessage<
	'createRule',
	{ name: string; content: string }
>;
export type ToggleRuleMessage = BaseExtensionMessage<
	'toggleRule',
	{ path: string; enabled: boolean; source?: 'claude' | 'opencode' }
>;
export type DeleteRuleMessage = BaseExtensionMessage<'deleteRule', { path: string }>;

// =============================================================================
// Permissions Messages
// =============================================================================

export type PermissionPolicyValue = 'ask' | 'allow' | 'deny';
export interface PermissionPolicies {
	edit: PermissionPolicyValue;
	terminal: PermissionPolicyValue;
	network: PermissionPolicyValue;
}

export type PermissionsUpdatedMessage = BaseExtensionMessage<
	'permissionsUpdated',
	{ policies: PermissionPolicies }
>;

export type UpdateTokensMessage = BaseExtensionMessage<'updateTokens', Partial<TokenStats>>;
export type UpdateTotalsMessage = BaseExtensionMessage<'updateTotals', Partial<TotalStats>>;

// =============================================================================
// Restore Messages
// =============================================================================

export type ShowRestoreOptionMessage = BaseExtensionMessage<'showRestoreOption', CommitInfo>;
export type RestoreSuccessMessage = BaseExtensionMessage<
	'restoreSuccess',
	{ message: string; commitSha?: string; messageId?: string; canUnrevert?: boolean }
>;
export type RestoreErrorMessage = BaseExtensionMessage<'restoreError', string>;
export type RestoreProgressMessage = BaseExtensionMessage<'restoreProgress', string>;
export type DeleteMessagesAfterMessage = BaseExtensionMessage<
	'deleteMessagesAfter',
	{ messageId: string }
>;
export type ClearRestoreCommitsMessage = BaseExtensionMessage<'clearRestoreCommits'>;
export type UpdateRestoreCommitsMessage = BaseExtensionMessage<
	'updateRestoreCommits',
	CommitInfo[]
>;
export type RestoreInputTextMessage = BaseExtensionMessage<'restoreInputText', string>;
export type MessagesReloadedMessage = BaseExtensionMessage<
	'messagesReloaded',
	{ messages: unknown[] }
>;
export type UnrevertAvailableMessage = BaseExtensionMessage<
	'unrevertAvailable',
	{ sessionId: string; cliSessionId?: string; available?: boolean }
>;

// =============================================================================
// File Messages
// =============================================================================

export interface FileChangedData {
	filePath: string;
	changeType: 'created' | 'modified' | 'deleted';
	linesAdded?: number;
	linesRemoved?: number;
	toolUseId?: string;
}

export type FileChangedMessage = BaseExtensionMessage<'fileChanged', FileChangedData>;
export type FileChangeUndoneMessage = BaseExtensionMessage<
	'fileChangeUndone',
	{ filePath: string }
>;
export type AllChangesUndoneMessage = BaseExtensionMessage<'allChangesUndone'>;
export type WorkspaceFilesMessage = BaseExtensionMessage<'workspaceFiles', WorkspaceFile[]>;

// =============================================================================
// Image Messages
// =============================================================================

export type ImagePathMessage = BaseExtensionMessage<'imagePath', { filePath: string }>;
export type ImageDataMessage = BaseExtensionMessage<'imageData', unknown>;

// =============================================================================
// Workspace Messages
// =============================================================================

export interface WorkspaceInfoData {
	name: string;
}

export type WorkspaceInfoMessage = BaseExtensionMessage<'workspaceInfo', WorkspaceInfoData>;

// =============================================================================
// Model & Settings Messages
// =============================================================================

export type ModelSelectedMessage = BaseExtensionMessage<'modelSelected'> & { model: string };
export type LoginRequiredMessage = BaseExtensionMessage<'loginRequired'>;
export type TerminalOpenedMessage = BaseExtensionMessage<'terminalOpened', string>;
export type SettingsDataMessage = BaseExtensionMessage<'settingsData', Record<string, unknown>>;
export type PlatformInfoMessage = BaseExtensionMessage<'platformInfo', PlatformInfo>;
export type ConfigChangedMessage = BaseExtensionMessage<'configChanged', string>;

export interface ModelCapabilities {
	reasoning?: boolean;
	vision?: boolean;
	tools?: boolean;
}

export interface ProxyModelsData {
	enabled: boolean;
	models: { id: string; name: string; capabilities?: ModelCapabilities }[];
	baseUrl?: string;
	error?: string;
}
export type ProxyModelsMessage = BaseExtensionMessage<'proxyModels', ProxyModelsData>;

export interface AnthropicModelsData {
	enabled: boolean;
	models: { id: string; name: string }[];
	keyPresent?: boolean;
	error?: string;
}
export type AnthropicModelsMessage = BaseExtensionMessage<'anthropicModels', AnthropicModelsData>;

export type AnthropicKeyStatusMessage = BaseExtensionMessage<
	'anthropicKeyStatus',
	{ hasKey: boolean; error?: string }
>;
export type AnthropicKeySavedMessage = BaseExtensionMessage<
	'anthropicKeySaved',
	{ success: boolean; error?: string }
>;
export type AnthropicKeyClearedMessage = BaseExtensionMessage<
	'anthropicKeyCleared',
	{ success: boolean; error?: string }
>;

// =============================================================================
// Clipboard Messages
// =============================================================================

export type ClipboardTextMessage = BaseExtensionMessage<'clipboardText', string>;
export type ClipboardContextMessage = BaseExtensionMessage<'clipboardContext', never> & {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
};
export type ClipboardContextNotFoundMessage = BaseExtensionMessage<
	'clipboardContextNotFound',
	never
> & {
	text: string;
};

// =============================================================================
// OpenCode Messages
// =============================================================================

export type OpenCodeStatusMessage = BaseExtensionMessage<
	'openCodeStatus',
	{ installed: boolean; version: string | null; error?: string }
>;
export type OpenCodeProvidersMessage = BaseExtensionMessage<
	'openCodeProviders',
	{
		providers: OpenCodeProviderData[];
		config: { isLoading?: boolean; error?: string };
	}
>;
export type OpenCodeModelSetMessage = BaseExtensionMessage<'openCodeModelSet', { model: string }>;
export type OpenCodeAuthResultMessage = BaseExtensionMessage<
	'openCodeAuthResult',
	{ success: boolean; error?: string; providerId: string }
>;
export type OpenCodeCustomProviderResultMessage = BaseExtensionMessage<
	'openCodeCustomProviderResult',
	{ success: boolean; error?: string; providerId: string }
>;
export type OpenCodeDisconnectResultMessage = BaseExtensionMessage<
	'openCodeDisconnectResult',
	{ success: boolean; error?: string; providerId: string }
>;
export type RemoveOpenCodeProviderMessage = BaseExtensionMessage<
	'removeOpenCodeProvider',
	{ providerId: string; providerName?: string }
>;
export type AvailableProvidersMessage = BaseExtensionMessage<
	'availableProviders',
	{ providers: { id: string; name: string }[] }
>;

// Proxy Provider Messages (for OpenCode CLI integration)
export type ProxyProviderSavingMessage = BaseExtensionMessage<
	'proxyProviderSaving',
	{ isLoading: boolean }
>;
export type ProxyProviderSavedMessage = BaseExtensionMessage<
	'proxyProviderSaved',
	{ success: boolean; error?: string; provider?: string }
>;
export type ReloadOpenCodeProvidersMessage = BaseExtensionMessage<'reloadOpenCodeProviders'>;

// =============================================================================
// OpenCode MCP Status Messages
// =============================================================================

export type OpenCodeMcpStatus =
	| { status: 'connected' }
	| { status: 'disabled' }
	| { status: 'failed'; error: string }
	| { status: 'needs_auth' }
	| { status: 'needs_client_registration'; error: string };

export type OpenCodeMcpStatusMessage = BaseExtensionMessage<
	'opencodeMcpStatus',
	Record<string, OpenCodeMcpStatus>
>;

export type OpenCodeMcpAuthStartedMessage = BaseExtensionMessage<
	'opencodeMcpAuthStarted',
	{ name: string; authorizationUrl: string }
>;

export type OpenCodeMcpAuthErrorMessage = BaseExtensionMessage<
	'opencodeMcpAuthError',
	{ name: string; error: string }
>;

export type McpServersMessage = BaseExtensionMessage<'mcpServers', MCPServersMap>;
export type McpServerSavedMessage = BaseExtensionMessage<'mcpServerSaved', { name: string }>;
export type McpServerDeletedMessage = BaseExtensionMessage<'mcpServerDeleted', { name: string }>;
export type McpServerErrorMessage = BaseExtensionMessage<'mcpServerError', { error: string }>;

export type McpStatusMessage = BaseExtensionMessage<
	'mcpStatus',
	Record<
		string,
		{
			status: string;
			error?: string;
			tools?: Array<{ name: string; description?: string }>;
			resources?: Array<{ uri: string; name: string; description?: string }>;
		}
	>
>;

// =============================================================================
// MCP Marketplace
// =============================================================================

export type McpMarketplaceCatalogMessage = BaseExtensionMessage<
	'mcpMarketplaceCatalog',
	{ catalog: McpMarketplaceCatalog; error?: string }
>;

export type McpMarketplaceInstallResultMessage = BaseExtensionMessage<
	'mcpMarketplaceInstallResult',
	{
		name: string;
		success: boolean;
		error?: string;
		installPrompt?: string;
		githubUrl?: string;
		openedUrl?: string;
	}
>;

export type McpInstalledMetadataMessage = BaseExtensionMessage<
	'mcpInstalledMetadata',
	{ metadata: Record<string, InstalledMcpServerMetadata> }
>;

// =============================================================================
// Agents Config Messages
// =============================================================================

export type AgentsConfigStatusMessage = BaseExtensionMessage<
	'agentsConfigStatus',
	{ hasProjectConfig: boolean; projectPath: string }
>;

export type AgentsSyncTarget = 'claude' | 'opencode' | 'cursor';

export type AgentsSyncResultMessage = BaseExtensionMessage<
	'agentsSyncResult',
	{ target: AgentsSyncTarget; success: boolean; error?: string }
>;

export type McpImportResultMessage = BaseExtensionMessage<
	'mcpImportResult',
	{ success: boolean; sources?: string[]; backups?: string[]; error?: string; message?: string }
>;

export type CliDiagnosticsMessage = BaseExtensionMessage<'cliDiagnostics', unknown>;
export type ConversationListMessage = BaseExtensionMessage<'conversationList', unknown>;
export type AllConversationsClearedMessage = BaseExtensionMessage<'allConversationsCleared'>;

// =============================================================================
// Union of All Extension Messages
// =============================================================================

export type ExtensionMessage =
	| SessionCreatedMessage
	| SessionClosedMessage
	| SessionClearedMessage
	| SessionSwitchedMessage
	| SessionProcessingCompleteMessage
	| SessionInfoMessage
	| SetProcessingMessage
	| ReadyMessage
	| LoadingMessage
	| ClearLoadingMessage
	| ErrorMessage
	| InterruptedMessage
	| SessionRetryingMessage
	| SessionIdleMessage
	| UserInputMessage
	| OutputMessage
	| UnifiedThinkingMessage
	| ThinkingMessage
	| ToolUseMessage
	| ToolResultMessage
	| AccessRequestMessage
	| AccessResponseMessage
	| AccessDataMessage
	// Unified message types (new format)
	| UnifiedUserMessage
	| UnifiedAssistantMessage
	| UnifiedToolUseMessage
	| UnifiedToolResultMessage
	| UnifiedAccessRequestMessage
	// System notice message
	| SystemNoticeMessage
	// Subtask messages
	| SubtaskExtensionMessage
	| ChildSessionCreatedMessage
	| RuleListMessage
	| RuleUpdatedMessage
	| PermissionsUpdatedMessage
	| UpdateTokensMessage
	| UpdateTotalsMessage
	| ShowRestoreOptionMessage
	| RestoreSuccessMessage
	| RestoreErrorMessage
	| RestoreProgressMessage
	| DeleteMessagesAfterMessage
	| ClearRestoreCommitsMessage
	| UpdateRestoreCommitsMessage
	| RestoreInputTextMessage
	| MessagesReloadedMessage
	| UnrevertAvailableMessage
	| FileChangedMessage
	| FileChangeUndoneMessage
	| AllChangesUndoneMessage
	| WorkspaceFilesMessage
	| ImagePathMessage
	| ImageDataMessage
	| WorkspaceInfoMessage
	| ModelSelectedMessage
	| LoginRequiredMessage
	| TerminalOpenedMessage
	| SettingsDataMessage
	| PlatformInfoMessage
	| ProxyModelsMessage
	| AnthropicModelsMessage
	| AnthropicKeyStatusMessage
	| AnthropicKeySavedMessage
	| AnthropicKeyClearedMessage
	| ConfigChangedMessage
	| ClipboardTextMessage
	| ClipboardContextMessage
	| ClipboardContextNotFoundMessage
	| OpenCodeStatusMessage
	| OpenCodeProvidersMessage
	| OpenCodeModelSetMessage
	| OpenCodeAuthResultMessage
	| OpenCodeCustomProviderResultMessage
	| OpenCodeDisconnectResultMessage
	| RemoveOpenCodeProviderMessage
	| AvailableProvidersMessage
	| ProxyProviderSavingMessage
	| ProxyProviderSavedMessage
	| ReloadOpenCodeProvidersMessage
	| OpenCodeMcpStatusMessage
	| OpenCodeMcpAuthStartedMessage
	| OpenCodeMcpAuthErrorMessage
	| McpMarketplaceCatalogMessage
	| McpMarketplaceInstallResultMessage
	| McpInstalledMetadataMessage
	| McpServersMessage
	| McpServerSavedMessage
	| McpServerDeletedMessage
	| McpServerErrorMessage
	| McpStatusMessage
	| AgentsConfigStatusMessage
	| AgentsSyncResultMessage
	| McpImportResultMessage
	| CommandsListMessage
	| SkillsListMessage
	| HooksListMessage
	| SubagentsListMessage
	| CliDiagnosticsMessage
	| ConversationListMessage
	| AllConversationsClearedMessage
	| DiscoveryStatusMessage
	| McpConfigReloadedMessage
	| ProjectUpdatedMessage
	| MessagePartRemovedMessage
	| ImprovePromptResultMessage
	| ImprovePromptErrorMessage
	| ImprovePromptCancelledMessage;

// =============================================================================
// Commands Messages
// =============================================================================

export type ParsedCommand = import('./schemas').ParsedCommand;

export type CommandsListMessage = BaseExtensionMessage<
	'commandsList',
	{
		custom: ParsedCommand[];
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	}
>;

// =============================================================================
// Skills & Hooks Messages
// =============================================================================

export type SkillsListMessage = BaseExtensionMessage<
	'skillsList',
	{
		skills: import('./schemas').ParsedSkill[];
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	}
>;

export type HooksListMessage = BaseExtensionMessage<
	'hooksList',
	{
		hooks: import('./schemas').ParsedHook[];
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	}
>;

export type SubagentsListMessage = BaseExtensionMessage<
	'subagentsList',
	{
		subagents: ParsedSubagent[];
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	}
>;

// =============================================================================
// Discovery Messages
// =============================================================================

export type DiscoveryStatusMessage = BaseExtensionMessage<
	'discoveryStatus',
	import('./schemas').DiscoveryStatus
>;

// =============================================================================
// MCP Config Hot-Reload Messages
// =============================================================================

export type McpConfigReloadedMessage = BaseExtensionMessage<
	'mcpConfigReloaded',
	{ source: 'file-watcher' | 'manual'; timestamp: number }
>;

// =============================================================================
// OpenCode Project & Message Events
// =============================================================================

export type ProjectUpdatedMessage = BaseExtensionMessage<
	'projectUpdated',
	import('./schemas').ProjectUpdated
>;

export type MessagePartRemovedMessage = BaseExtensionMessage<
	'messagePartRemoved',
	import('./schemas').MessagePartRemoved
>;

// =============================================================================
// Prompt Improver Messages
// =============================================================================

export type ImprovePromptResultMessage = BaseExtensionMessage<
	'improvePromptResult',
	{ requestId: string; improvedText: string }
>;
export type ImprovePromptErrorMessage = BaseExtensionMessage<
	'improvePromptError',
	{ requestId: string; error: string }
>;
export type ImprovePromptCancelledMessage = BaseExtensionMessage<
	'improvePromptCancelled',
	{ requestId: string }
>;

// =============================================================================
// Helper Type Guards
// =============================================================================

export function isSessionSpecificMessage(message: { type: string; sessionId?: string }): boolean {
	const sessionSpecificTypes = new Set([
		'ready',
		'loading',
		'clearLoading',
		'output',
		'user',
		'assistant',
		'thinking',
		'error',
		'interrupted',
		'sessionRetrying',
		'sessionIdle',
		'toolUse',
		'toolResult',
		'tool_use',
		'tool_result',
		'accessRequest',
		'accessResponse',
		'access_request',
		'subtask',
		'child-session-created',
		'updateTokens',
		'updateTotals',
		'showRestoreOption',
		'setProcessing',
		'fileChanged',
		'sessionProcessingComplete',
		'userInput',
		'messagesReloaded',
		'sessionInfo',
		'loginRequired',
		'terminalOpened',
	]);
	return sessionSpecificTypes.has(message.type);
}
