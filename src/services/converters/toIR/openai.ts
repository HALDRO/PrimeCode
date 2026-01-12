/**
 * @file OpenAI API Response Parser
 * @description Converts OpenAI Chat Completions API responses into unified IR format.
 * Based on CLIProxyAPI to_ir/openai.go
 */

import type {
	ContentPart,
	Message,
	ToolCall,
	ToolDefinition,
	UnifiedChatRequest,
	UnifiedEvent,
	Usage,
} from '../ir/types';
import {
	cleanJsonSchema,
	mapEffortToBudget,
	mapOpenAIFinishReason,
	mapStandardRole,
} from '../ir/types';

// =============================================================================
// Request Parsing (OpenAI → IR)
// =============================================================================

/**
 * Parse OpenAI Chat Completions request into unified IR format
 */
export function parseOpenAIRequest(rawJSON: string | Record<string, unknown>): UnifiedChatRequest {
	const parsed = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;

	const req: UnifiedChatRequest = {
		model: (parsed.model as string) || '',
		messages: [],
	};

	// Generation parameters
	if (parsed.temperature !== undefined) req.temperature = parsed.temperature as number;
	if (parsed.top_p !== undefined) req.topP = parsed.top_p as number;
	if (parsed.top_k !== undefined) req.topK = parsed.top_k as number;

	if (parsed.max_tokens !== undefined) {
		req.maxTokens = parsed.max_tokens as number;
	} else if (parsed.max_output_tokens !== undefined) {
		req.maxTokens = parsed.max_output_tokens as number;
	}

	// Stop sequences
	if (parsed.stop) {
		req.stopSequences = Array.isArray(parsed.stop)
			? (parsed.stop as string[])
			: [parsed.stop as string];
	}

	// Messages
	if (Array.isArray(parsed.messages)) {
		for (const m of parsed.messages) {
			req.messages.push(parseOpenAIMessage(m as Record<string, unknown>));
		}
	}

	// Tools
	if (Array.isArray(parsed.tools)) {
		req.tools = parsed.tools
			.map((t: unknown) => parseOpenAITool(t as Record<string, unknown>))
			.filter((t: ToolDefinition | null): t is ToolDefinition => t !== null);
	}

	// Tool choice
	if (parsed.tool_choice !== undefined) {
		req.toolChoice =
			typeof parsed.tool_choice === 'object' ? 'required' : (parsed.tool_choice as string);
	}

	if (parsed.parallel_tool_calls !== undefined) {
		req.parallelToolCalls = parsed.parallel_tool_calls as boolean;
	}

	// Modalities
	if (Array.isArray(parsed.modalities)) {
		req.responseModality = (parsed.modalities as string[]).map(m => m.toUpperCase());
	}

	// Thinking config
	req.thinking = parseOpenAIThinkingConfig(parsed);

	// Response format (structured output)
	if (parsed.response_format && typeof parsed.response_format === 'object') {
		const rf = parsed.response_format as Record<string, unknown>;
		if (rf.type === 'json_schema') {
			const jsonSchema = rf.json_schema as Record<string, unknown>;
			if (jsonSchema?.schema) {
				req.responseSchema = jsonSchema.schema as Record<string, unknown>;
			}
		}
	}

	return req;
}

/**
 * Parse a single OpenAI message into IR format
 */
function parseOpenAIMessage(m: Record<string, unknown>): Message {
	const roleStr = (m.role as string) || 'user';
	const msg: Message = {
		role: mapStandardRole(roleStr),
		content: [],
	};

	// Parse reasoning content for assistant messages
	if (roleStr === 'assistant') {
		const reasoning = parseReasoningFromJSON(m);
		if (reasoning.text) {
			msg.content.push({
				type: 'reasoning',
				reasoning: reasoning.text,
				thoughtSignature: reasoning.signature,
			});
		}
	}

	const content = m.content;

	// String content
	if (typeof content === 'string' && roleStr !== 'tool') {
		const text = content;
		const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
		// Skip empty content for assistant messages with tool_calls
		if (text || roleStr !== 'assistant' || !hasToolCalls) {
			msg.content.push({ type: 'text', text });
		}
	}
	// Array content
	else if (Array.isArray(content)) {
		for (const item of content) {
			const part = parseOpenAIContentPart(item as Record<string, unknown>, msg);
			if (part) {
				msg.content.push(part);
			}
		}
	}

	// Tool calls for assistant
	if (roleStr === 'assistant' && Array.isArray(m.tool_calls)) {
		msg.toolCalls = parseOpenAIStyleToolCalls(m.tool_calls as Record<string, unknown>[]);
	}

	// Tool result message
	if (roleStr === 'tool') {
		const toolCallId = (m.tool_call_id as string) || (m.tool_use_id as string) || '';
		const resultContent = typeof content === 'string' ? content : extractContentString(content);
		msg.content.push({
			type: 'tool_result',
			toolResult: {
				toolCallId,
				result: resultContent,
			},
		});
	}

	return msg;
}

/**
 * Parse OpenAI content part
 */
function parseOpenAIContentPart(item: Record<string, unknown>, msg: Message): ContentPart | null {
	const itemType = item.type as string;

	switch (itemType) {
		case 'text': {
			const text = (item.text as string) || '';
			if (text.trim()) {
				return { type: 'text', text };
			}
			return null;
		}

		case 'image_url': {
			const imageUrl = item.image_url as Record<string, unknown>;
			const url = imageUrl?.url as string;
			if (url) {
				const image = parseDataURI(url);
				if (image) {
					return { type: 'image', image };
				}
			}
			return null;
		}

		case 'image': {
			const source = item.source as Record<string, unknown>;
			const mediaType = (source?.media_type as string) || 'image/png';
			const data = source?.data as string;
			if (data) {
				return {
					type: 'image',
					image: { mimeType: mediaType, data },
				};
			}
			return null;
		}

		case 'tool_use': {
			// Tool use in content array (Claude-style in OpenAI format)
			const inputRaw = item.input;
			const args = inputRaw
				? typeof inputRaw === 'string'
					? inputRaw
					: JSON.stringify(inputRaw)
				: '{}';
			if (!msg.toolCalls) {
				msg.toolCalls = [];
			}
			msg.toolCalls.push({
				id: (item.id as string) || '',
				name: (item.name as string) || '',
				args,
			});
			return null;
		}

		case 'tool_result': {
			msg.role = 'tool';
			const resultContent = item.content;
			return {
				type: 'tool_result',
				toolResult: {
					toolCallId: (item.tool_use_id as string) || '',
					result: extractContentString(resultContent),
				},
			};
		}

		default:
			return null;
	}
}

/**
 * Parse OpenAI tool definition
 */
function parseOpenAITool(t: Record<string, unknown>): ToolDefinition | null {
	const toolType = t.type as string;
	let name = '';
	let description = '';
	let params: Record<string, unknown> | undefined;
	let isCustomTool = false;

	if (toolType === 'function') {
		const fn = t.function as Record<string, unknown>;
		if (fn && typeof fn === 'object') {
			name = (fn.name as string) || '';
			description = (fn.description as string) || '';
			if (fn.parameters) {
				params = cleanJsonSchema(fn.parameters as Record<string, unknown>);
			}
		} else {
			// Flat format
			name = (t.name as string) || '';
			description = (t.description as string) || '';
			if (t.parameters) {
				params = cleanJsonSchema(t.parameters as Record<string, unknown>);
			}
		}
	} else if (toolType === 'custom') {
		name = (t.name as string) || '';
		description = (t.description as string) || '';
		isCustomTool = true;
	} else if (t.name) {
		// Fallback for tools without explicit type
		name = (t.name as string) || '';
		description = (t.description as string) || '';
		if (t.parameters) {
			params = cleanJsonSchema(t.parameters as Record<string, unknown>);
		} else if (t.input_schema) {
			params = cleanJsonSchema(t.input_schema as Record<string, unknown>);
		}
	}

	if (!name) return null;

	return {
		name,
		description,
		parameters: params || {},
		isCustom: isCustomTool,
	};
}

/**
 * Parse thinking config from OpenAI request
 */
function parseOpenAIThinkingConfig(
	parsed: Record<string, unknown>,
): import('../ir/types').ThinkingConfig | undefined {
	let thinking: import('../ir/types').ThinkingConfig | undefined;

	// reasoning_effort field
	if (parsed.reasoning_effort) {
		const effort = parsed.reasoning_effort as string;
		const { budget, includeThoughts } = mapEffortToBudget(effort);
		thinking = { effort, budget, includeThoughts };
	}

	// reasoning object
	if (parsed.reasoning && typeof parsed.reasoning === 'object') {
		const reasoning = parsed.reasoning as Record<string, unknown>;
		if (!thinking) thinking = {};

		if (reasoning.effort) {
			thinking.effort = reasoning.effort as string;
			const { budget, includeThoughts } = mapEffortToBudget(reasoning.effort as string);
			thinking.budget = budget;
			thinking.includeThoughts = includeThoughts;
		}
		if (reasoning.summary) {
			thinking.summary = reasoning.summary as string;
		}
	}

	// Anthropic/Claude format: thinking.type == "enabled"
	if (parsed.thinking && typeof parsed.thinking === 'object') {
		const t = parsed.thinking as Record<string, unknown>;
		if (t.type === 'enabled') {
			if (!thinking) thinking = {};
			thinking.includeThoughts = true;
			thinking.budget = t.budget_tokens !== undefined ? (t.budget_tokens as number) : -1;
		} else if (t.type === 'disabled') {
			thinking = { includeThoughts: false, budget: 0 };
		}
	}

	return thinking;
}

// =============================================================================
// Response Parsing (OpenAI → IR)
// =============================================================================

/**
 * Parse OpenAI non-streaming response into IR format
 */
export function parseOpenAIResponse(rawJSON: string | Record<string, unknown>): {
	messages: Message[];
	usage: Usage | undefined;
} {
	const parsed = typeof rawJSON === 'string' ? JSON.parse(rawJSON) : rawJSON;

	// Handle Cline API wrapper format
	let root = parsed;
	if (parsed.data && typeof parsed.data === 'object') {
		root = parsed.data;
	}

	const usage = parseOpenAIUsage(root.usage as Record<string, unknown>);

	// Responses API format
	if (Array.isArray(root.output)) {
		return parseResponsesAPIOutput(root.output, usage);
	}

	// Chat Completions format
	const choices = root.choices as Record<string, unknown>[];
	if (!choices?.length) {
		return { messages: [], usage };
	}

	const message = choices[0].message as Record<string, unknown>;
	if (!message) {
		return { messages: [], usage };
	}

	const msg: Message = { role: 'assistant', content: [] };

	// Reasoning content
	const reasoning = parseReasoningFromJSON(message);
	if (reasoning.text) {
		msg.content.push({
			type: 'reasoning',
			reasoning: reasoning.text,
			thoughtSignature: reasoning.signature,
		});
	}

	// Text content
	if (message.content && typeof message.content === 'string') {
		msg.content.push({ type: 'text', text: message.content });
	}

	// Tool calls
	if (Array.isArray(message.tool_calls)) {
		msg.toolCalls = parseOpenAIStyleToolCalls(message.tool_calls as Record<string, unknown>[]);
	}

	if (msg.content.length === 0 && (!msg.toolCalls || msg.toolCalls.length === 0)) {
		return { messages: [], usage };
	}

	return { messages: [msg], usage };
}

/**
 * Parse Responses API output array
 */
function parseResponsesAPIOutput(
	output: Record<string, unknown>[],
	usage: Usage | undefined,
): { messages: Message[]; usage: Usage | undefined } {
	const messages: Message[] = [];

	for (const item of output) {
		const itemType = item.type as string;

		switch (itemType) {
			case 'message': {
				const msg: Message = { role: 'assistant', content: [] };
				const content = item.content as Record<string, unknown>[];
				if (Array.isArray(content)) {
					for (const c of content) {
						if ((c.type as string) === 'output_text' && c.text) {
							msg.content.push({ type: 'text', text: c.text as string });
						}
					}
				}
				if (msg.content.length > 0) {
					messages.push(msg);
				}
				break;
			}

			case 'reasoning': {
				const msg: Message = { role: 'assistant', content: [] };
				const summary = item.summary as Record<string, unknown>[];
				if (Array.isArray(summary)) {
					for (const s of summary) {
						if ((s.type as string) === 'summary_text' && s.text) {
							msg.content.push({ type: 'reasoning', reasoning: s.text as string });
						}
					}
				}
				if (msg.content.length > 0) {
					messages.push(msg);
				}
				break;
			}

			case 'function_call': {
				messages.push({
					role: 'assistant',
					content: [],
					toolCalls: [
						{
							id: (item.call_id as string) || '',
							name: (item.name as string) || '',
							args: (item.arguments as string) || '{}',
						},
					],
				});
				break;
			}
		}
	}

	return { messages, usage };
}

// =============================================================================
// Streaming Parsing (OpenAI → IR)
// =============================================================================

/**
 * Parse OpenAI streaming SSE chunk into IR events
 */
export function parseOpenAIChunk(rawChunk: string): UnifiedEvent[] {
	const trimmed = rawChunk.trim();
	if (!trimmed) return [];

	if (trimmed === '[DONE]') {
		return [{ type: 'finish', finishReason: 'stop' }];
	}

	let eventType = '';
	let dataStr = trimmed;

	// Parse SSE format
	if (trimmed.startsWith('event:')) {
		const parts = trimmed.split('\n', 2);
		if (parts.length >= 2) {
			eventType = parts[0].replace('event:', '').trim();
			dataStr = parts[1].trim();
		}
	}

	if (dataStr.startsWith('data:')) {
		dataStr = dataStr.replace('data:', '').trim();
	}

	if (!dataStr || dataStr === '[DONE]') {
		return dataStr === '[DONE]' ? [{ type: 'finish', finishReason: 'stop' }] : [];
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(dataStr);
	} catch {
		return [];
	}

	// Check for Responses API event type
	if (!eventType) {
		eventType = (parsed.type as string) || '';
	}

	if (eventType?.startsWith('response.')) {
		return parseResponsesStreamEvent(eventType, parsed);
	}

	return parseChatCompletionChunk(parsed);
}

function parseChatCompletionChunk(parsed: Record<string, unknown>): UnifiedEvent[] {
	const events: UnifiedEvent[] = [];
	const choices = parsed.choices as Record<string, unknown>[];

	if (!choices?.length) {
		// Check for usage-only chunk
		if (parsed.usage) {
			const usage = parseOpenAIUsage(parsed.usage as Record<string, unknown>);
			if (usage) {
				events.push({
					type: 'finish',
					usage,
					systemFingerprint: parsed.system_fingerprint as string,
				});
			}
		}
		return events;
	}

	const choice = choices[0];
	const delta = choice.delta as Record<string, unknown>;

	if (delta) {
		// Text content
		if (typeof delta.content === 'string') {
			events.push({ type: 'token', content: delta.content });
		}

		// Refusal
		if (delta.refusal && typeof delta.refusal === 'string') {
			events.push({ type: 'token', refusal: delta.refusal });
		}

		// Reasoning
		const reasoning = parseReasoningFromJSON(delta);
		if (reasoning.text) {
			events.push({
				type: 'reasoning',
				reasoning: reasoning.text,
				thoughtSignature: reasoning.signature,
			});
		}

		// Tool calls
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls as Record<string, unknown>[]) {
				const tcIndex = (tc.index as number) || 0;
				const func = tc.function as Record<string, unknown>;
				events.push({
					type: 'tool_call',
					toolCall: {
						id: (tc.id as string) || '',
						name: (func?.name as string) || '',
						args: (func?.arguments as string) || '',
					},
					toolCallIndex: tcIndex,
				});
			}
		}
	}

	// Finish reason
	const finishReason = choice.finish_reason as string;
	if (finishReason) {
		const event: UnifiedEvent = {
			type: 'finish',
			finishReason: mapOpenAIFinishReason(finishReason),
			systemFingerprint: parsed.system_fingerprint as string,
		};
		if (choice.logprobs) event.logprobs = choice.logprobs;
		if (choice.content_filter_results) event.contentFilter = choice.content_filter_results;
		events.push(event);
	} else if (events.length > 0) {
		// Attach system fingerprint to first event
		events[0].systemFingerprint = parsed.system_fingerprint as string;
	}

	return events;
}

/**
 * Parse Responses API stream event
 */
function parseResponsesStreamEvent(
	eventType: string,
	parsed: Record<string, unknown>,
): UnifiedEvent[] {
	const events: UnifiedEvent[] = [];

	switch (eventType) {
		case 'response.output_item.added': {
			const item = parsed.item as Record<string, unknown>;
			if (item) {
				const itemType = item.type as string;
				if (itemType === 'function_call' || itemType === 'custom_tool_call') {
					events.push({
						type: 'tool_call',
						toolCall: {
							id: (item.call_id as string) || '',
							itemId: (item.id as string) || '',
							name: (item.name as string) || '',
							args: '',
							isCustom: itemType === 'custom_tool_call',
						},
						toolCallIndex: (parsed.output_index as number) || 0,
					});
				}
			}
			break;
		}

		case 'response.output_text.delta': {
			const delta = (parsed.delta as string) || (parsed.text as string) || '';
			if (delta) {
				events.push({ type: 'token', content: delta });
			}
			break;
		}

		case 'response.reasoning_summary_text.delta': {
			const delta = (parsed.delta as string) || (parsed.text as string) || '';
			if (delta) {
				events.push({ type: 'reasoning_summary', reasoningSummary: delta });
			}
			break;
		}

		case 'response.function_call_arguments.done': {
			const args = parsed.arguments as string;
			if (args !== undefined) {
				events.push({
					type: 'tool_call_delta',
					toolCall: {
						id: '',
						itemId: (parsed.item_id as string) || '',
						name: '',
						args,
					},
					toolCallIndex: (parsed.output_index as number) || 0,
				});
			}
			break;
		}

		case 'response.custom_tool_call_input.delta': {
			const delta = parsed.delta as string;
			if (delta !== undefined) {
				events.push({
					type: 'tool_call_delta',
					toolCall: {
						id: '',
						itemId: (parsed.item_id as string) || '',
						name: '',
						args: delta,
						isCustom: true,
					},
					toolCallIndex: (parsed.output_index as number) || 0,
				});
			}
			break;
		}

		case 'response.completed': {
			const event: UnifiedEvent = { type: 'finish', finishReason: 'stop' };
			const response = parsed.response as Record<string, unknown>;
			if (response?.usage) {
				const u = response.usage as Record<string, unknown>;
				event.usage = {
					promptTokens: (u.input_tokens as number) || 0,
					completionTokens: (u.output_tokens as number) || 0,
					totalTokens: (u.total_tokens as number) || 0,
				};
			}
			events.push(event);
			break;
		}

		case 'error': {
			events.push({ type: 'error', finishReason: 'error' });
			break;
		}
	}

	return events;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Parse OpenAI usage statistics
 */
function parseOpenAIUsage(usage: Record<string, unknown> | undefined): Usage | undefined {
	if (!usage) return undefined;

	const result: Usage = {
		promptTokens: (usage.prompt_tokens as number) || 0,
		completionTokens: (usage.completion_tokens as number) || 0,
		totalTokens: (usage.total_tokens as number) || 0,
	};

	// Prompt token details
	const promptDetails = usage.prompt_tokens_details as Record<string, unknown>;
	if (promptDetails) {
		if (promptDetails.cached_tokens) {
			result.cachedTokens = promptDetails.cached_tokens as number;
		}
		if (promptDetails.audio_tokens) {
			result.audioTokens = promptDetails.audio_tokens as number;
		}
	}

	// Completion token details
	const completionDetails = usage.completion_tokens_details as Record<string, unknown>;
	if (completionDetails) {
		if (completionDetails.reasoning_tokens) {
			result.thoughtsTokenCount = completionDetails.reasoning_tokens as number;
		}
		if (completionDetails.accepted_prediction_tokens) {
			result.acceptedPredictionTokens = completionDetails.accepted_prediction_tokens as number;
		}
		if (completionDetails.rejected_prediction_tokens) {
			result.rejectedPredictionTokens = completionDetails.rejected_prediction_tokens as number;
		}
	}

	return result;
}

/**
 * Parse reasoning content from JSON (supports multiple formats)
 */
function parseReasoningFromJSON(obj: Record<string, unknown>): {
	text: string;
	signature?: string;
} {
	// OpenAI reasoning_content
	if (obj.reasoning_content && typeof obj.reasoning_content === 'string') {
		return {
			text: obj.reasoning_content,
			signature: obj.reasoning_signature as string | undefined,
		};
	}

	// Anthropic thinking
	if (obj.thinking && typeof obj.thinking === 'string') {
		return { text: obj.thinking };
	}

	return { text: '' };
}

/**
 * Parse OpenAI-style tool calls array
 */
function parseOpenAIStyleToolCalls(toolCalls: Record<string, unknown>[]): ToolCall[] {
	const result: ToolCall[] = [];
	for (const tc of toolCalls) {
		const func = tc.function as Record<string, unknown>;
		if (func) {
			result.push({
				id: (tc.id as string) || '',
				name: (func.name as string) || '',
				args: (func.arguments as string) || '{}',
			});
		}
	}
	return result;
}

/**
 * Parse data URI into image part
 */
function parseDataURI(url: string): { mimeType: string; data: string } | null {
	if (!url.startsWith('data:')) return null;

	const parts = url.split(',', 2);
	if (parts.length !== 2) return null;

	// Extract mime type from "data:image/png;base64"
	let mimeType = 'image/jpeg';
	const semicolonIdx = parts[0].indexOf(';');
	if (semicolonIdx > 5) {
		mimeType = parts[0].slice(5, semicolonIdx);
	}

	return { mimeType, data: parts[1] };
}

/**
 * Extract text content from various formats
 */
function extractContentString(content: unknown): string {
	if (typeof content === 'string') return content;

	if (Array.isArray(content)) {
		const textPart = content.find(
			item =>
				typeof item === 'object' &&
				item !== null &&
				(item as Record<string, unknown>).type === 'text' &&
				(item as Record<string, unknown>).text,
		);
		if (textPart) {
			return (textPart as Record<string, unknown>).text as string;
		}
	}

	if (content && typeof content === 'object') {
		return JSON.stringify(content);
	}

	return '';
}
