/**
 * @file Extension Message Types
 * @description Typed message definitions for communication between extension and webview.
 * Uses unified session_event protocol for all session-specific messages.
 * Global messages (settings, workspace info, etc.) use direct postMessage.
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
// Unified Session Event Protocol
// =============================================================================

export type SessionEventType =
	| 'message'
	| 'status'
	| 'stats'
	| 'complete'
	| 'restore'
	| 'file'
	| 'access'
	| 'messages_reload'
	| 'delete_messages_after'
	| 'message_removed'
	| 'session_info'
	| 'auth'
	| 'terminal';

export type SessionStatus = 'idle' | 'busy' | 'error' | 'retrying';

export type SessionMessageType =
	| 'user'
	| 'assistant'
	| 'thinking'
	| 'tool_use'
	| 'tool_result'
	| 'error'
	| 'subtask'
	| 'access_request'
	| 'system_notice'
	| 'interrupted';

export interface SessionMessageData {
	id: string;
	type: SessionMessageType;
	content?: string;
	partId?: string;
	isStreaming?: boolean;
	isDelta?: boolean;
	hidden?: boolean;
	timestamp?: string;
	toolName?: string;
	toolUseId?: string;
	toolInput?: string;
	rawInput?: Record<string, unknown>;
	filePath?: string;
	isError?: boolean;
	isRunning?: boolean;
	streamingOutput?: string;
	estimatedTokens?: number;
	title?: string;
	durationMs?: number;
	attachments?: Array<{ id: string; mime: string; filename?: string; url?: string }>;
	metadata?: Record<string, unknown>;
	agent?: string;
	prompt?: string;
	description?: string;
	command?: string;
	status?: 'running' | 'completed' | 'error' | 'cancelled';
	result?: string;
	messageID?: string;
	childSessionId?: string;
	childMessages?: string[];
	startTime?: string;
	reasoningTokens?: number;
	requestId?: string;
	tool?: string;
	input?: Record<string, unknown>;
	pattern?: string;
	resolved?: boolean;
	approved?: boolean;
	reason?: string;
	model?: string;
}

export interface SessionMessagePayload {
	eventType: 'message';
	message: SessionMessageData;
}

export interface SessionStatusPayload {
	eventType: 'status';
	status: SessionStatus;
	/** Optional human-readable UI status text (e.g., "Ready", "Claude is working...") */
	statusText?: string;
	/** Optional loading message shown while busy */
	loadingMessage?: string;
	retryInfo?: {
		attempt: number;
		message: string;
		nextRetryAt?: string;
	};
}

export interface SessionStatsPayload {
	eventType: 'stats';
	tokenStats?: Partial<TokenStats>;
	totalStats?: Partial<TotalStats>;
}

export interface SessionCompletePayload {
	eventType: 'complete';
	partId: string;
	toolUseId?: string;
	/** When true, indicates the message/part should be removed from UI */
	removed?: boolean;
	/** ID of the message to remove (used with removed: true) */
	messageId?: string;
}

export interface SessionRestorePayload {
	eventType: 'restore';
	action:
		| 'add_commit'
		| 'clear_commits'
		| 'set_commits'
		| 'success'
		| 'error'
		| 'progress'
		| 'unrevert_available'
		| 'restore_input';
	commit?: CommitInfo;
	commits?: CommitInfo[];
	message?: string;
	canUnrevert?: boolean;
	available?: boolean;
	text?: string;
}

export interface SessionFilePayload {
	eventType: 'file';
	action: 'changed' | 'undone' | 'all_undone';
	filePath?: string;
	fileName?: string;
	linesAdded?: number;
	linesRemoved?: number;
	toolUseId?: string;
}

export interface SessionAccessPayload {
	eventType: 'access';
	action: 'response';
	requestId: string;
	approved: boolean;
	alwaysAllow?: boolean;
}

export interface SessionMessagesReloadPayload {
	eventType: 'messages_reload';
	messages: SessionMessageData[];
}

export interface SessionDeleteMessagesAfterPayload {
	eventType: 'delete_messages_after';
	messageId: string;
}

export interface SessionMessageRemovedPayload {
	eventType: 'message_removed';
	messageId: string;
	partId?: string;
}

export interface SessionInfoData {
	sessionId: string;
	tools: string[];
	mcpServers: string[];
}

export interface SessionInfoPayload {
	eventType: 'session_info';
	data: SessionInfoData;
}

export interface SessionAuthPayload {
	eventType: 'auth';
	action: 'login_required';
}

export interface SessionTerminalPayload {
	eventType: 'terminal';
	action: 'opened';
	content?: string;
}

export type SessionEventPayload =
	| SessionMessagePayload
	| SessionStatusPayload
	| SessionStatsPayload
	| SessionCompletePayload
	| SessionRestorePayload
	| SessionFilePayload
	| SessionAccessPayload
	| SessionMessagesReloadPayload
	| SessionDeleteMessagesAfterPayload
	| SessionMessageRemovedPayload
	| SessionInfoPayload
	| SessionAuthPayload
	| SessionTerminalPayload;

export interface SessionEventMessage {
	type: 'session_event';
	targetId: string;
	eventType: SessionEventType;
	payload: SessionEventPayload;
	timestamp: number;
	sessionId?: string;
}

export type SessionLifecycleAction = 'created' | 'closed' | 'switched' | 'cleared';

export interface SessionLifecycleMessage {
	type: 'session_lifecycle';
	action: SessionLifecycleAction;
	sessionId: string;
	parentId?: string;
	data?: {
		isProcessing?: boolean;
		totalStats?: TotalStats;
		messages?: unknown[];
	};
}

// =============================================================================
// Helper Type Guards
// =============================================================================

export function isSessionEventMessage(message: unknown): message is SessionEventMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: string }).type === 'session_event'
	);
}

export function isSessionLifecycleMessage(message: unknown): message is SessionLifecycleMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: string }).type === 'session_lifecycle'
	);
}

// =============================================================================
// Tool Data Interfaces (used by SessionMessageData)
// =============================================================================

export interface ToolUseData {
	toolName: string;
	toolUseId: string;
	toolInput?: string;
	rawInput?: Record<string, unknown>;
	filePath?: string;
	streamingOutput?: string;
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
	title?: string;
	durationMs?: number;
	attachments?: Array<{
		id: string;
		mime: string;
		filename?: string;
		url?: string;
	}>;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Access Messages (global)
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

export type AccessDataMessage = BaseExtensionMessage<'accessData', Access>;

// =============================================================================
// Rule Messages (global)
// =============================================================================

export type Rule = import('./schemas').Rule;

export type RuleListMessage = BaseExtensionMessage<
	'ruleList',
	{ rules: Rule[]; meta?: { operation?: string; message?: string } }
>;
export type RuleUpdatedMessage = BaseExtensionMessage<'ruleUpdated', { rule: Rule }>;

// =============================================================================
// Permissions Messages (global)
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

// =============================================================================
// File Messages (global)
// =============================================================================

export type WorkspaceFilesMessage = BaseExtensionMessage<'workspaceFiles', WorkspaceFile[]>;

// =============================================================================
// Image Messages (global)
// =============================================================================

export type ImagePathMessage = BaseExtensionMessage<'imagePath', { filePath: string }>;
export type ImageDataMessage = BaseExtensionMessage<'imageData', unknown>;

// =============================================================================
// Workspace Messages (global)
// =============================================================================

export interface WorkspaceInfoData {
	name: string;
}

export type WorkspaceInfoMessage = BaseExtensionMessage<'workspaceInfo', WorkspaceInfoData>;

// =============================================================================
// Model & Settings Messages (global)
// =============================================================================

export type ModelSelectedMessage = BaseExtensionMessage<'modelSelected'> & { model: string };
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
// Clipboard Messages (global)
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
// OpenCode Messages (global)
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
// OpenCode MCP Status Messages (global)
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
// MCP Marketplace (global)
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
// Agents Config Messages (global)
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

// =============================================================================
// Diagnostics & History Messages (global)
// =============================================================================

export type CliDiagnosticsMessage = BaseExtensionMessage<'cliDiagnostics', unknown>;
export type ConversationListMessage = BaseExtensionMessage<'conversationList', unknown>;
export type AllConversationsClearedMessage = BaseExtensionMessage<'allConversationsCleared'>;

// =============================================================================
// Prompt Improver Messages (global)
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
// Commands, Skills, Hooks, Subagents Messages (global)
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
// Discovery & Project Messages (global)
// =============================================================================

export type DiscoveryStatusMessage = BaseExtensionMessage<
	'discoveryStatus',
	import('./schemas').DiscoveryStatus
>;

export type McpConfigReloadedMessage = BaseExtensionMessage<
	'mcpConfigReloaded',
	{ source: 'file-watcher' | 'manual'; timestamp: number }
>;

export type ProjectUpdatedMessage = BaseExtensionMessage<
	'projectUpdated',
	import('./schemas').ProjectUpdated
>;

// =============================================================================
// Union of All Extension Messages
// =============================================================================

export type ExtensionMessage =
	// Session events (unified protocol)
	| SessionEventMessage
	| SessionLifecycleMessage
	// Access messages
	| AccessDataMessage
	// Rules & permissions
	| RuleListMessage
	| RuleUpdatedMessage
	| PermissionsUpdatedMessage
	// Files
	| WorkspaceFilesMessage
	| ImagePathMessage
	| ImageDataMessage
	| WorkspaceInfoMessage
	// Model & settings
	| ModelSelectedMessage
	| SettingsDataMessage
	| PlatformInfoMessage
	| ProxyModelsMessage
	| AnthropicModelsMessage
	| AnthropicKeyStatusMessage
	| AnthropicKeySavedMessage
	| AnthropicKeyClearedMessage
	| ConfigChangedMessage
	// Clipboard
	| ClipboardTextMessage
	| ClipboardContextMessage
	| ClipboardContextNotFoundMessage
	// OpenCode
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
	// OpenCode MCP
	| OpenCodeMcpStatusMessage
	| OpenCodeMcpAuthStartedMessage
	| OpenCodeMcpAuthErrorMessage
	// MCP
	| McpMarketplaceCatalogMessage
	| McpMarketplaceInstallResultMessage
	| McpInstalledMetadataMessage
	| McpServersMessage
	| McpServerSavedMessage
	| McpServerDeletedMessage
	| McpServerErrorMessage
	| McpStatusMessage
	// Agents config
	| AgentsConfigStatusMessage
	| AgentsSyncResultMessage
	| McpImportResultMessage
	// Commands, skills, hooks, subagents
	| CommandsListMessage
	| SkillsListMessage
	| HooksListMessage
	| SubagentsListMessage
	// Diagnostics & history
	| CliDiagnosticsMessage
	| ConversationListMessage
	| AllConversationsClearedMessage
	// Discovery & project
	| DiscoveryStatusMessage
	| McpConfigReloadedMessage
	| ProjectUpdatedMessage
	// Prompt improver
	| ImprovePromptResultMessage
	| ImprovePromptErrorMessage
	| ImprovePromptCancelledMessage;
