/**
 * @file Claude API Request Parser
 * @description Converts Claude Messages API requests into unified IR format.
 * Based on CLIProxyAPI to_ir/claude.go
 */

import type { FinishReason, Message, UnifiedChatRequest, UnifiedEvent, Usage } from '../ir/types';
import {
	CLAUDE_SSE_CONTENT_BLOCK_DELTA,
	CLAUDE_SSE_CONTENT_BLOCK_START,
	CLAUDE_SSE_CONTENT_BLOCK_STOP,
	CLAUDE_SSE_ERROR,
	CLAUDE_SSE_MESSAGE_DELTA,
	CLAUDE_SSE_MESSAGE_START,
	CLAUDE_SSE_MESSAGE_STOP,
	cleanJsonSchema,
} from '../ir/types';

// =============================================================================
// Request Parsing
// =============================================================================

/**
 * Parse Claude Messages API request into unified IR format
 */
export function parseClaudeRequest(rawJSON: string | Record<string, unknown>): UnifiedChatRequest {
	const parsed = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;

	const req: UnifiedChatRequest = {
		model: parsed.model || '',
		messages: [],
	};

	// Generation parameters
	if (parsed.max_tokens !== undefined) req.maxTokens = parsed.max_tokens;
	if (parsed.temperature !== undefined) req.temperature = parsed.temperature;
	if (parsed.top_p !== undefined) req.topP = parsed.top_p;
	if (parsed.top_k !== undefined) req.topK = parsed.top_k;
	if (Array.isArray(parsed.stop_sequences)) req.stopSequences = parsed.stop_sequences;

	// System message
	if (parsed.system) {
		const systemText = parseSystemMessage(parsed.system);
		if (systemText) {
			req.messages.push({
				role: 'system',
				content: [{ type: 'text', text: systemText }],
			});
		}
	}

	// Messages
	if (Array.isArray(parsed.messages)) {
		for (const m of parsed.messages) {
			req.messages.push(parseClaudeMessage(m));
		}
	}

	// Tools
	if (Array.isArray(parsed.tools)) {
		req.tools = parsed.tools.map((t: Record<string, unknown>) => ({
			name: (t.name as string) || '',
			description: (t.description as string) || '',
			parameters:
				t.input_schema && typeof t.input_schema === 'object'
					? cleanJsonSchema(t.input_schema as Record<string, unknown>)
					: {},
		}));
	}

	// Thinking/Reasoning config
	if (parsed.thinking && typeof parsed.thinking === 'object') {
		const t = parsed.thinking as Record<string, unknown>;
		if (t.type === 'enabled') {
			req.thinking = {
				includeThoughts: true,
				budget: (t.budget_tokens as number) ?? -1,
			};
		} else if (t.type === 'disabled') {
			req.thinking = {
				includeThoughts: false,
				budget: 0,
			};
		}
	}

	// Metadata
	if (parsed.metadata && typeof parsed.metadata === 'object') {
		req.metadata = parsed.metadata as Record<string, unknown>;
	}

	return req;
}

function parseSystemMessage(system: unknown): string {
	if (typeof system === 'string') {
		return system;
	}
	if (Array.isArray(system)) {
		return system
			.filter(
				(part: Record<string, unknown>) => part.type === 'text' && typeof part.text === 'string',
			)
			.map((part: Record<string, unknown>) => part.text as string)
			.join('\n');
	}
	return '';
}

/**
 * Parse a single Claude message into IR Message format
 */
function parseClaudeMessage(m: Record<string, unknown>): Message {
	const roleStr = (m.role as string) || 'user';
	const role: 'user' | 'assistant' | 'tool' = roleStr === 'assistant' ? 'assistant' : 'user';

	const msg: Message = {
		role,
		content: [],
	};

	const content = m.content;

	// Simple string content
	if (typeof content === 'string') {
		msg.content.push({ type: 'text', text: content });
		return msg;
	}

	// Array content - check if it contains tool_result (should become 'tool' role)
	if (Array.isArray(content)) {
		// Check if this is a tool result message
		const hasToolResult = content.some(
			(block: Record<string, unknown>) => block.type === 'tool_result',
		);
		if (hasToolResult && role === 'user') {
			msg.role = 'tool';
		}

		for (const block of content) {
			parseClaudeContentBlock(block, msg);
		}
	}

	return msg;
}

function parseClaudeContentBlock(block: Record<string, unknown>, msg: Message): void {
	const blockType = block.type as string;

	switch (blockType) {
		case 'text':
			if (block.text) {
				msg.content.push({ type: 'text', text: block.text as string });
			}
			break;

		case 'thinking': {
			// Extract thinking text - handle both simple string and wrapped object formats
			let thinkingText = block.thinking as string;
			if (!thinkingText && (block.thinking as Record<string, string>)?.text) {
				thinkingText = (block.thinking as Record<string, string>).text;
			}
			msg.content.push({
				type: 'reasoning',
				reasoning: thinkingText || '',
				thoughtSignature: block.signature as string | undefined,
			});
			break;
		}

		case 'image':
			if ((block.source as Record<string, string>)?.type === 'base64') {
				const source = block.source as Record<string, string>;
				msg.content.push({
					type: 'image',
					image: {
						mimeType: source.media_type || 'image/png',
						data: source.data,
					},
				});
			}
			break;

		case 'tool_use': {
			const inputRaw = block.input;
			const args = inputRaw
				? typeof inputRaw === 'string'
					? inputRaw
					: JSON.stringify(inputRaw)
				: '{}';

			if (!msg.toolCalls) {
				msg.toolCalls = [];
			}
			msg.toolCalls.push({
				id: (block.id as string) || '',
				name: (block.name as string) || '',
				args,
			});
			break;
		}

		case 'tool_result': {
			const resultContent = block.content;
			let resultStr = '';

			if (typeof resultContent === 'string') {
				resultStr = resultContent;
			} else if (Array.isArray(resultContent)) {
				resultStr = resultContent
					.filter(
						(part: Record<string, unknown>) =>
							part.type === 'text' && typeof part.text === 'string',
					)
					.map((part: Record<string, unknown>) => part.text as string)
					.join('\n');
			} else if (resultContent) {
				resultStr = JSON.stringify(resultContent);
			}

			msg.content.push({
				type: 'tool_result',
				toolResult: {
					toolCallId: (block.tool_use_id as string) || '',
					result: resultStr,
				},
			});
			break;
		}
	}
}

// =============================================================================
// Response Parsing
// =============================================================================

/**
 * Parse Claude non-streaming response into IR format
 */
export function parseClaudeResponse(rawJSON: string | Record<string, unknown>): {
	messages: Message[];
	usage: Usage | undefined;
} {
	const parsed = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;

	let usage: Usage | undefined;
	if (parsed.usage) {
		usage = parseClaudeUsage(parsed.usage);
	}

	const content = parsed.content;
	if (!content || !Array.isArray(content)) {
		return { messages: [], usage };
	}

	const msg: Message = {
		role: 'assistant',
		content: [],
	};

	for (const block of content) {
		parseClaudeContentBlock(block, msg);
	}

	if (msg.content.length > 0 || msg.toolCalls?.length) {
		return { messages: [msg], usage };
	}

	return { messages: [], usage };
}

/**
 * Parse Claude usage statistics
 */
function parseClaudeUsage(usage: Record<string, unknown>): Usage {
	return {
		promptTokens: (usage.input_tokens as number) || 0,
		completionTokens: (usage.output_tokens as number) || 0,
		totalTokens: ((usage.input_tokens as number) || 0) + ((usage.output_tokens as number) || 0),
	};
}

// =============================================================================
// Streaming Parsing
// =============================================================================

/**
 * Extract SSE data from raw chunk
 */
export function extractSSEData(chunk: string): string | null {
	const lines = chunk.split('\n');
	for (const line of lines) {
		if (line.startsWith('data:')) {
			return line.slice(5).trim();
		}
	}
	return null;
}

/**
 * Parse Claude streaming SSE chunk into IR events
 */
export function parseClaudeChunk(rawChunk: string): UnifiedEvent[] {
	const data = extractSSEData(rawChunk);
	if (!data) {
		return [];
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(data);
	} catch {
		return [];
	}

	const eventType = parsed.type as string;

	switch (eventType) {
		case CLAUDE_SSE_MESSAGE_START:
			return parseClaudeMessageStart(parsed);

		case CLAUDE_SSE_CONTENT_BLOCK_START:
			return parseClaudeContentBlockStart(parsed);

		case CLAUDE_SSE_CONTENT_BLOCK_DELTA:
			return parseClaudeStreamDelta(parsed);

		case CLAUDE_SSE_CONTENT_BLOCK_STOP:
			return parseClaudeContentBlockStop(parsed);

		case CLAUDE_SSE_MESSAGE_DELTA:
			return parseClaudeMessageDelta(parsed);

		case CLAUDE_SSE_MESSAGE_STOP:
			return [{ type: 'finish', finishReason: 'stop' }];

		case CLAUDE_SSE_ERROR: {
			const errorMsg =
				(parsed.error as Record<string, unknown>)?.message || 'Unknown Claude API error';
			return [{ type: 'error', error: new Error(errorMsg as string) }];
		}

		default:
			return [];
	}
}

/**
 * Parse message_start event
 */
function parseClaudeMessageStart(_parsed: Record<string, unknown>): UnifiedEvent[] {
	// message_start doesn't produce IR events directly, but we could extract usage info
	// It will be combined with final usage in message_delta
	return [];
}

/**
 * Parse content_block_start event - important for tool calls initialization
 */
function parseClaudeContentBlockStart(parsed: Record<string, unknown>): UnifiedEvent[] {
	const contentBlock = parsed.content_block as Record<string, unknown>;
	if (!contentBlock) return [];

	const blockType = contentBlock.type as string;
	const index = (parsed.index as number) || 0;

	switch (blockType) {
		case 'tool_use':
			// Initialize tool call with id and name from content_block_start
			return [
				{
					type: 'tool_call',
					toolCall: {
						id: (contentBlock.id as string) || '',
						name: (contentBlock.name as string) || '',
						args: '',
					},
					toolCallIndex: index,
				},
			];

		case 'thinking':
		case 'text':
			// Thinking/Text block started - actual content comes in content_block_delta
			return [];

		default:
			return [];
	}
}

/**
 * Parse content_block_stop event
 */
function parseClaudeContentBlockStop(parsed: Record<string, unknown>): UnifiedEvent[] {
	const index = (parsed.index as number) || 0;
	// content_block_stop signals the end of a content block
	// We can use this to mark tool calls as complete
	return [
		{
			type: 'tool_call_delta',
			toolCall: {
				id: '',
				name: '',
				args: '',
				isComplete: true,
			},
			toolCallIndex: index,
		},
	];
}

/**
 * Parse content_block_delta event
 */
function parseClaudeStreamDelta(parsed: Record<string, unknown>): UnifiedEvent[] {
	const delta = parsed.delta as Record<string, unknown>;
	if (!delta) return [];

	const deltaType = delta.type as string;

	switch (deltaType) {
		case 'text_delta':
			if (delta.text) {
				return [{ type: 'token', content: delta.text as string }];
			}
			break;

		case 'thinking_delta':
			if (delta.thinking) {
				return [{ type: 'reasoning', reasoning: delta.thinking as string }];
			}
			break;

		case 'signature_delta':
			if (delta.signature) {
				return [{ type: 'reasoning', thoughtSignature: delta.signature as string }];
			}
			break;

		case 'input_json_delta':
			if (delta.partial_json !== undefined) {
				return [
					{
						type: 'tool_call_delta',
						toolCall: {
							id: '',
							name: '',
							args: delta.partial_json as string,
						},
						toolCallIndex: (parsed.index as number) || 0,
					},
				];
			}
			break;
	}

	return [];
}

/**
 * Parse message_delta event
 */
function parseClaudeMessageDelta(parsed: Record<string, unknown>): UnifiedEvent[] {
	const events: UnifiedEvent[] = [];
	const delta = parsed.delta as Record<string, unknown>;

	if (delta?.stop_reason) {
		let finishReason: FinishReason = 'stop';
		if (delta.stop_reason === 'tool_use') {
			finishReason = 'tool_calls';
		} else if (delta.stop_reason === 'max_tokens') {
			finishReason = 'length';
		}

		const event: UnifiedEvent = { type: 'finish', finishReason };

		// Include usage if present
		const usage = parsed.usage as Record<string, unknown>;
		if (usage) {
			event.usage = {
				promptTokens: (usage.input_tokens as number) || 0,
				completionTokens: (usage.output_tokens as number) || 0,
				totalTokens: ((usage.input_tokens as number) || 0) + ((usage.output_tokens as number) || 0),
			};
		}

		events.push(event);
	}

	return events;
}
