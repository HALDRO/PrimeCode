/**
 * @file projector.test.ts
 * @description Tests for the pure derive layer — deriveSessionView,
 * collectDescendantSessionIds, computeDerivedSessionStats.
 */

import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { beforeEach, describe, expect, it } from 'vitest';
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
		sessionOwnedFiles: {},
		childSessionIdsByParentId: {},
		originatingToolCallBySessionId: {},
		sessionInput: {},
		queuedMessagesBySession: {},
		sessionAgent: {},
		sessionModel: {},
		sessionModelSource: {},
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
	beforeEach(() => {
		clearSessionViewCache('ses1');
	});

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

	it('preserves raw tool input and output for unknown tools', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const part = {
			id: 'p-unknown-tool',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'custom_invalid_tool',
			callID: 'call-unknown-1',
			state: {
				status: 'error',
				input: { weird_param: 'value', nested_arg: { bad: true } },
				output: 'invalid tool invocation payload',
				title: 'Invalid',
				metadata: {},
				time: { start: Date.now(), end: Date.now() + 1 },
			},
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [part] },
		});
		const view = deriveSessionView(store, 'ses1');
		const toolNode = view.nodesById[view.nodeIds[1]];
		expect(toolNode.kind).toBe('tool_use');
		if (toolNode.kind === 'tool_use') {
			expect(toolNode.toolName).toBe('custom_invalid_tool');
			expect(toolNode.rawInput).toEqual({ weird_param: 'value', nested_arg: { bad: true } });
			expect(toolNode.rawOutput).toBe('invalid tool invocation payload');
			expect(toolNode.status).toBe('error');
		}
	});

	it('humanizes running tool activity and clears it when session is idle', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const runningBash = {
			id: 'p-running-bash',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'bash',
			callID: 'call-bash-1',
			state: { status: 'running', input: {}, output: '' },
			metadata: {},
		} as unknown as Part;

		const busyStore = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [runningBash] },
			sessionStatus: { ses1: { type: 'busy' } },
		});
		const busyView = deriveSessionView(busyStore, 'ses1');
		expect(busyView.toolActivity).toEqual(
			expect.objectContaining({
				toolName: 'bash',
				label: 'Running Bash',
				toolUseId: 'call-bash-1',
			}),
		);

		const idleStore = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: {
				a1: [
					{
						...runningBash,
						state: {
							status: 'completed',
							input: {},
							output: 'done',
							title: 'Done',
							metadata: {},
							time: { start: Date.now(), end: Date.now() + 1 },
						},
					} as unknown as Part,
				],
			},
			sessionStatus: { ses1: { type: 'idle' } },
		});
		const idleView = deriveSessionView(idleStore, 'ses1');
		expect(idleView.toolActivity).toBeNull();
		expect(idleView.streamingToolId).toBeNull();
	});

	it('clears running tool activity once assistant text streaming takes over', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const runningBash: Part = {
			id: 'tool-bash-live',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'bash',
			callID: 'call-bash-live',
			state: { status: 'running', input: {}, output: '' },
			metadata: {},
		} as unknown as Part;
		const streamingText = makeTextPart('p-live-text', 'a1', 'Hello world');
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [runningBash, streamingText] },
			sessionStatus: { ses1: { type: 'busy' } },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.toolActivity).toBeNull();
		expect(view.isLastAssistantStreaming).toBe(true);
		expect(view.generationStatus.phase).toBe('responding');
	});

	it('switches generation status from tool to thinking when reasoning starts', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const completedRead = {
			id: 'tool-read-completed',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'read',
			callID: 'call-read-completed',
			state: { status: 'completed', input: {}, output: 'done' },
			metadata: {},
		} as unknown as Part;
		const reasoning = {
			id: 'thinking-live',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'reasoning',
			text: 'thinking...',
			time: { start: Date.now() },
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [completedRead, reasoning] },
			sessionStatus: { ses1: { type: 'busy' } },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.toolActivity).toBeNull();
		expect(view.generationStatus.phase).toBe('thinking');
		expect(view.generationStatus.label).toBe('Thinking');
	});

	it('falls back to working after tool completion before any reasoning or text appears', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const completedBash = {
			id: 'tool-bash-completed',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'bash',
			callID: 'call-bash-completed',
			state: { status: 'completed', input: {}, output: 'done' },
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [completedBash] },
			sessionStatus: { ses1: { type: 'busy' } },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.toolActivity).toBeNull();
		expect(view.generationStatus.phase).toBe('working');
		expect(view.generationStatus.label).toBe('Working');
	});

	it('keeps retry as the strongest generation status', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1');
		const runningBash = {
			id: 'tool-bash-retry',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'bash',
			callID: 'call-bash-retry',
			state: { status: 'running', input: {}, output: '' },
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [runningBash] },
			sessionStatus: {
				ses1: { type: 'retry', attempt: 1, message: 'Rate limited', next: Date.now() + 1000 },
			},
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.toolActivity).toEqual(
			expect.objectContaining({
				toolName: 'bash',
			}),
		);
		expect(view.generationStatus.phase).toBe('retry');
		expect(view.generationStatus.label).toBe('Retrying');
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

	it('projects OhMy background task reminders as system events instead of user messages', () => {
		const user = makeUserMessage('u1', 'ses1');
		const reminder = [
			'<system-reminder>',
			'[BACKGROUND TASK COMPLETED]',
			'**ID:** `bg_123`',
			'**Description:** OpenCode runtime baseline',
			'</system-reminder>',
			'<!-- OMO_INTERNAL_INITIATOR -->',
		].join('\n');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: { u1: [makeTextPart('p1', 'u1', reminder)] },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['system-event-p1']);
		const node = view.nodesById['system-event-p1'];
		expect(node?.kind).toBe('system_event');
	});

	it('projects generic system-reminder envelopes as system events', () => {
		const user = makeUserMessage('u1', 'ses1');
		const reminderPart = makeTextPart(
			'p1',
			'u1',
			'<system-reminder>Use plan mode.</system-reminder>',
		) as Part & { synthetic?: boolean };
		reminderPart.synthetic = true;
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: { u1: [reminderPart] },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['system-event-p1']);
	});

	it('splits user text from synthetic system reminders on the same message', () => {
		const user = makeUserMessage('u1', 'ses1');
		const reminderPart = makeTextPart(
			'p2',
			'u1',
			'<system-reminder>Read-only plan mode is active.</system-reminder>',
		) as Part & { synthetic?: boolean };
		reminderPart.synthetic = true;
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: { u1: [makeTextPart('p1', 'u1', 'Please inspect this.'), reminderPart] },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['u1', 'system-event-p2']);
		expect(view.nodesById.u1?.kind).toBe('user');
	});

	it('keeps plain background task text as a normal user message without explicit markers', () => {
		const user = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: { u1: [makeTextPart('p1', 'u1', 'BACKGROUND TASK COMPLETED in my notes')] },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodesById.u1?.kind).toBe('user');
	});

	it('keeps literal system-reminder markup in normal user text visible', () => {
		const user = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: {
				u1: [
					makeTextPart(
						'p1',
						'u1',
						'Please document literal <system-reminder>example</system-reminder> markup.',
					),
				],
			},
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['u1']);
		expect(view.nodesById.u1?.kind).toBe('user');
		if (view.nodesById.u1?.kind === 'user') {
			expect(view.nodesById.u1.parts).toHaveLength(1);
			expect(view.nodesById.u1.parts[0].id).toBe('p1');
		}
	});

	it('projects OhMy system directives as system events', () => {
		const user = makeUserMessage('u1', 'ses1');
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: {
				u1: [
					makeTextPart(
						'p1',
						'u1',
						'[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]\nContinue pending work.',
					),
				],
			},
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['system-event-p1']);
	});

	it('projects partial streaming system-reminder envelopes as system events', () => {
		const user = makeUserMessage('u1', 'ses1');
		const reminderPart = makeTextPart('p1', 'u1', '<system-reminder>Still streaming') as Part & {
			synthetic?: boolean;
		};
		reminderPart.synthetic = true;
		const store = makeMinimalStore({
			messages: { ses1: [user] },
			parts: { u1: [reminderPart] },
		});

		const view = deriveSessionView(store, 'ses1');
		expect(view.nodeIds).toEqual(['system-event-p1']);
	});

	it('keeps assistant replies parented to OMO reminders in the previous real user section', () => {
		const user = makeUserMessage('u1', 'ses1');
		const firstAssistant = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const reminder = makeUserMessage('u-reminder', 'ses1');
		const secondAssistant = makeAssistantMessage('a2', 'ses1', 'u-reminder', {
			completed: true,
		});
		const reminderText = [
			'<system-reminder>',
			'[ALL BACKGROUND TASKS COMPLETE]',
			'Use `background_output(task_id="<id>")` to retrieve each result.',
			'</system-reminder>',
			'<!-- OMO_INTERNAL_INITIATOR -->',
		].join('\n');
		const store = makeMinimalStore({
			messages: { ses1: [user, firstAssistant, reminder, secondAssistant] },
			parts: {
				u1: [makeTextPart('p-user', 'u1', 'Please do the work.')],
				a1: [makeTextPart('p-a1', 'a1', 'Starting work.')],
				'u-reminder': [makeTextPart('p-reminder', 'u-reminder', reminderText)],
				a2: [makeTextPart('p-a2', 'a2', 'Continuing after background output.')],
			},
		});

		const view = deriveSessionView(store, 'ses1');

		expect(view.sections).toHaveLength(1);
		expect(view.nodesById['msg-p-a2']?.kind).toBe('assistant');
		if (view.nodesById['msg-p-a2']?.kind === 'assistant') {
			expect(view.nodesById['msg-p-a2'].parentMessageId).toBe('u1');
		}
	});

	it('keeps ordinary user messages as separate visible sections', () => {
		const firstUser = makeUserMessage('u1', 'ses1');
		const firstAssistant = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const secondUser = makeUserMessage('u2', 'ses1');
		const secondAssistant = makeAssistantMessage('a2', 'ses1', 'u2', { completed: true });
		const store = makeMinimalStore({
			messages: { ses1: [firstUser, firstAssistant, secondUser, secondAssistant] },
			parts: {
				u1: [makeTextPart('p-u1', 'u1', 'First prompt.')],
				a1: [makeTextPart('p-a1', 'a1', 'First answer.')],
				u2: [makeTextPart('p-u2', 'u2', 'Second prompt.')],
				a2: [makeTextPart('p-a2', 'a2', 'Second answer.')],
			},
		});

		const view = deriveSessionView(store, 'ses1');

		expect(view.sections).toHaveLength(2);
		expect(view.sections[0].userMessage.id).toBe('u1');
		expect(view.sections[1].userMessage.id).toBe('u2');
	});

	it('materializes task tool as task_card with subagent metadata', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const taskPart: Part = {
			id: 'p1',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-1',
			state: {
				status: 'completed',
				input: {
					subagent_type: 'explore',
					description: 'do stuff',
					prompt: 'Find the relevant files',
					category: 'quick',
					command: 'task',
				},
				output: 'task_id: child-task-1\n\n<task_result>result</task_result>',
			},
			metadata: {},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
		});
		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.agent).toBe('explore');
			expect(taskNode.description).toBe('do stuff');
			expect(taskNode.prompt).toBe('Find the relevant files');
			expect(taskNode.category).toBe('quick');
			expect(taskNode.command).toBe('task');
			expect(taskNode.taskId).toBeUndefined();
		}
	});

	it('uses task metadata model when child session model is missing', () => {
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
			metadata: {
				sessionId: 'child1',
				model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
			},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
		});

		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.childSessionId).toBe('child1');
			expect(taskNode.childSummary.modelId).toBe('anthropic/claude-sonnet-4');
		}
	});

	it('prefers child session model over task metadata model', () => {
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
			metadata: {
				sessionId: 'child1',
				model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
			},
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
			sessionModel: { child1: 'openai/gpt-5.1' },
		});

		const view = deriveSessionView(store, 'ses1');
		const taskNode = view.nodesById[view.nodeIds[1]];
		expect(taskNode.kind).toBe('task_card');
		if (taskNode.kind === 'task_card') {
			expect(taskNode.childSessionId).toBe('child1');
			expect(taskNode.childSummary.modelId).toBe('openai/gpt-5.1');
		}
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

	it('materializes terminal child assistant text as task_result once it appears after the last tool', () => {
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
	});

	it('materializes explicit terminal child task result wrapper as task_result', () => {
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
		expect(childView.nodeIds.map(id => childView.nodesById[id]?.kind)).toEqual([
			'user',
			'task_result',
		]);
	});

	it('materializes child terminal summary text as task_result before graph mapping exists', () => {
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
	});

	it('materializes terminal child task output as task_result after preserving prior transcript activity', () => {
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
		expect(assistantNodes).toHaveLength(1);
		expect(assistantNodes[0].content).toBe('I am reading files now.');
		expect(childView.nodesById['task-result-task-call-1']?.kind).toBe('task_result');
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

	it('keeps background task cards running until the child session becomes idle', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const taskPart: Part = {
			id: 'p-background-task',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-bg',
			state: {
				status: 'completed',
				input: { description: 'launch child', run_in_background: true },
				output:
					'Background task launched.\n\nBackground Task ID: bg_123\nDescription: Launch child\nStatus: pending',
			},
			metadata: { sessionId: 'child-bg' },
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
			sessionStatus: { 'child-bg': { type: 'busy' } },
		});

		const runningView = deriveSessionView(store, 'ses1');
		const runningNode = runningView.nodesById[runningView.nodeIds[1]];
		expect(runningNode.kind).toBe('task_card');
		if (runningNode.kind === 'task_card') {
			expect(runningNode.status).toBe('running');
			expect(runningNode.isBackgroundLaunch).toBe(false);
		}

		const idleStore = makeMinimalStore({
			...store,
			sessionStatus: { 'child-bg': { type: 'idle' } },
		});
		const idleView = deriveSessionView(idleStore, 'ses1');
		const idleNode = idleView.nodesById[idleView.nodeIds[1]];
		expect(idleNode.kind).toBe('task_card');
		if (idleNode.kind === 'task_card') {
			expect(idleNode.status).toBe('completed');
		}
	});

	it('does not mark restored background task cards as running without explicit child busy status', () => {
		const user = makeUserMessage('u1', 'ses1');
		const asst = makeAssistantMessage('a1', 'ses1', 'u1', { completed: true });
		const taskPart: Part = {
			id: 'p-restored-background-task',
			messageID: 'a1',
			sessionID: 'ses1',
			type: 'tool',
			tool: 'task',
			callID: 'task-call-restored-bg',
			state: {
				status: 'completed',
				input: { description: 'restore child', run_in_background: true },
				output:
					'Background task launched.\n\nBackground Task ID: bg_456\nDescription: Restore child\nStatus: pending',
			},
			metadata: { sessionId: 'child-restored-bg' },
		} as unknown as Part;
		const store = makeMinimalStore({
			messages: { ses1: [user, asst] },
			parts: { a1: [taskPart] },
			sessions: [{ id: 'child-restored-bg', parentID: 'ses1' } as never],
			sessionStatus: { 'child-restored-bg': { type: 'idle' } },
		});

		const view = deriveSessionView(store, 'ses1');
		const node = view.nodesById[view.nodeIds[1]];
		expect(node.kind).toBe('task_card');
		if (node.kind === 'task_card') {
			expect(node.status).toBe('completed');
			expect(node.isBackgroundLaunch).toBe(false);
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
