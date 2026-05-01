/**
 * @file Protocol
 * @description Unified typed message contract for Extension ↔ Webview communication.
 *              Combines both directions:
 *              - Extension → Webview (response messages)
 *              - Webview → Extension (command messages)
 *              Single source of truth for the postMessage protocol.
 */

import type { ProxyEndpointProtocol } from './proxyEndpoints';
import type {
	Access,
	InstalledMcpServerMetadata,
	MCPServerConfig,
	MCPServersMap,
	OpenCodeProviderData,
	ParsedCommand,
	ParsedSkill,
	PlatformInfo,
	QuestionInfo,
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

export interface SessionInfoData {
	sessionId: string;
	title?: string;
	parentSessionId?: string;
	tools?: string[];
	mcpServers?: string[];
	autoAccept?: boolean;
}

export interface PermissionAutoAcceptState {
	mode: 'default' | 'on' | 'off';
	effective: boolean;
}

// =============================================================================
// Question Event Payload (OpenCode question tool)
// =============================================================================

// QuestionInfo is derived from TypeBox schema in schemas.ts.
export type { QuestionInfo } from './schemas';

export type QuestionAnswer = string[];

export interface SessionTodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
	priority: 'high' | 'medium' | 'low' | string;
}

export interface SessionPermissionRequest {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: {
		messageID: string;
		callID: string;
	};
}

export interface SessionQuestionRequest {
	id: string;
	sessionID: string;
	questions: QuestionInfo[];
	tool?: {
		messageID: string;
		callID: string;
	};
	resolved?: boolean;
	answers?: QuestionAnswer[];
	rejected?: boolean;
}

export type TabStateMessage = BaseExtensionMessage<
	'tabState',
	{
		openTabs: string[];
		activeTab?: string;
		autoAcceptBySession?: Record<string, boolean>;
	}
>;

export type AccessDataMessage = BaseExtensionMessage<'accessData', Access>;

// =============================================================================
// Rule Messages (global)
// =============================================================================

import type { Rule } from './schemas';

export type RuleListMessage = BaseExtensionMessage<
	'ruleList',
	{ rules: Rule[]; meta?: { operation?: string; message?: string } }
>;
export type RuleUpdatedMessage = BaseExtensionMessage<'ruleUpdated', { rule: Rule }>;

// =============================================================================
// Permissions Messages (global)
// =============================================================================

// Re-export from unified permissions module (single source of truth)
import type {
	PermissionCategory as _PermissionCategory,
	PermissionPolicies as _PermissionPolicies,
	PermissionPolicyValue as _PermissionPolicyValue,
} from './permissions';
export type PermissionPolicies = _PermissionPolicies;
export type PermissionPolicyValue = _PermissionPolicyValue;
export type PermissionCategory = _PermissionCategory;
export { DEFAULT_POLICIES, PERMISSION_CATEGORIES } from './permissions';

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

export interface ProxyModelData {
	id: string;
	name: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	capabilities?: ModelCapabilities;
	variants?: string[];
}

export interface ProxyModelsData {
	enabled: boolean;
	models?: ProxyModelData[];
	enabledModelIds?: string[];
	baseUrl?: string;
	error?: string;
	endpointId?: string;
}
export type ProxyModelsMessage = BaseExtensionMessage<'proxyModels', ProxyModelsData>;

// =============================================================================
// Clipboard Messages (global)
// =============================================================================

export type ClipboardTextMessage = BaseExtensionMessage<'clipboardText', string>;

// =============================================================================
// OpenCode Messages (global)
// =============================================================================

export type OpenCodeStatusMessage = BaseExtensionMessage<
	'openCodeStatus',
	{ installed: boolean; version: string | null; error?: string }
>;
export interface LspStatusData {
	id: string;
	name: string;
	root: string;
	status: 'connected' | 'error';
}
export type LspStatusMessage = BaseExtensionMessage<'lspStatus', { items: LspStatusData[] }>;
export type OpenCodeProvidersMessage = BaseExtensionMessage<
	'openCodeProviders',
	{
		providers: OpenCodeProviderData[];
		config: { isLoading?: boolean; error?: string };
	}
>;
export type OpenCodeModelSetMessage = BaseExtensionMessage<
	'openCodeModelSet',
	{ model: string | null }
>;
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
	{ providers: { id: string; name: string; env?: string[]; models?: Record<string, unknown>[] }[] }
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
// MCP Installed Metadata
// =============================================================================

export type McpInstalledMetadataMessage = BaseExtensionMessage<
	'mcpInstalledMetadata',
	{ metadata: Record<string, InstalledMcpServerMetadata> }
>;

// =============================================================================
// MCP Config Status Messages (global)
// =============================================================================

export type McpConfigStatusMessage = BaseExtensionMessage<
	'mcpConfigStatus',
	{ hasProjectConfig: boolean; projectPath: string }
>;

// =============================================================================
// Diagnostics Messages (global)
// =============================================================================

export type CliDiagnosticsMessage = BaseExtensionMessage<'cliDiagnostics', unknown>;
export type SessionAutoAcceptMessage = BaseExtensionMessage<
	'sessionAutoAccept',
	{
		sessionId?: string;
		autoAccept?: boolean;
		states?: Record<string, boolean>;
	}
>;

export type ShowNotificationMessage = BaseExtensionMessage<
	'showNotification',
	{
		notification: {
			id?: string;
			type: 'error' | 'system_notice';
			content: string;
			timestamp?: string;
			reason?: string;
		};
	}
>;

export interface QueuedMessageData {
	queueId: string;
	messageId?: string;
	sessionId: string;
	text: string;
	model?: string;
	agent?: string;
	variant?: string;
	attachments?: SendMessageAttachments;
	queuedAt: number;
}

export type QueueEventMessage = BaseExtensionMessage<
	'messageQueue',
	{
		action: 'enqueued' | 'dequeued' | 'cancelled' | 'cleared';
		sessionId: string;
		queue: QueuedMessageData[];
		cancelledText?: string;
		cancelledAttachments?: Pick<NonNullable<SendMessageAttachments>, 'images'>;
		cancelledAgent?: string;
	}
>;

export type ResourceKind = 'agent' | 'command' | 'skill' | 'plugin';
export type ResourceAction = 'setDisabled';
export type ResourceActionResult =
	| 'verified'
	| 'config-written-unverified'
	| 'shadowed'
	| 'stale'
	| 'error';

export type ResourceActionTarget =
	| { type: 'project-config'; jsonPointer: string }
	| { type: 'project-file'; path: string; frontmatterKey?: string };

export type AgentResource = {
	id: string;
	kind: 'agent';
	name: string;
	description?: string;
	source: 'project' | 'global' | 'builtin' | 'runtime';
	sourceKind: 'builtin' | 'custom';
	hasProjectOverride: boolean;
	sourcePath?: string;
	disabled: boolean;
	hidden?: boolean;
	mode?: 'primary' | 'subagent' | 'all';
	model?: string;
	variant?: string;
	action?: {
		type: 'setDisabled';
		target: ResourceActionTarget;
	};
};

export type CommandResource = CommandListItem & { kind: 'command'; id: string };
export type SkillResource = SkillListItem & { kind: 'skill'; id: string };
export type PluginResource = PluginListItem & { kind: 'plugin' };
export type ManagedResource = AgentResource | CommandResource | SkillResource | PluginResource;

export type ResourcesListMessage = BaseExtensionMessage<
	'resourcesList',
	{
		kind: ResourceKind;
		resources: ManagedResource[];
		revision: number;
		requestId?: string;
		operationId?: string;
		error?: string;
	}
>;

export type ResourceOperationMessage = BaseExtensionMessage<
	'resourceOperation',
	{
		operationId: string;
		resourceId?: string;
		action?: ResourceAction;
		status: 'started' | 'completed';
		result?: ResourceActionResult;
		message?: string;
		revision?: number;
	}
>;

export type CommandListItem = ParsedCommand & {
	source: 'project' | 'global';
	locationScope: 'project' | 'global';
};

export type SkillListItem = ParsedSkill & {
	source: 'project' | 'global' | 'external';
	locationScope: 'project' | 'global';
	format: 'opencode' | 'agent-compatible' | 'claude-compatible';
};

export type PluginListItem = {
	id: string;
	name: string;
	path?: string;
	source: 'project' | 'global' | 'config';
	locationScope: 'project' | 'global';
	origin: 'file' | 'config';
};

// =============================================================================
// Discovery, Project, Editor, SSE Messages (global)
// =============================================================================

export type DiscoveryStatusMessage = BaseExtensionMessage<
	'discoveryStatus',
	import('./schemas').DiscoveryStatus
>;
export type ProjectUpdatedMessage = BaseExtensionMessage<
	'projectUpdated',
	import('./schemas').ProjectUpdated
>;
export type EditorSelectionMessage = BaseExtensionMessage<
	'editorSelection',
	{ text: string; fileName?: string }
>;
export type ServerInfoMessage = BaseExtensionMessage<
	'serverInfo',
	{ url: string; revision: number; workspaceRoot: string }
>;

// =============================================================================
// Extension Version Check
// =============================================================================

export type ExtensionVersionMessage = BaseExtensionMessage<
	'extensionVersion',
	{
		current: string;
		latest: string | null;
		updateAvailable: boolean;
		releaseUrl: string | null;
		isChecking: boolean;
		error?: string;
	}
>;

// =============================================================================
// Connection Details
// =============================================================================

export interface ConnectionDetailsData {
	serverUrl: string | null;
	isServerOwner: boolean;
	uptime: number | null;
	port: number | null;
}

export type ConnectionDetailsMessage = BaseExtensionMessage<
	'connectionDetails',
	ConnectionDetailsData
>;

export type OpenHistoryMessage = BaseExtensionMessage<'openHistory'>;

export type RequestNewSessionMessage = BaseExtensionMessage<'requestNewSession'>;

export type OpenSettingsMessage = BaseExtensionMessage<'openSettings'>;

// =============================================================================
// Extension → Webview Union
// =============================================================================

export type ExtensionMessage =
	| TabStateMessage
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
	| OpenCodeStatusMessage
	| LspStatusMessage
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
	| McpInstalledMetadataMessage
	| McpServersMessage
	| McpServerSavedMessage
	| McpServerDeletedMessage
	| McpServerErrorMessage
	| McpStatusMessage
	| McpConfigStatusMessage
	| ResourcesListMessage
	| ResourceOperationMessage
	| CliDiagnosticsMessage
	| SessionAutoAcceptMessage
	| DiscoveryStatusMessage
	| ProjectUpdatedMessage
	| EditorSelectionMessage
	| ServerInfoMessage
	| ExtensionVersionMessage
	| ConnectionDetailsMessage
	| OpenHistoryMessage
	| RequestNewSessionMessage
	| OpenSettingsMessage
	| ShowNotificationMessage
	| QueueEventMessage;

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

export interface SendMessageAttachments {
	files?: string[];
	codeSnippets?: Array<{
		filePath: string;
		content: string;
		startLine?: number;
		endLine?: number;
	}>;
	images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
}

export interface SendMessageCommand {
	type: 'sendMessage';
	sessionId: string;
	text: string;
	messageID?: string;
	model?: string;
	agent?: string;
	variant?: string;
	attachments?: SendMessageAttachments;
}

export interface StopRequestCommand {
	type: 'stopRequest';
	sessionId: string;
}

export interface CancelQueuedMessageCommand {
	type: 'cancelQueuedMessage';
	sessionId: string;
	queueId: string;
}

export interface ForceQueuedMessageCommand {
	type: 'forceQueuedMessage';
	sessionId: string;
	queueId: string;
}

export interface ReorderQueueCommand {
	type: 'reorderQueue';
	sessionId: string;
	queueIds: string[];
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
export interface GetRulesCommand {
	type: 'getRules';
}

export interface GetResourcesCommand {
	type: 'getResources';
	kind?: ResourceKind;
	requestId?: string;
}

export interface MutateResourceCommand {
	type: 'mutateResource';
	kind: ResourceKind;
	action: 'create' | 'delete' | 'update';
	name: string;
	payload?: Record<string, unknown>;
}

export interface ApplyResourceActionCommand {
	type: 'applyResourceAction';
	operationId: string;
	resourceId?: string;
	action: ResourceAction;
	value?: boolean | string;
	scope: 'project';
}

// =============================================================================
// MCP Commands
// =============================================================================

export interface LoadMCPServersCommand {
	type: 'loadMCPServers';
}
export interface SaveMCPServerCommand {
	type: 'saveMCPServer';
	name: string;
	config: MCPServerConfig;
}
export interface SetMCPServerEnabledCommand {
	type: 'setMCPServerEnabled';
	name: string;
	enabled: boolean;
}
export interface DeleteMCPServerCommand {
	type: 'deleteMCPServer';
	name: string;
}
export interface OpenMcpConfigCommand {
	type: 'openMcpConfig';
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
	endpointId?: string;
	headers?: Record<string, string>;
	protocol?: ProxyEndpointProtocol;
}
export interface SyncProxyModelsCommand {
	type: 'syncProxyModels';
	baseUrl: string;
	apiKey: string;
	enabledModelIds: string[];
	endpointId?: string;
	providerId?: string;
	providerName?: string;
	headers?: Record<string, string>;
	protocol?: ProxyEndpointProtocol;
}
export interface RemoveProxyEndpointCommand {
	type: 'removeProxyEndpoint';
	providerId: string;
	baseUrl?: string;
}

// =============================================================================
// Tool / Access Commands
// =============================================================================

export interface GetPermissionsCommand {
	type: 'getPermissions';
}
export interface SetPermissionPolicyCommand {
	type: 'setPermissionPolicy';
	category: PermissionCategory;
	policy: PermissionPolicyValue;
}
export interface SetAutoAcceptCommand {
	type: 'setAutoAccept';
	mode: 'default' | 'on' | 'off';
	sessionId: string;
}
export interface SetAlwaysAllowToolCommand {
	type: 'setAlwaysAllowTool';
	toolName: string;
	allow: boolean;
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
export interface CheckExtensionVersionCommand {
	type: 'checkExtensionVersion';
}

// =============================================================================
// Connection Status Commands
// =============================================================================

export interface RestartOpenCodeCommand {
	type: 'restartOpenCode';
}

export interface ReloadExtensionCommand {
	type: 'reloadExtension';
}

export interface GetConnectionDetailsCommand {
	type: 'getConnectionDetails';
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
	line?: number;
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
export interface BrowseFilesCommand {
	type: 'browseFiles';
}
export interface BrowseFoldersCommand {
	type: 'browseFolders';
}
export interface GetWorkspaceFilesCommand {
	type: 'getWorkspaceFiles';
	searchTerm: string;
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
// Resource file open commands
// =============================================================================
export interface OpenSkillFileCommand {
	type: 'openSkillFile';
	filePath: string;
}

export interface OpenCommandFileCommand {
	type: 'openCommandFile';
	filePath: string;
}

export interface OpenPluginFileCommand {
	type: 'openPluginFile';
	filePath: string;
}

export interface DeleteSubagentCommand {
	type: 'deleteSubagent';
	name: string;
}
export interface OpenSubagentFileCommand {
	type: 'openSubagentFile';
	filePath: string;
}

export interface CreateRuleCommand {
	type: 'createRule';
	name: string;
	content: string;
}

export interface DeleteRuleCommand {
	type: 'deleteRule';
	path: string;
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
// =============================================================================
// Conversation & Orchestration Commands
// =============================================================================

export interface SyncAllCommand {
	type: 'syncAll';
}

// =============================================================================
// Webview → Extension Union
// =============================================================================

export type WebviewCommand =
	| WebviewDidLaunchCommand
	| SendMessageCommand
	| StopRequestCommand
	| CancelQueuedMessageCommand
	| ForceQueuedMessageCommand
	| ReorderQueueCommand
	| GetSettingsCommand
	| UpdateSettingsCommand
	| GetRulesCommand
	| GetResourcesCommand
	| MutateResourceCommand
	| ApplyResourceActionCommand
	| LoadMCPServersCommand
	| SaveMCPServerCommand
	| SetMCPServerEnabledCommand
	| DeleteMCPServerCommand
	| OpenMcpConfigCommand
	| ReloadAllProvidersCommand
	| CheckOpenCodeStatusCommand
	| LoadOpenCodeProvidersCommand
	| LoadAvailableProvidersCommand
	| SetOpenCodeProviderAuthCommand
	| DisconnectOpenCodeProviderCommand
	| SetOpenCodeModelCommand
	| SelectModelCommand
	| LoadProxyModelsCommand
	| SyncProxyModelsCommand
	| RemoveProxyEndpointCommand
	| GetPermissionsCommand
	| SetPermissionPolicyCommand
	| SetAutoAcceptCommand
	| SetAlwaysAllowToolCommand
	| CheckDiscoveryStatusCommand
	| GetAccessCommand
	| CheckCLIDiagnosticsCommand
	| OpenFileCommand
	| OpenFileDiffCommand
	| OpenExternalCommand
	| GetImageDataCommand
	| BrowseFilesCommand
	| BrowseFoldersCommand
	| GetWorkspaceFilesCommand
	| ProxyFetchCommand
	| ProxyFetchAbortCommand
	| OpenSkillFileCommand
	| OpenCommandFileCommand
	| OpenPluginFileCommand
	| DeleteSubagentCommand
	| OpenSubagentFileCommand
	| CreateRuleCommand
	| DeleteRuleCommand
	| AcceptFileCommand
	| AcceptAllFilesCommand
	| UndoFileChangesCommand
	| UndoAllChangesCommand
	| SyncAllCommand
	| CheckExtensionVersionCommand
	| RestartOpenCodeCommand
	| ReloadExtensionCommand
	| GetConnectionDetailsCommand;

// =============================================================================
// Utility
// =============================================================================

/** Extract a single command variant from the union by its `type` literal. */
export type CommandOf<T extends WebviewCommand['type']> = Extract<WebviewCommand, { type: T }>;
