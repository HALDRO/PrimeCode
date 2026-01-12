/**
 * @file OpenAI API Request/Response Generator
 * @description Converts unified IR format to OpenAI Chat Completions API format.
 * Based on CLIProxyAPI from_ir/openai.go
 */

import type {
	Message,
	ResponseMeta,
	ToolDefinition,
	UnifiedChatRequest,
	UnifiedEvent,
	Usage,
} from '../ir/types';
import {
	combineReasoningParts,
	combineTextParts,
	getFirstReasoningSignature,
	mapBudgetToEffort,
	mapFinishReasonToOpenAI,
} from '../ir/types';

// =============================================================================
// Request Conversion
// =============================================================================

/**
 * Check if model is an OpenAI reasoning model (o1, o3 series)
 */
function isReasoningModel(model: string): boolean {
	const lowerModel = model.toLowerCase();
	return lowerModel.startsWith('o1') || lowerModel.startsWith('o3');
}

/**
 * Convert unified IR request to OpenAI Chat Completions API JSON
 */
export function toOpenAIRequest(req: UnifiedChatRequest): Record<string, unknown> {
	const result: Record<string, unknown> = {
		model: req.model,
		messages: [],
	};

	const isReasoning = isReasoningModel(req.model);

	// Generation parameters
	if (req.temperature !== undefined) result.temperature = req.temperature;
	if (req.topP !== undefined) result.top_p = req.topP;

	if (req.maxTokens !== undefined) {
		if (isReasoning) {
			result.max_completion_tokens = req.maxTokens;
		} else {
			result.max_tokens = req.maxTokens;
		}
	}

	if (req.stopSequences?.length) {
		result.stop = req.stopSequences;
	}

	// Thinking/reasoning - only for models that support it
	if (req.thinking?.includeThoughts && isReasoning) {
		result.reasoning_effort = mapBudgetToEffort(req.thinking.budget ?? -1, 'auto');
	}

	// Convert messages
	result.messages = req.messages
		.map(convertMessageToOpenAI)
		.filter((msg): msg is Record<string, unknown> => msg !== null);

	// Tools
	if (req.tools?.length) {
		result.tools = buildOpenAITools(req.tools);
	}

	// Tool choice
	if (req.toolChoice) {
		result.tool_choice = req.toolChoice;
	}
	if (req.parallelToolCalls !== undefined) {
		result.parallel_tool_calls = req.parallelToolCalls;
	}

	// Response modality
	if (req.responseModality?.length) {
		result.modalities = req.responseModality;
	}

	return result;
}

/**
 * Convert a single IR message to OpenAI format
 */
function convertMessageToOpenAI(msg: Message): Record<string, unknown> | null {
	switch (msg.role) {
		case 'system': {
			const text = combineTextParts(msg);
			return text ? { role: 'system', content: text } : null;
		}
		case 'user':
			return buildOpenAIUserMessage(msg);
		case 'assistant':
			return buildOpenAIAssistantMessage(msg);
		case 'tool':
			return buildOpenAIToolMessage(msg);
		default:
			return null;
	}
}

/**
 * Build OpenAI user message
 */
function buildOpenAIUserMessage(msg: Message): Record<string, unknown> | null {
	const parts: Record<string, unknown>[] = [];

	for (const part of msg.content) {
		if (part.type === 'text' && part.text) {
			parts.push({ type: 'text', text: part.text });
		} else if (part.type === 'image' && part.image) {
			const url = part.image.url || `data:${part.image.mimeType};base64,${part.image.data}`;
			parts.push({
				type: 'image_url',
				image_url: { url },
			});
		}
	}

	if (parts.length === 0) return null;

	// Simplify if only one text part
	if (parts.length === 1 && parts[0].type === 'text') {
		return { role: 'user', content: parts[0].text };
	}

	return { role: 'user', content: parts };
}

/**
 * Build OpenAI assistant message
 */
function buildOpenAIAssistantMessage(msg: Message): Record<string, unknown> {
	const result: Record<string, unknown> = { role: 'assistant' };

	// Text content
	const text = combineTextParts(msg);
	if (text) {
		result.content = text;
	}

	// Reasoning content (if supported)
	const reasoning = combineReasoningParts(msg);
	if (reasoning) {
		result.reasoning_content = reasoning;
		const signature = getFirstReasoningSignature(msg);
		if (signature) {
			result.reasoning_signature = signature;
		}
	}

	// Tool calls
	if (msg.toolCalls?.length) {
		result.tool_calls = msg.toolCalls.map(tc => ({
			id: tc.id,
			type: 'function',
			function: {
				name: tc.name,
				arguments: tc.args,
			},
		}));
	}

	return result;
}

/**
 * Build OpenAI tool result message
 */
function buildOpenAIToolMessage(msg: Message): Record<string, unknown> | null {
	for (const part of msg.content) {
		if (part.type === 'tool_result' && part.toolResult) {
			return {
				role: 'tool',
				tool_call_id: part.toolResult.toolCallId,
				content: part.toolResult.result,
			};
		}
	}
	return null;
}

/**
 * Build OpenAI tools array
 */
function buildOpenAITools(tools: ToolDefinition[]): Record<string, unknown>[] {
	return tools.map(t => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters || { type: 'object', properties: {} },
		},
	}));
}

// =============================================================================
// Response Conversion
// =============================================================================

/**
 * Convert IR messages to OpenAI chat completion response
 */
export function toOpenAIChatCompletion(
	messages: Message[],
	usage: Usage | undefined,
	model: string,
	messageId: string,
	meta?: ResponseMeta,
): Record<string, unknown> {
	const responseId = meta?.responseId || messageId;
	const created = meta?.createTime || Math.floor(Date.now() / 1000);

	const response: Record<string, unknown> = {
		id: responseId,
		object: 'chat.completion',
		created,
		model,
		choices: [],
	};

	// Find last assistant message
	const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

	if (lastAssistant) {
		const msgContent: Record<string, unknown> = { role: 'assistant' };

		// Text content
		const text = combineTextParts(lastAssistant);
		if (text) {
			msgContent.content = text;
		}

		// Reasoning
		const reasoning = combineReasoningParts(lastAssistant);
		if (reasoning) {
			msgContent.reasoning_content = reasoning;
		}

		// Tool calls
		if (lastAssistant.toolCalls?.length) {
			msgContent.tool_calls = lastAssistant.toolCalls.map(tc => ({
				id: tc.id,
				type: 'function',
				function: {
					name: tc.name,
					arguments: tc.args,
				},
			}));
		}

		// Determine finish reason
		const finishReason =
			lastAssistant.toolCalls && lastAssistant.toolCalls.length > 0 ? 'tool_calls' : 'stop';

		const choice: Record<string, unknown> = {
			index: 0,
			finish_reason: finishReason,
			message: msgContent,
		};

		if (meta?.nativeFinishReason) {
			choice.native_finish_reason = meta.nativeFinishReason;
		}

		response.choices = [choice];
	}

	// Usage
	if (usage) {
		const usageMap: Record<string, unknown> = {
			prompt_tokens: usage.promptTokens,
			completion_tokens: usage.completionTokens,
			total_tokens: usage.totalTokens,
		};

		if (usage.thoughtsTokenCount && usage.thoughtsTokenCount > 0) {
			usageMap.completion_tokens_details = {
				reasoning_tokens: usage.thoughtsTokenCount,
			};
		}

		response.usage = usageMap;
	}

	return response;
}

// =============================================================================
// Streaming Conversion
// =============================================================================

/**
 * Convert IR event to OpenAI SSE streaming chunk
 */
export function toOpenAIChunk(
	event: UnifiedEvent,
	model: string,
	messageId: string,
	_chunkIndex: number,
	meta?: ResponseMeta,
): Record<string, unknown> | null {
	const responseId = meta?.responseId || messageId;
	const created = meta?.createTime || Math.floor(Date.now() / 1000);

	const chunk: Record<string, unknown> = {
		id: responseId,
		object: 'chat.completion.chunk',
		created,
		model,
		choices: [],
	};

	if (event.systemFingerprint) {
		chunk.system_fingerprint = event.systemFingerprint;
	}

	const choice: Record<string, unknown> = {
		index: 0,
		delta: {},
	};

	switch (event.type) {
		case 'token': {
			const delta: Record<string, unknown> = { role: 'assistant' };
			if (event.content) delta.content = event.content;
			if (event.refusal) delta.refusal = event.refusal;
			choice.delta = delta;
			break;
		}

		case 'reasoning': {
			const delta: Record<string, unknown> = {};
			if (event.reasoning) delta.reasoning_content = event.reasoning;
			if (event.thoughtSignature) delta.reasoning_signature = event.thoughtSignature;
			choice.delta = delta;
			break;
		}

		case 'tool_call':
			if (event.toolCall) {
				const tcChunk: Record<string, unknown> = {
					index: event.toolCallIndex || 0,
				};
				if (event.toolCall.id) {
					tcChunk.id = event.toolCall.id;
					tcChunk.type = 'function';
				}
				tcChunk.function = {
					name: event.toolCall.name || undefined,
					arguments: event.toolCall.args || '',
				};
				choice.delta = { tool_calls: [tcChunk] };
			}
			break;

		case 'tool_call_delta':
			if (event.toolCall) {
				const tcChunk: Record<string, unknown> = {
					index: event.toolCallIndex || 0,
				};
				if (event.toolCall.id) {
					tcChunk.id = event.toolCall.id;
					tcChunk.type = 'function';
				}
				const funcChunk: Record<string, unknown> = {
					arguments: event.toolCall.args || '',
				};
				if (event.toolCall.name) {
					funcChunk.name = event.toolCall.name;
				}
				tcChunk.function = funcChunk;
				choice.delta = { tool_calls: [tcChunk] };
			}
			break;

		case 'image':
			if (event.image) {
				choice.delta = {
					role: 'assistant',
					images: [
						{
							index: 0,
							type: 'image_url',
							image_url: {
								url: `data:${event.image.mimeType};base64,${event.image.data}`,
							},
						},
					],
				};
			}
			break;

		case 'finish':
			choice.finish_reason = mapFinishReasonToOpenAI(event.finishReason || 'stop');
			if (meta?.nativeFinishReason) {
				choice.native_finish_reason = meta.nativeFinishReason;
			}
			if (event.logprobs) choice.logprobs = event.logprobs;
			if (event.contentFilter) choice.content_filter_results = event.contentFilter;
			if (event.usage) chunk.usage = buildChunkUsage(event.usage);
			break;

		case 'error':
			return null;

		default:
			return null;
	}

	if (event.logprobs && event.type !== 'finish') {
		choice.logprobs = event.logprobs;
	}

	chunk.choices = [choice];
	return chunk;
}

/**
 * Build usage map for streaming chunk
 */
function buildChunkUsage(usage: Usage, _meta?: ResponseMeta): Record<string, unknown> {
	const usageMap: Record<string, unknown> = {
		prompt_tokens: usage.promptTokens,
		completion_tokens: usage.completionTokens,
		total_tokens: usage.totalTokens,
	};

	const promptDetails: Record<string, unknown> = {};
	if (usage.cachedTokens && usage.cachedTokens > 0)
		promptDetails.cached_tokens = usage.cachedTokens;
	if (usage.audioTokens && usage.audioTokens > 0) promptDetails.audio_tokens = usage.audioTokens;
	if (Object.keys(promptDetails).length > 0) usageMap.prompt_tokens_details = promptDetails;

	const completionDetails: Record<string, unknown> = {};
	if (usage.thoughtsTokenCount && usage.thoughtsTokenCount > 0)
		completionDetails.reasoning_tokens = usage.thoughtsTokenCount;
	if (usage.acceptedPredictionTokens && usage.acceptedPredictionTokens > 0)
		completionDetails.accepted_prediction_tokens = usage.acceptedPredictionTokens;
	if (usage.rejectedPredictionTokens && usage.rejectedPredictionTokens > 0)
		completionDetails.rejected_prediction_tokens = usage.rejectedPredictionTokens;
	if (Object.keys(completionDetails).length > 0)
		usageMap.completion_tokens_details = completionDetails;

	return usageMap;
}

/**
 * Format OpenAI SSE chunk as string
 */
export function formatOpenAISSE(chunk: Record<string, unknown>): string {
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format OpenAI SSE done marker
 */
export function formatOpenAISSEDone(): string {
	return 'data: [DONE]\n\n';
}

// =============================================================================
// OpenAI Responses API Conversion
// Based on CLIProxyAPI internal/translator/openai/openai/responses/
// =============================================================================

/**
 * State for Responses API streaming conversion
 */
export interface ResponsesStreamState {
	seq: number;
	responseId: string;
	createdAt: number;
	started: boolean;
	reasoningId: string;
	reasoningIndex: number;
	// Aggregation buffers
	msgTextBuf: Map<number, string>;
	reasoningBuf: string;
	funcArgsBuf: Map<number, string>;
	funcNames: Map<number, string>;
	funcCallIds: Map<number, string>;
	// Item state tracking
	msgItemAdded: Set<number>;
	msgContentAdded: Set<number>;
	msgItemDone: Set<number>;
	funcArgsDone: Set<number>;
	funcItemDone: Set<number>;
	// Usage
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	reasoningTokens: number;
	usageSeen: boolean;
}

/**
 * Create new Responses API stream state
 */
export function createResponsesStreamState(): ResponsesStreamState {
	return {
		seq: 0,
		responseId: '',
		createdAt: 0,
		started: false,
		reasoningId: '',
		reasoningIndex: 0,
		msgTextBuf: new Map(),
		reasoningBuf: '',
		funcArgsBuf: new Map(),
		funcNames: new Map(),
		funcCallIds: new Map(),
		msgItemAdded: new Set(),
		msgContentAdded: new Set(),
		msgItemDone: new Set(),
		funcArgsDone: new Set(),
		funcItemDone: new Set(),
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		reasoningTokens: 0,
		usageSeen: false,
	};
}

/**
 * Convert unified IR request to OpenAI Responses API format
 */
export function toOpenAIResponsesRequest(req: UnifiedChatRequest): Record<string, unknown> {
	const result: Record<string, unknown> = {
		model: req.model,
		input: [],
	};

	// Instructions from system message
	const systemMsg = req.messages.find(m => m.role === 'system');
	if (systemMsg) {
		const text = combineTextParts(systemMsg);
		if (text) result.instructions = text;
	}

	// Convert messages to input array
	result.input = convertMessagesToResponsesInput(req.messages);

	// Generation parameters
	if (req.maxTokens !== undefined) result.max_output_tokens = req.maxTokens;
	if (req.temperature !== undefined) result.temperature = req.temperature;
	if (req.topP !== undefined) result.top_p = req.topP;

	// Thinking/reasoning
	if (req.thinking?.includeThoughts) {
		result.reasoning = {
			effort: mapBudgetToEffort(req.thinking.budget ?? -1, 'auto'),
		};
	}

	// Tools
	if (req.tools?.length) {
		result.tools = req.tools.map(t => ({
			type: 'function',
			name: t.name,
			description: t.description,
			parameters: t.parameters || { type: 'object', properties: {} },
		}));
	}

	// Tool choice
	if (req.toolChoice) result.tool_choice = req.toolChoice;
	if (req.parallelToolCalls !== undefined) result.parallel_tool_calls = req.parallelToolCalls;

	return result;
}

function convertMessagesToResponsesInput(messages: Message[]): Record<string, unknown>[] {
	const input: Record<string, unknown>[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') continue;

		if (msg.role === 'user') {
			const content: Record<string, unknown>[] = [];
			for (const part of msg.content) {
				if (part.type === 'text' && part.text) {
					content.push({ type: 'input_text', text: part.text });
				} else if (part.type === 'image' && part.image) {
					const url = part.image.url || `data:${part.image.mimeType};base64,${part.image.data}`;
					content.push({ type: 'input_image', image_url: url });
				}
			}
			if (content.length > 0) {
				input.push({ type: 'message', role: 'user', content });
			}
		} else if (msg.role === 'assistant') {
			const content: Record<string, unknown>[] = [];
			const text = combineTextParts(msg);
			if (text) content.push({ type: 'output_text', text });

			if (content.length > 0) {
				input.push({ type: 'message', role: 'assistant', content });
			}
			// Tool calls
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					input.push({
						type: 'function_call',
						call_id: tc.id,
						name: tc.name,
						arguments: tc.args,
					});
				}
			}
		} else if (msg.role === 'tool') {
			for (const part of msg.content) {
				if (part.type === 'tool_result' && part.toolResult) {
					input.push({
						type: 'function_call_output',
						call_id: part.toolResult.toolCallId,
						output: part.toolResult.result,
					});
				}
			}
		}
	}
	return input;
}

/**
 * Convert IR messages to OpenAI Responses API non-streaming response
 */
export function toOpenAIResponsesResponse(
	messages: Message[],
	usage: Usage | undefined,
	model: string,
	responseId: string,
	meta?: ResponseMeta,
): Record<string, unknown> {
	const id = meta?.responseId || responseId;
	const createdAt = meta?.createTime || Math.floor(Date.now() / 1000);

	const response: Record<string, unknown> = {
		id,
		object: 'response',
		created_at: createdAt,
		status: 'completed',
		model,
		output: [],
	};

	const output: Record<string, unknown>[] = [];

	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;

		// Reasoning output
		const reasoning = combineReasoningParts(msg);
		if (reasoning) {
			output.push({
				id: `rs_${id}`,
				type: 'reasoning',
				summary: [{ type: 'summary_text', text: reasoning }],
			});
		}

		// Message output
		const text = combineTextParts(msg);
		if (text) {
			output.push({
				id: `msg_${id}_0`,
				type: 'message',
				status: 'completed',
				role: 'assistant',
				content: [
					{
						type: 'output_text',
						text,
						annotations: [],
						logprobs: [],
					},
				],
			});
		}

		// Function call outputs
		if (msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				output.push({
					id: `fc_${tc.id}`,
					type: 'function_call',
					status: 'completed',
					call_id: tc.id,
					name: tc.name,
					arguments: tc.args,
				});
			}
		}
	}

	response.output = output;

	if (usage) {
		response.usage = {
			input_tokens: usage.promptTokens,
			input_tokens_details: { cached_tokens: usage.cachedTokens || 0 },
			output_tokens: usage.completionTokens,
			output_tokens_details: usage.thoughtsTokenCount
				? { reasoning_tokens: usage.thoughtsTokenCount }
				: {},
			total_tokens: usage.totalTokens,
		};
	}

	return response;
}

/**
 * Convert IR event to OpenAI Responses API SSE streaming format
 */
export function toOpenAIResponsesSSE(
	event: UnifiedEvent,
	model: string,
	responseId: string,
	state: ResponsesStreamState,
): string[] {
	const results: string[] = [];

	const nextSeq = (): number => {
		state.seq++;
		return state.seq;
	};

	const emitEvent = (eventType: string, payload: Record<string, unknown>): string => {
		return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
	};

	// Initialize on first event
	if (!state.started) {
		state.responseId = responseId;
		state.createdAt = Math.floor(Date.now() / 1000);
		state.started = true;

		// response.created
		results.push(
			emitEvent('response.created', {
				type: 'response.created',
				sequence_number: nextSeq(),
				response: {
					id: state.responseId,
					object: 'response',
					created_at: state.createdAt,
					status: 'in_progress',
					model,
				},
			}),
		);

		// response.in_progress
		results.push(
			emitEvent('response.in_progress', {
				type: 'response.in_progress',
				sequence_number: nextSeq(),
				response: {
					id: state.responseId,
					object: 'response',
					created_at: state.createdAt,
					status: 'in_progress',
					model,
				},
			}),
		);
	}

	processResponseEvent(event, state, results, nextSeq, emitEvent, model);

	return results;
}

function processResponseEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
	model: string,
): void {
	switch (event.type) {
		case 'token':
			processTokenEvent(event, state, results, nextSeq, emitEvent);
			break;

		case 'reasoning':
		case 'reasoning_summary':
			processReasoningEvent(event, state, results, nextSeq, emitEvent);
			break;

		case 'tool_call':
			processToolCallEvent(event, state, results, nextSeq, emitEvent);
			break;

		case 'tool_call_delta':
			processToolCallDeltaEvent(event, state, results, nextSeq, emitEvent);
			break;

		case 'finish':
			processFinishEvent(event, state, results, nextSeq, emitEvent, model);
			break;
	}
}

function processTokenEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	const idx = 0;
	// Ensure message item and content part are announced
	if (!state.msgItemAdded.has(idx)) {
		results.push(
			emitEvent('response.output_item.added', {
				type: 'response.output_item.added',
				sequence_number: nextSeq(),
				output_index: idx,
				item: {
					id: `msg_${state.responseId}_${idx}`,
					type: 'message',
					status: 'in_progress',
					role: 'assistant',
					content: [],
				},
			}),
		);
		state.msgItemAdded.add(idx);
	}
	if (!state.msgContentAdded.has(idx)) {
		results.push(
			emitEvent('response.content_part.added', {
				type: 'response.content_part.added',
				sequence_number: nextSeq(),
				item_id: `msg_${state.responseId}_${idx}`,
				output_index: idx,
				content_index: 0,
				part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
			}),
		);
		state.msgContentAdded.add(idx);
	}

	// Emit text delta
	if (event.content) {
		results.push(
			emitEvent('response.output_text.delta', {
				type: 'response.output_text.delta',
				sequence_number: nextSeq(),
				item_id: `msg_${state.responseId}_${idx}`,
				output_index: idx,
				content_index: 0,
				delta: event.content,
				logprobs: [],
			}),
		);
		// Aggregate text
		const current = state.msgTextBuf.get(idx) || '';
		state.msgTextBuf.set(idx, current + event.content);
	}
}

function processReasoningEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	const idx = 0;
	// Initialize reasoning item if needed
	if (!state.reasoningId) {
		state.reasoningId = `rs_${state.responseId}_${idx}`;
		state.reasoningIndex = idx;
		results.push(
			emitEvent('response.output_item.added', {
				type: 'response.output_item.added',
				sequence_number: nextSeq(),
				output_index: idx,
				item: {
					id: state.reasoningId,
					type: 'reasoning',
					status: 'in_progress',
					summary: [],
				},
			}),
		);
		results.push(
			emitEvent('response.reasoning_summary_part.added', {
				type: 'response.reasoning_summary_part.added',
				sequence_number: nextSeq(),
				item_id: state.reasoningId,
				output_index: state.reasoningIndex,
				summary_index: 0,
				part: { type: 'summary_text', text: '' },
			}),
		);
	}

	const text = event.reasoning || event.reasoningSummary || '';
	if (text) {
		state.reasoningBuf += text;
		results.push(
			emitEvent('response.reasoning_summary_text.delta', {
				type: 'response.reasoning_summary_text.delta',
				sequence_number: nextSeq(),
				item_id: state.reasoningId,
				output_index: state.reasoningIndex,
				summary_index: 0,
				delta: text,
			}),
		);
	}
}

function processToolCallEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	if (!event.toolCall) return;

	const idx = event.toolCallIndex || 0;
	const callId = event.toolCall.id;
	const name = event.toolCall.name;

	// Close message if open
	if (state.msgItemAdded.has(0) && !state.msgItemDone.has(0)) {
		emitMessageDone(state, results, nextSeq, emitEvent);
	}

	state.funcCallIds.set(idx, callId);
	state.funcNames.set(idx, name);
	state.funcArgsBuf.set(idx, '');

	results.push(
		emitEvent('response.output_item.added', {
			type: 'response.output_item.added',
			sequence_number: nextSeq(),
			output_index: idx,
			item: {
				id: `fc_${callId}`,
				type: 'function_call',
				status: 'in_progress',
				call_id: callId,
				name,
				arguments: '',
			},
		}),
	);
}

function processToolCallDeltaEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	if (!event.toolCall) return;

	const idx = event.toolCallIndex || 0;
	const callId = state.funcCallIds.get(idx) || event.toolCall.id || '';
	const args = event.toolCall.args || '';

	if (args) {
		const current = state.funcArgsBuf.get(idx) || '';
		state.funcArgsBuf.set(idx, current + args);

		results.push(
			emitEvent('response.function_call_arguments.delta', {
				type: 'response.function_call_arguments.delta',
				sequence_number: nextSeq(),
				item_id: `fc_${callId}`,
				output_index: idx,
				delta: args,
			}),
		);
	}

	// If complete, emit done events
	if (event.toolCall.isComplete && !state.funcItemDone.has(idx)) {
		const finalArgs = state.funcArgsBuf.get(idx) || '{}';
		const name = state.funcNames.get(idx) || '';

		results.push(
			emitEvent('response.function_call_arguments.done', {
				type: 'response.function_call_arguments.done',
				sequence_number: nextSeq(),
				item_id: `fc_${callId}`,
				output_index: idx,
				arguments: finalArgs,
			}),
		);

		results.push(
			emitEvent('response.output_item.done', {
				type: 'response.output_item.done',
				sequence_number: nextSeq(),
				output_index: idx,
				item: {
					id: `fc_${callId}`,
					type: 'function_call',
					status: 'completed',
					call_id: callId,
					name,
					arguments: finalArgs,
				},
			}),
		);

		state.funcItemDone.add(idx);
	}
}

function processFinishEvent(
	event: UnifiedEvent,
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
	model: string,
): void {
	// Update usage
	if (event.usage) {
		state.promptTokens = event.usage.promptTokens;
		state.completionTokens = event.usage.completionTokens;
		state.totalTokens = event.usage.totalTokens;
		state.reasoningTokens = event.usage.thoughtsTokenCount || 0;
		state.usageSeen = true;
	}

	// Close any open message
	if (state.msgItemAdded.has(0) && !state.msgItemDone.has(0)) {
		emitMessageDone(state, results, nextSeq, emitEvent);
	}

	// Close reasoning if open
	if (state.reasoningId) {
		emitReasoningDone(state, results, nextSeq, emitEvent);
	}

	// Close any open function calls
	for (const [idx, callId] of state.funcCallIds) {
		if (!state.funcItemDone.has(idx)) {
			const finalArgs = state.funcArgsBuf.get(idx) || '{}';
			const name = state.funcNames.get(idx) || '';

			results.push(
				emitEvent('response.function_call_arguments.done', {
					type: 'response.function_call_arguments.done',
					sequence_number: nextSeq(),
					item_id: `fc_${callId}`,
					output_index: idx,
					arguments: finalArgs,
				}),
			);

			results.push(
				emitEvent('response.output_item.done', {
					type: 'response.output_item.done',
					sequence_number: nextSeq(),
					output_index: idx,
					item: {
						id: `fc_${callId}`,
						type: 'function_call',
						status: 'completed',
						call_id: callId,
						name,
						arguments: finalArgs,
					},
				}),
			);

			state.funcItemDone.add(idx);
		}
	}

	// Build output array for completed response
	const output = buildCompletedOutput(state);

	// response.completed
	const completed: Record<string, unknown> = {
		type: 'response.completed',
		sequence_number: nextSeq(),
		response: {
			id: state.responseId,
			object: 'response',
			created_at: state.createdAt,
			status: 'completed',
			model,
			output,
		},
	};

	if (state.usageSeen) {
		completed.response = {
			...(completed.response as Record<string, unknown>),
			usage: {
				input_tokens: state.promptTokens,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens: state.completionTokens,
				output_tokens_details: state.reasoningTokens
					? { reasoning_tokens: state.reasoningTokens }
					: {},
				total_tokens: state.totalTokens,
			},
		};
	}

	results.push(emitEvent('response.completed', completed));
}

function emitReasoningDone(
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	results.push(
		emitEvent('response.reasoning_summary_text.done', {
			type: 'response.reasoning_summary_text.done',
			sequence_number: nextSeq(),
			item_id: state.reasoningId,
			output_index: state.reasoningIndex,
			summary_index: 0,
			text: state.reasoningBuf,
		}),
	);
	results.push(
		emitEvent('response.reasoning_summary_part.done', {
			type: 'response.reasoning_summary_part.done',
			sequence_number: nextSeq(),
			item_id: state.reasoningId,
			output_index: state.reasoningIndex,
			summary_index: 0,
			part: { type: 'summary_text', text: state.reasoningBuf },
		}),
	);
}

function buildCompletedOutput(state: ResponsesStreamState): Record<string, unknown>[] {
	const output: Record<string, unknown>[] = [];

	if (state.reasoningBuf) {
		output.push({
			id: state.reasoningId,
			type: 'reasoning',
			summary: [{ type: 'summary_text', text: state.reasoningBuf }],
		});
	}

	for (const idx of state.msgItemAdded) {
		const text = state.msgTextBuf.get(idx) || '';
		output.push({
			id: `msg_${state.responseId}_${idx}`,
			type: 'message',
			status: 'completed',
			role: 'assistant',
			content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
		});
	}

	for (const [idx, callId] of state.funcCallIds) {
		output.push({
			id: `fc_${callId}`,
			type: 'function_call',
			status: 'completed',
			call_id: callId,
			name: state.funcNames.get(idx) || '',
			arguments: state.funcArgsBuf.get(idx) || '{}',
		});
	}

	return output;
}

/**
 * Helper to emit message done events
 */
function emitMessageDone(
	state: ResponsesStreamState,
	results: string[],
	nextSeq: () => number,
	emitEvent: (type: string, payload: Record<string, unknown>) => string,
): void {
	const idx = 0;
	const fullText = state.msgTextBuf.get(idx) || '';

	results.push(
		emitEvent('response.output_text.done', {
			type: 'response.output_text.done',
			sequence_number: nextSeq(),
			item_id: `msg_${state.responseId}_${idx}`,
			output_index: idx,
			content_index: 0,
			text: fullText,
			logprobs: [],
		}),
	);

	results.push(
		emitEvent('response.content_part.done', {
			type: 'response.content_part.done',
			sequence_number: nextSeq(),
			item_id: `msg_${state.responseId}_${idx}`,
			output_index: idx,
			content_index: 0,
			part: { type: 'output_text', text: fullText, annotations: [], logprobs: [] },
		}),
	);

	results.push(
		emitEvent('response.output_item.done', {
			type: 'response.output_item.done',
			sequence_number: nextSeq(),
			output_index: idx,
			item: {
				id: `msg_${state.responseId}_${idx}`,
				type: 'message',
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: fullText, annotations: [], logprobs: [] }],
			},
		}),
	);

	state.msgItemDone.add(idx);
}
