import { describe, expect, it } from 'vitest';
import type { ChatState, RenderTaskCardNode } from '../chatStore';
import { projectSessionMessages } from '../selectors';

function createSession(
	id: string,
	title: string,
	overrides?: Partial<ChatState['sessionsById'][string]>,
) {
	return {
		id,
		title,
		agent: undefined,
		model: undefined,
		userMessagesById: {},
		runtimeMessageRecords: [] as ChatState['sessionsById'][string]['runtimeMessageRecords'],
		runtimeMessagePartsById: {} as ChatState['sessionsById'][string]['runtimeMessagePartsById'],
		input: '',
		status: 'Ready',
		streamingToolId: null,
		isProcessing: false,
		isAutoRetrying: false,
		retryInfo: null,
		isLoading: false,
		toolActivity: null,
		lastActive: 0,
		changedFiles: [],
		cumulativeDiffs: [],
		restoreCommits: [],
		unrevertAvailable: false,
		revertedFromMessageId: null,
		turnTokens: {},
		queuedMessages: [],
		availableTools: [],
		availableMcpServers: [],
		autoAccept: false,
		permissionAutoAcceptMode: 'default' as const,
		todos: [],
		pendingPermissions: [],
		pendingQuestions: [],
		...overrides,
	};
}

function createBaseState(): ChatState {
	return {
		sessionsById: {
			root: createSession('root', 'Root', {
				runtimeMessageRecords: [
					{ id: 'a-root', sessionId: 'root', role: 'assistant', createdAt: 1 },
				],
				runtimeMessagePartsById: {
					'a-root': [
						{
							id: 'root-task-part',
							messageId: 'a-root',
							sessionId: 'root',
							type: 'tool',
							callId: 't1',
							toolName: 'task',
							state: {
								status: 'completed',
								input: {
									subagent_type: 'general',
									prompt: 'do child work',
									description: 'child task',
								},
								output: '<task_result>Final child result</task_result>',
								metadata: { sessionId: 'child' },
							},
						},
					],
				},
			}),
			child: createSession('child', 'Child', {
				runtimeMessageRecords: [
					{ id: 'child-a', sessionId: 'child', role: 'assistant', createdAt: 2 },
				],
				runtimeMessagePartsById: {
					'child-a': [
						{
							id: 'child-text',
							messageId: 'child-a',
							sessionId: 'child',
							type: 'text',
							text: 'Child execution history',
							createdAt: 2,
							completedAt: 2,
						},
						{
							id: 'child-task-part',
							messageId: 'child-a',
							sessionId: 'child',
							type: 'tool',
							callId: 't2',
							toolName: 'task',
							state: {
								status: 'completed',
								input: {
									subagent_type: 'general',
									prompt: 'do grandchild work',
									description: 'grandchild task',
								},
								output: '<task_result>Nested task result</task_result>',
								metadata: { sessionId: 'grandchild' },
							},
						},
					],
				},
			}),
			grandchild: createSession('grandchild', 'Grandchild', {
				runtimeMessageRecords: [
					{ id: 'gc-a', sessionId: 'grandchild', role: 'assistant', createdAt: 3 },
				],
				runtimeMessagePartsById: {
					'gc-a': [
						{
							id: 'gc-text',
							messageId: 'gc-a',
							sessionId: 'grandchild',
							type: 'text',
							text: 'Grandchild execution history',
							createdAt: 3,
							completedAt: 3,
						},
					],
				},
			}),
		},
		sessionOrder: ['root', 'child', 'grandchild'],
		activeSessionId: 'root',
		editingMessageId: null,
		editDrafts: {},
		isImprovingPrompt: false,
		improvingPromptRequestId: null,
		promptVersions: null,
		childSessionIdsByParentId: {
			root: ['child'],
			child: ['grandchild'],
		},
		originatingToolCallBySessionId: {
			child: 't1',
			grandchild: 't2',
		},
		actions: {} as never,
	};
}

describe('projectSessionMessages — flat projection with childSessionId', () => {
	it('produces task_card with childSessionId instead of embedded childSession', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, 'root');

		expect(items).toHaveLength(1);
		const card = items[0] as RenderTaskCardNode;
		expect(card.kind).toBe('task_card');
		expect(card.childSessionId).toBe('child');
		// No embedded childSession — child content is rendered by React components
		expect('childSession' in card).toBe(false);
	});

	it('extracts task result from tool output', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		expect(card.result).toBe('<task_result>Final child result</task_result>');
	});

	it('populates childSummary with title, tokens, diffStats', () => {
		const state = createBaseState();
		state.sessionsById.child.changedFiles = [
			{
				filePath: 'a.ts',
				fileName: 'a.ts',
				linesAdded: 10,
				linesRemoved: 3,
				toolUseId: 'x',
				timestamp: 1,
			},
		];
		state.sessionsById.child.turnTokens = {
			turn1: { input: 100, output: 50, total: 150 },
		};
		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		expect(card.childSummary.title).toBe('Child');
		expect(card.childSummary.diffStats).toEqual({ added: 10, removed: 3 });
		expect(card.childSummary.tokens?.total).toBe(150);
	});

	it('derives task status from child session state', () => {
		const state = createBaseState();
		// Override tool status to running
		const parts = state.sessionsById.root.runtimeMessagePartsById['a-root'];
		if (parts[0]?.state) parts[0].state.status = 'running';
		state.sessionsById.child.status = 'Stopped';
		state.sessionsById.child.isProcessing = false;

		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		expect(card.status).toBe('cancelled');
	});

	it('counts nested children in childSummary.childCount', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		// child has one grandchild
		expect(card.childSummary.childCount).toBe(1);
	});

	it('projects child session independently (flat, no recursion)', () => {
		const state = createBaseState();
		const childItems = projectSessionMessages(state, 'child');

		// Child session has: assistant text + task_card (for grandchild)
		expect(childItems.length).toBe(2);
		expect(childItems[0].kind).toBe('assistant');
		expect(childItems[1].kind).toBe('task_card');

		const grandchildCard = childItems[1] as RenderTaskCardNode;
		expect(grandchildCard.childSessionId).toBe('grandchild');
		expect('childSession' in grandchildCard).toBe(false);
	});

	it('projects grandchild session independently', () => {
		const state = createBaseState();
		const gcItems = projectSessionMessages(state, 'grandchild');

		expect(gcItems.length).toBe(1);
		expect(gcItems[0].kind).toBe('assistant');
	});

	it('returns empty for unknown session', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, 'nonexistent');
		expect(items).toHaveLength(0);
	});

	it('returns empty for undefined session', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, undefined);
		expect(items).toHaveLength(0);
	});

	it('handles session with no parts', () => {
		const state = createBaseState();
		state.sessionsById.empty = createSession('empty', 'Empty');
		const items = projectSessionMessages(state, 'empty');
		expect(items).toHaveLength(0);
	});

	it('preserves agent and description in task_card', () => {
		const state = createBaseState();
		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		expect(card.agent).toBe('general');
		expect(card.description).toBe('child task');
		expect(card.prompt).toBe('do child work');
	});

	it('handles task tool without metadata.sessionId', () => {
		const state = createBaseState();
		// Remove sessionId from metadata
		const parts = state.sessionsById.root.runtimeMessagePartsById['a-root'];
		if (parts?.[0]?.state) parts[0].state.metadata = {};

		const items = projectSessionMessages(state, 'root');
		const card = items[0] as RenderTaskCardNode;
		expect(card.kind).toBe('task_card');
		expect(card.childSessionId).toBeUndefined();
	});

	it('includes non-task tool_use items as-is', () => {
		const state = createBaseState();
		// Add a read tool to root
		state.sessionsById.root.runtimeMessagePartsById['a-root'].unshift({
			id: 'read-part',
			messageId: 'a-root',
			sessionId: 'root',
			type: 'tool',
			callId: 'read-1',
			toolName: 'read',
			state: { status: 'completed', input: { filePath: 'a.ts' }, output: 'contents' },
		});

		const items = projectSessionMessages(state, 'root');
		expect(items).toHaveLength(2);
		expect(items[0].kind).toBe('tool_use');
		expect(items[1].kind).toBe('task_card');
	});
});
