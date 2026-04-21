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
	OpenCodeProviderData,
	ParsedSubagent,
	PlatformInfo,
	QuestionInfo,
	SubagentCommandFields,
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
	| 'message_record'
	| 'message_record_removed'
	| 'message_part'
	| 'message_part_delta'
	| 'message_part_removed'
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
	| 'turn_tokens'
	| 'file_diff'
	| 'todo'
	| 'permission'
	| 'user_message'
	| 'notification'
	| 'question';

export type SessionStatus = 'idle' | 'busy' | 'error' | 'retrying';

export interface SubtaskRetryInfo {
	attempt: number;
	message: string;
	nextRetryAt?: string;
}

export interface SessionUserMessagePayload {
	eventType: 'user_message';
	message: {
		id: string;
		timestamp?: string;
		content: string;
		model?: string;
		agent?: string;
		summary?: {
			title?: string;
			diffs?: Array<{
				file: string;
				additions: number;
				deletions: number;
				status?: 'added' | 'deleted' | 'modified';
			}>;
		};
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
		normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
	};
}

export type SessionLinkSource = 'metadata' | 'session_parentID' | 'deferred' | 'restored';

export interface SessionNotificationPayload {
	eventType: 'notification';
	notification: {
		id: string;
		type: 'error' | 'interrupted' | 'system_notice';
		content: string;
		timestamp?: string;
		reason?: string;
		normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
	};
}

export interface SessionMessageRecordPayload {
	eventType: 'message_record';
	message: {
		id: string;
		sessionId: string;
		role: 'user' | 'assistant';
		parentId?: string;
		createdAt?: number;
		completedAt?: number;
		modelId?: string;
		providerId?: string;
		agent?: string;
		tokens?: {
			input: number;
			output: number;
			reasoning?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
		cost?: number;
	};
}

export interface SessionMessageRecordRemovedPayload {
	eventType: 'message_record_removed';
	messageId: string;
}

export interface SessionMessagePartPayload {
	eventType: 'message_part';
	part: {
		id: string;
		messageId: string;
		sessionId: string;
		type: 'text' | 'reasoning' | 'tool' | 'file' | 'compaction' | 'other';
		text?: string;
		callId?: string;
		toolName?: string;
		state?: {
			status?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
			input?: unknown;
			output?: string;
			title?: string;
			metadata?: unknown;
		};
		createdAt?: number;
		completedAt?: number;
		mime?: string;
		url?: string;
		filename?: string;
		synthetic?: boolean;
		auto?: boolean;
		normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
	};
}

export interface SessionMessagePartDeltaPayload {
	eventType: 'message_part_delta';
	messageId: string;
	partId: string;
	field: string;
	delta: string;
}

export interface SessionMessagePartRemovedPayload {
	eventType: 'message_part_removed';
	messageId: string;
	partId: string;
}

export interface ToolActivityInfo {
	/** Canonical lowercase tool name (e.g. 'write', 'edit', 'bash'). */
	toolName: string;
	/** Human-readable label (e.g. 'Writing file...', 'Running command...'). */
	label: string;
	/** Optional file path associated with the tool call. */
	filePath?: string;
	/** Tool use ID for correlation with tool_use messages. */
	toolUseId?: string;
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
	/** Current tool activity — set when a tool starts, cleared on idle/tool_result. */
	toolActivity?: ToolActivityInfo | null;
}

export interface SessionCompletePayload {
	eventType: 'complete';
	partId: string;
	toolUseId?: string;
	removed?: boolean;
	messageId?: string;
	completedAt?: number;
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

export interface SessionFileDiffPayload {
	eventType: 'file_diff';
	diffs: Array<{
		file: string;
		additions: number;
		deletions: number;
		status?: 'added' | 'deleted' | 'modified';
	}>;
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
	messages: SessionUserMessagePayload['message'][];
	runtimeMessageRecords?: SessionMessageRecordPayload['message'][];
	runtimeMessageParts?: SessionMessagePartPayload['part'][];
	changedFiles?: Array<{
		filePath: string;
		fileName: string;
		linesAdded: number;
		linesRemoved: number;
		toolUseId: string;
		timestamp: number;
	}>;
	cumulativeDiffs?: Array<{
		file: string;
		additions: number;
		deletions: number;
		status?: 'added' | 'deleted' | 'modified';
	}>;
	turnTokens?: Record<
		string,
		{
			input: number;
			output: number;
			total?: number;
			usage?: number;
			cacheRead?: number;
			durationMs?: number;
		}
	>;
	restoreCommits?: CommitInfo[];
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

export interface SessionInfoPayload {
	eventType: 'session_info';
	data: SessionInfoData;
	permissionAutoAccept?: PermissionAutoAcceptState;
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
	// Latest token snapshot plus authoritative per-turn usage for a single
	// parent-session user message.
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	usageTokens?: number;
	cacheReadTokens: number;
	durationMs?: number;
	userMessageId?: string;
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

export interface SessionTodoPayload {
	eventType: 'todo';
	todos: SessionTodoItem[];
}

export interface SessionPermissionPayload {
	eventType: 'permission';
	action: 'set' | 'upsert' | 'remove';
	requests?: SessionPermissionRequest[];
	request?: SessionPermissionRequest;
	requestId?: string;
	response?: 'once' | 'always' | 'reject';
}

export interface SessionQuestionPayload {
	eventType: 'question';
	action: 'set' | 'upsert' | 'remove';
	requests?: SessionQuestionRequest[];
	request?: SessionQuestionRequest;
	requestId?: string;
	answers?: QuestionAnswer[];
	rejected?: boolean;
}

export type SessionEventPayload =
	| SessionMessageRecordPayload
	| SessionMessageRecordRemovedPayload
	| SessionMessagePartPayload
	| SessionMessagePartDeltaPayload
	| SessionMessagePartRemovedPayload
	| SessionStatusPayload
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
	| SessionTurnTokensPayload
	| SessionFileDiffPayload
	| SessionTodoPayload
	| SessionPermissionPayload
	| SessionUserMessagePayload
	| SessionNotificationPayload
	| SessionQuestionPayload;

export interface SessionEventMessage {
	type: 'session_event';
	targetId: string;
	eventType: SessionEventType;
	payload: SessionEventPayload;
	timestamp: number;
	sessionId?: string;
	normalizedEntry?: import('./normalizedTypes').NormalizedEntry;
}

/**
 * Batched session events for transport efficiency.
 * Reduces postMessage overhead by sending multiple events in a single message.
 */
export interface SessionEventBatchMessage {
	type: 'session_event_batch';
	messages: SessionEventMessage[];
}

export type SessionLifecycleAction = 'created' | 'closed' | 'switched' | 'cleared';

export interface SessionLifecycleMessage {
	type: 'session_lifecycle';
	action: SessionLifecycleAction;
	sessionId?: string;
	data?: {
		isProcessing?: boolean;
		messages?: unknown[];
	};
}

// =============================================================================
// Tool Data Interfaces
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

export type SubagentsListMessage = BaseExtensionMessage<
	'subagentsList',
	{
		subagents: ParsedSubagent[];
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	}
>;

export type AgentsListMessage = BaseExtensionMessage<
	'agentsList',
	{
		agents: Array<{
			id: string;
			mode?: string;
			description?: string;
			model?: string;
			variant?: string;
			builtIn?: boolean;
			hidden?: boolean;
		}>;
		isLoading: boolean;
		error?: string;
	}
>;

export type PluginsListMessage = BaseExtensionMessage<
	'pluginsList',
	{
		plugins: string[];
		isLoading: boolean;
		error?: string;
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
export type ServerInfoMessage = BaseExtensionMessage<
	'serverInfo',
	{ url: string; revision: number }
>;

export type SseEventMessage = BaseExtensionMessage<'sseEvent', { id: string; data: string }>;
export type SseOpenMessage = BaseExtensionMessage<'sseOpen', { id: string }>;
export type SseErrorMessage = BaseExtensionMessage<'sseError', { id: string; error: string }>;
export type SseClosedMessage = BaseExtensionMessage<'sseClosed', { id: string }>;

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

export type OpenSettingsMessage = BaseExtensionMessage<'openSettings'>;

// =============================================================================
// Extension → Webview Union
// =============================================================================

export type ExtensionMessage =
	| SessionEventMessage
	| SessionEventBatchMessage
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
	| OpenCodeStatusMessage
	| LspStatusMessage
	| OpenCodeProvidersMessage
	| OpenCodeModelSetMessage
	| OpenCodeAuthResultMessage
	| OpenCodeCustomProviderResultMessage
	| OpenCodeDisconnectResultMessage
	| RemoveOpenCodeProviderMessage
	| SseOpenMessage
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
	| CommandsListMessage
	| SkillsListMessage
	| SubagentsListMessage
	| AgentsListMessage
	| PluginsListMessage
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
	| SseClosedMessage
	| ExtensionVersionMessage
	| ConnectionDetailsMessage
	| OpenHistoryMessage
	| OpenSettingsMessage
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
	editMode?: 'revert' | 'history_only';
	/** Agent override for this message (e.g. 'plan', 'build'). */
	agent?: string;
	/** Thinking effort variant (e.g. 'high', 'max', 'low'). Sent to CLI as-is. */
	variant?: string;
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
}
export interface RemoveProxyEndpointCommand {
	type: 'removeProxyEndpoint';
	providerId: string;
	baseUrl?: string;
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

export interface QuestionResponseCommand {
	type: 'questionResponse';
	requestId: string;
	answers: QuestionAnswer[];
	sessionId?: string;
}

export interface QuestionRejectCommand {
	type: 'questionReject';
	requestId: string;
	sessionId?: string;
}

export interface GetPermissionsCommand {
	type: 'getPermissions';
}
export interface SetPermissionsCommand {
	type: 'setPermissions';
	policies: Partial<PermissionPolicies>;
	provider?: string;
}
export interface SetAutoAcceptCommand {
	type: 'setAutoAccept';
	mode: 'default' | 'on' | 'off';
	sessionId?: string;
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
	sessionId?: string;
}
export interface UnrevertCommand {
	type: 'unrevert';
	sessionId?: string;
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
	filePath: string;
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
	filePath: string;
}

export type CreateSubagentCommand = SubagentCommandFields;
export interface DeleteSubagentCommand {
	type: 'deleteSubagent';
	name: string;
}
export interface OpenSubagentFileCommand {
	type: 'openSubagentFile';
	filePath: string;
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
// Message Queue Commands
// =============================================================================

/** Queued message data stored per-session on the extension side. */
export interface QueuedMessageData {
	/** Unique queue entry ID */
	queueId: string;
	/** Original message text */
	text: string;
	/** Model override */
	model?: string;
	/** Target session */
	sessionId: string;
	/** Agent override (e.g. 'plan', 'build') */
	agent?: string;
	/** Thinking effort variant (e.g. 'high', 'max', 'low'). */
	variant?: string;
	/** Attachments */
	attachments?: SendMessageCommand['attachments'];
	/** Timestamp when queued */
	queuedAt: number;
}

export interface CancelQueuedMessageCommand {
	type: 'cancelQueuedMessage';
	queueId: string;
	sessionId: string;
}

export interface ForceQueuedMessageCommand {
	type: 'forceQueuedMessage';
	queueId: string;
	sessionId: string;
}

export interface ReorderQueueCommand {
	type: 'reorderQueue';
	sessionId: string;
	/** Ordered list of queueIds — new order for the queue */
	queueIds: string[];
}

// Extension → Webview queue events
export type QueueEventMessage = BaseExtensionMessage<
	'messageQueue',
	{
		action: 'enqueued' | 'dequeued' | 'cancelled' | 'cleared';
		sessionId: string;
		queue: QueuedMessageData[];
		/** The cancelled message text, returned to input on cancel */
		cancelledText?: string;
		/** The cancelled message attachments, restored on cancel */
		cancelledAttachments?: SendMessageCommand['attachments'];
		/** The cancelled message agent, restored on cancel */
		cancelledAgent?: string;
	}
>;

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
	| GetSubagentsCommand
	| GetAgentsCommand
	| GetPluginsCommand
	| GetRulesCommand
	| LoadMCPServersCommand
	| SaveMCPServerCommand
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
	| AccessResponseCommand
	| QuestionResponseCommand
	| QuestionRejectCommand
	| GetPermissionsCommand
	| SetPermissionsCommand
	| SetAutoAcceptCommand
	| CheckDiscoveryStatusCommand
	| GetAccessCommand
	| CheckCLIDiagnosticsCommand
	| OpenFileCommand
	| OpenFileDiffCommand
	| OpenExternalCommand
	| GetImageDataCommand
	| BrowseFilesCommand
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
	| CreateCommandCommand
	| DeleteCommandCommand
	| OpenCommandFileCommand
	| CreateSubagentCommand
	| DeleteSubagentCommand
	| OpenSubagentFileCommand
	| AddPluginCommand
	| RemovePluginCommand
	| ToggleRuleCommand
	| CreateRuleCommand
	| DeleteRuleCommand
	| AcceptFileCommand
	| AcceptAllFilesCommand
	| UndoFileChangesCommand
	| UndoAllChangesCommand
	| ClearAllConversationsCommand
	| SyncAllCommand
	| CancelQueuedMessageCommand
	| ForceQueuedMessageCommand
	| ReorderQueueCommand
	| CheckExtensionVersionCommand
	| RestartOpenCodeCommand
	| ReloadExtensionCommand
	| GetConnectionDetailsCommand;

// =============================================================================
// Utility
// =============================================================================

/** Extract a single command variant from the union by its `type` literal. */
export type CommandOf<T extends WebviewCommand['type']> = Extract<WebviewCommand, { type: T }>;
