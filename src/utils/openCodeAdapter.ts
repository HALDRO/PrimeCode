/**
 * @file OpenCode message conversion
 * @description Converts OpenCode SDK message structures into the unified ConversationMessage
 * format used across the entire system. Ensures strict alignment between CLI outputs,
 * storage, and UI representation without intermediate mapping.
 */

import type { ConversationMessage } from '../types';

export interface OpenCodeMessage {
	info: {
		id: string;
		role: 'user' | 'assistant';
		timestamp?: number;
		[key: string]: unknown;
	};
	parts: Array<{
		id?: string;
		type: string;
		text?: string;
		tool?: string;
		callID?: string;
		state?: {
			input?: unknown;
			output?: string;
			error?: string;
			status?: string;
		};
		// Extended reasoning fields
		reasoning_text?: string;
		reasoning_opaque?: string;
		cot_id?: string;
		cot_summary?: string;
		signature?: string;
		// Step fields
		cost?: number;
		tokens?: {
			input?: number;
			output?: number;
			reasoning?: number;
			cache?: { read?: number; write?: number };
		};
		[key: string]: unknown;
	}>;
}

/**
 * Convert OpenCode messages to unified ConversationMessage format
 */
export function convertOpenCodeMessagesToStorage(
	messages: OpenCodeMessage[],
): ConversationMessage[] {
	const storageMessages: ConversationMessage[] = [];

	for (const msg of messages) {
		const { info, parts } = msg;
		const timestamp =
			typeof info.timestamp === 'number'
				? new Date(info.timestamp).toISOString()
				: new Date().toISOString();

		if (info.role === 'user') {
			const text = parts
				.filter(p => p.type === 'text')
				.map(p => p.text || '')
				.join('');

			storageMessages.push({
				id: info.id,
				timestamp,
				type: 'user',
				content: text,
			});
		} else if (info.role === 'assistant') {
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const partId = part.id || `${info.id}-${i}`;

				switch (part.type) {
					case 'text':
						if (part.text) {
							storageMessages.push({
								id: partId,
								timestamp,
								type: 'assistant',
								content: part.text,
							});
						}
						break;

					case 'tool':
					case 'tool-invocation': {
						const input = part.state?.input as Record<string, unknown> | undefined;
						const filePath =
							(input?.filePath as string) ||
							(input?.file_path as string) ||
							(input?.path as string) ||
							(input?.target_file as string) ||
							undefined;

						storageMessages.push({
							id: partId,
							timestamp,
							type: 'tool_use',
							toolUseId: part.callID || part.id || partId,
							toolName: part.tool || 'unknown',
							toolInput: part.state?.input ? JSON.stringify(part.state.input) : '',
							rawInput: input || {},
							filePath,
						});

						if (part.state?.status === 'completed' || part.state?.status === 'error') {
							storageMessages.push({
								id: `${partId}-result`,
								timestamp,
								type: 'tool_result',
								toolUseId: part.callID || part.id || partId,
								toolName: part.tool || 'unknown',
								content: part.state.output || part.state.error || '',
								isError: part.state.status === 'error',
							});
						}
						break;
					}

					case 'thinking':
					case 'reasoning': {
						const thinkingContent = part.text || part.reasoning_text || '';
						if (thinkingContent) {
							storageMessages.push({
								id: partId,
								timestamp,
								type: 'thinking',
								content: thinkingContent,
							});
						}
						break;
					}

					default:
						if (part.text) {
							storageMessages.push({
								id: partId,
								timestamp,
								type: 'assistant',
								content: part.text,
							});
						}
						break;
				}
			}
		}
	}

	return storageMessages;
}
