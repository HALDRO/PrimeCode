/**
 * @file Shared TypeBox schemas and derived TypeScript types
 * @description Defines runtime-validated schemas (TypeBox) shared between extension and webview.
 * Acts as the single source of truth for cross-boundary message payloads and stored data shapes.
 * Types are derived from schemas to keep compile-time and runtime contracts aligned.
 * Includes commit/checkpoint metadata used by both git-based restore and OpenCode-native checkpoints.
 */

import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

// =============================================================================
// CLI Provider Types
// =============================================================================

export const CLIProviderTypeSchema = Type.Literal('opencode');
export type CLIProviderType = Static<typeof CLIProviderTypeSchema>;

// =============================================================================
// Unified MCP Registry Types
// =============================================================================

const UnifiedMcpTransportStdioSchema = Type.Object({
	type: Type.Literal('stdio'),
	command: Type.Array(Type.String(), { minItems: 1 }),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
});

const UnifiedMcpTransportHttpSchema = Type.Object({
	type: Type.Literal('http'),
	url: Type.String(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const UnifiedMcpTransportSseSchema = Type.Object({
	type: Type.Literal('sse'),
	url: Type.String(),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const UnifiedMcpTransportSchema = Type.Union([
	UnifiedMcpTransportStdioSchema,
	UnifiedMcpTransportHttpSchema,
	UnifiedMcpTransportSseSchema,
]);

const UnifiedMcpMetadataSchema = Type.Object({
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

const MCPServerTypeSchema = Type.Union([
	Type.Literal('http'),
	Type.Literal('sse'),
	Type.Literal('stdio'),
]);

export const MCPServerConfigSchema = Type.Object({
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	type: Type.Optional(MCPServerTypeSchema),
	// UI/registry helpers (not part of raw mcp-servers.json, but used by this extension)
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

/**
 * Cumulative session-level stats — full state, not deltas.
 * CLI returns absolute values per request; we store the latest snapshot.
 * Only `requestCount`, `totalDuration`, `totalCost` and subagent counters are truly cumulative.
 */
export const TotalStatsSchema = Type.Object({
	contextTokens: Type.Number(), // Current context window size (last API input tokens).
	outputTokens: Type.Number(), // Current output tokens (last API response).
	totalTokens: Type.Number(), // Current total tokens (input + output) from CLI — context window usage.
	cacheReadTokens: Type.Number(), // Cache read tokens (last API response).
	cacheCreationTokens: Type.Number(), // Cache creation tokens (last API response).
	reasoningTokens: Type.Number(), // Reasoning/thinking tokens (last API response).
	requestCount: Type.Number(), // Total API requests in this session.
	totalDuration: Type.Number(), // Total model processing time across all requests (ms).
	totalCost: Type.Number(), // Total cost across all requests.
	currentDuration: Type.Optional(Type.Number()), // Duration of the current/last request (ms).
	subagentTokensInput: Type.Number(), // Cumulative input tokens from all subagent/child sessions.
	subagentTokensOutput: Type.Number(), // Cumulative output tokens from all subagent/child sessions.
	subagentCount: Type.Number(), // Total number of subagent invocations in this session.
	totalInputTokens: Type.Number(), // Cumulative input tokens across all API requests.
	totalOutputTokens: Type.Number(), // Cumulative output tokens across all API requests.
});
export type TotalStats = Static<typeof TotalStatsSchema>;

// =============================================================================
// Access Types
// =============================================================================

export const AccessSchema = Type.Object({
	toolName: Type.String(),
	commands: Type.Optional(Type.Array(Type.String())),
	allowAll: Type.Optional(Type.Boolean()),
});
export type Access = Static<typeof AccessSchema>;

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
	// When using OpenCode-native revert, we may also keep a git checkpoint SHA to restore workspace files.
	workspaceCommitSha: Type.Optional(Type.String()),
});
export type CommitInfo = Static<typeof CommitInfoSchema>;

// =============================================================================
// Message Attachments
// =============================================================================

const CodeSnippetAttachmentSchema = Type.Object({
	filePath: Type.String(),
	startLine: Type.Number(),
	endLine: Type.Number(),
	content: Type.String(),
});

const ImageAttachmentSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	dataUrl: Type.String(),
	path: Type.Optional(Type.String()),
});

const MessageAttachmentsSchema = Type.Object({
	files: Type.Optional(Type.Array(Type.String())),
	codeSnippets: Type.Optional(Type.Array(CodeSnippetAttachmentSchema)),
	images: Type.Optional(Type.Array(ImageAttachmentSchema)),
});

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
		attachments: Type.Optional(MessageAttachmentsSchema),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('assistant'),
		content: Type.String(),
		partId: Type.Optional(Type.String()),
		hidden: Type.Optional(Type.Boolean()),
		contextId: Type.Optional(Type.String()),
		isStreaming: Type.Optional(Type.Boolean()),
		isDelta: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('thinking'),
		content: Type.String(),
		partId: Type.Optional(Type.String()),
		reasoningTokens: Type.Optional(Type.Number()),
		startTime: Type.Optional(Type.Number()),
		durationMs: Type.Optional(Type.Number()),
		isStreaming: Type.Optional(Type.Boolean()),
		isDelta: Type.Optional(Type.Boolean()),
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
		streamingOutput: Type.Optional(Type.String()),
		isRunning: Type.Optional(Type.Boolean()),
		hidden: Type.Optional(Type.Boolean()),
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		contextId: Type.Optional(Type.String()),
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
		title: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
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
		metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		contextId: Type.Optional(Type.String()),
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
		status: Type.Union([
			Type.Literal('running'),
			Type.Literal('completed'),
			Type.Literal('error'),
			Type.Literal('cancelled'),
		]),
		contextId: Type.Optional(Type.String()),
		result: Type.Optional(Type.String()),
		messageID: Type.Optional(Type.String()),
		transcript: Type.Optional(Type.Array(Type.Any())),
		startTime: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
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
	status: Type.Union([
		Type.Literal('running'),
		Type.Literal('completed'),
		Type.Literal('error'),
		Type.Literal('cancelled'),
	]),
	contextId: Type.Optional(Type.String()),
	result: Type.Optional(Type.String()),
	messageID: Type.Optional(Type.String()),
	transcript: Type.Optional(Type.Array(ConversationMessageSchema)),
	startTime: Type.Optional(Type.String()),
	durationMs: Type.Optional(Type.Number()),
});
export type SubtaskMessage = Static<typeof SubtaskMessageSchema>;

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

const ProjectUpdatedSchema = Type.Object({
	project: Type.Object({
		id: Type.String(),
		name: Type.Optional(Type.String()),
		worktree: Type.Optional(Type.String()),
		vcs: Type.Optional(Type.Literal('git')),
	}),
});
export type ProjectUpdated = Static<typeof ProjectUpdatedSchema>;

const OpenCodeModelDataSchema = Type.Object({
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
	source: Type.Union([Type.Literal('opencode')]),
	content: Type.Optional(Type.String()),
	isReadOnly: Type.Optional(Type.Boolean()),
});
export type Rule = Static<typeof RuleSchema>;

// =============================================================================
// Agents / Commands / Skills / Hooks
// =============================================================================

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

export const ParsedSkillSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	content: Type.String(),
	version: Type.Optional(Type.String()),
	path: Type.String(),
});
export type ParsedSkill = Static<typeof ParsedSkillSchema>;

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

export const ParsedSubagentSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	prompt: Type.String(),
	path: Type.String(),
});
export type ParsedSubagent = Static<typeof ParsedSubagentSchema>;

// =============================================================================
// Discovery Status
// =============================================================================

export const DiscoveryStatusSchema = Type.Object({
	rules: Type.Object({
		hasAgentsMd: Type.Boolean(),
		ruleFiles: Type.Array(Type.String()),
	}),
	permissions: Type.Object({
		openCodeConfig: Type.Optional(Type.String()),
	}),
	skills: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.String(),
			type: Type.Literal('opencode'),
		}),
	),
	hooks: Type.Array(
		Type.Object({
			name: Type.String(),
			path: Type.String(),
			type: Type.Literal('opencode'),
		}),
	),
});
export type DiscoveryStatus = Static<typeof DiscoveryStatusSchema>;

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
