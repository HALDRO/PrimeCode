/**
 * @file Shared TypeBox schemas and derived TypeScript types
 * @description Defines runtime-validated schemas (TypeBox) shared between extension and webview.
 * Acts as the single source of truth for cross-boundary message payloads and stored data shapes.
 * Types are derived from schemas to keep compile-time and runtime contracts aligned.
 * Includes commit/checkpoint metadata used by both git-based restore (Claude CLI) and OpenCode-native checkpoints.
 */

import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

// =============================================================================
// CLI Provider Types
// =============================================================================

export const CLIProviderTypeSchema = Type.Union([Type.Literal('claude'), Type.Literal('opencode')]);
export type CLIProviderType = Static<typeof CLIProviderTypeSchema>;

// =============================================================================
// Unified MCP Registry Types
// =============================================================================

export const UnifiedMcpTransportStdioSchema = Type.Object({
	type: Type.Literal('stdio'),
	command: Type.Array(Type.String(), { minItems: 1 }),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
});

export const UnifiedMcpTransportHttpSchema = Type.Object({
	type: Type.Literal('http'),
	url: Type.String(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const UnifiedMcpTransportSseSchema = Type.Object({
	type: Type.Literal('sse'),
	url: Type.String(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const UnifiedMcpTransportSchema = Type.Union([
	UnifiedMcpTransportStdioSchema,
	UnifiedMcpTransportHttpSchema,
	UnifiedMcpTransportSseSchema,
]);
export type UnifiedMcpTransport = Static<typeof UnifiedMcpTransportSchema>;

export const UnifiedMcpMetadataSchema = Type.Object({
	description: Type.Optional(Type.String()),
	source: Type.Optional(
		Type.Union([
			Type.Literal('marketplace'),
			Type.Literal('user'),
			Type.Literal('workspace'),
			Type.Literal('import'),
		]),
	),
	lastStatus: Type.Optional(Type.String()),
	lastError: Type.Optional(Type.String()),
	lastCheckedAt: Type.Optional(Type.String()),
});
export type UnifiedMcpMetadata = Static<typeof UnifiedMcpMetadataSchema>;

export const UnifiedMcpServerSchema = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	transport: UnifiedMcpTransportSchema,
	timeoutMs: Type.Optional(Type.Number()),
	metadata: Type.Optional(UnifiedMcpMetadataSchema),
});
export type UnifiedMcpServer = Static<typeof UnifiedMcpServerSchema>;

export const UnifiedMcpRegistrySchema = Type.Record(Type.String(), UnifiedMcpServerSchema);
export type UnifiedMcpRegistry = Static<typeof UnifiedMcpRegistrySchema>;

// =============================================================================
// Agents Config Types (.agents/mcp.json)
// =============================================================================

export const AgentsMcpServerSchema = Type.Object({
	type: Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('sse')]),
	command: Type.Optional(Type.Array(Type.String())),
	url: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Number()),
});
export type AgentsMcpServer = Static<typeof AgentsMcpServerSchema>;

export const AgentsMcpConfigSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	version: Type.Optional(Type.Number()),
	servers: Type.Record(Type.String(), AgentsMcpServerSchema),
});
export type AgentsMcpConfig = Static<typeof AgentsMcpConfigSchema>;

// =============================================================================
// MCP Server Types
// =============================================================================

export const MCPServerTypeSchema = Type.Union([
	Type.Literal('http'),
	Type.Literal('sse'),
	Type.Literal('stdio'),
]);
export type MCPServerType = Static<typeof MCPServerTypeSchema>;

export const MCPServerConfigSchema = Type.Object({
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	type: Type.Optional(MCPServerTypeSchema),
	// UI/registry helpers (not part of Claude's raw mcp-servers.json, but used by this extension)
	enabled: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Number()),
});
export type MCPServerConfig = Static<typeof MCPServerConfigSchema>;

export const MCPServersMapSchema = Type.Record(Type.String(), MCPServerConfigSchema);
export type MCPServersMap = Static<typeof MCPServersMapSchema>;

// =============================================================================
// MCP Marketplace & Installed Metadata (UI layer)
// =============================================================================

export const McpMarketplaceItemSchema = Type.Object({
	mcpId: Type.String(),
	name: Type.String(),
	author: Type.Optional(Type.String()),
	description: Type.String(),
	githubUrl: Type.Optional(Type.String()),
	logoUrl: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	tags: Type.Array(Type.String()),
	requiresApiKey: Type.Optional(Type.Boolean()),
	isRecommended: Type.Optional(Type.Boolean()),
	githubStars: Type.Optional(Type.Number()),
	downloadCount: Type.Optional(Type.Number()),
});
export type McpMarketplaceItem = Static<typeof McpMarketplaceItemSchema>;

export const McpMarketplaceCatalogSchema = Type.Object({
	schemaVersion: Type.Number(),
	items: Type.Array(McpMarketplaceItemSchema),
});
export type McpMarketplaceCatalog = Static<typeof McpMarketplaceCatalogSchema>;

export const InstalledMcpServerMetadataSchema = Type.Object({
	source: Type.Union([Type.Literal('marketplace'), Type.Literal('custom')]),
	displayName: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	icon: Type.Optional(Type.String()),
	installedAt: Type.Optional(Type.String()),
	marketplaceId: Type.Optional(Type.String()),
});
export type InstalledMcpServerMetadata = Static<typeof InstalledMcpServerMetadataSchema>;

// =============================================================================
// Token Usage Types
// =============================================================================

export const TokenUsageAPISchema = Type.Object({
	input_tokens: Type.Optional(Type.Number()),
	output_tokens: Type.Optional(Type.Number()),
	cache_creation_input_tokens: Type.Optional(Type.Number()),
	cache_read_input_tokens: Type.Optional(Type.Number()),
	reasoning_tokens: Type.Optional(Type.Number()),
});
export type TokenUsageAPI = Static<typeof TokenUsageAPISchema>;

export const TokenStatsSchema = Type.Object({
	totalTokensInput: Type.Number(),
	totalTokensOutput: Type.Number(),
	currentInputTokens: Type.Number(),
	currentOutputTokens: Type.Number(),
	cacheCreationTokens: Type.Number(),
	cacheReadTokens: Type.Number(),
	reasoningTokens: Type.Number(),
	totalReasoningTokens: Type.Number(),
});
export type TokenStats = Static<typeof TokenStatsSchema>;

export const TotalStatsSchema = Type.Object({
	totalCost: Type.Number(),
	totalTokensInput: Type.Number(),
	totalTokensOutput: Type.Number(),
	totalReasoningTokens: Type.Optional(Type.Number()),
	requestCount: Type.Number(),
	totalDuration: Type.Optional(Type.Number()),
	currentCost: Type.Optional(Type.Number()),
	currentDuration: Type.Optional(Type.Number()),
	currentTurns: Type.Optional(Type.Number()),
});
export type TotalStats = Static<typeof TotalStatsSchema>;

/**
 * Transforms Claude API token usage to UI-friendly token stats
 */
export function apiTokensToStats(api: TokenUsageAPI): Partial<TokenStats> {
	return {
		currentInputTokens: api.input_tokens ?? 0,
		currentOutputTokens: api.output_tokens ?? 0,
		cacheCreationTokens: api.cache_creation_input_tokens ?? 0,
		cacheReadTokens: api.cache_read_input_tokens ?? 0,
		reasoningTokens: api.reasoning_tokens ?? 0,
	};
}

// =============================================================================
// Access Types
// =============================================================================

export const AccessSchema = Type.Object({
	toolName: Type.String(),
	commands: Type.Optional(Type.Array(Type.String())),
	allowAll: Type.Optional(Type.Boolean()),
});
export type Access = Static<typeof AccessSchema>;

export const AccessStoreSchema = Type.Object({
	alwaysAllow: Type.Record(Type.String(), Type.Union([Type.Boolean(), Type.Array(Type.String())])),
});
export type AccessStore = Static<typeof AccessStoreSchema>;

export const AccessRequestSchema = Type.Object({
	id: Type.String(),
	tool: Type.String(),
	input: Type.Record(Type.String(), Type.Unknown()),
	timestamp: Type.String(),
	toolUseId: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
});
export type AccessRequest = Static<typeof AccessRequestSchema>;

export const AccessResponseSchema = Type.Object({
	id: Type.String(),
	approved: Type.Boolean(),
	timestamp: Type.String(),
});
export type AccessResponse = Static<typeof AccessResponseSchema>;

// =============================================================================
// Workspace & Files
// =============================================================================

export const WorkspaceFileSchema = Type.Object({
	name: Type.String(),
	path: Type.String(),
	fsPath: Type.String(),
});
export type WorkspaceFile = Static<typeof WorkspaceFileSchema>;

// =============================================================================
// Git & Commits
// =============================================================================

export const CommitInfoSchema = Type.Object({
	id: Type.String(),
	sha: Type.String(),
	message: Type.String(),
	timestamp: Type.String(),
	associatedMessageId: Type.Optional(Type.String()),
	// OpenCode checkpoint metadata (optional; git-based commits won't have these)
	sessionId: Type.Optional(Type.String()),
	cliSessionId: Type.Optional(Type.String()),
	isOpenCodeCheckpoint: Type.Optional(Type.Boolean()),
	// When using OpenCode-native revert, we may also keep a git checkpoint SHA to restore workspace files.
	workspaceCommitSha: Type.Optional(Type.String()),
});
export type CommitInfo = Static<typeof CommitInfoSchema>;

// =============================================================================
// Message Attachments
// =============================================================================

/** Code snippet with file location and content */
export const CodeSnippetAttachmentSchema = Type.Object({
	filePath: Type.String(),
	startLine: Type.Number(),
	endLine: Type.Number(),
	content: Type.String(),
});
export type CodeSnippetAttachment = Static<typeof CodeSnippetAttachmentSchema>;

/** Image attachment with data URL or path */
export const ImageAttachmentSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	dataUrl: Type.String(),
	path: Type.Optional(Type.String()),
});
export type ImageAttachment = Static<typeof ImageAttachmentSchema>;

/** Unified attachments structure for user messages */
export const MessageAttachmentsSchema = Type.Object({
	/** File paths referenced in the message */
	files: Type.Optional(Type.Array(Type.String())),
	/** Code snippets with line ranges */
	codeSnippets: Type.Optional(Type.Array(CodeSnippetAttachmentSchema)),
	/** Attached images */
	images: Type.Optional(Type.Array(ImageAttachmentSchema)),
});
export type MessageAttachments = Static<typeof MessageAttachmentsSchema>;

// =============================================================================
// Conversation History
// =============================================================================

export const ConversationMessageSchema = Type.Union([
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('user'),
		content: Type.String(),
		model: Type.Optional(Type.String()),
		/** Structured attachments (files, code snippets, images) */
		attachments: Type.Optional(MessageAttachmentsSchema),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('assistant'),
		content: Type.String(),
		/** Part ID from SDK for streaming merge identification */
		partId: Type.Optional(Type.String()),
		/** Hide from main flow when nested under subtasks */
		hidden: Type.Optional(Type.Boolean()),
		/** Child session ID for subtask messages */
		childSessionId: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('thinking'),
		content: Type.String(),
		/** Part ID from SDK for streaming merge identification */
		partId: Type.Optional(Type.String()),
		/** Reasoning tokens used for this thinking block */
		reasoningTokens: Type.Optional(Type.Number()),
		/** Start time in milliseconds (Date.now()) for frontend to compute elapsed */
		startTime: Type.Optional(Type.Number()),
		/** Duration of thinking in milliseconds (final value when streaming ends) */
		durationMs: Type.Optional(Type.Number()),
		/** Whether this message is currently streaming */
		isStreaming: Type.Optional(Type.Boolean()),
		/** Whether this is a delta update (append to existing content) */
		isDelta: Type.Optional(Type.Boolean()),
		/** Hide from main flow when nested under subtasks */
		hidden: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('tool_use'),
		toolName: Type.String(),
		toolUseId: Type.String(),
		toolInput: Type.Optional(Type.String()),
		rawInput: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		filePath: Type.Optional(Type.String()),
		/** Streaming output for running tools (e.g., Bash intermediate output) */
		streamingOutput: Type.Optional(Type.String()),
		/** Whether the tool is currently running */
		isRunning: Type.Optional(Type.Boolean()),
		hidden: Type.Optional(Type.Boolean()),
		/** Tool metadata from SDK (OpenCode) */
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		/** Child session ID for subtask tool calls */
		childSessionId: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('tool_result'),
		toolName: Type.String(),
		toolUseId: Type.String(),
		content: Type.String(),
		isError: Type.Boolean(),
		estimatedTokens: Type.Optional(Type.Number()),
		hidden: Type.Optional(Type.Boolean()),
		/** Human-readable title from SDK (e.g., "Reading file.ts") */
		title: Type.Optional(Type.String()),
		/** Tool execution time in milliseconds */
		durationMs: Type.Optional(Type.Number()),
		/** Attached files (e.g., screenshots, generated images) */
		attachments: Type.Optional(
			Type.Array(
				Type.Object({
					id: Type.String(),
					mime: Type.String(),
					filename: Type.Optional(Type.String()),
					url: Type.Optional(Type.String()),
				}),
			),
		),
		/** Tool metadata from SDK */
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		/** Child session ID for subtask tool results */
		childSessionId: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('error'),
		content: Type.String(),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('interrupted'),
		content: Type.String(),
		/** Reason for interruption: user_stopped, cli_crash, connection_lost, timeout */
		reason: Type.Optional(
			Type.Union([
				Type.Literal('user_stopped'),
				Type.Literal('cli_crash'),
				Type.Literal('connection_lost'),
				Type.Literal('timeout'),
				Type.String(),
			]),
		),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('access_request'),
		requestId: Type.String(),
		tool: Type.String(),
		input: Type.Record(Type.String(), Type.Unknown()),
		pattern: Type.Optional(Type.String()),
		toolUseId: Type.Optional(Type.String()),
		resolved: Type.Optional(Type.Boolean()),
		approved: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('subtask'),
		agent: Type.String(),
		prompt: Type.String(),
		description: Type.String(),
		command: Type.Optional(Type.String()),
		status: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('error')]),
		childMessages: Type.Optional(Type.Array(Type.String())),
		childSessionId: Type.Optional(Type.String()),
		result: Type.Optional(Type.String()),
		messageID: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('system_notice'),
		content: Type.String(),
	}),
]);

export type ConversationMessage = Static<typeof ConversationMessageSchema>;

export const SubtaskMessageSchema = Type.Object({
	id: Type.Optional(Type.String()),
	timestamp: Type.String(),
	type: Type.Literal('subtask'),
	agent: Type.String(),
	prompt: Type.String(),
	description: Type.String(),
	command: Type.Optional(Type.String()),
	status: Type.Union([Type.Literal('running'), Type.Literal('completed'), Type.Literal('error')]),
	childMessages: Type.Optional(Type.Array(Type.String())),
	childSessionId: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	messageID: Type.Optional(Type.String()),
});
export type SubtaskMessage = Static<typeof SubtaskMessageSchema>;

export const ConversationDataSchema = Type.Object({
	sessionId: Type.String(),
	startTime: Type.Union([Type.String(), Type.Undefined()]),
	endTime: Type.String(),
	messageCount: Type.Number(),
	totalCost: Type.Number(),
	totalTokens: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		reasoning: Type.Optional(Type.Number()),
	}),
	/** Total duration of all API calls in milliseconds */
	totalDuration: Type.Optional(Type.Number()),
	/** Number of API requests made */
	requestCount: Type.Optional(Type.Number()),
	messages: Type.Array(ConversationMessageSchema),
	filename: Type.String(),
});
export type ConversationData = Static<typeof ConversationDataSchema>;

export const ConversationIndexEntrySchema = Type.Object({
	filename: Type.String(),
	sessionId: Type.String(),
	startTime: Type.String(),
	endTime: Type.String(),
	messageCount: Type.Number(),
	totalCost: Type.Number(),
	firstUserMessage: Type.String(),
	lastUserMessage: Type.String(),
	customTitle: Type.Optional(Type.String()),
});
export type ConversationIndexEntry = Static<typeof ConversationIndexEntrySchema>;

// =============================================================================
// Platform Info
// =============================================================================

export const PlatformInfoSchema = Type.Object({
	platform: Type.String(),
	isWindows: Type.Boolean(),
});
export type PlatformInfo = Static<typeof PlatformInfoSchema>;

// =============================================================================
// Settings
// =============================================================================

export const ClaudeSettingsSchema = Type.Object({
	provider: Type.Optional(CLIProviderTypeSchema),
	'proxy.baseUrl': Type.String(),
	'proxy.apiKey': Type.String(),
	'proxy.enabledModels': Type.Array(Type.String()),
	'proxy.useSingleModel': Type.Optional(Type.Boolean()),
	'proxy.haikuModel': Type.Optional(Type.String()),
	'proxy.sonnetModel': Type.Optional(Type.String()),
	'proxy.opusModel': Type.Optional(Type.String()),
	'proxy.subagentModel': Type.Optional(Type.String()),
	'opencode.autoStart': Type.Optional(Type.Boolean()),
	'opencode.serverTimeout': Type.Optional(Type.Number()),
	'opencode.agent': Type.Optional(Type.String()),
	'opencode.enabledModels': Type.Array(Type.String()),
	'providers.disabled': Type.Array(Type.String()),
	'promptImprove.model': Type.Optional(Type.String()),
	'promptImprove.template': Type.Optional(Type.String()),
	'promptImprove.timeoutMs': Type.Optional(Type.Number()),
});
export type ClaudeSettings = Static<typeof ClaudeSettingsSchema>;

// =============================================================================
// Session Info
// =============================================================================

export const SessionInfoSchema = Type.Object({
	sessionId: Type.String(),
	tools: Type.Array(Type.String()),
	mcpServers: Type.Array(Type.String()),
});
export type SessionInfo = Static<typeof SessionInfoSchema>;

// =============================================================================
// OpenCode Agent Types
// =============================================================================

export const OpenCodeAgentModeSchema = Type.Union([
	Type.Literal('subagent'),
	Type.Literal('primary'),
	Type.Literal('all'),
]);
export type OpenCodeAgentMode = Static<typeof OpenCodeAgentModeSchema>;

export const OpenCodeAgentSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	mode: OpenCodeAgentModeSchema,
	builtIn: Type.Boolean(),
	options: Type.Optional(
		Type.Object({
			color: Type.Optional(Type.String()),
		}),
	),
});
export type OpenCodeAgent = Static<typeof OpenCodeAgentSchema>;

// =============================================================================
// OpenCode Session Types
// =============================================================================

export const OpenCodeSessionSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	projectID: Type.Optional(Type.String()),
	directory: Type.Optional(Type.String()),
	time: Type.Optional(
		Type.Object({
			created: Type.Number(),
			updated: Type.Number(),
		}),
	),
});
export type OpenCodeSession = Static<typeof OpenCodeSessionSchema>;

// =============================================================================
// OpenCode Access Types
// =============================================================================

export const OpenCodeAccessSchema = Type.Object({
	id: Type.String(),
	type: Type.String(),
	pattern: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	sessionID: Type.String(),
	messageID: Type.String(),
	callID: Type.Optional(Type.String()),
	title: Type.String(),
	metadata: Type.Record(Type.String(), Type.Unknown()),
	time: Type.Object({
		created: Type.Number(),
	}),
});
export type OpenCodeAccess = Static<typeof OpenCodeAccessSchema>;

export const OpenCodeAccessResponseSchema = Type.Union([
	Type.Literal('once'),
	Type.Literal('always'),
	Type.Literal('reject'),
]);
export type OpenCodeAccessResponse = Static<typeof OpenCodeAccessResponseSchema>;

// =============================================================================
// OpenCode Project & Message Events
// =============================================================================

export const ProjectUpdatedSchema = Type.Object({
	project: Type.Object({
		id: Type.String(),
		name: Type.Optional(Type.String()),
		worktree: Type.Optional(Type.String()),
		vcs: Type.Optional(Type.Literal('git')),
	}),
});
export type ProjectUpdated = Static<typeof ProjectUpdatedSchema>;

export const MessagePartRemovedSchema = Type.Object({
	messageId: Type.String(),
	partId: Type.String(),
});
export type MessagePartRemoved = Static<typeof MessagePartRemovedSchema>;

// =============================================================================
// OpenCode Provider Types
// =============================================================================

export const OpenCodeModelDataSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	reasoning: Type.Optional(Type.Boolean()),
	limit: Type.Optional(
		Type.Object({
			context: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
		}),
	),
});
export type OpenCodeModelData = Static<typeof OpenCodeModelDataSchema>;

export const OpenCodeProviderDataSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	isCustom: Type.Optional(Type.Boolean()),
	models: Type.Array(OpenCodeModelDataSchema),
});
export type OpenCodeProviderData = Static<typeof OpenCodeProviderDataSchema>;

// =============================================================================
// Rules
// =============================================================================

export const RuleSchema = Type.Object({
	name: Type.String(),
	path: Type.String(),
	isEnabled: Type.Boolean(),
	source: Type.Union([Type.Literal('claude'), Type.Literal('opencode')]),
	content: Type.Optional(Type.String()),
	/** Read-only rules cannot be toggled (e.g., derived OpenCode files like AGENTS.md) */
	isReadOnly: Type.Optional(Type.Boolean()),
});
export type Rule = Static<typeof RuleSchema>;

// =============================================================================
// Agents / Commands / Skills / Hooks
// =============================================================================

/**
 * Parsed command from .agents/commands/*.md
 * Supports both Claude (allowed-tools) and OpenCode (agent, model) formats
 */
export const ParsedCommandSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	prompt: Type.String(),
	allowedTools: Type.Optional(Type.Array(Type.String())),
	argumentHint: Type.Optional(Type.String()),
	agent: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	subtask: Type.Optional(Type.Boolean()),
	path: Type.String(),
});
export type ParsedCommand = Static<typeof ParsedCommandSchema>;

/**
 * Parsed skill from .agents/skills/*
 */
export const ParsedSkillSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	content: Type.String(),
	version: Type.Optional(Type.String()),
	path: Type.String(),
});
export type ParsedSkill = Static<typeof ParsedSkillSchema>;

/**
 * Parsed hook from .agents/hooks/*
 */
export const ParsedHookSchema = Type.Object({
	name: Type.String(),
	enabled: Type.Boolean(),
	event: Type.String(),
	pattern: Type.Optional(Type.String()),
	action: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	path: Type.String(),
});
export type ParsedHook = Static<typeof ParsedHookSchema>;

// =============================================================================
// Discovery Status (Rules, Permissions, Skills, Hooks)
// =============================================================================

export const DiscoveryStatusSchema = Type.Object({
	rules: Type.Object({
		hasAgentsMd: Type.Boolean(),
		hasClaudeMd: Type.Boolean(),
		hasClaudeShim: Type.Boolean(),
		ruleFiles: Type.Array(Type.String()),
	}),
	permissions: Type.Object({
		claudeConfig: Type.Optional(Type.String()),
		openCodeConfig: Type.Optional(Type.String()),
	}),
	skills: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.String(),
			type: Type.Union([Type.Literal('claude'), Type.Literal('opencode')]),
		}),
	),
	hooks: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.String(),
			type: Type.Literal('claude'),
		}),
	),
});
export type DiscoveryStatus = Static<typeof DiscoveryStatusSchema>;

// =============================================================================
// Webview Message
// =============================================================================

export const WebviewMessageSchema = Type.Object({
	type: Type.String(),
	data: Type.Optional(Type.Unknown()),
	text: Type.Optional(Type.String()),
	planMode: Type.Optional(Type.Boolean()),
	model: Type.Optional(Type.String()),
	command: Type.Optional(Type.String()),
	filename: Type.Optional(Type.String()),
	newTitle: Type.Optional(Type.String()),
	filePaths: Type.Optional(Type.Array(Type.String())),
	settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	searchTerm: Type.Optional(Type.String()),
	filePath: Type.Optional(Type.String()),
	startLine: Type.Optional(Type.Number()),
	endLine: Type.Optional(Type.Number()),
	path: Type.Optional(Type.String()),
	imageData: Type.Optional(Type.String()),
	imageType: Type.Optional(Type.String()),
	/** Structured attachments for sendMessage (files, code snippets, images) */
	attachments: Type.Optional(MessageAttachmentsSchema),
	id: Type.Optional(Type.String()),
	approved: Type.Optional(Type.Boolean()),
	alwaysAllow: Type.Optional(Type.Boolean()),
	response: Type.Optional(OpenCodeAccessResponseSchema),
	createClaudeShim: Type.Optional(Type.Boolean()),
	toolName: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	source: Type.Optional(Type.Union([Type.Literal('claude'), Type.Literal('opencode')])),
	/** Message ID for operations like dismissError */
	messageId: Type.Optional(Type.String()),
	policies: Type.Optional(
		Type.Object({
			edit: Type.Union([Type.Literal('ask'), Type.Literal('allow'), Type.Literal('deny')]),
			terminal: Type.Union([Type.Literal('ask'), Type.Literal('allow'), Type.Literal('deny')]),
			network: Type.Union([Type.Literal('ask'), Type.Literal('allow'), Type.Literal('deny')]),
		}),
	),
	config: Type.Optional(MCPServerConfigSchema),
	url: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	apiKey: Type.Optional(Type.String()),
	anthropicApiKey: Type.Optional(Type.String()),
	loadAnthropicModels: Type.Optional(Type.Boolean()),
	setAnthropicApiKey: Type.Optional(Type.Boolean()),
	clearAnthropicApiKey: Type.Optional(Type.Boolean()),
	getAnthropicKeyStatus: Type.Optional(Type.Boolean()),
	mcpId: Type.Optional(Type.String()),
	patch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	oldContent: Type.Optional(Type.String()),
	newContent: Type.Optional(Type.String()),
	meta: Type.Optional(InstalledMcpServerMetadataSchema),
	// Multi-session support: UI session identifier for routing messages
	sessionId: Type.Optional(Type.String()),
	// Prompt Improver
	requestId: Type.Optional(Type.String()),
	promptTemplate: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number()),
});
export type WebviewMessage = Static<typeof WebviewMessageSchema>;

// =============================================================================
// VS Code API
// =============================================================================

export interface VSCodeApi {
	postMessage: (message: unknown) => void;
	getState: () => unknown;
	setState: (state: unknown) => void;
}

declare global {
	interface Window {
		acquireVsCodeApi?: () => VSCodeApi;
		vscode?: VSCodeApi;
	}
}
