/**
 * @file API Format Converter
 * @description High-level API for converting between Claude and OpenAI formats.
 * Provides simple functions for the most common use cases.
 */

// Re-export fromIR generators
export {
	type ClaudeStreamState,
	createClaudeStreamState,
	toClaudeRequest,
	toClaudeResponse,
	toClaudeSSE,
} from './fromIR/claude';
export {
	createResponsesStreamState,
	formatOpenAISSE,
	formatOpenAISSEDone,
	type ResponsesStreamState,
	toOpenAIChatCompletion,
	toOpenAIChunk,
	toOpenAIRequest,
	toOpenAIResponsesRequest,
	toOpenAIResponsesResponse,
	toOpenAIResponsesSSE,
} from './fromIR/openai';

// Re-export IR types
export * from './ir/types';

// Re-export toIR parsers
export {
	parseClaudeChunk,
	parseClaudeRequest,
	parseClaudeResponse,
} from './toIR/claude';
export {
	parseOpenAIChunk,
	parseOpenAIRequest,
	parseOpenAIResponse,
} from './toIR/openai';

import { logger } from '../../utils/logger';
import {
	type ClaudeStreamState,
	createClaudeStreamState,
	toClaudeResponse,
	toClaudeSSE,
} from './fromIR/claude';
import {
	createResponsesStreamState,
	formatOpenAISSE,
	formatOpenAISSEDone,
	type ResponsesStreamState,
	toOpenAIChunk,
	toOpenAIRequest,
	toOpenAIResponsesRequest,
	toOpenAIResponsesSSE,
} from './fromIR/openai';
import { parseClaudeChunk, parseClaudeRequest } from './toIR/claude';
import { parseOpenAIChunk, parseOpenAIResponse } from './toIR/openai';

// =============================================================================
// High-Level Conversion Functions
// =============================================================================

export interface ConversionResult<T> {
	success: boolean;
	data?: T;
	error?: string;
}

/**
 * Convert Claude request to OpenAI request format
 * Use this when you have a Claude Messages API request and need to send it to an OpenAI-compatible endpoint
 */
export function claudeRequestToOpenAI(
	claudeRequest: string | Record<string, unknown>,
): Record<string, unknown> {
	const ir = parseClaudeRequest(claudeRequest);
	return toOpenAIRequest(ir);
}

/**
 * Safe wrapper for Claude → OpenAI request conversion
 */
export function safeClaudeRequestToOpenAI(
	claudeRequest: string | Record<string, unknown>,
): ConversionResult<Record<string, unknown>> {
	try {
		const result = claudeRequestToOpenAI(claudeRequest);
		return { success: true, data: result };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown conversion error',
		};
	}
}

/**
 * Convert OpenAI response to Claude response format
 * Use this when you receive an OpenAI response and need to return it in Claude format
 */
export function openAIResponseToClaude(
	openAIResponse: string | Record<string, unknown>,
	model: string,
	messageId: string,
): Record<string, unknown> {
	const { messages, usage } = parseOpenAIResponse(openAIResponse);
	return toClaudeResponse(messages, usage, model, messageId);
}

/**
 * Safe wrapper for OpenAI → Claude response conversion
 */
export function safeOpenAIResponseToClaude(
	openAIResponse: string | Record<string, unknown>,
	model: string,
	messageId: string,
): ConversionResult<Record<string, unknown>> {
	try {
		const result = openAIResponseToClaude(openAIResponse, model, messageId);
		return { success: true, data: result };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown conversion error',
		};
	}
}

/**
 * Convert Claude request to OpenAI Responses API format
 * Use this when you need to send a Claude request to OpenAI's /v1/responses endpoint
 */
export function claudeRequestToOpenAIResponses(
	claudeRequest: string | Record<string, unknown>,
): Record<string, unknown> {
	const ir = parseClaudeRequest(claudeRequest);
	return toOpenAIResponsesRequest(ir);
}

/**
 * Convert OpenAI Responses API response to Claude format
 */
export function openAIResponsesToClaudeResponse(
	openAIResponse: string | Record<string, unknown>,
	model: string,
	messageId: string,
): Record<string, unknown> {
	const { messages, usage } = parseOpenAIResponse(openAIResponse);
	return toClaudeResponse(messages, usage, model, messageId);
}

// =============================================================================
// Streaming Converters
// =============================================================================

/**
 * Streaming converter for Claude → OpenAI direction
 * Converts Claude SSE chunks to OpenAI SSE format
 */
export class ClaudeToOpenAIStreamConverter {
	private chunkIndex = 0;
	private model: string;
	private messageId: string;

	constructor(model: string, messageId?: string) {
		this.model = model;
		this.messageId = messageId || `chatcmpl-${Date.now()}`;
	}

	/**
	 * Convert a Claude SSE chunk to OpenAI SSE format
	 * Returns null if the chunk doesn't produce output
	 */
	convertChunk(claudeChunk: string): string | null {
		const events = parseClaudeChunk(claudeChunk);
		if (events.length === 0) {
			return null;
		}

		const results: string[] = [];
		for (const event of events) {
			const chunk = toOpenAIChunk(event, this.model, this.messageId, this.chunkIndex++);
			if (chunk) {
				results.push(formatOpenAISSE(chunk));
			}
		}

		return results.length > 0 ? results.join('') : null;
	}

	/**
	 * Get the done marker for OpenAI streaming
	 */
	getDoneMarker(): string {
		return formatOpenAISSEDone();
	}
}

/**
 * Streaming converter for OpenAI → Claude direction
 * Converts OpenAI SSE chunks to Claude SSE format
 */
export class OpenAIToClaudeStreamConverter {
	private state: ClaudeStreamState;
	private model: string;
	private messageId: string;
	private _loggedCount: number = 0;

	constructor(model: string, messageId?: string) {
		this.model = model;
		this.messageId = messageId || `msg_${Date.now()}`;
		this.state = createClaudeStreamState();
	}

	/**
	 * Convert an OpenAI SSE chunk to Claude SSE format
	 * Returns null if the chunk doesn't produce output
	 */
	convertChunk(openAIChunk: string): string | null {
		const events = parseOpenAIChunk(openAIChunk);
		if (events.length === 0) {
			return null;
		}

		// Log parsed events (rate-limited; log first few per converter instance)
		const maxPreview = 80;
		const shouldLog = this._loggedCount < 3 || Math.random() < 0.03;
		if (shouldLog) {
			for (const event of events) {
				logger.info(
					`[Converter] IR event: type=${event.type}, contentPreview="${(event.content || '').substring(0, maxPreview)}", ` +
						`hasToolCall=${!!event.toolCall}, toolName=${event.toolCall?.name || 'none'}, ` +
						`toolArgsPreview="${(event.toolCall?.args || '').substring(0, maxPreview)}"`,
				);
			}
		}
		this._loggedCount += events.length;

		const results: string[] = [];
		for (const event of events) {
			const sse = toClaudeSSE(event, this.model, this.messageId, this.state);
			if (sse) {
				results.push(sse);
			}
		}

		return results.length > 0 ? results.join('') : null;
	}
}

/**
 * Streaming converter for Claude → OpenAI Responses API direction
 * Converts Claude SSE chunks to OpenAI Responses API SSE format
 */
export class ClaudeToOpenAIResponsesStreamConverter {
	private state: ResponsesStreamState;
	private model: string;
	private responseId: string;

	constructor(model: string, responseId?: string) {
		this.model = model;
		this.responseId = responseId || `resp_${Date.now()}`;
		this.state = createResponsesStreamState();
	}

	/**
	 * Convert a Claude SSE chunk to OpenAI Responses API SSE format
	 * Returns null if the chunk doesn't produce output
	 */
	convertChunk(claudeChunk: string): string | null {
		const events = parseClaudeChunk(claudeChunk);
		if (events.length === 0) {
			return null;
		}

		const results: string[] = [];
		for (const event of events) {
			const sseEvents = toOpenAIResponsesSSE(event, this.model, this.responseId, this.state);
			results.push(...sseEvents);
		}

		return results.length > 0 ? results.join('') : null;
	}
}

/**
 * Streaming converter for OpenAI → OpenAI Responses API direction
 * Converts OpenAI Chat Completions SSE chunks to OpenAI Responses API SSE format
 */
export class OpenAIToResponsesStreamConverter {
	private state: ResponsesStreamState;
	private model: string;
	private responseId: string;

	constructor(model: string, responseId?: string) {
		this.model = model;
		this.responseId = responseId || `resp_${Date.now()}`;
		this.state = createResponsesStreamState();
	}

	/**
	 * Convert an OpenAI Chat Completions SSE chunk to OpenAI Responses API SSE format
	 * Returns null if the chunk doesn't produce output
	 */
	convertChunk(openAIChunk: string): string | null {
		const events = parseOpenAIChunk(openAIChunk);
		if (events.length === 0) {
			return null;
		}

		const results: string[] = [];
		for (const event of events) {
			const sseEvents = toOpenAIResponsesSSE(event, this.model, this.responseId, this.state);
			results.push(...sseEvents);
		}

		return results.length > 0 ? results.join('') : null;
	}
}
