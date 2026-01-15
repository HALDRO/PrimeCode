import type { TokenUsageAPI } from '../../../types';
import { logger } from '../../../utils/logger';
import type { CLIStreamData } from '../../ICLIService';

/**
 * @file SDKEventAdapter.ts
 * @description Adapter that transforms Claude SDK messages to the unified CLIStreamData format.
 * strictly following the mapping rules from docs/SDK-MIGRATION-PLAN.md.
 */

// NOTE: This file intentionally avoids importing types from '@anthropic-ai/claude-agent-sdk'.
// The package is ESM-only; this repo currently compiles extension code as CommonJS and
// TypeScript will error even on type-only imports. We use local structural types instead.

type NonNullableUsage = {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
};

type SDKBaseMessage = {
	type: string;
	session_id: string;
};

type SDKSystemMessageInit = SDKBaseMessage & {
	type: 'system';
	subtype: 'init';
	tools: string[];
	mcp_servers?: { name: string }[];
};

type SDKStatusMessage = SDKBaseMessage & {
	type: 'system';
	subtype: 'status';
	status: 'compacting' | null;
};

type SDKCompactBoundaryMessage = SDKBaseMessage & {
	type: 'system';
	subtype: 'compact_boundary';
	compact_metadata: {
		trigger: 'manual' | 'auto';
		pre_tokens: number;
	};
};

type SDKHookResponseMessage = SDKBaseMessage & {
	type: 'system';
	subtype: 'hook_response';
	hook_name: string;
	hook_event: string;
	stdout: string;
	stderr: string;
	exit_code?: number;
};

type SDKSubagentStartMessage = SDKBaseMessage & {
	type: 'system';
	subtype: 'subagent_start';
	agent_name: string;
	agent_id?: string;
	prompt?: string;
	description?: string;
};

type SDKSubagentEndMessage = SDKBaseMessage & {
	type: 'system';
	subtype: 'subagent_end';
	agent_name: string;
	agent_id?: string;
	result?: string;
};

type SDKSystemMessage =
	| SDKSystemMessageInit
	| SDKStatusMessage
	| SDKCompactBoundaryMessage
	| SDKHookResponseMessage
	| SDKSubagentStartMessage
	| SDKSubagentEndMessage;

type SDKAssistantContentBlock = { type: string; id?: string } & Record<string, unknown>;

type SDKAssistantMessage = SDKBaseMessage & {
	type: 'assistant';
	message: {
		id: string;
		role?: 'assistant';
		content: SDKAssistantContentBlock[];
		usage?: NonNullableUsage;
	};
};

type SDKPartialAssistantMessage = SDKBaseMessage & {
	type: 'stream_event';
	uuid: string;
	event: {
		type: string;
		index?: number;
		delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
		content_block?: { type: string; id?: string; name?: string; text?: string };
	};
	parent_tool_use_id?: string | null;
};

type SDKToolProgressMessage = SDKBaseMessage & {
	type: 'tool_progress';
	tool_use_id: string;
	tool_name: string;
	parent_tool_use_id?: string | null;
	elapsed_time_seconds: number;
};

type SDKAuthStatusMessage = SDKBaseMessage & {
	type: 'auth_status';
	isAuthenticating: boolean;
	output?: string[];
	error?: string;
};

type SDKPermissionDenial = {
	tool_name: string;
	tool_use_id: string;
	tool_input: Record<string, unknown>;
};

type SDKResultMessage = SDKBaseMessage & {
	type: 'result';
	subtype: string;
	is_error: boolean;
	total_cost_usd?: number;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	usage?: NonNullableUsage;
	modelUsage?: Record<string, unknown>;
	permission_denials?: SDKPermissionDenial[];
	result?: string;
	structured_output?: unknown;
	errors?: string[];
};

type SDKUserMessage = SDKBaseMessage & {
	type: 'user';
	message: {
		role?: 'user';
		content: string | Record<string, unknown>[];
	};
};

type SDKMessageLike = SDKBaseMessage & Record<string, unknown>;
/**
 * Transform an SDK message to CLIStreamData.
 * Returns null if the message should be ignored (e.g. internal SDK events not needed for UI).
 */
export function transformSDKMessage(message: SDKMessageLike): CLIStreamData | null {
	const { type, session_id: sessionId } = message;

	switch (type) {
		case 'system':
			return handleSystemMessage(message as SDKSystemMessage, sessionId);

		case 'assistant':
			return handleAssistantMessage(message as SDKAssistantMessage, sessionId);

		case 'stream_event':
			return handleStreamEvent(message as SDKPartialAssistantMessage, sessionId);

		case 'tool_progress':
			return handleToolProgress(message as SDKToolProgressMessage, sessionId);

		case 'auth_status':
			return handleAuthStatus(message as SDKAuthStatusMessage, sessionId);

		case 'result':
			return handleResult(message as SDKResultMessage, sessionId);

		case 'user':
			// Usually we don't need to mirror user messages back to UI as they originate there,
			// but if needed for history sync, we can map them.
			// For now, per plan, we focus on system/assistant/result.
			return handleUserMessage(message as SDKUserMessage, sessionId);

		default:
			return null;
	}
}

function handleSystemMessage(
	message: SDKSystemMessage | SDKCompactBoundaryMessage | SDKStatusMessage,
	sessionId: string,
): CLIStreamData | null {
	const subtype = message.subtype;

	switch (subtype) {
		case 'init': {
			const msg = message as SDKSystemMessageInit;
			return {
				type: 'system',
				subtype: 'init',
				sessionId,
				tools: msg.tools,
				mcpServers: msg.mcp_servers?.map((s: { name: string }) => s.name),
			};
		}

		case 'status': {
			const msg = message as SDKStatusMessage;
			return {
				type: 'system',
				subtype: 'status',
				sessionId,
				status: msg.status,
			};
		}

		case 'compact_boundary': {
			const msg = message as SDKCompactBoundaryMessage;
			return {
				type: 'system',
				subtype: 'compact_boundary',
				sessionId,
				compactMetadata: {
					trigger: msg.compact_metadata.trigger,
					preTokens: msg.compact_metadata.pre_tokens,
				},
			};
		}

		case 'subagent_start': {
			const msg = message as SDKSubagentStartMessage;
			const agentId =
				msg.agent_id || `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			logger.debug(`[SDKEventAdapter] Subagent started: ${msg.agent_name} (${agentId})`);
			return {
				type: 'subtask',
				sessionId,
				subtask: {
					id: agentId,
					agent: msg.agent_name,
					prompt: msg.prompt || '',
					description: msg.description || msg.agent_name,
					messageID: '',
					status: 'running',
				},
			};
		}

		case 'subagent_end': {
			const msg = message as SDKSubagentEndMessage;
			logger.debug(`[SDKEventAdapter] Subagent ended: ${msg.agent_name} (${msg.agent_id})`);
			return {
				type: 'subtask',
				sessionId,
				subtask: {
					id: msg.agent_id || '',
					agent: msg.agent_name,
					prompt: '',
					description: '',
					messageID: '',
					status: 'completed',
					result: msg.result,
				},
			};
		}

		default:
			return null;
	}
}

function handleAssistantMessage(message: SDKAssistantMessage, sessionId: string): CLIStreamData {
	// Map content blocks
	const content = message.message.content.map((block: SDKAssistantContentBlock) => {
		const cliBlock = { ...block } as Record<string, unknown> & { tool_use_id?: string };

		if (block.type === 'tool_use' && typeof block.id === 'string') {
			cliBlock.tool_use_id = block.id;
		}

		return cliBlock;
	}) as unknown as NonNullable<CLIStreamData['message']>['content'];

	return {
		type: 'assistant',
		sessionId,
		message: {
			id: message.message.id,
			role: 'assistant',
			content,
			usage: mapUsage(message.message.usage as unknown as NonNullableUsage),
		},
	};
}

function handleStreamEvent(message: SDKPartialAssistantMessage, sessionId: string): CLIStreamData {
	return {
		type: 'stream_event',
		sessionId,
		streamEvent: {
			uuid: message.uuid, // UUID string
			event: message.event, // RawMessageStreamEvent
			parentToolUseId: message.parent_tool_use_id || undefined,
		},
		contextId: message.parent_tool_use_id || undefined,
	};
}

function handleToolProgress(message: SDKToolProgressMessage, sessionId: string): CLIStreamData {
	return {
		type: 'tool_progress',
		sessionId,
		toolProgress: {
			toolUseId: message.tool_use_id,
			toolName: message.tool_name,
			parentToolUseId: message.parent_tool_use_id || undefined,
			elapsedTimeSeconds: message.elapsed_time_seconds,
		},
		contextId: message.parent_tool_use_id || undefined,
	};
}

function handleAuthStatus(message: SDKAuthStatusMessage, sessionId: string): CLIStreamData {
	return {
		type: 'auth_status',
		sessionId,
		authStatus: {
			isAuthenticating: message.isAuthenticating,
			output: message.output ?? [],
			error: message.error,
		},
	};
}

function handleResult(message: SDKResultMessage, sessionId: string): CLIStreamData {
	const base: CLIStreamData = {
		type: 'result',
		subtype: message.subtype,
		sessionId,
		isError: message.is_error,
		totalCostUsd: message.total_cost_usd,
		durationMs: message.duration_ms,
		durationApiMs: message.duration_api_ms,
		numTurns: message.num_turns,
		usage: mapUsage(message.usage),
		modelUsage: message.modelUsage as unknown as CLIStreamData['modelUsage'],
		permissionDenials: message.permission_denials as SDKPermissionDenial[],
	};

	if (message.subtype === 'success') {
		base.result = message.result;
		base.structuredOutput = message.structured_output;
	} else {
		// Error subtypes
		if ('errors' in message) {
			base.errors = message.errors;
		}
	}

	return base;
}

function handleUserMessage(message: SDKUserMessage, sessionId: string): CLIStreamData {
	// Log tool results for debugging - user messages contain tool execution results
	const rawMessage = message as SDKUserMessage & { tool_use_result?: unknown };
	if (rawMessage.tool_use_result) {
		logger.debug('[SDKEventAdapter] Tool result in user message:', {
			sessionId,
			toolResult: JSON.stringify(rawMessage.tool_use_result).slice(0, 500),
		});
	}

	// Minimal mapping for user messages if they pass through
	return {
		type: 'user',
		sessionId,
		message: {
			role: 'user',
			content: Array.isArray(message.message.content)
				? (message.message.content as unknown as NonNullable<CLIStreamData['message']>['content'])
				: [
						{
							type: 'text',
							text: typeof message.message.content === 'string' ? message.message.content : '',
						},
					],
		},
	};
}

function mapUsage(usage: NonNullableUsage | undefined): TokenUsageAPI | undefined {
	if (!usage) return undefined;
	return {
		input_tokens: usage.input_tokens || 0,
		output_tokens: usage.output_tokens || 0,
		cache_read_input_tokens: usage.cache_read_input_tokens || 0,
		cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
	};
}
