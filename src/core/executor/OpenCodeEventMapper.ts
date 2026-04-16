import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import type { SessionMessagePartPayload, SessionMessageRecordPayload } from '../../common';

type MessageWithRuntimeFields = Message & {
	parentID?: string;
	modelID?: string;
	providerID?: string;
	mode?: string;
	cost?: number;
};

function asPartTime(part: Part): { start?: number; end?: number } | undefined {
	const time = Reflect.get(part as object, 'time');
	return time && typeof time === 'object' ? (time as { start?: number; end?: number }) : undefined;
}

function asToolStateTime(part: Part): { start?: number; end?: number } | undefined {
	if (part.type !== 'tool') return undefined;
	const state = Reflect.get(part as object, 'state');
	if (!state || typeof state !== 'object') return undefined;
	const time = Reflect.get(state as object, 'time');
	return time && typeof time === 'object' ? (time as { start?: number; end?: number }) : undefined;
}

export function mapSdkMessageToRecord(
	info: Message,
	options?: { agent?: string },
): SessionMessageRecordPayload['message'] {
	const message = info as MessageWithRuntimeFields;
	const completedAtValue = Reflect.get(info.time as object, 'completed');
	const completedAt = typeof completedAtValue === 'number' ? completedAtValue : undefined;
	return {
		id: info.id,
		sessionId: info.sessionID,
		role: info.role,
		parentId: message.parentID,
		createdAt: info.time?.created,
		completedAt,
		modelId: message.modelID,
		providerId: message.providerID,
		agent: options?.agent ?? (typeof message.mode === 'string' ? message.mode : undefined),
		tokens:
			info.role === 'assistant'
				? {
						input: info.tokens.input,
						output: info.tokens.output,
						reasoning: info.tokens.reasoning,
						cacheRead: info.tokens.cache.read,
						cacheWrite: info.tokens.cache.write,
						total:
							typeof info.tokens.total === 'number'
								? info.tokens.total
								: info.tokens.input + info.tokens.output,
					}
				: undefined,
		cost: typeof message.cost === 'number' ? message.cost : undefined,
	};
}

export function mapSdkPartToPayload(
	part: Part,
	messageId: string,
	sessionId: string,
): SessionMessagePartPayload['part'] {
	const partTime = asPartTime(part) ?? asToolStateTime(part);
	return {
		id: typeof part.id === 'string' ? part.id : messageId,
		messageId,
		sessionId,
		type:
			part.type === 'text' ||
			part.type === 'reasoning' ||
			part.type === 'tool' ||
			part.type === 'file' ||
			part.type === 'compaction'
				? part.type
				: 'other',
		text: 'text' in part ? part.text : undefined,
		callId: 'callID' in part ? part.callID : undefined,
		toolName: 'tool' in part ? part.tool : undefined,
		state: 'state' in part ? (part.state as SessionMessagePartPayload['part']['state']) : undefined,
		createdAt: partTime?.start,
		completedAt: partTime?.end,
		mime: 'mime' in part ? part.mime : undefined,
		url: 'url' in part ? part.url : undefined,
		filename: 'filename' in part ? part.filename : undefined,
		synthetic: 'synthetic' in part ? part.synthetic : undefined,
		auto: 'auto' in part ? part.auto : undefined,
	};
}
