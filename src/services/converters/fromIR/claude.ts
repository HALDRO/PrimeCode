/**
 * @file Claude API Request/Response Generator
 * @description Converts unified IR format to Claude Messages API format.
 * Based on CLIProxyAPI from_ir/claude.go
 */

import type {
	Message,
	ThinkingConfig,
	ToolCall,
	ToolDefinition,
	UnifiedChatRequest,
	UnifiedEvent,
	Usage,
} from '../ir/types';
import {
	CLAUDE_BLOCK_IMAGE,
	CLAUDE_BLOCK_TEXT,
	CLAUDE_BLOCK_THINKING,
	CLAUDE_BLOCK_TOOL_RESULT,
	CLAUDE_BLOCK_TOOL_USE,
	CLAUDE_DEFAULT_MAX_TOKENS,
	CLAUDE_ROLE_ASSISTANT,
	CLAUDE_ROLE_USER,
	CLAUDE_SSE_CONTENT_BLOCK_DELTA,
	CLAUDE_SSE_CONTENT_BLOCK_START,
	CLAUDE_SSE_CONTENT_BLOCK_STOP,
	CLAUDE_SSE_ERROR,
	CLAUDE_SSE_MESSAGE_DELTA,
	CLAUDE_SSE_MESSAGE_START,
	CLAUDE_SSE_MESSAGE_STOP,
	CLAUDE_STOP_END_TURN,
	CLAUDE_STOP_TOOL_USE,
	cleanJsonSchemaForClaude,
	combineReasoningParts,
	combineTextParts,
	parseToolCallArgs,
} from '../ir/types';

// =============================================================================
// Request Conversion
// =============================================================================

/**
 * Convert unified IR request to Claude Messages API JSON
 */
export function toClaudeRequest(req: UnifiedChatRequest): Record<string, unknown> {
	const result: Record<string, unknown> = {
		model: req.model,
		max_tokens: req.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS,
		messages: [],
	};

	// Generation parameters
	if (req.temperature !== undefined) result.temperature = req.temperature;
	if (req.topP !== undefined) result.top_p = req.topP;
	if (req.topK !== undefined) result.top_k = req.topK;
	if (req.stopSequences?.length) result.stop_sequences = req.stopSequences;

	// Thinking config
	if (req.thinking) {
		applyThinkingConfig(result, req.thinking);
	}

	// System message - extract from messages and put at root level
	const { systemText, nonSystemMessages } = extractSystemMessage(req.messages);
	if (systemText) {
		result.system = systemText;
	}

	// Convert messages
	result.messages = buildClaudeMessages(nonSystemMessages);

	// Tools
	if (req.tools?.length) {
		result.tools = buildClaudeTools(req.tools);
	}

	// Metadata
	if (req.metadata && Object.keys(req.metadata).length > 0) {
		result.metadata = req.metadata;
	}

	return result;
}

/**
 * Apply thinking config to request
 */
function applyThinkingConfig(result: Record<string, unknown>, thinking: ThinkingConfig): void {
	const t: Record<string, unknown> = {};

	if (thinking.includeThoughts && thinking.budget !== 0) {
		t.type = 'enabled';
		if (thinking.budget && thinking.budget > 0) {
			t.budget_tokens = thinking.budget;
		}
	} else if (thinking.budget === 0) {
		t.type = 'disabled';
	}

	if (Object.keys(t).length > 0) {
		result.thinking = t;
	}
}

/**
 * Extract system message text and return remaining messages
 */
function extractSystemMessage(messages: Message[]): {
	systemText: string;
	nonSystemMessages: Message[];
} {
	let systemText = '';
	const nonSystemMessages: Message[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			const text = combineTextParts(msg);
			if (text) {
				systemText += (systemText ? '\n' : '') + text;
			}
		} else {
			nonSystemMessages.push(msg);
		}
	}

	return { systemText, nonSystemMessages };
}

/**
 * Build Claude messages array
 */
function buildClaudeMessages(msgs: Message[]): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = [];

	for (const msg of msgs) {
		if (msg.role === 'user') {
			const parts = buildClaudeContentParts(msg, false);
			if (parts.length > 0) {
				messages.push({ role: CLAUDE_ROLE_USER, content: parts });
			}
		} else if (msg.role === 'assistant') {
			const parts = buildClaudeContentParts(msg, true);
			if (parts.length > 0) {
				messages.push({ role: CLAUDE_ROLE_ASSISTANT, content: parts });
			}
		} else if (msg.role === 'tool') {
			// Tool results go as user messages with tool_result blocks
			for (const part of msg.content) {
				if (part.type === 'tool_result' && part.toolResult) {
					messages.push({
						role: CLAUDE_ROLE_USER,
						content: [
							{
								type: CLAUDE_BLOCK_TOOL_RESULT,
								tool_use_id: part.toolResult.toolCallId,
								content: part.toolResult.result,
							},
						],
					});
				}
			}
		}
	}

	return messages;
}

/**
 * Build Claude content parts from IR message
 */
function buildClaudeContentParts(
	msg: Message,
	includeToolCalls: boolean,
): Record<string, unknown>[] {
	const parts: Record<string, unknown>[] = [];

	for (const p of msg.content) {
		switch (p.type) {
			case 'reasoning':
				if (p.reasoning) {
					const thinkingBlock: Record<string, unknown> = {
						type: CLAUDE_BLOCK_THINKING,
						thinking: p.reasoning,
					};
					if (p.thoughtSignature) {
						thinkingBlock.signature = p.thoughtSignature;
					}
					parts.push(thinkingBlock);
				}
				break;

			case 'text':
				if (p.text) {
					parts.push({ type: CLAUDE_BLOCK_TEXT, text: p.text });
				}
				break;

			case 'image':
				if (p.image) {
					// Claude API requires clean base64 without data URI prefix
					let imageData = p.image.data || '';
					if (imageData.includes(',')) {
						imageData = imageData.split(',')[1] || imageData;
					}
					parts.push({
						type: CLAUDE_BLOCK_IMAGE,
						source: {
							type: 'base64',
							media_type: p.image.mimeType,
							data: imageData,
						},
					});
				}
				break;

			case 'tool_result':
				if (p.toolResult) {
					parts.push({
						type: CLAUDE_BLOCK_TOOL_RESULT,
						tool_use_id: p.toolResult.toolCallId,
						content: p.toolResult.result,
					});
				}
				break;
		}
	}

	// Add tool calls for assistant messages
	if (includeToolCalls && msg.toolCalls) {
		for (const tc of msg.toolCalls) {
			parts.push({
				type: CLAUDE_BLOCK_TOOL_USE,
				id: tc.id,
				name: tc.name,
				input: parseToolCallArgs(tc.args),
			});
		}
	}

	return parts;
}

/**
 * Build Claude tools array
 */
function buildClaudeTools(tools: ToolDefinition[]): Record<string, unknown>[] {
	return tools.map(t => {
		const tool: Record<string, unknown> = {
			name: t.name,
			description: t.description,
		};

		if (t.parameters && Object.keys(t.parameters).length > 0) {
			tool.input_schema = cleanJsonSchemaForClaude({ ...t.parameters });
		} else {
			tool.input_schema = {
				type: 'object',
				properties: {},
				additionalProperties: false,
			};
		}

		return tool;
	});
}

// =============================================================================
// Response Conversion
// =============================================================================

/**
 * Convert IR messages to Claude non-streaming response
 */
export function toClaudeResponse(
	messages: Message[],
	usage: Usage | undefined,
	model: string,
	messageId: string,
): Record<string, unknown> {
	const response: Record<string, unknown> = {
		id: messageId,
		type: 'message',
		role: CLAUDE_ROLE_ASSISTANT,
		model,
		stop_reason: CLAUDE_STOP_END_TURN,
		content: [],
	};

	const contentParts: Record<string, unknown>[] = [];
	let hasToolCalls = false;

	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;

		// Reasoning/thinking
		const reasoning = combineReasoningParts(msg);
		if (reasoning) {
			contentParts.push({ type: CLAUDE_BLOCK_THINKING, thinking: reasoning });
		}

		// Text
		const text = combineTextParts(msg);
		if (text) {
			contentParts.push({ type: CLAUDE_BLOCK_TEXT, text });
		}

		// Tool calls
		if (msg.toolCalls?.length) {
			hasToolCalls = true;
			for (const tc of msg.toolCalls) {
				contentParts.push({
					type: CLAUDE_BLOCK_TOOL_USE,
					id: tc.id,
					name: tc.name,
					input: parseToolCallArgs(tc.args),
				});
			}
		}
	}

	response.content = contentParts;

	if (hasToolCalls) {
		response.stop_reason = CLAUDE_STOP_TOOL_USE;
	}

	if (usage) {
		response.usage = {
			input_tokens: usage.promptTokens,
			output_tokens: usage.completionTokens,
		};
	}

	return response;
}

// =============================================================================
// Streaming Conversion
// =============================================================================

/**
 * State for Claude streaming conversion
 */
export interface ClaudeStreamState {
	messageId: string;
	model: string;
	messageStartSent: boolean;
	textBlockIndex: number;
	textBlockStarted: boolean;
	textBlockStopped: boolean;
	toolBlockCount: number;
	currentToolBlockIndex: number;
	hasToolCalls: boolean;
	hasContent: boolean;
	finishSent: boolean;
	/** Track active tool calls by their OpenAI index -> Claude block index */
	activeToolCalls: Map<number, { blockIndex: number; id: string; name: string }>;
	/** Current active block index (null if no block is open) */
	activeBlockIndex: number | null;
	/** Current active block type ('text', 'thinking', 'tool_use', or null) */
	activeBlockType: 'text' | 'thinking' | 'tool_use' | null;
	/** Next block index to use */
	nextBlockIndex: number;
}

/**
 * Create new Claude stream state
 */
export function createClaudeStreamState(): ClaudeStreamState {
	return {
		messageId: '',
		model: '',
		messageStartSent: false,
		textBlockIndex: 0,
		textBlockStarted: false,
		textBlockStopped: false,
		toolBlockCount: 0,
		currentToolBlockIndex: 0,
		hasToolCalls: false,
		hasContent: false,
		finishSent: false,
		activeToolCalls: new Map(),
		activeBlockIndex: null,
		activeBlockType: null,
		nextBlockIndex: 0,
	};
}

/**
 * Convert IR event to Claude SSE streaming format
 */
export function toClaudeSSE(
	event: UnifiedEvent,
	model: string,
	messageId: string,
	state: ClaudeStreamState,
): string {
	let result = '';

	// Send message_start if not sent yet
	if (!state.messageStartSent) {
		state.messageStartSent = true;
		state.model = model;
		state.messageId = messageId;

		result += formatSSE(CLAUDE_SSE_MESSAGE_START, {
			type: CLAUDE_SSE_MESSAGE_START,
			message: {
				id: messageId,
				type: 'message',
				role: CLAUDE_ROLE_ASSISTANT,
				content: [],
				model,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	switch (event.type) {
		case 'token':
			result += emitTextDelta(event.content || '', state);
			break;

		case 'reasoning':
			if (event.reasoning) {
				result += emitThinkingDelta(event.reasoning, state);
			}
			if (event.thoughtSignature) {
				result += emitSignatureDelta(event.thoughtSignature, state);
			}
			break;

		case 'tool_call':
			if (event.toolCall) {
				result += emitToolCall(event.toolCall, state, event.toolCallIndex);
			}
			break;

		case 'tool_call_delta':
			if (event.toolCall) {
				result += emitToolCallDelta(event.toolCall, state, event.toolCallIndex);
			}
			break;

		case 'finish':
			if (!state.finishSent) {
				state.finishSent = true;
				result += emitFinish(event.usage, state);
			}
			break;

		case 'error':
			result += formatSSE(CLAUDE_SSE_ERROR, {
				type: CLAUDE_SSE_ERROR,
				error: {
					type: 'api_error',
					message: event.error?.message || 'Unknown error',
				},
			});
			break;
	}

	return result;
}

/**
 * Format SSE event
 */
function formatSSE(eventType: string, data: Record<string, unknown>): string {
	return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Emit text delta
 */
function emitTextDelta(text: string, state: ClaudeStreamState): string {
	let result = '';

	// If we were doing something else (or nothing), start a new text block
	if (state.activeBlockType !== 'text') {
		// Close previous block if needed (though usually implied by new block start, explicit stop is cleaner)
		if (state.activeBlockIndex !== null) {
			result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
				type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
				index: state.activeBlockIndex,
			});
		}

		state.activeBlockIndex = state.nextBlockIndex++;
		state.activeBlockType = 'text';

		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_START, {
			type: CLAUDE_SSE_CONTENT_BLOCK_START,
			index: state.activeBlockIndex,
			content_block: { type: CLAUDE_BLOCK_TEXT, text: '' },
		});
	}

	state.hasContent = true;

	const activeIndex = state.activeBlockIndex;
	if (activeIndex === null) {
		return '';
	}

	result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
		type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
		index: activeIndex,
		delta: { type: 'text_delta', text },
	});

	return result;
}

/**
 * Emit thinking delta
 */
function emitThinkingDelta(thinking: string, state: ClaudeStreamState): string {
	let result = '';

	// If we were doing something else, start a new thinking block
	if (state.activeBlockType !== 'thinking') {
		if (state.activeBlockIndex !== null) {
			result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
				type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
				index: state.activeBlockIndex,
			});
		}

		state.activeBlockIndex = state.nextBlockIndex++;
		state.activeBlockType = 'thinking';

		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_START, {
			type: CLAUDE_SSE_CONTENT_BLOCK_START,
			index: state.activeBlockIndex,
			content_block: { type: CLAUDE_BLOCK_THINKING, thinking: '' },
		});
	}

	state.hasContent = true;

	const activeIndex = state.activeBlockIndex;
	if (activeIndex === null) {
		return '';
	}

	result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
		type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
		index: activeIndex,
		delta: { type: 'thinking_delta', thinking },
	});

	return result;
}

/**
 * Emit signature delta
 */
function emitSignatureDelta(signature: string, state: ClaudeStreamState): string {
	let result = '';

	// Ensure we are in a thinking block (signature belongs to thinking)
	if (state.activeBlockType !== 'thinking') {
		// If we aren't in thinking, we probably can't just attach signature,
		// but let's try to start one or use current if it's text (fallback)
		// For now, assume it follows thinking logic
		if (state.activeBlockIndex !== null) {
			result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
				type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
				index: state.activeBlockIndex,
			});
		}

		state.activeBlockIndex = state.nextBlockIndex++;
		state.activeBlockType = 'thinking';

		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_START, {
			type: CLAUDE_SSE_CONTENT_BLOCK_START,
			index: state.activeBlockIndex,
			content_block: { type: CLAUDE_BLOCK_THINKING, thinking: '' },
		});
	}

	state.hasContent = true;

	const activeIndex = state.activeBlockIndex;
	if (activeIndex === null) {
		return '';
	}

	result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
		type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
		index: activeIndex,
		delta: { type: 'signature_delta', signature },
	});

	return result;
}

/**
 * Emit tool call
 * Handles both initial tool_call events and streaming deltas from OpenAI
 */
function emitToolCall(tc: ToolCall, state: ClaudeStreamState, toolCallIndex?: number): string {
	let result = '';
	const tcIndex = toolCallIndex ?? 0;

	// Check if this tool call already exists (streaming delta case)
	const existingTool = state.activeToolCalls.get(tcIndex);

	if (existingTool) {
		// This is a delta for an existing tool call - just emit the args delta
		if (tc.args) {
			result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
				type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
				index: existingTool.blockIndex,
				delta: { type: 'input_json_delta', partial_json: tc.args },
			});
		}
		return result;
	}

	// This is a new tool call - need to start a new block

	// Close previous block if open
	if (state.activeBlockIndex !== null) {
		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
			type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
			index: state.activeBlockIndex,
		});
	}

	state.hasContent = true;
	state.hasToolCalls = true;

	const idx = state.nextBlockIndex++;
	state.activeBlockIndex = idx;
	state.activeBlockType = 'tool_use';

	// Track this tool call
	state.activeToolCalls.set(tcIndex, {
		blockIndex: idx,
		id: tc.id || `tool_${tcIndex}`,
		name: tc.name || '',
	});

	// Start tool use block
	result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_START, {
		type: CLAUDE_SSE_CONTENT_BLOCK_START,
		index: idx,
		content_block: {
			type: CLAUDE_BLOCK_TOOL_USE,
			id: tc.id || `tool_${tcIndex}`,
			name: tc.name || '',
			input: {},
		},
	});

	// Emit args if present
	if (tc.args) {
		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
			type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
			index: idx,
			delta: { type: 'input_json_delta', partial_json: tc.args },
		});
	}

	return result;
}

/**
 * Emit tool call delta (streaming args)
 */
function emitToolCallDelta(tc: ToolCall, state: ClaudeStreamState, toolCallIndex?: number): string {
	const tcIndex = toolCallIndex ?? 0;

	// Try to find the tool call by index
	const existingTool = state.activeToolCalls.get(tcIndex);

	// If we can't find the tool, we can't emit a delta for it.
	// This usually shouldn't happen if emitToolCall was called first.
	if (!existingTool) {
		return '';
	}

	const idx = existingTool.blockIndex;
	let result = '';

	if (tc.args) {
		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_DELTA, {
			type: CLAUDE_SSE_CONTENT_BLOCK_DELTA,
			index: idx,
			delta: { type: 'input_json_delta', partial_json: tc.args },
		});
	}

	if (tc.isComplete) {
		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
			type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
			index: idx,
		});
		state.activeToolCalls.delete(tcIndex);

		// If this was the active block, mark it as closed/unknown so next text starts fresh
		if (state.activeBlockIndex === idx) {
			state.activeBlockIndex = null;
			state.activeBlockType = null;
		}
	}

	return result;
}

/**
 * Emit finish events
 */
function emitFinish(usage: Usage | undefined, state: ClaudeStreamState): string {
	if (!state.hasContent) {
		return '';
	}

	let result = '';

	// Close any active block
	if (state.activeBlockIndex !== null) {
		result += formatSSE(CLAUDE_SSE_CONTENT_BLOCK_STOP, {
			type: CLAUDE_SSE_CONTENT_BLOCK_STOP,
			index: state.activeBlockIndex,
		});
		state.activeBlockIndex = null;
	}

	// Use hasToolCalls flag instead of activeToolCalls.size because tool calls may have been closed
	const stopReason = state.hasToolCalls ? CLAUDE_STOP_TOOL_USE : CLAUDE_STOP_END_TURN;

	const delta: Record<string, unknown> = {
		type: CLAUDE_SSE_MESSAGE_DELTA,
		delta: { stop_reason: stopReason },
	};

	if (usage) {
		delta.usage = {
			input_tokens: usage.promptTokens,
			output_tokens: usage.completionTokens,
		};
	}

	result += formatSSE(CLAUDE_SSE_MESSAGE_DELTA, delta);
	result += formatSSE(CLAUDE_SSE_MESSAGE_STOP, { type: CLAUDE_SSE_MESSAGE_STOP });

	return result;
}
