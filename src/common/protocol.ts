/**
 * @file Protocol
 * @description Unified typed message contract for Extension ↔ Webview communication.
 *              Combines both directions:
 *              - Extension → Webview (response messages)
 *              - Webview → Extension (command messages)
 *              Single source of truth for the postMessage protocol.
 */

import type {
	Access,
	CommitInfo,
	InstalledMcpServerMetadata,
	MCPServerConfig,
	MCPServersMap,
	McpMarketplaceCatalog,
	OpenCodeProviderData,
	ParsedSubagent,
	PlatformInfo,
	TotalStats,
	WorkspaceFile,
} from './schemas';

// #############################################################################
//
//  PART 1 — Extension → Webview Messages
//
// #############################################################################

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
	| 'terminal'
	| 'turn_tokens';

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
	attachments?: {
		files?: string[];
		codeSnippets?: Array<{
			filePath: string;
			content: string;
			startLine?: number;
			endLine?: number;
		}>;
		images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
	};
	metadata?: Record<string, unknown>;
	agent?: string;
	prompt?: string;
	description?: string;
	command?: string;
	status?: 'running' | 'completed' | 'error' | 'cancelled';
	result?: string;
	messageID?: string;
	contextId?: string;
	startTime?: string | number;
	reasoningTokens?: number;
	requestId?: string;
	tool?: string;
	input?: Record<string, unknown>;
	pattern?: string;
	resolved?: boolean;
	approved?: boolean;
	reason?: string;
	model?: string;
	normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
}

// =============================================================================
// Session Event Payloads
// =============================================================================

export interface SessionMessagePayload {
	eventType: 'message';
	message: SessionMessageData;
}

export interface SessionStatusPayload {
	eventType: 'status';
	status: SessionStatus;
	statusText?: string;
	loadingMessage?: string;
	retryInfo?: {
		attempt: number;
		message: string;
		nextRetryAt?: string;
	};
}

export interface SessionStatsPayload {
	eventType: 'stats';
	totalStats?: Partial<TotalStats>;
	modelID?: string;
	providerID?: string;
}

export interface SessionCompletePayload {
	eventType: 'complete';
	partId: string;
	toolUseId?: string;
	removed?: boolean;
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
	revertedFromMessageId?: string;
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

export interface SessionTurnTokensPayload {
	eventType: 'turn_tokens';
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	durationMs?: number;
	userMessageId?: string;
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
	| SessionTerminalPayload
	| SessionTurnTokensPayload;

export interface SessionEventMessage {
	type: 'session_event';
	targetId: string;
	eventType: SessionEventType;
	payload: SessionEventPayload;
	timestamp: number;
	sessionId?: string;
	normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
}

export type SessionLifecycleAction = 'created' | 'closed' | 'switched' | 'cleared';

export interface SessionLifecycleMessage {
	type: 'session_lifecycle';
	action: SessionLifecycleAction;
	sessionId?: string;
	data?: {
		isProcessing?: boolean;
		totalStats?: TotalStats;
		messages?: unknown[];
	};
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

import type { ParsedCommand as _ParsedCommand, Rule } from './schemas';

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
// File / Image / Workspace Messages (global)
// =============================================================================

export type WorkspaceFilesMessage = BaseExtensionMessage<'workspaceFiles', WorkspaceFile[]>;
export type ImagePathMessage = BaseExtensionMessage<'imagePath', { filePath: string }>;
export type ImageDataMessage = BaseExtensionMessage<'imageData', unknown>;

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
	text?: string;
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

export type AgentsSyncTarget = 'opencode' | 'cursor';

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

export type CommandsListMessage = BaseExtensionMessage<
	'commandsList',
	{
		custom: _ParsedCommand[];
		cli?: Array<{ name: string; description?: string }>;
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
// Discovery, Project, Editor, SSE Messages (global)
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
export type EditorSelectionMessage = BaseExtensionMessage<
	'editorSelection',
	{ text: string; fileName?: string }
>;
export type ServerInfoMessage = BaseExtensionMessage<'serverInfo', { url: string }>;

export type SseEventMessage = BaseExtensionMessage<'sseEvent', { id: string; data: string }>;
export type SseErrorMessage = BaseExtensionMessage<'sseError', { id: string; error: string }>;
export type SseClosedMessage = BaseExtensionMessage<'sseClosed', { id: string }>;

// =============================================================================
// Extension → Webview Union
// =============================================================================

export type ExtensionMessage =
	| SessionEventMessage
	| SessionLifecycleMessage
	| AccessDataMessage
	| RuleListMessage
	| RuleUpdatedMessage
	| PermissionsUpdatedMessage
	| WorkspaceFilesMessage
	| ImagePathMessage
	| ImageDataMessage
	| WorkspaceInfoMessage
	| ModelSelectedMessage
	| SettingsDataMessage
	| PlatformInfoMessage
	| ProxyModelsMessage
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
	| ImprovePromptResultMessage
	| ImprovePromptErrorMessage
	| ImprovePromptCancelledMessage
	| EditorSelectionMessage
	| ServerInfoMessage
	| SseEventMessage
	| SseErrorMessage
	| SseClosedMessage;

// #############################################################################
//
//  PART 2 — Webview → Extension Commands
//
// #############################################################################

// =============================================================================
// Session Commands
// =============================================================================

export interface WebviewDidLaunchCommand {
	type: 'webviewDidLaunch';
}
export interface CreateSessionCommand {
	type: 'createSession';
}

export interface SwitchSessionCommand {
	type: 'switchSession';
	sessionId: string;
}

export interface CloseSessionCommand {
	type: 'closeSession';
	sessionId: string;
}

export interface SendMessageCommand {
	type: 'sendMessage';
	text: string;
	model?: string;
	sessionId?: string;
	messageID?: string;
	planMode?: boolean;
	attachments?: {
		files?: string[];
		codeSnippets?: Array<{
			filePath: string;
			content: string;
			startLine?: number;
			endLine?: number;
		}>;
		images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
	};
}

export interface StopRequestCommand {
	type: 'stopRequest';
	sessionId?: string;
}

export interface ImprovePromptRequestCommand {
	type: 'improvePromptRequest';
	text: string;
	requestId: string;
	model?: string;
	timeoutMs?: number;
}

export interface CancelImprovePromptCommand {
	type: 'cancelImprovePrompt';
	requestId: string;
}

export interface GetConversationListCommand {
	type: 'getConversationList';
}

export interface LoadConversationCommand {
	type: 'loadConversation';
	filename: string;
}

export interface DeleteConversationCommand {
	type: 'deleteConversation';
	filename: string;
}

export interface RenameConversationCommand {
	type: 'renameConversation';
	filename: string;
	newTitle: string;
}

// =============================================================================
// Settings Commands
// =============================================================================

export interface GetSettingsCommand {
	type: 'getSettings';
}
export interface UpdateSettingsCommand {
	type: 'updateSettings';
	settings: Record<string, unknown>;
}
export interface GetCommandsCommand {
	type: 'getCommands';
}
export interface GetSkillsCommand {
	type: 'getSkills';
}
export interface GetHooksCommand {
	type: 'getHooks';
}
export interface GetSubagentsCommand {
	type: 'getSubagents';
}
export interface GetRulesCommand {
	type: 'getRules';
}

// =============================================================================
// MCP Commands
// =============================================================================

export interface LoadMCPServersCommand {
	type: 'loadMCPServers';
}
export interface FetchMcpMarketplaceCatalogCommand {
	type: 'fetchMcpMarketplaceCatalog';
	forceRefresh: boolean;
}
export interface InstallMcpFromMarketplaceCommand {
	type: 'installMcpFromMarketplace';
	mcpId: string;
}
export interface SaveMCPServerCommand {
	type: 'saveMCPServer';
	name: string;
	config: MCPServerConfig;
}
export interface DeleteMCPServerCommand {
	type: 'deleteMCPServer';
	name: string;
}
export interface OpenAgentsMcpConfigCommand {
	type: 'openAgentsMcpConfig';
}
export interface ImportMcpFromCLICommand {
	type: 'importMcpFromCLI';
}
export interface SyncAgentsToOpenCodeProjectCommand {
	type: 'syncAgentsToOpenCodeProject';
}

// =============================================================================
// Provider Commands
// =============================================================================

export interface ReloadAllProvidersCommand {
	type: 'reloadAllProviders';
}
export interface CheckOpenCodeStatusCommand {
	type: 'checkOpenCodeStatus';
}
export interface LoadOpenCodeProvidersCommand {
	type: 'loadOpenCodeProviders';
}
export interface LoadAvailableProvidersCommand {
	type: 'loadAvailableProviders';
}
export interface SetOpenCodeProviderAuthCommand {
	type: 'setOpenCodeProviderAuth';
	providerId: string;
	apiKey: string;
}
export interface DisconnectOpenCodeProviderCommand {
	type: 'disconnectOpenCodeProvider';
	providerId: string;
}
export interface SetOpenCodeModelCommand {
	type: 'setOpenCodeModel';
	model: string;
}
export interface SelectModelCommand {
	type: 'selectModel';
	model: string;
}
export interface LoadProxyModelsCommand {
	type: 'loadProxyModels';
	baseUrl: string;
	apiKey: string;
}

// =============================================================================
// Tool / Access Commands
// =============================================================================

export interface AccessResponseCommand {
	type: 'accessResponse';
	id: string;
	approved: boolean;
	alwaysAllow?: boolean;
	response?: 'once' | 'always' | 'reject';
	sessionId?: string;
	toolName?: string;
}

export interface GetPermissionsCommand {
	type: 'getPermissions';
}
export interface SetPermissionsCommand {
	type: 'setPermissions';
	policies: Partial<PermissionPolicies>;
	provider?: string;
}
export interface CheckDiscoveryStatusCommand {
	type: 'checkDiscoveryStatus';
}
export interface GetAccessCommand {
	type: 'getAccess';
}
export interface CheckCLIDiagnosticsCommand {
	type: 'checkCLIDiagnostics';
}

// =============================================================================
// File Commands
// =============================================================================

export interface OpenFileCommand {
	type: 'openFile';
	filePath: string;
	line?: number;
	startLine?: number;
	endLine?: number;
}
export interface OpenFileDiffCommand {
	type: 'openFileDiff';
	filePath: string;
	oldContent?: string;
	newContent?: string;
}
export interface OpenExternalCommand {
	type: 'openExternal';
	url: string;
}
export interface GetImageDataCommand {
	type: 'getImageData';
	id?: string;
	name?: string;
	path?: string;
}
export interface GetClipboardContextCommand {
	type: 'getClipboardContext';
	text: string;
}
export interface GetWorkspaceFilesCommand {
	type: 'getWorkspaceFiles';
	searchTerm: string;
}

// =============================================================================
// SSE Commands
// =============================================================================

export interface SseSubscribeCommand {
	type: 'sseSubscribe';
	id: string;
	url: string;
}
export interface SseCloseCommand {
	type: 'sseClose';
	id: string;
}

// =============================================================================
// Restore Commands
// =============================================================================

export interface RestoreCommitCommand {
	type: 'restoreCommit';
	commitId?: string;
	data?: { commitId: string };
}
export interface UnrevertCommand {
	type: 'unrevert';
}

// =============================================================================
// Proxy Fetch Commands
// =============================================================================

export interface ProxyFetchCommand {
	type: 'proxyFetch';
	id: string;
	url: string;
	options?: { method?: string; headers?: Record<string, string>; body?: string };
}
export interface ProxyFetchAbortCommand {
	type: 'proxyFetchAbort';
	id: string;
}

// =============================================================================
// Agents CRUD Commands (Skills / Hooks / Commands / Subagents)
// =============================================================================

export interface CreateSkillCommand {
	type: 'createSkill';
	name: string;
	description: string;
	content: string;
	version?: string;
}
export interface DeleteSkillCommand {
	type: 'deleteSkill';
	name: string;
}
export interface OpenSkillFileCommand {
	type: 'openSkillFile';
	name: string;
}
export interface ImportSkillsFromCLICommand {
	type: 'importSkillsFromCLI';
}
export interface SyncSkillsToCLICommand {
	type: 'syncSkillsToCLI';
}

export interface CreateHookCommand {
	type: 'createHook';
	name: string;
	enabled: boolean;
	event: string;
	pattern?: string;
	action?: string;
	content?: string;
}
export interface DeleteHookCommand {
	type: 'deleteHook';
	name: string;
}
export interface OpenHookFileCommand {
	type: 'openHookFile';
	name: string;
}
export interface ImportHooksFromCLICommand {
	type: 'importHooksFromCLI';
}
export interface SyncHooksToCLICommand {
	type: 'syncHooksToCLI';
}

export interface CreateCommandCommand {
	type: 'createCommand';
	name: string;
	description: string;
	content: string;
}
export interface DeleteCommandCommand {
	type: 'deleteCommand';
	name: string;
}
export interface OpenCommandFileCommand {
	type: 'openCommandFile';
	name: string;
}
export interface ImportCommandsFromCLICommand {
	type: 'importCommandsFromCLI';
}
export interface SyncCommandsToCLICommand {
	type: 'syncCommandsToCLI';
}

export interface CreateSubagentCommand {
	type: 'createSubagent';
	name: string;
	description: string;
	content: string;
}
export interface DeleteSubagentCommand {
	type: 'deleteSubagent';
	name: string;
}
export interface OpenSubagentFileCommand {
	type: 'openSubagentFile';
	name: string;
}
export interface ImportSubagentsFromCLICommand {
	type: 'importSubagentsFromCLI';
}
export interface SyncSubagentsToCLICommand {
	type: 'syncSubagentsToCLI';
}

export interface ToggleRuleCommand {
	type: 'toggleRule';
	path: string;
	enabled: boolean;
	source: 'opencode';
}

// =============================================================================
// File Action Commands
// =============================================================================

export interface AcceptFileCommand {
	type: 'acceptFile';
	filePath: string;
}
export interface AcceptAllFilesCommand {
	type: 'acceptAllFiles';
	filePaths: string[];
}
export interface UndoFileChangesCommand {
	type: 'undoFileChanges';
	filePath: string;
}
export interface UndoAllChangesCommand {
	type: 'undoAllChanges';
}
export interface CopyLastResponseCommand {
	type: 'copyLastResponse';
}
export interface CopyAllMessagesCommand {
	type: 'copyAllMessages';
}
export interface CopyLastDiffsCommand {
	type: 'copyLastDiffs';
}
export interface CopyAllDiffsCommand {
	type: 'copyAllDiffs';
}

// =============================================================================
// Conversation & Orchestration Commands
// =============================================================================

export interface ClearAllConversationsCommand {
	type: 'clearAllConversations';
}
export interface SyncAllCommand {
	type: 'syncAll';
}

// =============================================================================
// Webview → Extension Union
// =============================================================================

export type WebviewCommand =
	| WebviewDidLaunchCommand
	| CreateSessionCommand
	| SwitchSessionCommand
	| CloseSessionCommand
	| SendMessageCommand
	| StopRequestCommand
	| ImprovePromptRequestCommand
	| CancelImprovePromptCommand
	| GetConversationListCommand
	| LoadConversationCommand
	| DeleteConversationCommand
	| RenameConversationCommand
	| GetSettingsCommand
	| UpdateSettingsCommand
	| GetCommandsCommand
	| GetSkillsCommand
	| GetHooksCommand
	| GetSubagentsCommand
	| GetRulesCommand
	| LoadMCPServersCommand
	| FetchMcpMarketplaceCatalogCommand
	| InstallMcpFromMarketplaceCommand
	| SaveMCPServerCommand
	| DeleteMCPServerCommand
	| OpenAgentsMcpConfigCommand
	| ImportMcpFromCLICommand
	| SyncAgentsToOpenCodeProjectCommand
	| ReloadAllProvidersCommand
	| CheckOpenCodeStatusCommand
	| LoadOpenCodeProvidersCommand
	| LoadAvailableProvidersCommand
	| SetOpenCodeProviderAuthCommand
	| DisconnectOpenCodeProviderCommand
	| SetOpenCodeModelCommand
	| SelectModelCommand
	| LoadProxyModelsCommand
	| AccessResponseCommand
	| GetPermissionsCommand
	| SetPermissionsCommand
	| CheckDiscoveryStatusCommand
	| GetAccessCommand
	| CheckCLIDiagnosticsCommand
	| OpenFileCommand
	| OpenFileDiffCommand
	| OpenExternalCommand
	| GetImageDataCommand
	| GetClipboardContextCommand
	| GetWorkspaceFilesCommand
	| SseSubscribeCommand
	| SseCloseCommand
	| RestoreCommitCommand
	| UnrevertCommand
	| ProxyFetchCommand
	| ProxyFetchAbortCommand
	| CreateSkillCommand
	| DeleteSkillCommand
	| OpenSkillFileCommand
	| ImportSkillsFromCLICommand
	| SyncSkillsToCLICommand
	| CreateHookCommand
	| DeleteHookCommand
	| OpenHookFileCommand
	| ImportHooksFromCLICommand
	| SyncHooksToCLICommand
	| CreateCommandCommand
	| DeleteCommandCommand
	| OpenCommandFileCommand
	| ImportCommandsFromCLICommand
	| SyncCommandsToCLICommand
	| CreateSubagentCommand
	| DeleteSubagentCommand
	| OpenSubagentFileCommand
	| ImportSubagentsFromCLICommand
	| SyncSubagentsToCLICommand
	| ToggleRuleCommand
	| AcceptFileCommand
	| AcceptAllFilesCommand
	| UndoFileChangesCommand
	| UndoAllChangesCommand
	| CopyLastResponseCommand
	| CopyAllMessagesCommand
	| CopyLastDiffsCommand
	| CopyAllDiffsCommand
	| ClearAllConversationsCommand
	| SyncAllCommand;

// =============================================================================
// Utility
// =============================================================================

/** Extract a single command variant from the union by its `type` literal. */
export type CommandOf<T extends WebviewCommand['type']> = Extract<WebviewCommand, { type: T }>;
