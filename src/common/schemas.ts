/**
 * @file Shared TypeBox schemas and derived TypeScript types
 * @description Defines runtime-validated schemas (TypeBox) shared between extension and webview.
 * Acts as the single source of truth for cross-boundary message payloads and stored data shapes.
 * Types are derived from schemas to keep compile-time and runtime contracts aligned.
 */

import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// =============================================================================
// CLI Provider Types
// =============================================================================

const CLIProviderTypeSchema = Type.Literal('opencode');
export type CLIProviderType = Static<typeof CLIProviderTypeSchema>;

// =============================================================================
// MCP Server Config Types (OpenCode native: opencode.json → mcp section)
// =============================================================================

/**
 * OpenCode MCP server config (opencode.json → mcp section).
 *
 * Discriminated by `type`:
 *   - "local"  → command[] + environment?  (stdio transport)
 *   - "remote" → url + headers? + oauth?   (HTTP/SSE transport)
 *
 * OpenCode also allows override-only entries: `{ enabled: boolean }`
 * (no type field) to toggle a server defined elsewhere in the config chain.
 */
const McpServerSchema = Type.Object({
	type: Type.Optional(Type.Union([Type.Literal('local'), Type.Literal('remote')])),
	command: Type.Optional(Type.Array(Type.String())),
	url: Type.Optional(Type.String()),
	environment: Type.Optional(Type.Record(Type.String(), Type.String())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	enabled: Type.Optional(Type.Boolean()),
	timeout: Type.Optional(Type.Number()),
	oauth: Type.Optional(
		Type.Union([
			Type.Object({
				clientId: Type.Optional(Type.String()),
				clientSecret: Type.Optional(Type.String()),
				scope: Type.Optional(Type.String()),
			}),
			Type.Literal(false),
		]),
	),
});
export type McpServer = Static<typeof McpServerSchema>;

export const McpConfigSchema = Type.Object(
	{
		mcp: Type.Optional(Type.Record(Type.String(), McpServerSchema)),
	},
	{ additionalProperties: true },
);
export type McpConfig = Static<typeof McpConfigSchema>;

// =============================================================================
// MCP Server Types
// =============================================================================

/**
 * MCPServerConfig — webview/UI-facing representation of an MCP server.
 * Uses the same local/remote types as OpenCode.
 * Conversion between McpServer (disk) ↔ MCPServerConfig (UI) happens in McpConfigService.
 */
const MCPServerTypeSchema = Type.Union([Type.Literal('local'), Type.Literal('remote')]);

const MCPServerConfigSchema = Type.Object({
	command: Type.Optional(Type.String()),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	url: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	type: Type.Optional(MCPServerTypeSchema),
	enabled: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Number()),
});
export type MCPServerConfig = Static<typeof MCPServerConfigSchema>;

const MCPServersMapSchema = Type.Record(Type.String(), MCPServerConfigSchema);
export type MCPServersMap = Static<typeof MCPServersMapSchema>;

// =============================================================================
// MCP Installed Metadata (UI layer)
// =============================================================================

const InstalledMcpServerMetadataSchema = Type.Object({
	source: Type.Union([Type.Literal('custom'), Type.Literal('runtime')]),
	displayName: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	icon: Type.Optional(Type.String()),
	installedAt: Type.Optional(Type.String()),
});
export type InstalledMcpServerMetadata = Static<typeof InstalledMcpServerMetadataSchema>;

/**
 * Cumulative session-level stats — full state, not deltas.
 * CLI returns absolute values per request; we store the latest snapshot.
 * Only `requestCount`, `totalDuration`, `totalCost` and subagent counters are truly cumulative.
 */
const TotalStatsSchema = Type.Object({
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
// Question Types (SSE question.asked → webview)
// =============================================================================

const QuestionOptionSchema = Type.Object({
	label: Type.String(),
	description: Type.String(),
	recommended: Type.Optional(Type.Boolean()),
});

const QuestionInfoSchema = Type.Object({
	question: Type.String(),
	header: Type.String(),
	options: Type.Array(QuestionOptionSchema),
	multiple: Type.Optional(Type.Boolean()),
	custom: Type.Optional(Type.Boolean()),
});
export type QuestionInfo = Static<typeof QuestionInfoSchema>;

const QuestionToolRefSchema = Type.Object({
	messageID: Type.String(),
	callID: Type.String(),
});

const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

const SessionTodoStatusSchema = Type.Union([
	Type.Literal('pending'),
	Type.Literal('in_progress'),
	Type.Literal('completed'),
	Type.Literal('cancelled'),
]);
export type SessionTodoStatus = Static<typeof SessionTodoStatusSchema>;

const SessionTodoItemSchema = Type.Object({
	id: Type.String(),
	content: Type.String(),
	status: SessionTodoStatusSchema,
	priority: Type.String(),
});
export type SessionTodoItemSchemaType = Static<typeof SessionTodoItemSchema>;

const SessionPermissionRequestSchema = Type.Object({
	id: Type.String(),
	sessionID: Type.String(),
	permission: Type.String(),
	patterns: Type.Array(Type.String()),
	metadata: UnknownRecordSchema,
	always: Type.Array(Type.String()),
	tool: Type.Optional(QuestionToolRefSchema),
});
export type SessionPermissionRequestSchemaType = Static<typeof SessionPermissionRequestSchema>;

const SessionQuestionRequestSchema = Type.Object({
	id: Type.String(),
	sessionID: Type.String(),
	questions: Type.Array(QuestionInfoSchema),
	tool: Type.Optional(QuestionToolRefSchema),
});
export type SessionQuestionRequestSchemaType = Static<typeof SessionQuestionRequestSchema>;

const PermissionRuntimePayloadSchema = Type.Object({
	id: Type.Optional(Type.String()),
	requestId: Type.Optional(Type.String()),
	sessionID: Type.Optional(Type.String()),
	permission: Type.Optional(Type.String()),
	patterns: Type.Optional(Type.Array(Type.String())),
	metadata: Type.Optional(UnknownRecordSchema),
	toolInput: Type.Optional(UnknownRecordSchema),
	input: Type.Optional(UnknownRecordSchema),
	always: Type.Optional(Type.Array(Type.String())),
	toolUseId: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	tool: Type.Optional(Type.Union([Type.String(), QuestionToolRefSchema])),
});
export type PermissionRuntimePayload = Static<typeof PermissionRuntimePayloadSchema>;

const QuestionRuntimePayloadSchema = Type.Object({
	id: Type.Optional(Type.String()),
	requestId: Type.Optional(Type.String()),
	sessionID: Type.Optional(Type.String()),
	questions: Type.Array(QuestionInfoSchema),
	tool: Type.Optional(QuestionToolRefSchema),
});
export type QuestionRuntimePayload = Static<typeof QuestionRuntimePayloadSchema>;

const SessionUpdatedRuntimePayloadSchema = Type.Object({
	sessionId: Type.Optional(Type.String()),
	modelID: Type.Optional(Type.String()),
	providerID: Type.Optional(Type.String()),
	status: Type.Optional(
		Type.Object({
			type: Type.Optional(Type.String()),
			attempt: Type.Optional(Type.Number()),
			message: Type.Optional(Type.String()),
			next: Type.Optional(Type.Number()),
		}),
	),
});
export type SessionUpdatedRuntimePayload = Static<typeof SessionUpdatedRuntimePayloadSchema>;

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getStringProp(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === 'string' ? value : undefined;
}

function isSessionTodoStatus(value: string): value is SessionTodoStatus {
	return Value.Check(SessionTodoStatusSchema, value);
}

export function parseSessionTodoItem(value: unknown): SessionTodoItemSchemaType | undefined {
	const record = asObjectRecord(value);
	const id = record ? getStringProp(record, 'id') : undefined;
	const content = record ? getStringProp(record, 'content') : undefined;
	const status = record ? getStringProp(record, 'status') : undefined;
	const priority = record ? getStringProp(record, 'priority') : undefined;
	if (!id || !content || !status || !priority) return undefined;
	const parsed = {
		id,
		content,
		status: isSessionTodoStatus(status) ? status : 'pending',
		priority,
	};
	return Value.Check(SessionTodoItemSchema, parsed) ? parsed : undefined;
}

export function parseSessionPermissionRequest(
	value: unknown,
	expectedSessionId?: string,
): SessionPermissionRequestSchemaType | undefined {
	if (!Value.Check(SessionPermissionRequestSchema, value)) return undefined;
	if (expectedSessionId && value.sessionID !== expectedSessionId) return undefined;
	return value;
}

export function parseSessionQuestionRequest(
	value: unknown,
	expectedSessionId?: string,
): SessionQuestionRequestSchemaType | undefined {
	if (!Value.Check(SessionQuestionRequestSchema, value)) return undefined;
	if (expectedSessionId && value.sessionID !== expectedSessionId) return undefined;
	return value;
}

export function mapQuestionRuntimePayloadToRequest(
	value: unknown,
	sessionId: string,
	fallbackToolUseId?: string,
): SessionQuestionRequestSchemaType | undefined {
	const raw = Value.Cast(QuestionRuntimePayloadSchema, asObjectRecord(value) ?? {});
	const requestId = raw.requestId ?? raw.id;
	if (!requestId) return undefined;
	const request = {
		id: requestId,
		sessionID: sessionId,
		questions: raw.questions,
		tool:
			raw.tool ??
			(fallbackToolUseId
				? {
						messageID: requestId,
						callID: fallbackToolUseId,
					}
				: undefined),
	};
	return Value.Check(SessionQuestionRequestSchema, request) ? request : undefined;
}

// =============================================================================
// Access Types
// =============================================================================

const AccessSchema = Type.Object({
	toolName: Type.String(),
	commands: Type.Optional(Type.Array(Type.String())),
	allowAll: Type.Optional(Type.Boolean()),
});
export type Access = Static<typeof AccessSchema>;

// =============================================================================
// Workspace & Files
// =============================================================================

const WorkspaceFileSchema = Type.Object({
	name: Type.String(),
	path: Type.String(),
	fsPath: Type.String(),
});
export type WorkspaceFile = Static<typeof WorkspaceFileSchema>;

// =============================================================================
// Conversation History
// =============================================================================

const ConversationMessageSchema = Type.Union([
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('user'),
		content: Type.String(),
		model: Type.Optional(Type.String()),
		agent: Type.Optional(Type.String()),
		summary: Type.Optional(
			Type.Object({
				title: Type.Optional(Type.String()),
				diffs: Type.Optional(
					Type.Array(
						Type.Object({
							file: Type.String(),
							additions: Type.Number(),
							deletions: Type.Number(),
							status: Type.Optional(
								Type.Union([
									Type.Literal('added'),
									Type.Literal('deleted'),
									Type.Literal('modified'),
								]),
							),
						}),
					),
				),
			}),
		),
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
		/** The agent that produced this response (e.g. 'build', 'plan'). */
		agent: Type.Optional(Type.String()),
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
		childSessionId: Type.Optional(Type.String()),
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
		startTime: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
		childTokens: Type.Optional(
			Type.Object({
				input: Type.Number(),
				output: Type.Number(),
				total: Type.Number(),
				cacheRead: Type.Optional(Type.Number()),
				durationMs: Type.Optional(Type.Number()),
			}),
		),
		childModelId: Type.Optional(Type.String()),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('system_notice'),
		content: Type.String(),
	}),
	Type.Object({
		id: Type.Optional(Type.String()),
		timestamp: Type.String(),
		type: Type.Literal('question'),
		requestId: Type.String(),
		questions: Type.Array(QuestionInfoSchema),
		tool: Type.Optional(QuestionToolRefSchema),
		toolUseId: Type.Optional(Type.String()),
		childSessionId: Type.Optional(Type.String()),
		resolved: Type.Optional(Type.Boolean()),
		answers: Type.Optional(Type.Array(Type.Array(Type.String()))),
	}),
]);

export type ConversationMessage = Static<typeof ConversationMessageSchema>;

const ConversationIndexEntrySchema = Type.Object({
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

const PlatformInfoSchema = Type.Object({
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
	/** Thinking effort variant names available for this model (e.g. ['low','medium','high']). */
	variants: Type.Optional(Type.Array(Type.String())),
});

const OpenCodeProviderDataSchema = Type.Object({
	id: Type.String(),
	name: Type.String(),
	npm: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	source: Type.Optional(
		Type.Union([
			Type.Literal('env'),
			Type.Literal('api'),
			Type.Literal('config'),
			Type.Literal('custom'),
		]),
	),
	env: Type.Optional(Type.Array(Type.String())),
	models: Type.Array(OpenCodeModelDataSchema),
});
export type OpenCodeProviderData = Static<typeof OpenCodeProviderDataSchema>;

// =============================================================================
// Rules
// =============================================================================

const RuleSchema = Type.Object({
	name: Type.String(),
	path: Type.String(),
	source: Type.Union([Type.Literal('opencode')]),
	content: Type.Optional(Type.String()),
	isReadOnly: Type.Optional(Type.Boolean()),
});
export type Rule = Static<typeof RuleSchema>;

// =============================================================================
// Agents / Commands / Skills (OpenCode canonical formats)
// =============================================================================

/**
 * ParsedCommand — matches OpenCode Command schema.
 * OpenCode uses 'template' field, but we support 'prompt' as alias for backward compat.
 */
const ParsedCommandSchema = Type.Object({
	name: Type.String(),
	description: Type.Optional(Type.String()),
	template: Type.String(),
	agent: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	subtask: Type.Optional(Type.Boolean()),
	path: Type.String(),
});
export type ParsedCommand = Static<typeof ParsedCommandSchema>;

const ParsedSkillSchema = Type.Object({
	name: Type.String(),
	description: Type.String(),
	content: Type.String(),
	version: Type.Optional(Type.String()),
	path: Type.String(),
	policy: Type.Optional(
		Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('deny')]),
	),
	policySource: Type.Optional(Type.Union([Type.Literal('exact'), Type.Literal('wildcard')])),
	policyPattern: Type.Optional(Type.String()),
});
export type ParsedSkill = Static<typeof ParsedSkillSchema>;

/**
 * ParsedSubagent — matches OpenCode Agent schema from config.ts.
 * Supports all OpenCode Agent fields: model, mode, permission, color, steps, temperature, tools, etc.
 */
const PermissionLevel = Type.Union([
	Type.Literal('ask'),
	Type.Literal('allow'),
	Type.Literal('deny'),
]);
const ParsedSubagentSchema = Type.Object({
	name: Type.String(),
	prompt: Type.String(),
	path: Type.String(),
	description: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	variant: Type.Optional(Type.String()),
	temperature: Type.Optional(Type.Number()),
	topP: Type.Optional(Type.Number()),
	mode: Type.Optional(
		Type.Union([Type.Literal('subagent'), Type.Literal('primary'), Type.Literal('all')]),
	),
	disable: Type.Optional(Type.Boolean()),
	hidden: Type.Optional(Type.Boolean()),
	color: Type.Optional(Type.String()),
	steps: Type.Optional(Type.Number()),
	tools: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
	permission: Type.Optional(
		Type.Object({
			edit: Type.Optional(PermissionLevel),
			bash: Type.Optional(
				Type.Union([PermissionLevel, Type.Record(Type.String(), PermissionLevel)]),
			),
			webfetch: Type.Optional(PermissionLevel),
			doom_loop: Type.Optional(PermissionLevel),
			external_directory: Type.Optional(PermissionLevel),
		}),
	),
	options: Type.Optional(Type.Record(Type.String(), Type.Any())),
});
export type ParsedSubagent = Static<typeof ParsedSubagentSchema>;

// =============================================================================
// Discovery Status
// =============================================================================

const DiscoveryStatusSchema = Type.Object({
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
