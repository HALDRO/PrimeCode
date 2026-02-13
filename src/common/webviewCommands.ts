/**
 * @file Webview → Extension typed message contract (discriminated union)
 * @description Single source of truth for ALL messages the webview can send to the extension.
 * Every handler reads fields from the top-level message object (webview spreads data via
 * postMessageToVSCode). No more `msg.data` nesting — everything is flat.
 */

import type { PermissionPolicies } from './extensionMessages';
import type { MCPServerConfig } from './schemas';

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
	options?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	};
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
// Conversation Commands (additional)
// =============================================================================

export interface ClearAllConversationsCommand {
	type: 'clearAllConversations';
}

// =============================================================================
// Orchestration Commands
// =============================================================================

export interface SyncAllCommand {
	type: 'syncAll';
}

// =============================================================================
// Discriminated Union
// =============================================================================

export type WebviewCommand =
	// Session
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
	// Settings
	| GetSettingsCommand
	| UpdateSettingsCommand
	| GetCommandsCommand
	| GetSkillsCommand
	| GetHooksCommand
	| GetSubagentsCommand
	| GetRulesCommand
	// MCP
	| LoadMCPServersCommand
	| FetchMcpMarketplaceCatalogCommand
	| InstallMcpFromMarketplaceCommand
	| SaveMCPServerCommand
	| DeleteMCPServerCommand
	| OpenAgentsMcpConfigCommand
	| ImportMcpFromCLICommand
	| SyncAgentsToOpenCodeProjectCommand
	// Provider
	| ReloadAllProvidersCommand
	| CheckOpenCodeStatusCommand
	| LoadOpenCodeProvidersCommand
	| LoadAvailableProvidersCommand
	| SetOpenCodeProviderAuthCommand
	| DisconnectOpenCodeProviderCommand
	| SetOpenCodeModelCommand
	| SelectModelCommand
	| LoadProxyModelsCommand
	// Tool / Access
	| AccessResponseCommand
	| GetPermissionsCommand
	| SetPermissionsCommand
	| CheckDiscoveryStatusCommand
	| GetAccessCommand
	| CheckCLIDiagnosticsCommand
	// File
	| OpenFileCommand
	| OpenFileDiffCommand
	| OpenExternalCommand
	| GetImageDataCommand
	| GetClipboardContextCommand
	| GetWorkspaceFilesCommand
	// SSE
	| SseSubscribeCommand
	| SseCloseCommand
	// Restore
	| RestoreCommitCommand
	| UnrevertCommand
	// Proxy
	| ProxyFetchCommand
	| ProxyFetchAbortCommand
	// Agents CRUD
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
	// File Actions
	| AcceptFileCommand
	| AcceptAllFilesCommand
	| UndoFileChangesCommand
	| UndoAllChangesCommand
	| CopyLastResponseCommand
	| CopyAllMessagesCommand
	| CopyLastDiffsCommand
	| CopyAllDiffsCommand
	// Conversation (additional)
	| ClearAllConversationsCommand
	// Orchestration
	| SyncAllCommand;

// =============================================================================
// Utility: Extract a specific command by type
// =============================================================================

/** Extract a single command variant from the union by its `type` literal. */
export type CommandOf<T extends WebviewCommand['type']> = Extract<WebviewCommand, { type: T }>;
