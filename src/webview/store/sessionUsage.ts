/**
 * @file sessionUsage.ts
 * @description Pure assistant-message usage aggregation shared by projectors and selectors.
 *              Computes conservative rollups from normalized OpenCode assistant usage only.
 *              Tree aggregation walks parent/child session links with cycle protection and
 *              labels totals as computed UI rollups rather than provider billing truth.
 */

import type { AssistantMessage, Message } from '@opencode-ai/sdk/v2/client';
import { computeTurnUsage, getSnapshotTotal } from '../../common/tokenStats';
import type { SessionStore, TokenUsage } from './chatStore';

export interface AssistantContextSnapshot {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	limit: number;
	usage: number | null;
}

export interface AssistantUsageSummary {
	usageTokens: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	requestCount: number;
	incompleteUsageCount: number;
	latestContext?: AssistantContextSnapshot;
}

export interface SessionTreeUsageStats {
	hasActiveSession: boolean;
	hasActivity: boolean;
	totalTokens: number;
	rootTokens: number;
	childTokens: number;
	requestCount: number;
	childSessionCount: number;
	cost: number;
	durationMs: number;
	cacheRead: number;
	cacheWrite: number;
	incompleteUsageCount: number;
	latestRootContext?: AssistantContextSnapshot;
}

export const EMPTY_SESSION_TREE_USAGE_STATS: SessionTreeUsageStats = {
	hasActiveSession: false,
	hasActivity: false,
	totalTokens: 0,
	rootTokens: 0,
	childTokens: 0,
	requestCount: 0,
	childSessionCount: 0,
	cost: 0,
	durationMs: 0,
	cacheRead: 0,
	cacheWrite: 0,
	incompleteUsageCount: 0,
	latestRootContext: undefined,
};

function isAssistantMessage(msg: Message): msg is AssistantMessage {
	return msg.role === 'assistant';
}

function getAssistantDurationMs(msg: AssistantMessage): number {
	if (typeof msg.time.completed !== 'number') return 0;
	return msg.time.completed >= msg.time.created ? msg.time.completed - msg.time.created : 0;
}

function getAssistantCost(msg: AssistantMessage): number {
	return typeof msg.cost === 'number' && msg.cost > 0 ? msg.cost : 0;
}

function hasAssistantActivity(msg: AssistantMessage, snapshotTotal: number): boolean {
	return snapshotTotal > 0 || getAssistantCost(msg) > 0 || getAssistantDurationMs(msg) > 0;
}

export function computeAssistantUsageSummary(
	messages: Message[] | undefined,
	contextLimit = 0,
): AssistantUsageSummary {
	let previousSessionSnapshotTotal = 0;
	let usageTokens = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let durationMs = 0;
	let requestCount = 0;
	let incompleteUsageCount = 0;
	let latestContext: AssistantContextSnapshot | undefined;

	if (!messages || messages.length === 0) {
		return {
			usageTokens,
			inputTokens,
			outputTokens,
			reasoningTokens,
			cacheRead,
			cacheWrite,
			cost,
			durationMs,
			requestCount,
			incompleteUsageCount,
			latestContext,
		};
	}

	for (const msg of messages) {
		if (!isAssistantMessage(msg)) continue;
		const snapshotTotal = getSnapshotTotal(msg.tokens);
		const messageDurationMs = getAssistantDurationMs(msg);
		const messageCost = getAssistantCost(msg);
		if (!hasAssistantActivity(msg, snapshotTotal)) continue;

		requestCount += 1;
		cost += messageCost;
		durationMs += messageDurationMs;
		inputTokens += msg.tokens.input ?? 0;
		outputTokens += msg.tokens.output ?? 0;
		reasoningTokens += msg.tokens.reasoning ?? 0;
		cacheRead += msg.tokens.cache?.read ?? 0;
		cacheWrite += msg.tokens.cache?.write ?? 0;

		if (snapshotTotal > 0) {
			const usage = computeTurnUsage(msg.tokens, { previousSessionSnapshotTotal });
			usageTokens += usage.usageTokens;
			previousSessionSnapshotTotal = usage.nextSessionSnapshotTotal;
			latestContext = {
				input: msg.tokens.input ?? 0,
				output: msg.tokens.output ?? 0,
				reasoning: msg.tokens.reasoning ?? 0,
				cacheRead: msg.tokens.cache?.read ?? 0,
				cacheWrite: msg.tokens.cache?.write ?? 0,
				total: snapshotTotal,
				limit: contextLimit,
				usage: contextLimit > 0 ? Math.min((snapshotTotal / contextLimit) * 100, 100) : null,
			};
			continue;
		}

		incompleteUsageCount += 1;
	}

	return {
		usageTokens,
		inputTokens,
		outputTokens,
		reasoningTokens,
		cacheRead,
		cacheWrite,
		cost,
		durationMs,
		requestCount,
		incompleteUsageCount,
		latestContext,
	};
}

export function computeAssistantUsage(messages: Message[] | undefined): TokenUsage | undefined {
	const summary = computeAssistantUsageSummary(messages);
	if (summary.usageTokens <= 0) return undefined;
	return {
		input: summary.latestContext?.input ?? 0,
		output: summary.latestContext?.output ?? 0,
		total: summary.usageTokens,
		usage: summary.usageTokens,
		cacheRead: summary.latestContext?.cacheRead ?? 0,
		cacheWrite: summary.latestContext?.cacheWrite ?? 0,
		durationMs: summary.durationMs,
	};
}

function collectSessionTreeIds(
	childSessionIdsByParentId: Record<string, string[]>,
	sessionId: string,
): string[] {
	const visited = new Set([sessionId]);
	const sessionIds = [sessionId];
	const queue = [...(childSessionIdsByParentId[sessionId] ?? [])];
	let head = 0;

	while (head < queue.length) {
		const currentSessionId = queue[head++];
		if (!currentSessionId || visited.has(currentSessionId)) continue;
		visited.add(currentSessionId);
		sessionIds.push(currentSessionId);
		queue.push(...(childSessionIdsByParentId[currentSessionId] ?? []));
	}

	return sessionIds;
}

export function computeSessionTreeUsageStats(
	state: Pick<SessionStore, 'messages' | 'childSessionIdsByParentId'>,
	sessionId: string | undefined,
	contextLimit = 0,
): SessionTreeUsageStats {
	if (!sessionId) return EMPTY_SESSION_TREE_USAGE_STATS;

	const sessionIds = collectSessionTreeIds(state.childSessionIdsByParentId, sessionId);
	let rootTokens = 0;
	let childTokens = 0;
	let requestCount = 0;
	let cost = 0;
	let durationMs = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let incompleteUsageCount = 0;
	let latestRootContext: AssistantContextSnapshot | undefined;

	for (const currentSessionId of sessionIds) {
		const summary = computeAssistantUsageSummary(
			state.messages[currentSessionId],
			currentSessionId === sessionId ? contextLimit : 0,
		);
		if (currentSessionId === sessionId) {
			rootTokens = summary.usageTokens;
			latestRootContext = summary.latestContext;
		} else {
			childTokens += summary.usageTokens;
		}
		requestCount += summary.requestCount;
		cost += summary.cost;
		durationMs += summary.durationMs;
		cacheRead += summary.cacheRead;
		cacheWrite += summary.cacheWrite;
		incompleteUsageCount += summary.incompleteUsageCount;
	}

	const totalTokens = rootTokens + childTokens;

	return {
		hasActiveSession: true,
		hasActivity: requestCount > 0,
		totalTokens,
		rootTokens,
		childTokens,
		requestCount,
		childSessionCount: Math.max(0, sessionIds.length - 1),
		cost,
		durationMs,
		cacheRead,
		cacheWrite,
		incompleteUsageCount,
		latestRootContext,
	};
}
