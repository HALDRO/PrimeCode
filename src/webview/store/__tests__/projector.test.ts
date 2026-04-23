/**
 * @file projector.test.ts
 * @description Tests for the pure projection layer — projectSession, applyDelta, applyToolDelta,
 * collectDescendantSessionIds, computeDerivedSessionStats.
 */

import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import type { SessionStore } from '../chatStore';
import {
	applyDelta,
	applyToolDelta,
	collectDescendantSessionIds,
	computeDerivedSessionStats,
	projectSession,
} from '../projector';

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
		queuedMessages: {},
		restoreCommits: {},
		revertedFromMessageId: {},
		sessionCanUnrevert: {},
		sessionInput: {},
		sessionAgent: {},
		sessionModel: {},
		sessionAutoAccept: {},
		draftAttachments: {},
		draftAgent: {},
		lastError: null,
		materializedViews: {},
		actions: {} as SessionStore['actions'],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// projectSession
// ---------------------------------------------------------------------------

describe('projectSession', () => {
	it('returns empty view for undefined sessionId', () => {
		const view = projectSession(makeMinimalStore(), undefined);
		expect(view.nodeIds).toHaveLength(0);
		expect(view.version).toBe(0);
	});

	it('returns empty view for session with no messages', () => {
		const store = makeMinimalStore({ messages: { ses1: [] } });
		const view = projectSession(store, 'ses1');
		expect(view.nodeIds).toHaveLength(0);
	});

	it('projects user message', () => {
		const msg = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [msg] },
			parts: {},
		});
		const view = projectSession(store, 'ses1');
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
		const view = projectSession(store, 'ses1');
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
		const view = projectSession(store, 'ses1');
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
		const view = projectSession(store, 'ses1');
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
		const view = projectSession(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
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
		const view = projectSession(store, 'ses1');
		expect(view.nodeIds).toHaveLength(3); // user + 2 text parts
		for (const id of view.nodeIds) {
			expect(view.nodesById[id]).toBeDefined();
		}
	});
});

// ---------------------------------------------------------------------------
// applyDelta
// ---------------------------------------------------------------------------

describe('applyDelta', () => {
	it('appends text delta to assistant node', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeTextPart('p1', 'a1', 'Hello');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = projectSession(store, 'ses1');
		const updated = applyDelta(view, 'p1', 'text', ' world');
		expect(updated).not.toBeNull();
		if (!updated) return;
		const node = updated.nodesById['msg-p1'];
		expect(node.kind).toBe('assistant');
		if (node.kind === 'assistant') {
			expect(node.content).toBe('Hello world');
		}
		// nodeIds should be the same reference (no structural change)
		expect(updated.nodeIds).toBe(view.nodeIds);
		expect(updated.lastUpdateWasStructural).toBe(false);
		expect(updated.version).toBe(view.version + 1);
	});

	it('appends text delta to thinking node', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeReasoningPart('p1', 'a1', 'think');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = projectSession(store, 'ses1');
		const updated = applyDelta(view, 'p1', 'text', 'ing...');
		expect(updated).not.toBeNull();
		if (!updated) return;
		const node = updated.nodesById['thinking-p1'];
		expect(node.kind).toBe('thinking');
		if (node.kind === 'thinking') {
			expect(node.content).toBe('thinking...');
		}
	});

	it('returns null for unknown partId', () => {
		const user = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: {},
		});
		const view = projectSession(store, 'ses1');
		const result = applyDelta(view, 'nonexistent', 'text', 'data');
		expect(result).toBeNull();
	});

	it('returns null for unsupported field', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeTextPart('p1', 'a1', 'Hello');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = projectSession(store, 'ses1');
		const result = applyDelta(view, 'p1', 'unknownField', 'data');
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// applyToolDelta
// ---------------------------------------------------------------------------

describe('applyToolDelta', () => {
	it('appends output delta to tool node', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeToolPart('p1', 'a1', 'Bash', 'call-1');
		// Override state to running with empty output
		(part as unknown as ToolPart).state = { status: 'running', input: {} } as ToolPart['state'];
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = projectSession(store, 'ses1');
		const updated = applyToolDelta(view, 'call-1', 'output', 'line1\n');
		expect(updated).not.toBeNull();
		if (!updated) return;
		const node = updated.nodesById['call-1'];
		expect(node.kind).toBe('tool_use');
		if (node.kind === 'tool_use') {
			expect(node.streamingOutput).toBe('line1\n');
		}
	});

	it('appends output delta to tool node via partId lookup', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const part = makeToolPart('p1', 'a1', 'Bash', 'call-1');
		(part as unknown as ToolPart).state = { status: 'running', input: {} } as ToolPart['state'];
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = projectSession(store, 'ses1');
		// Use partId 'p1' instead of callID 'call-1' — simulates real delta event
		const updated = applyToolDelta(view, 'p1', 'output', 'line1\n');
		expect(updated).not.toBeNull();
		if (!updated) return;
		const node = updated.nodesById['call-1'];
		expect(node.kind).toBe('tool_use');
		if (node.kind === 'tool_use') {
			expect(node.streamingOutput).toBe('line1\n');
		}
	});

	it('returns null for non-tool node', () => {
		const user = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: {},
		});
		const view = projectSession(store, 'ses1');
		const result = applyToolDelta(view, 'u1', 'output', 'data');
		// u1 is a user node, not a tool node
		expect(result).toBeNull();
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
