import type { AssistantMessage, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../chatStore';
import { collectDescendantSessionIds, computeDerivedSessionStats } from '../selectors';

function assistantMessage(
	id: string,
	options: { total: number; created: number; completed: number },
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
			input: 0,
			output: 0,
			reasoning: 0,
			total: options.total,
			cache: { read: 0, write: 0 },
		},
		cost: 0,
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

	it('aggregates request count and subagent count across nested descendants', () => {
		const state = createState({
			messages: {
				root: [assistantMessage('a-root', { total: 100, created: 0, completed: 10 })],
				child: [assistantMessage('a-child', { total: 50, created: 10, completed: 30 })],
				grandchild: [assistantMessage('a-grandchild', { total: 25, created: 30, completed: 60 })],
				leaf: [assistantMessage('a-leaf', { total: 0, created: 60, completed: 80 })],
			},
			childSessionIdsByParentId: {
				root: ['child'],
				child: ['grandchild'],
				grandchild: ['leaf'],
			},
		});

		expect(computeDerivedSessionStats(state, 'root')).toEqual({
			requestCount: 4,
			totalDuration: 80,
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
