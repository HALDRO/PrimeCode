/**
 * @file eventToMessage — shared CLI event → SessionMessageData mapper
 * @description Pure functions that extract SessionMessageData from CLIEvent payloads.
 * Eliminates duplication between ChatProvider (live), SessionHandler.replayHistoryIntoSession,
 * and SessionHandler.buildTranscriptFromHistory.
 *
 * Each mapper returns a SessionMessageData object. Callers are responsible for:
 * - Side effects (postSessionMessage, postComplete, routeToParentTranscript)
 * - Lifecycle management (activeThinkingPartIds, activeAssistantPartIds)
 * - Subtask enrichment (transcript, childTokens, durationMs) during replay
 */

import type { NormalizedEntry } from '../common/normalizedTypes';
import type {
	AssistantMessageData,
	ErrorMessageData,
	SessionMessageData,
	ThinkingMessageData,
	ToolResultMessageData,
	ToolUseMessageData,
	UserMessageData,
} from '../common/protocol';

// =============================================================================
// Options
// =============================================================================

export interface MapperOptions {
	/** ID prefix for fallback IDs (e.g. 'hist', 'child'). Default: none. */
	idPrefix?: string;
	/** NormalizedEntry to attach to the message. */
	normalizedEntry?: NormalizedEntry;
}

// =============================================================================
// Helpers
// =============================================================================

function fallbackId(prefix: string, idPrefix?: string): string {
	const tag = idPrefix ? `${idPrefix}-` : '';
	return `${tag}${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function resolveTimestamp(dataTimestamp?: string): string {
	return dataTimestamp || new Date().toISOString();
}

/**
 * Extract filePath from tool input using the common cascade:
 * `filePath` → `file_path` → `path`
 */
export function extractFilePath(input: Record<string, unknown>): string | undefined {
	if (typeof input.filePath === 'string') return input.filePath;
	if (typeof input.file_path === 'string') return input.file_path;
	if (typeof input.path === 'string') return input.path;
	return undefined;
}

// =============================================================================
// Mappers
// =============================================================================

/** Map a `message` CLI event to an AssistantMessageData. */
export function mapMessageEvent(
	data: { content?: string; partId?: string; timestamp?: string },
	opts?: MapperOptions,
): AssistantMessageData {
	const partId = data.partId;
	return {
		id: partId ? `msg-${partId}` : fallbackId('msg', opts?.idPrefix),
		type: 'assistant',
		content: data.content || '',
		isDelta: false,
		timestamp: resolveTimestamp(data.timestamp),
		normalizedEntry: opts?.normalizedEntry,
	};
}

/** Map a `thinking` CLI event to a ThinkingMessageData. */
export function mapThinkingEvent(
	data: { content?: string; partId?: string; timestamp?: string; durationMs?: number },
	opts?: MapperOptions,
): ThinkingMessageData {
	return {
		id: data.partId ? `thinking-${data.partId}` : fallbackId('thinking', opts?.idPrefix),
		type: 'thinking',
		content: data.content || '',
		isDelta: false,
		isStreaming: false,
		timestamp: resolveTimestamp(data.timestamp),
		...(data.durationMs ? { durationMs: data.durationMs } : {}),
	};
}

/** Map a `tool_use` CLI event to a ToolUseMessageData. */
export function mapToolUseEvent(
	data: {
		id?: string;
		tool?: string;
		name?: string;
		input?: unknown;
		toolUseId?: string;
		timestamp?: string;
	},
	opts?: MapperOptions,
): ToolUseMessageData {
	const toolUseId = data.toolUseId || data.id || fallbackId('tool', opts?.idPrefix);
	const toolName = data.tool || data.name || 'unknown';
	const input = (data.input as Record<string, unknown>) || {};
	const filePath = extractFilePath(input);

	return {
		id: toolUseId,
		type: 'tool_use',
		toolName,
		toolUseId,
		rawInput: input,
		toolInput: JSON.stringify(input),
		...(filePath ? { filePath } : {}),
		timestamp: resolveTimestamp(data.timestamp),
		normalizedEntry: opts?.normalizedEntry,
	};
}

/** Map a `tool_result` CLI event to a ToolResultMessageData. */
export function mapToolResultEvent(
	data: {
		tool_use_id?: string;
		id?: string;
		tool?: string;
		name?: string;
		content?: string | unknown;
		is_error?: boolean;
		title?: string;
		metadata?: unknown;
		timestamp?: string;
	},
	opts?: MapperOptions,
): ToolResultMessageData {
	const toolUseId = data.tool_use_id || data.id || fallbackId('tool', opts?.idPrefix);
	const toolName = data.tool || data.name || 'unknown';
	const content =
		typeof data.content === 'string'
			? data.content
			: data.content
				? JSON.stringify(data.content)
				: '';
	const metadata =
		data.metadata && typeof data.metadata === 'object'
			? (data.metadata as Record<string, unknown>)
			: undefined;

	return {
		id: `res-${toolUseId}`,
		type: 'tool_result',
		toolName,
		toolUseId,
		content,
		isError: Boolean(data.is_error),
		...(typeof data.title === 'string' ? { title: data.title } : {}),
		...(metadata ? { metadata } : {}),
		timestamp: resolveTimestamp(data.timestamp),
		normalizedEntry: opts?.normalizedEntry,
	};
}

/** Map a `normalized_log` (role=user) CLI event to a UserMessageData. */
export function mapUserEvent(
	data: {
		content?: string;
		timestamp?: string;
		messageId?: string;
		attachments?: UserMessageData['attachments'];
	},
	opts?: MapperOptions,
): UserMessageData {
	return {
		id: data.messageId?.trim() || `msg-local-${Math.random().toString(36).slice(2, 9)}`,
		type: 'user',
		content: data.content || '',
		timestamp: resolveTimestamp(data.timestamp),
		normalizedEntry: opts?.normalizedEntry,
		...(data.attachments ? { attachments: data.attachments } : {}),
	};
}

/** Map an `error` CLI event to an ErrorMessageData. */
export function mapErrorEvent(data: { message: string }, opts?: MapperOptions): ErrorMessageData {
	return {
		id: fallbackId('error', opts?.idPrefix),
		type: 'error',
		content: data.message || 'Unknown error',
		isError: true,
		timestamp: new Date().toISOString(),
		normalizedEntry: opts?.normalizedEntry,
	};
}

/**
 * Convert an array of CLI events into a SessionMessageData transcript.
 * Handles: message, thinking, tool_use, tool_result.
 * Used for building subtask transcripts from child session history.
 */
export function buildTranscript(
	events: Array<{ type: string; data: unknown; normalizedEntry?: NormalizedEntry }>,
	idPrefix = 'child',
): SessionMessageData[] {
	const transcript: SessionMessageData[] = [];
	for (const event of events) {
		const opts: MapperOptions = { idPrefix, normalizedEntry: event.normalizedEntry };
		const data = event.data as Record<string, unknown>;
		switch (event.type) {
			case 'message':
				transcript.push(mapMessageEvent(data as Parameters<typeof mapMessageEvent>[0], opts));
				break;
			case 'thinking':
				transcript.push(mapThinkingEvent(data as Parameters<typeof mapThinkingEvent>[0], opts));
				break;
			case 'tool_use':
				transcript.push(mapToolUseEvent(data as Parameters<typeof mapToolUseEvent>[0], opts));
				break;
			case 'tool_result':
				transcript.push(mapToolResultEvent(data as Parameters<typeof mapToolResultEvent>[0], opts));
				break;
		}
	}
	return transcript;
}
