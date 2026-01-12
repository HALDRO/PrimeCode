/**
 * @file Unified Intermediate Representation Types
 * @description Types for converting between Claude and OpenAI API formats.
 * Based on CLIProxyAPI Canonical IR architecture.
 */

// =============================================================================
// Constants
// =============================================================================

export const CLAUDE_DEFAULT_MAX_TOKENS = 8192;

export const CLAUDE_ROLE_USER = 'user';
export const CLAUDE_ROLE_ASSISTANT = 'assistant';

export const CLAUDE_BLOCK_TEXT = 'text';
export const CLAUDE_BLOCK_THINKING = 'thinking';
export const CLAUDE_BLOCK_IMAGE = 'image';
export const CLAUDE_BLOCK_TOOL_USE = 'tool_use';
export const CLAUDE_BLOCK_TOOL_RESULT = 'tool_result';

export const CLAUDE_STOP_END_TURN = 'end_turn';
export const CLAUDE_STOP_TOOL_USE = 'tool_use';

export const CLAUDE_SSE_MESSAGE_START = 'message_start';
export const CLAUDE_SSE_MESSAGE_DELTA = 'message_delta';
export const CLAUDE_SSE_MESSAGE_STOP = 'message_stop';
export const CLAUDE_SSE_CONTENT_BLOCK_START = 'content_block_start';
export const CLAUDE_SSE_CONTENT_BLOCK_DELTA = 'content_block_delta';
export const CLAUDE_SSE_CONTENT_BLOCK_STOP = 'content_block_stop';
export const CLAUDE_SSE_ERROR = 'error';

// =============================================================================
// Event Types
// =============================================================================

/** Type of event in the unified stream */
export type EventType =
	| 'token'
	| 'reasoning'
	| 'reasoning_summary'
	| 'tool_call'
	| 'tool_call_delta'
	| 'image'
	| 'finish'
	| 'error';

/** Why the model stopped generating */
export type FinishReason =
	| 'stop'
	| 'length'
	| 'tool_calls'
	| 'content_filter'
	| 'error'
	| 'unknown';

/** Role of the message sender */
export type Role = 'user' | 'assistant' | 'system' | 'tool';

/** Type of content part */
export type ContentType = 'text' | 'reasoning' | 'image' | 'file' | 'tool_result';

// =============================================================================
// Usage & Metadata
// =============================================================================

/** Token usage statistics */
export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Reasoning/thinking token count */
	thoughtsTokenCount?: number;
	/** Cached input tokens */
	cachedTokens?: number;
	/** Audio input tokens */
	audioTokens?: number;
	/** Accepted prediction tokens */
	acceptedPredictionTokens?: number;
	/** Rejected prediction tokens */
	rejectedPredictionTokens?: number;
}

/** Metadata from upstream response */
export interface ResponseMeta {
	responseId?: string;
	nativeFinishReason?: string;
	createTime?: number;
}

// =============================================================================
// Content Parts
// =============================================================================

/** Image content part */
export interface ImagePart {
	mimeType: string;
	/** Base64 encoded data */
	data?: string;
	/** URL for remote images */
	url?: string;
}

/** File input (PDF, etc.) */
export interface FilePart {
	fileId?: string;
	fileUrl?: string;
	filename?: string;
	/** Base64 encoded data */
	fileData?: string;
}

/** Tool execution result */
export interface ToolResultPart {
	toolCallId: string;
	toolName?: string;
	result: string;
	images?: ImagePart[];
	files?: FilePart[];
}

/** A discrete part of a message */
export interface ContentPart {
	type: ContentType;
	/** Populated if type === 'text' */
	text?: string;
	/** Populated if type === 'reasoning' */
	reasoning?: string;
	/** Thought signature (for verification) */
	thoughtSignature?: string;
	/** Populated if type === 'image' */
	image?: ImagePart;
	/** Populated if type === 'file' */
	file?: FilePart;
	/** Populated if type === 'tool_result' */
	toolResult?: ToolResultPart;
}

// =============================================================================
// Tool Calls & Definitions
// =============================================================================

/** Request from model to execute a tool */
export interface ToolCall {
	id: string;
	/** Internal item_id (used for mapping in streaming) */
	itemId?: string;
	name: string;
	/** JSON string of arguments (or raw text for custom tools) */
	args: string;
	/** Raw partial arguments */
	partialArgs?: string;
	/** Thought signature for this tool call */
	thoughtSignature?: string;
	/** True for custom tools (e.g., apply_patch) */
	isCustom?: boolean;
	/** True when tool call streaming is complete */
	isComplete?: boolean;
}

/** Tool capability exposed to the model */
export interface ToolDefinition {
	name: string;
	description: string;
	/** JSON Schema object */
	parameters?: Record<string, unknown>;
	/** Grammar format for custom tools */
	format?: Record<string, unknown>;
	/** True for custom/freeform tools */
	isCustom?: boolean;
}

// =============================================================================
// Messages
// =============================================================================

/** A single message in the conversation history */
export interface Message {
	role: Role;
	content: ContentPart[];
	/** Populated if role === 'assistant' and there are tool calls */
	toolCalls?: ToolCall[];
}

// =============================================================================
// Configuration
// =============================================================================

/** Controls reasoning capabilities */
export interface ThinkingConfig {
	/** Reasoning summary mode: "auto", "concise", "detailed" */
	summary?: string;
	/** Reasoning effort: "none", "low", "medium", "high" */
	effort?: string;
	/** Token budget for thinking (-1 for auto, 0 for disabled) */
	budget?: number;
	includeThoughts?: boolean;
}

/** Controls function calling behavior */
export interface FunctionCallingConfig {
	/** "AUTO", "ANY", "NONE" */
	mode?: string;
	allowedFunctionNames?: string[];
	streamFunctionCallArguments?: boolean;
}

/** Content safety filtering */
export interface SafetySetting {
	category: string;
	threshold: string;
}

/** Image generation parameters */
export interface ImageConfig {
	aspectRatio?: string;
	imageSize?: string;
}

// =============================================================================
// Unified Request
// =============================================================================

/** Unified chat request - the "Esperanto" request format */
export interface UnifiedChatRequest {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	temperature?: number;
	topP?: number;
	topK?: number;
	maxTokens?: number;
	stopSequences?: string[];
	thinking?: ThinkingConfig;
	safetySettings?: SafetySetting[];
	imageConfig?: ImageConfig;
	responseModality?: string[];
	metadata?: Record<string, unknown>;
	/** System instructions (Responses API) */
	instructions?: string;
	/** For conversation continuity */
	previousResponseId?: string;
	promptId?: string;
	promptVersion?: string;
	promptVariables?: Record<string, unknown>;
	promptCacheKey?: string;
	toolChoice?: string;
	responseSchema?: Record<string, unknown>;
	functionCalling?: FunctionCallingConfig;
	store?: boolean;
	parallelToolCalls?: boolean;
}

// =============================================================================
// Unified Event (Streaming)
// =============================================================================

/** A single event in the chat stream - the "Esperanto" response format */
export interface UnifiedEvent {
	type: EventType;
	/** For token events */
	content?: string;
	/** For reasoning events */
	reasoning?: string;
	/** For reasoning summary events */
	reasoningSummary?: string;
	/** Thought signature */
	thoughtSignature?: string;
	/** Refusal message */
	refusal?: string;
	/** System fingerprint */
	systemFingerprint?: string;
	/** For tool_call events */
	toolCall?: ToolCall;
	/** For image events */
	image?: ImagePart;
	/** Usage stats on finish */
	usage?: Usage;
	/** For error events */
	error?: Error;
	/** Log probabilities */
	logprobs?: unknown;
	/** Content filter results */
	contentFilter?: unknown;
	/** Index for tool call in parallel calls */
	toolCallIndex?: number;
	/** Why generation stopped */
	finishReason?: FinishReason;
}

// =============================================================================
// Utility Functions
// =============================================================================

/** Map standard role string to Role type */
export function mapStandardRole(role: string): Role {
	const normalized = role.toLowerCase();
	switch (normalized) {
		case 'user':
			return 'user';
		case 'assistant':
			return 'assistant';
		case 'system':
		case 'developer':
			return 'system';
		case 'tool':
		case 'function':
			return 'tool';
		default:
			return 'user';
	}
}

/** Map OpenAI finish reason to unified FinishReason */
export function mapOpenAIFinishReason(reason: string): FinishReason {
	switch (reason) {
		case 'stop':
			return 'stop';
		case 'length':
		case 'max_tokens':
			return 'length';
		case 'tool_calls':
		case 'function_call':
			return 'tool_calls';
		case 'content_filter':
			return 'content_filter';
		default:
			return 'unknown';
	}
}

/** Map unified FinishReason to OpenAI format */
export function mapFinishReasonToOpenAI(reason: FinishReason): string {
	switch (reason) {
		case 'stop':
		case 'error':
			return 'stop';
		case 'length':
			return 'length';
		case 'tool_calls':
			return 'tool_calls';
		case 'content_filter':
			return 'content_filter';
		default:
			return 'stop';
	}
}

/**
 * Map thinking budget to effort string
 * @param budget Token budget (-1 for auto, 0 for none)
 * @param defaultEffort Default effort if budget is auto
 */
export function mapBudgetToEffort(budget: number, defaultEffort = 'auto'): string {
	if (budget === 0) return 'none';
	if (budget < 0) return defaultEffort;
	if (budget <= 1024) return 'low';
	if (budget <= 8192) return 'medium';
	if (budget <= 24576) return 'high';
	return 'xhigh';
}

/**
 * Map effort string to budget
 * @returns Object containing numeric budget and includeThoughts flag
 */
export function mapEffortToBudget(effort: string): { budget: number; includeThoughts: boolean } {
	switch (effort.toLowerCase()) {
		case 'none':
			return { budget: 0, includeThoughts: false };
		case 'minimal':
			return { budget: 512, includeThoughts: true };
		case 'low':
			return { budget: 1024, includeThoughts: true };
		case 'medium':
			return { budget: 8192, includeThoughts: true };
		case 'high':
			return { budget: 24576, includeThoughts: true };
		case 'xhigh':
			return { budget: 32768, includeThoughts: true };
		default:
			return { budget: -1, includeThoughts: true };
	}
}

/** Combine text parts from a message */
export function combineTextParts(msg: Message): string {
	return msg.content.reduce((acc, p) => {
		if (p.type === 'text' && p.text) {
			return acc + p.text;
		}
		return acc;
	}, '');
}

/** Combine reasoning parts from a message */
export function combineReasoningParts(msg: Message): string {
	return msg.content.reduce((acc, p) => {
		if (p.type === 'reasoning' && p.reasoning) {
			return acc + p.reasoning;
		}
		return acc;
	}, '');
}

/** Get first reasoning signature from message */
export function getFirstReasoningSignature(msg: Message): string | undefined {
	return msg.content.find(p => p.type === 'reasoning' && p.thoughtSignature)?.thoughtSignature;
}

/** Parse tool call arguments (JSON string to object) */
export function parseToolCallArgs(args: string): Record<string, unknown> {
	if (!args || args === '{}') {
		return {};
	}
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

/** Clean JSON schema for Claude (remove unsupported fields) */
export function cleanJsonSchemaForClaude(schema: Record<string, unknown>): Record<string, unknown> {
	const cleaned = { ...schema };

	// Remove fields not supported by Claude
	delete cleaned.$schema;
	delete cleaned.$id;
	delete cleaned.$ref;
	delete cleaned.definitions;
	delete cleaned.$defs;

	// Recursively clean nested objects
	if (cleaned.properties && typeof cleaned.properties === 'object') {
		const props = cleaned.properties as Record<string, unknown>;
		for (const key of Object.keys(props)) {
			if (props[key] && typeof props[key] === 'object') {
				props[key] = cleanJsonSchemaForClaude(props[key] as Record<string, unknown>);
			}
		}
	}

	// Clean items in arrays
	if (cleaned.items && typeof cleaned.items === 'object') {
		cleaned.items = cleanJsonSchemaForClaude(cleaned.items as Record<string, unknown>);
	}

	return cleaned;
}

/** Clean JSON schema (general) */
export function cleanJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const cleaned = { ...schema };

	if (!cleaned.type) {
		cleaned.type = 'object';
	}

	if (cleaned.type === 'object' && !cleaned.properties) {
		cleaned.properties = {};
	}

	return cleaned;
}
