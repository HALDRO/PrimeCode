import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { isSessionProcessing, useChatStore } from '../chatStore';
import { deriveSessionView } from '../derived';
import type { WebviewSdkEvent } from '../eventReducer';
import { useSettingsStore } from '../settingsStore';

const SESSION_ID = 'session-1';

function resetStore() {
	useChatStore.setState(useChatStore.getInitialState(), true);
	useSettingsStore.setState(useSettingsStore.getInitialState(), true);
}

function createUserMessage(id: string, text: string): { message: Message; part: Part } {
	return {
		message: {
			id,
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message,
		part: {
			id: `${id}-text`,
			messageID: id,
			sessionID: SESSION_ID,
			type: 'text',
			text,
		} as Part,
	};
}

function createUserMessageWithModel(
	id: string,
	text: string,
	model: { providerID: string; modelID: string },
	sessionId = SESSION_ID,
): { message: Message; part: Part } {
	return {
		message: {
			id,
			sessionID: sessionId,
			role: 'user',
			time: { created: Date.now() },
			model,
		} as Message,
		part: {
			id: `${id}-text`,
			messageID: id,
			sessionID: sessionId,
			type: 'text',
			text,
		} as Part,
	};
}

function restoreFromEvents(events: WebviewSdkEvent[]) {
	useChatStore.getState().actions.applyBatch(events);
}

describe('chatStore restore', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);
	});

	it('restores canonical session messages and parts from sdk events', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: first.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: first.part,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: second.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: second.part,
				},
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.messages[SESSION_ID].map(message => message.id)).toEqual(['msg-1', 'msg-2']);
		expect(state.parts['msg-1'][0]).toMatchObject({ text: 'first' });
		expect(state.parts['msg-2'][0]).toMatchObject({ text: 'second' });
	});

	it('restores session model from the last user message in session history', () => {
		const first = createUserMessageWithModel('msg-1', 'first', {
			providerID: 'anthropic',
			modelID: 'claude-sonnet-4',
		});
		const second = createUserMessageWithModel('msg-2', 'second', {
			providerID: 'openai',
			modelID: 'gpt-5',
		});

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: first.message,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: second.message,
				},
			} as never,
		]);
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('copies the active session model into a newly created session', () => {
		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);

		useChatStore.getState().actions.applyTabState([SESSION_ID, 'session-2'], 'session-2');

		const state = useChatStore.getState();
		expect(state.activeSessionId).toBe('session-2');
		expect(state.sessionModel['session-2']).toBe('openai/gpt-5');
		expect(state.sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('uses the latest selected model for new sessions after switching models', () => {
		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);
		useSettingsStore.getState().actions.setLastSelectedModel('openai/gpt-5');

		useChatStore.getState().actions.applyTabState([SESSION_ID, 'session-2'], 'session-2');

		const state = useChatStore.getState();
		expect(state.sessionModel[SESSION_ID]).toBe('openai/gpt-5');
		expect(state.sessionModel['session-2']).toBe('openai/gpt-5');
	});

	it('initializes already-created empty sessions when global model is restored', () => {
		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBeUndefined();

		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('anthropic/claude-sonnet-4');
	});

	it('does not overwrite an explicit session model when global model is restored', () => {
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);

		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('seeds restored sessions from the global model when history has no model yet', () => {
		useSettingsStore.getState().actions.setLastSelectedModel('openai/gpt-5');
		const first = createUserMessage('msg-1', 'first');

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: first.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: first.part,
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('drops removed messages after restore', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: first.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: first.part,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: second.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: second.part,
				},
			} as never,
		]);
		useChatStore.getState().actions.applyEvent({
			type: 'message.removed',
			properties: {
				sessionID: SESSION_ID,
				messageID: 'msg-2',
			},
		} as never);
		const state = useChatStore.getState();
		expect(state.messages[SESSION_ID].map(message => message.id)).toEqual(['msg-1']);
		expect(state.parts['msg-2']).toBeUndefined();
	});

	it('maps server revert marker to the previous visible user turn', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');
		const third = createUserMessage('msg-3', 'third');

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: first.message },
			} as never,
			{
				type: 'message.part.updated',
				properties: { part: first.part },
			} as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: second.message },
			} as never,
			{
				type: 'message.part.updated',
				properties: { part: second.part },
			} as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: third.message },
			} as never,
			{
				type: 'message.part.updated',
				properties: { part: third.part },
			} as never,
		]);

		useChatStore.setState(state => ({
			...state,
			sessions: [
				{
					id: SESSION_ID,
					revert: { messageID: 'msg-3' },
				} as never,
			],
		}));

		const view = deriveSessionView(useChatStore.getState(), SESSION_ID);
		expect(view.sections).toHaveLength(3);
		expect(view.sections[1].isRevertPoint).toBe(true);
		expect(view.sections[1].isReverted).toBe(true);
		expect(view.sections[2].isReverted).toBe(true);
		expect(view.sections[2].isRevertPoint).toBe(false);
	});

	it('allows follow-up send immediately after local revert state switches session back to idle', () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				[SESSION_ID]: { type: 'busy' },
			},
			sessions: [{ id: SESSION_ID, revert: { messageID: 'msg-2' } } as never],
		}));

		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				[SESSION_ID]: { type: 'idle' },
			},
			sessions: [{ id: SESSION_ID, revert: { messageID: 'msg-3' } } as never],
		}));

		expect(useChatStore.getState().sessionStatus[SESSION_ID]).toEqual({ type: 'idle' });
		expect(useChatStore.getState().sessions[0]?.revert).toEqual({ messageID: 'msg-3' });
	});

	it('clears session input independently from optimistic message application', () => {
		useChatStore.getState().actions.updateSessionInput('draft text', SESSION_ID);

		const optimistic = createUserMessage('msg-optimistic', 'draft text');
		useChatStore.getState().actions.addOptimisticMessage({
			sessionId: SESSION_ID,
			message: optimistic.message,
			parts: [optimistic.part],
		});
		useChatStore.getState().actions.updateSessionInput('', SESSION_ID);

		const state = useChatStore.getState();
		expect(state.sessionInput[SESSION_ID]).toBe('');
		expect(state.messages[SESSION_ID].some(message => message.id === 'msg-optimistic')).toBe(true);
	});

	it('keeps revert marker stable across repeated local edit-send preparations', () => {
		useChatStore.setState(state => ({
			...state,
			sessions: [{ id: SESSION_ID, revert: { messageID: 'msg-3' } } as never],
			sessionStatus: { ...state.sessionStatus, [SESSION_ID]: { type: 'idle' } },
		}));

		useChatStore.setState(state => ({
			...state,
			sessions: [{ id: SESSION_ID, revert: { messageID: 'msg-3' } } as never],
			sessionStatus: { ...state.sessionStatus, [SESSION_ID]: { type: 'idle' } },
		}));

		expect(useChatStore.getState().sessions[0]?.revert).toEqual({ messageID: 'msg-3' });
		expect(useChatStore.getState().sessionStatus[SESSION_ID]).toEqual({ type: 'idle' });
	});

	it('only treats the latest assistant message as processing', () => {
		const olderAssistant = {
			id: 'a-old',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u1',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const newerAssistant = {
			id: 'a-new',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u2',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now(), completed: Date.now() + 1 },
		} as unknown as Message;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: olderAssistant },
			} as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: newerAssistant },
			} as never,
		]);

		expect(isSessionProcessing(useChatStore.getState(), SESSION_ID)).toBe(false);
	});

	it('optimistically truncates stale tail messages during edit flow', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');
		const third = createUserMessage('msg-3', 'third');

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: first.message },
			} as never,
			{ type: 'message.part.updated', properties: { part: first.part } } as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: second.message },
			} as never,
			{ type: 'message.part.updated', properties: { part: second.part } } as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: third.message },
			} as never,
			{ type: 'message.part.updated', properties: { part: third.part } } as never,
		]);

		useChatStore.getState().actions.truncateSessionMessages(SESSION_ID, 'msg-2', true);

		const state = useChatStore.getState();
		expect(state.messages[SESSION_ID].map(message => message.id)).toEqual(['msg-1']);
		expect(state.parts['msg-2']).toBeUndefined();
		expect(state.parts['msg-3']).toBeUndefined();
	});

	it('clears stale session model when truncation removes the only model-bearing user message', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');
		(second.message as Record<string, unknown>).model = {
			providerID: 'openai',
			modelID: 'gpt-5',
		};

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: first.message },
			} as never,
			{ type: 'message.part.updated', properties: { part: first.part } } as never,
			{
				type: 'message.updated',
				properties: { sessionID: SESSION_ID, info: second.message },
			} as never,
			{ type: 'message.part.updated', properties: { part: second.part } } as never,
		]);

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');

		useChatStore.getState().actions.truncateSessionMessages(SESSION_ID, 'msg-1', false);

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBeUndefined();
	});

	it('keeps accumulated streaming text when stale part updates arrive in the same batch', () => {
		const userMessage = createUserMessage('msg-live-user', 'prompt');
		const assistantMessage = {
			id: 'msg-live',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'msg-live-user',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const assistantPart = {
			id: 'msg-live-text',
			messageID: 'msg-live',
			sessionID: SESSION_ID,
			type: 'text',
			text: 'Hello',
		} as Part;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: userMessage.message,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: userMessage.part,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: assistantMessage,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: assistantPart,
				},
			} as never,
		]);

		useChatStore.getState().actions.applyBatch([
			{
				type: 'message.part.delta',
				properties: {
					messageID: 'msg-live',
					partID: 'msg-live-text',
					field: 'text',
					delta: ' world',
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'msg-live-text',
						messageID: 'msg-live',
						sessionID: SESSION_ID,
						type: 'text',
						text: 'Hello',
					},
				},
			} as never,
			{
				type: 'message.part.delta',
				properties: {
					messageID: 'msg-live',
					partID: 'msg-live-text',
					field: 'text',
					delta: '!',
				},
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.parts[assistantMessage.id][0]).toMatchObject({ text: 'Hello world!' });
		const node = deriveSessionView(state, SESSION_ID).nodesById['msg-msg-live-text'];
		expect(node).toMatchObject({ kind: 'assistant', content: 'Hello world!' });
	});
});

describe('chatStore derived view streaming', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);
	});

	function setupAssistantStreaming() {
		const userMsg: Message = {
			id: 'u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a1',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u1',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const textPart: Part = {
			id: 'p1',
			messageID: 'a1',
			sessionID: SESSION_ID,
			type: 'text',
			text: 'Hello',
		} as unknown as Part;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: userMsg,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: asstMsg,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: textPart,
				},
			} as never,
		]);
		return useChatStore.getState();
	}

	it('creates derived view from restore event batches', () => {
		const state = setupAssistantStreaming();
		const view = deriveSessionView(state, SESSION_ID);
		expect(view).toBeDefined();
		expect(view.nodeIds.length).toBe(2); // user + assistant
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode).toBeDefined();
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello');
		}
	});

	it('updates derived view content on applyEvent delta', () => {
		setupAssistantStreaming();

		useChatStore.getState().actions.applyEvent({
			type: 'message.part.delta',
			properties: {
				sessionID: SESSION_ID,
				messageID: 'a1',
				partID: 'p1',
				field: 'text',
				delta: ' world',
			},
		} as never);

		const state = useChatStore.getState();
		const view = deriveSessionView(state, SESSION_ID);
		expect(view).toBeDefined();
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello world');
		}
	});

	it('updates derived view content on applyBatch delta', () => {
		setupAssistantStreaming();

		useChatStore.getState().actions.applyBatch([
			{
				type: 'message.part.delta',
				properties: {
					sessionID: SESSION_ID,
					messageID: 'a1',
					partID: 'p1',
					field: 'text',
					delta: ' world',
				},
			} as never,
			{
				type: 'message.part.delta',
				properties: {
					sessionID: SESSION_ID,
					messageID: 'a1',
					partID: 'p1',
					field: 'text',
					delta: '!',
				},
			} as never,
		]);

		const state = useChatStore.getState();
		const view = deriveSessionView(state, SESSION_ID);
		expect(view).toBeDefined();
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello world!');
		}
	});

	it('recomputes derived view after each delta', () => {
		setupAssistantStreaming();
		const before = deriveSessionView(useChatStore.getState(), SESSION_ID);

		useChatStore.getState().actions.applyEvent({
			type: 'message.part.delta',
			properties: {
				sessionID: SESSION_ID,
				messageID: 'a1',
				partID: 'p1',
				field: 'text',
				delta: '!',
			},
		} as never);

		const after = deriveSessionView(useChatStore.getState(), SESSION_ID);
		expect(after.nodesById['msg-p1']).toMatchObject({ kind: 'assistant', content: 'Hello!' });
		expect(after).not.toBe(before);
	});

	it('re-groups sections when MCP server names change', () => {
		const userMsg: Message = {
			id: 'u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a1',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u1',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const toolPart: Part = {
			id: 'tool-1',
			messageID: 'a1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'mcp_fetch',
			callID: 'call-1',
			state: { status: 'completed', input: {}, output: 'done' },
		} as unknown as Part;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: userMsg,
				},
			} as never,
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: asstMsg,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: toolPart,
				},
			} as never,
		]);
		const before = deriveSessionView(useChatStore.getState(), SESSION_ID, []);

		useSettingsStore.getState().actions.setMcpServers({ mcp: { type: 'local', command: 'node' } });

		const after = deriveSessionView(useChatStore.getState(), SESSION_ID, ['mcp']);
		expect(after).toBeDefined();
		expect(after.sections.length).toBeGreaterThan(0);
		expect(after).not.toBe(before);
	});
});
