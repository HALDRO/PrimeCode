/**
 * @file Claude CLI Types
 * @description Internal type definitions for Claude CLI integration.
 * Includes support for extended reasoning fields (thinking, chain-of-thought).
 * Aligned with Claude Code SDK types from agentSdkTypes.d.ts.
 * Extracted from ClaudeProcessService.ts.
 */

import type { TokenUsageAPI } from '../../../types';
import type { ModelUsage, PermissionDenial } from '../../ICLIService';

// Re-export for convenience
export type { ModelUsage, PermissionDenial };

// =============================================================================
// Content Block Types
// =============================================================================

/** Content block in Claude CLI message */
export interface JsonContentBlock {
	type: string;
	text?: string;
	/** Thinking/reasoning content (Anthropic extended thinking) */
	thinking?: string;
	/** Tool name for tool_use blocks */
	name?: string;
	/** Block ID */
	id?: string;
	/** Tool input parameters */
	input?: {
		file_path?: string;
		todos?: unknown[];
		[key: string]: unknown;
	};
	/** Tool result content */
	content?: string | unknown;
	/** Whether tool execution resulted in error */
	is_error?: boolean;
	/** Reference to tool_use block ID */
	tool_use_id?: string;
	// Extended reasoning fields (Azure OpenAI, Copilot API, o1/o3 models)
	/** Reasoning text content */
	reasoning_text?: string;
	/** Opaque reasoning token (for models that don't expose reasoning) */
	reasoning_opaque?: string;
	/** Chain-of-thought ID */
	cot_id?: string;
	/** Chain-of-thought summary */
	cot_summary?: string;
	/** Cryptographic signature for reasoning verification */
	signature?: string;
}

// =============================================================================
// Stream Event Types
// =============================================================================

/** Stream event delta for partial updates */
export interface JsonStreamDelta {
	type: string;
	text?: string;
	thinking?: string;
	partial_json?: string;
	// Extended reasoning in deltas
	reasoning_text?: string;
}

/** Stream event content block */
export interface JsonStreamContentBlock {
	type: string;
	id?: string;
	name?: string;
	text?: string;
	thinking?: string;
}

/** Stream event structure */
export interface JsonStreamEvent {
	uuid: string;
	session_id?: string;
	event: {
		type: string;
		index?: number;
		delta?: JsonStreamDelta;
		content_block?: JsonStreamContentBlock;
	};
	parent_tool_use_id?: string;
}

// =============================================================================
// Main Stream Data Types
// =============================================================================

/** Main JSON stream data from Claude CLI */
export interface JsonStreamData {
	type: string;
	subtype?: string;
	session_id?: string;
	tools?: unknown[];
	mcp_servers?: unknown[];
	message?: {
		content: JsonContentBlock[];
		usage?: TokenUsageAPI;
	};
	is_error?: boolean;
	result?: string;
	total_cost_usd?: number;
	duration_ms?: number;
	/** API call duration in milliseconds */
	duration_api_ms?: number;
	num_turns?: number;
	content?: string | unknown;
	/** Token usage statistics */
	usage?: TokenUsageAPI;
	/** Per-model usage breakdown */
	modelUsage?: Record<string, ModelUsage>;
	/** Permission denials during execution */
	permission_denials?: PermissionDenial[];
	/** Structured output (when using JSON schema output format) */
	structured_output?: unknown;
	/** Error messages (for error result subtypes) */
	errors?: string[];

	// Stream event fields (when type === 'stream_event')
	uuid?: string;
	event?: JsonStreamEvent['event'];
	parent_tool_use_id?: string;

	// Compact boundary fields (when type === 'system' && subtype === 'compact_boundary')
	compact_metadata?: {
		trigger: 'manual' | 'auto';
		pre_tokens: number;
	};

	// Status fields (when type === 'system' && subtype === 'status')
	status?: 'compacting' | null;

	// Hook response fields (when type === 'system' && subtype === 'hook_response')
	hook_name?: string;
	hook_event?: string;
	stdout?: string;
	stderr?: string;
	exit_code?: number;

	// Tool progress fields (when type === 'tool_progress')
	tool_use_id?: string;
	tool_name?: string;
	elapsed_time_seconds?: number;

	// Auth status fields (when type === 'auth_status')
	isAuthenticating?: boolean;
	output?: string[];
	error?: string;
}
