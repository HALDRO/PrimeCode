/**
 * @file projector.test.ts
 * @description Tests for the pure derive layer — deriveSessionView,
 * collectDescendantSessionIds, computeDerivedSessionStats.
 */

import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../chatStore';
import {
	clearSessionViewCache,
	collectDescendantSessionIds,
	computeDerivedSessionStats,
	deriveSessionView,
} from '../derived';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(id: string, sessionId: string): Message {
	return {
		id,
		sessionID: sessionId,
		role: 'user',
		time: { created: Date.now() },
	} as Message;
}

function makeAssistantMessage(
	id: string,
	sessionId: string,
	parentID: string,
	opts: { completed?: boolean } = {},
): Message {
	return {
		id,
		sessionID: sessionId,
		role: 'assistant',
		parentID,
		agent: 'build',
		tokens: { input: 100, output: 50, reasoning: 0, total: 150, cache: { read: 0, write: 0 } },
		cost: 0,
		time: {
			created: Date.now(),
			completed: opts.completed ? Date.now() + 1000 : undefined,
		},
	} as unknown as Message;
}

function makeTextPart(id: string, messageID: string, text: string): Part {
	return {
		id,
		messageID,
		sessionID: 'ses1',
		type: 'text',
		text,
	} as unknown as Part;
}

function makeToolPart(id: string, messageID: string, toolName: string, callID: string): Part {
	return {
		id,
		messageID,
		sessionID: 'ses1',
		type: 'tool',
		tool: toolName,
		callID,
		state: { status: 'completed', input: {}, output: 'done' },
		metadata: {},
	} as unknown as Part;
}

function makeReasoningPart(id: string, messageID: string, text: string): Part {
	return {
		id,
		messageID,
		sessionID: 'ses1',
		type: 'reasoning',
		text,
		time: { start: Date.now(), end: Date.now() + 500 },
	} as unknown as Part;
}

function makeMinimalStore(overrides: Partial<SessionStore> = {}): SessionStore {
	return {
		sessions: [],
		sessionStatus: {},
		sessionDiff: {},
		messages: {},
		parts: {},
		todos: {},
		permissions: {},
		questions: {},
		activeSessionId: undefined,
		sessionOrder: [],
		editingMessageId: null,
		editDrafts: {},
		isImprovingPrompt: false,
		improvingPromptRequestId: null,
		promptVersions: null,
		childSessionIdsByParentId: {},
		originatingToolCallBySessionId: {},
		sessionInput: {},
		queuedMessagesBySession: {},
		sessionAgent: {},
		sessionModel: {},
		sessionAutoAccept: {},
		draftAttachments: {},
		draftAgent: {},
		lastError: null,
		actions: {} as SessionStore['actions'],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// deriveSessionView
// ---------------------------------------------------------------------------

describe('deriveSessionView', () => {
	it('uses distinct cache entries for different MCP server lists', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [makeToolPart('p1', 'a1', 'mcp', 'call-1')] },
		});

		const withoutMcp = deriveSessionView(store, 'ses1', []);
		const withMcp = deriveSessionView(store, 'ses1', ['server-a']);

		expect(withMcp).not.toBe(withoutMcp);
	});

	it('clears all cached variants for a session', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [makeTextPart('p1', 'a1', 'Hello')] },
		});

		const before = deriveSessionView(store, 'ses1', ['server-a']);
		clearSessionViewCache('ses1');
		const after = deriveSessionView(store, 'ses1', ['server-a']);

		expect(after).not.toBe(before);
	});

	it('returns empty view for undefined sessionId', () => {
		const view = deriveSessionView(makeMinimalStore(), undefined);
		expect(view.nodeIds).toHaveLength(0);
	});

	it('returns empty view for session with no messages', () => {
		const store = makeMinimalStore({ messages: { ses1: [] } });
		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toHaveLength(0);
	});

	it('projects user message', () => {
		const msg = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [msg] },
			parts: {},
		});
		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toHaveLength(1);
		expect(view.nodesById[view.nodeIds[0]].kind).toBe('user');
	});

	it('projects assistant text part as RenderAssistantMessage', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const part = makeTextPart('p1', 'a1', 'Hello world');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = deriveSessionView(store, 'ses1');
		// user + assistant text
		expect(view.nodeIds).toHaveLength(2);
		const asstNode = view.nodesById[view.nodeIds[1]];
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello world');
			expect(asstNode.partId).toBe('p1');
		}
	});

	it('projects tool part as RenderToolUseMessage', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const part = makeToolPart('p1', 'a1', 'Read', 'call-1');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toHaveLength(2);
		const toolNode = view.nodesById[view.nodeIds[1]];
		expect(toolNode.kind).toBe('tool_use');
		if (toolNode.kind === 'tool_use') {
			expect(toolNode.toolName).toBe('Read');
			expect(toolNode.toolUseId).toBe('call-1');
		}
	});

	it('projects reasoning part as RenderThinkingMessage', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeReasoningPart('p1', 'a1', 'thinking...');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toHaveLength(2);
		const thinkNode = view.nodesById[view.nodeIds[1]];
		expect(thinkNode.kind).toBe('thinking');
		if (thinkNode.kind === 'thinking') {
			expect(thinkNode.content).toBe('thinking...');
		}
	});

	it('materializes task tool as task_card', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const taskPart: Part = {
			id: 'p1',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: { status: 'completed', input: { description: 'do stuff' }, output: 'result' },
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
		});
		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
	});

	it('resolves child session through session graph when task metadata lacks sessionId', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'p1',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: { status: 'completed', input: { description: 'do stuff' }, output: 'done' },
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: { a1: [taskPart] },
			childSessionIdsByParentId: { ses1: ['child1'] },
			originatingToolCallBySessionId: { child1: 'task-call-1' },
		});

		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.childSessionId).toBe('child1');
			expect(taskNode.parentMessageId).toBe('u1');
			expect(taskNode.result).toBeUndefined();
			expect(taskNode.childSummary.tokens?.total).toBeGreaterThan(0);
			expect(taskNode.childSummary.durationMs).toBeGreaterThan(0);
		}
	});

	it('classifies terminal child assistant text as task_result even when parent output differs', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'p1',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: { status: 'completed', input: { description: 'do stuff' }, output: 'done' },
			metadata: { sessionId: 'child1' },
		} as unknown as Part;
		const childToolPart = makeToolPart('child-tool', 'a2', 'Read', 'read-call-1');
		childToolPart.sessionID = 'child1';
		const childTextPart = makeTextPart('child-text', 'a2', 'Child transcript text');
		childTextPart.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: {
				a1: [taskPart],
				a2: [childToolPart, childTextPart],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
		});

		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.childSessionId).toBe('child1');
			expect(taskNode.result).toBeUndefined();
		}

		const childView = deriveSessionView(store, 'child1');
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'tool_use',
			'task_result',
		]);
		const taskResultNode = childView.nodesById['task-result-task-call-1'];
		expect(taskResultNode?.kind).toBe('task_result');
		if (taskResultNode?.kind === 'task_result') {
			expect(taskResultNode.content).toBe('Child transcript text');
		}
	});

	it('materializes terminal child task result wrapper as a canonical task_result node', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'task-part',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: {
				status: 'completed',
				input: { description: 'do stuff' },
				output: '<task_result>Summary text\ntask_id: child1</task_result>',
			},
			metadata: {},
		} as unknown as Part;
		const childResultPart = makeTextPart(
			'child-result-text',
			'a2',
			'<task_result>Summary text\ntask_id: child1</task_result>',
		);
		childResultPart.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: {
				a1: [taskPart],
				a2: [childResultPart],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
			originatingToolCallBySessionId: { child1: 'task-call-1' },
		});

		const parentView = deriveSessionView(store, 'ses1');
		const taskNode = parentView.nodesById[parentView.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.result).toBeUndefined();
			expect(taskNode.childSessionId).toBe('child1');
		}

		const childView = deriveSessionView(store, 'child1');
		const childNode = childView.nodesById['task-result-task-call-1'];
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'task_result',
		]);
		expect(childNode?.kind).toBe('task_result');
		if (childNode?.kind === 'task_result') {
			expect(childNode.content).toBe('Summary text');
			expect(childNode.taskIdLine).toBe('task_id: child1');
			expect(childNode.source.childAssistantPartId).toBe('child-result-text');
		}
	});

	it('materializes child task result using official task metadata before graph mapping exists', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'task-part',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: {
				status: 'completed',
				input: { description: 'do stuff' },
				output: '<task_result>Summary text\ntask_id: child1</task_result>',
			},
			metadata: { sessionId: 'child1' },
		} as unknown as Part;
		const childToolPart = makeToolPart('child-tool', 'a2', 'Read', 'read-call-1');
		childToolPart.sessionID = 'child1';
		const childResultPart = makeTextPart('child-result-text', 'a2', 'Summary text');
		childResultPart.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: {
				a1: [taskPart],
				a2: [childToolPart, childResultPart],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
			originatingToolCallBySessionId: {},
		});

		const childView = deriveSessionView(store, 'child1');
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'tool_use',
			'task_result',
		]);
		const childNode = childView.nodesById['task-result-task-call-1'];
		expect(childNode?.kind).toBe('task_result');
		if (childNode?.kind === 'task_result') {
			expect(childNode.content).toBe('Summary text');
		}
	});

	it('replaces only the terminal child task output with task_result after preserving prior transcript activity', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'task-part',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: {
				status: 'completed',
				input: { description: 'inspect upstream' },
				output: [
					'task_id: child1 (for resuming to continue this task if needed)',
					'',
					'<task_result>',
					'Final upstream summary',
					'</task_result>',
				].join('\n'),
			},
			metadata: { sessionId: 'child1' },
		} as unknown as Part;
		const childIntroPart = makeTextPart('child-intro-text', 'a2', 'I am reading files now.');
		childIntroPart.sessionID = 'child1';
		const childToolPart = makeToolPart('child-read', 'a2', 'Read', 'read-call-1');
		childToolPart.sessionID = 'child1';
		const childResultPart = makeTextPart('child-result-text', 'a2', 'Final upstream summary');
		childResultPart.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: {
				a1: [taskPart],
				a2: [childIntroPart, childToolPart, childResultPart],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
		});

		const childView = deriveSessionView(store, 'child1');
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'assistant',
			'tool_use',
			'task_result',
		]);
		const assistantNodes = childView.nodeIds
			.map(id => childView.nodesById[id])
			.filter(
				(node): node is Extract<typeof node, { kind: 'assistant' }> => node.kind === 'assistant',
			);
		const taskResultNode = childView.nodesById['task-result-task-call-1'];
		expect(assistantNodes).toHaveLength(1);
		expect(assistantNodes[0].content).toBe('I am reading files now.');
		expect(taskResultNode?.kind).toBe('task_result');
		if (taskResultNode?.kind === 'task_result') {
			expect(taskResultNode.content).toBe('Final upstream summary');
			expect(taskResultNode.taskIdLine).toBe(
				'task_id: child1 (for resuming to continue this task if needed)',
			);
		}
	});

	it('combines multiple terminal child assistant text parts into one task_result', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst1 = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const childAsst2 = makeAssistantMessage('a3', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'task-part',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: { status: 'completed', input: { description: 'do stuff' }, output: 'done' },
			metadata: { sessionId: 'child1' },
		} as unknown as Part;
		const childToolPart = makeToolPart('child-tool', 'a2', 'Read', 'read-call-1');
		childToolPart.sessionID = 'child1';
		const terminalFirst = makeTextPart('terminal-first', 'a2', 'First terminal paragraph.');
		terminalFirst.sessionID = 'child1';
		const terminalSecond = makeTextPart('terminal-second', 'a3', 'Second terminal paragraph.');
		terminalSecond.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst1, childAsst2],
			},
			parts: {
				a1: [taskPart],
				a2: [childToolPart, terminalFirst],
				a3: [terminalSecond],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
		});

		const childView = deriveSessionView(store, 'child1');
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'tool_use',
			'task_result',
		]);
		const taskResultNode = childView.nodesById['task-result-task-call-1'];
		expect(taskResultNode?.kind).toBe('task_result');
		if (taskResultNode?.kind === 'task_result') {
			expect(taskResultNode.source.childAssistantPartId).toBe('terminal-first');
			expect(taskResultNode.content).toBe(
				'First terminal paragraph.\n\nSecond terminal paragraph.',
			);
		}
	});

	it('keeps terminal child text as assistant while the parent task is not completed', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const childUser = makeUserMessage('u2', 'child1');
		const childAsst = makeAssistantMessage('a2', 'child1', 'u2', { completed: true });
		const taskPart: Part = {
			id: 'task-part',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: {
				status: 'running',
				input: { description: 'do stuff' },
			},
			metadata: {},
		} as unknown as Part;
		const childToolPart = makeToolPart('child-tool', 'a2', 'Read', 'read-call-1');
		childToolPart.sessionID = 'child1';
		const childTextPart = makeTextPart('child-text', 'a2', 'Different child transcript text');
		childTextPart.sessionID = 'child1';
		const store = makeMinimalStore({
			messages: {
				ses1: [user, asst],
				child1: [childUser, childAsst],
			},
			parts: {
				a1: [taskPart],
				a2: [childToolPart, childTextPart],
			},
			childSessionIdsByParentId: { ses1: ['child1'] },
			originatingToolCallBySessionId: { child1: 'task-call-1' },
		});

		const childView = deriveSessionView(store, 'child1');
		const childAssistantNodes = childView.nodeIds
			.map(id => childView.nodesById[id])
			.filter(
				(node): node is Extract<typeof node, { kind: 'assistant' }> => node.kind === 'assistant',
			);
		expect(childAssistantNodes).toHaveLength(1);
		expect(childAssistantNodes[0].content).toBe('Different child transcript text');
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'tool_use',
			'assistant',
		]);
	});

	it('builds nodesById index correctly', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const p1 = makeTextPart('p1', 'a1', 'text1');
		const p2 = makeTextPart('p2', 'a1', 'text2');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [p1, p2] },
		});
		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toHaveLength(3); // user + 2 text parts
		for (const id of view.nodeIds) {
			expect(view.nodesById[id]).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// collectDescendantSessionIds
// ---------------------------------------------------------------------------

describe('collectDescendantSessionIds', () => {
	it('returns empty for session with no children', () => {
		const store = makeMinimalStore({ childSessionIdsByParentId: {} });
		expect(collectDescendantSessionIds(store, 'root')).toEqual([]);
	});

	it('collects direct children', () => {
		const store = makeMinimalStore({
			childSessionIdsByParentId: { root: ['c1', 'c2'] },
		});
		expect(collectDescendantSessionIds(store, 'root')).toEqual(['c1', 'c2']);
	});

	it('collects nested descendants', () => {
		const store = makeMinimalStore({
			childSessionIdsByParentId: {
				root: ['c1'],
				c1: ['c2'],
				c2: ['c3'],
			},
		});
		expect(collectDescendantSessionIds(store, 'root')).toEqual(['c1', 'c2', 'c3']);
	});

	it('handles cycles gracefully', () => {
		const store = makeMinimalStore({
			childSessionIdsByParentId: {
				root: ['c1'],
				c1: ['root'], // cycle
			},
		});
		const result = collectDescendantSessionIds(store, 'root');
		expect(result).toContain('c1');
		// Should not infinite loop — visited set prevents it
		expect(result.length).toBeLessThan(10);
	});
});

// ---------------------------------------------------------------------------
// computeDerivedSessionStats
// ---------------------------------------------------------------------------

describe('computeDerivedSessionStats', () => {
	it('returns zeros for undefined sessionId', () => {
		const store = makeMinimalStore();
		expect(computeDerivedSessionStats(store, undefined)).toEqual({
			requestCount: 0,
			totalDuration: 0,
			subagentCount: 0,
		});
	});

	it('counts requests from assistant messages with tokens', () => {
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const store = makeMinimalStore({
			messages: { ses1: [makeUserMessage('u1', 'ses1'), asst] },
			childSessionIdsByParentId: {},
		});
		const stats = computeDerivedSessionStats(store, 'ses1');
		expect(stats.requestCount).toBe(1);
		expect(stats.subagentCount).toBe(0);
	});

	it('includes child session stats', () => {
		const parentAsst = makeAssistantMessage('a1', 'root', 'u1', { completed: true });
		const childAsst = makeAssistantMessage('a2', 'child', 'u2', { completed: true });
		const store = makeMinimalStore({
			messages: {
				root: [makeUserMessage('u1', 'root'), parentAsst],
				child: [makeUserMessage('u2', 'child'), childAsst],
			},
			childSessionIdsByParentId: { root: ['child'] },
		});
		const stats = computeDerivedSessionStats(store, 'root');
		expect(stats.requestCount).toBe(2);
		expect(stats.subagentCount).toBe(1);
	});
});
