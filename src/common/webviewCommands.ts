/**
 * @file Webview → Extension typed message contract (discriminated union)
 * @description Single source of truth for ALL messages the webview can send to the extension.
 * Every handler reads fields from the top-level message object (webview spreads data via
 * postMessageToVSCode). No more `msg.data` nesting — everything is flat.
 */

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
	/** Agent override for this message (e.g. 'plan', 'build'). */
	agent?: string;
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

export interface GetSubagentsCommand {
	type: 'getSubagents';
}

export interface GetAgentsCommand {
	type: 'getAgents';
}

export interface GetPluginsCommand {
	type: 'getPlugins';
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

export interface SaveMCPServerCommand {
	type: 'saveMCPServer';
	name: string;
	config: MCPServerConfig;
}

export interface DeleteMCPServerCommand {
	type: 'deleteMCPServer';
	name: string;
}

export interface OpenMcpConfigCommand {
	type: 'openMcpConfig';
}

// =============================================================================
// Agents CRUD Commands (Skills / Commands / Subagents)
// =============================================================================

export interface CreateSkillCommand {
	type: 'createSkill';
	name: string;
	description: string;
	content: string;
}

export interface DeleteSkillCommand {
	type: 'deleteSkill';
	name: string;
}

export interface OpenSkillFileCommand {
	type: 'openSkillFile';
	name: string;
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

export interface AddPluginCommand {
	type: 'addPlugin';
	plugin: string;
}

export interface RemovePluginCommand {
	type: 'removePlugin';
	plugin: string;
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
	| GetSubagentsCommand
	| GetAgentsCommand
	| GetPluginsCommand
	| GetRulesCommand
	// MCP
	| LoadMCPServersCommand
	| SaveMCPServerCommand
	| DeleteMCPServerCommand
	| OpenMcpConfigCommand
	// Agents CRUD
	| CreateSkillCommand
	| DeleteSkillCommand
	| OpenSkillFileCommand
	| CreateCommandCommand
	| DeleteCommandCommand
	| OpenCommandFileCommand
	| CreateSubagentCommand
	| DeleteSubagentCommand
	| OpenSubagentFileCommand
	| AddPluginCommand
	| RemovePluginCommand
	| ToggleRuleCommand
	// File Actions
	| AcceptFileCommand
	| AcceptAllFilesCommand
	| UndoFileChangesCommand
	| UndoAllChangesCommand
	// Conversation (additional)
	| ClearAllConversationsCommand
	// Orchestration
	| SyncAllCommand;

// =============================================================================
// Utility: Extract a specific command by type
// =============================================================================

/** Extract a single command variant from the union by its `type` literal. */
export type CommandOf<T extends WebviewCommand['type']> = Extract<WebviewCommand, { type: T }>;
