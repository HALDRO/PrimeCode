import type { AssistantMessage, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../chatStore';
import { collectDescendantSessionIds, computeDerivedSessionStats } from '../selectors';
import { computeSessionTreeUsageStats } from '../sessionUsage';

function assistantMessage(
	id: string,
	options: {
		total: number;
		input?: number;
		output?: number;
		reasoning?: number;
		created: number;
		completed: number;
		cost?: number;
		cacheRead?: number;
		cacheWrite?: number;
	},
): AssistantMessage {
	return {
		id,
		sessionID: 'session',
		parentID: 'parent',
		role: 'assistant',
		modelID: 'gpt-5',
		providerID: 'oai',
		mode: 'default',
		path: '',
		stopReason: 'end_turn',
		parts: [],
		time: { created: options.created, completed: options.completed },
		tokens: {
			input: options.input ?? 0,
			output: options.output ?? 0,
			reasoning: options.reasoning ?? 0,
			total: options.total,
			cache: { read: options.cacheRead ?? 0, write: options.cacheWrite ?? 0 },
		},
		cost: options.cost ?? 0,
	} as unknown as AssistantMessage;
}

function createState(overrides: Partial<SessionStore>): SessionStore {
	return {
		sessions: [],
		sessionStatus: {} as Record<string, SessionStatus>,
		sessionDiff: {},
		messages: {},
		parts: {},
		todos: {},
		permissions: {},
		questions: {},
		activeSessionId: 'root',
		sessionOrder: [],
		editingMessageId: null,
		editDrafts: {},
		sessionInput: {},
		draftAttachments: {},
		draftAgent: {},
		improvingPromptRequestId: null,
		isImprovingPrompt: false,
		promptVersions: { original: '', improved: '', showingImproved: false },
		sessionAutoAccept: {},
		sessionModel: {},
		sessionAgent: {},
		childSessionIdsByParentId: {},
		originatingToolCallBySessionId: {},
		actions: {} as SessionStore['actions'],
		...overrides,
	} as SessionStore;
}

describe('selectors nested subtasks', () => {
	it('collects descendant session ids recursively', () => {
		const state = createState({
			childSessionIdsByParentId: {
				root: ['child-a', 'child-b'],
				'child-a': ['grandchild-a1'],
				'grandchild-a1': ['great-grandchild-a1'],
			},
		});

		expect(collectDescendantSessionIds(state, 'root')).toEqual([
			'child-a',
			'child-b',
			'grandchild-a1',
			'great-grandchild-a1',
		]);
	});

	it('aggregates assistant response count and subagent count across nested descendants', () => {
		const state = createState({
			messages: {
				root: [
					assistantMessage('a-root-1', { total: 100, created: 0, completed: 10 }),
					assistantMessage('a-root-2', { total: 140, created: 10, completed: 25 }),
				],
				child: [assistantMessage('a-child', { total: 50, created: 25, completed: 45 })],
				grandchild: [assistantMessage('a-grandchild', { total: 25, created: 45, completed: 75 })],
				leaf: [assistantMessage('a-leaf', { total: 0, created: 75, completed: 95 })],
			},
			childSessionIdsByParentId: {
				root: ['child'],
				child: ['grandchild'],
				grandchild: ['leaf'],
			},
		});

		expect(computeDerivedSessionStats(state, 'root')).toEqual({
			requestCount: 5,
			totalDuration: 95,
			subagentCount: 3,
		});
	});

	it('counts child sessions with assistant activity even when token totals are zero', () => {
		const state = createState({
			messages: {
				child: [assistantMessage('a-child', { total: 0, created: 100, completed: 160 })],
			},
		});

		expect(computeDerivedSessionStats(state, 'child')).toEqual({
			requestCount: 1,
			totalDuration: 60,
			subagentCount: 0,
		});
	});

	it('computes recursive active tree token rollups and avoids child cycles', () => {
		const state = createState({
			messages: {
				root: [
					assistantMessage('a-root-1', { total: 100, created: 0, completed: 10, cost: 0.01 }),
					assistantMessage('a-root-2', {
						total: 150,
						input: 90,
						output: 40,
						reasoning: 15,
						created: 10,
						completed: 25,
						cost: 0.02,
						cacheRead: 20,
						cacheWrite: 5,
					}),
				],
				child: [
					assistantMessage('a-child', {
						total: 60,
						input: 25,
						output: 20,
						created: 25,
						completed: 45,
						cost: 0.03,
					}),
				],
				grandchild: [
					assistantMessage('a-grandchild', {
						total: 85,
						input: 45,
						output: 30,
						created: 45,
						completed: 70,
					}),
				],
			},
			childSessionIdsByParentId: {
				root: ['child'],
				child: ['grandchild'],
				grandchild: ['root'],
			},
		});

		const stats = computeSessionTreeUsageStats(state, 'root', 200);
		expect(stats).toMatchObject({
			hasActiveSession: true,
			hasActivity: true,
			totalTokens: 265,
			totalInputTokens: 175,
			totalOutputTokens: 90,
			rootTokens: 145,
			rootInputTokens: 105,
			rootOutputTokens: 40,
			childTokens: 120,
			childInputTokens: 70,
			childOutputTokens: 50,
			requestCount: 4,
			childSessionCount: 2,
			cost: 0.06,
			durationMs: 70,
			cacheRead: 20,
			cacheWrite: 5,
			incompleteUsageCount: 0,
		});
		expect(stats.latestRootContext).toMatchObject({
			input: 90,
			output: 40,
			reasoning: 15,
			total: 150,
			limit: 200,
			usage: 75,
			cacheRead: 20,
			cacheWrite: 5,
		});
	});

	it('warns when assistant activity exists without usage fields', () => {
		const state = createState({
			messages: {
				root: [assistantMessage('a-root', { total: 0, created: 100, completed: 150 })],
			},
		});

		expect(computeSessionTreeUsageStats(state, 'root')).toMatchObject({
			hasActivity: true,
			totalTokens: 0,
			requestCount: 1,
			durationMs: 50,
			incompleteUsageCount: 1,
		});
	});

	it('returns nested descendant count for child summary source data', () => {
		const state = createState({
			childSessionIdsByParentId: {
				child: ['grandchild-a', 'grandchild-b'],
				'grandchild-a': ['great-grandchild'],
			},
		});

		expect(collectDescendantSessionIds(state, 'child')).toHaveLength(3);
	});
});
