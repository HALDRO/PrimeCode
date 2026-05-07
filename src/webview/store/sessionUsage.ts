/**
 * @file sessionUsage.ts
 * @description Pure session usage aggregation shared by projectors and selectors for child-session summaries.
 */

import type { AssistantMessage, Message } from '@opencode-ai/sdk/v2/client';
import { computeTurnUsage, getSnapshotTotal } from '../../common/tokenStats';
import type { TokenUsage } from './chatStore';

function isAssistantMessage(msg: Message): msg is AssistantMessage {
	return msg.role === 'assistant';
}

export function computeAssistantUsage(messages: Message[] | undefined): TokenUsage | undefined {
	if (!messages || messages.length === 0) return undefined;

	let previousSessionSnapshotTotal = 0;
	let usageTotal = 0;
	let latestInput = 0;
	let latestOutput = 0;
	let latestCacheRead = 0;
	let durationMs = 0;

	for (const msg of messages) {
		if (!isAssistantMessage(msg)) continue;
		const snapshotTotal = getSnapshotTotal(msg.tokens);
		if (snapshotTotal > 0) {
			const usage = computeTurnUsage(msg.tokens, { previousSessionSnapshotTotal });
			usageTotal += usage.usageTokens;
			previousSessionSnapshotTotal = usage.nextSessionSnapshotTotal;
			latestInput = msg.tokens.input ?? 0;
			latestOutput = msg.tokens.output ?? 0;
			latestCacheRead = msg.tokens.cache?.read ?? 0;
		}
		if (typeof msg.time.completed === 'number') {
			durationMs += msg.time.completed - msg.time.created;
		}
	}

	if (usageTotal <= 0) return undefined;
	return {
		input: latestInput,
		output: latestOutput,
		total: usageTotal,
		usage: usageTotal,
		cacheRead: latestCacheRead,
		durationMs,
	};
}
