import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';
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

describe('chatStore restore', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.handleSessionCreated(SESSION_ID);
	});

	it('restores canonical session messages and parts from snapshot', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');

		useChatStore.getState().actions.handleExtensionMessage({
			type: 'restore_session',
			data: {
				sessionId: SESSION_ID,
				messages: [first.message, second.message],
				parts: {
					[first.message.id]: [first.part],
					[second.message.id]: [second.part],
				},
			},
		});

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

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [first.message, second.message],
			parts: {
				[first.message.id]: [first.part],
				[second.message.id]: [second.part],
			},
		});

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('does not copy the previous session model into a newly created session', () => {
		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);

		useChatStore.getState().actions.handleSessionCreated('session-2');

		const state = useChatStore.getState();
		expect(state.activeSessionId).toBe('session-2');
		expect(state.sessionModel['session-2']).toBe('anthropic/claude-sonnet-4');
		expect(state.sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('seeds restored sessions from the global model when history has no model yet', () => {
		useSettingsStore.getState().actions.setLastSelectedModel('openai/gpt-5');
		const first = createUserMessage('msg-1', 'first');

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [first.message],
			parts: {
				[first.message.id]: [first.part],
			},
		});

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('drops removed messages after restore', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [first.message, second.message],
			parts: {
				[first.message.id]: [first.part],
				[second.message.id]: [second.part],
			},
		});
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

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [userMessage.message, assistantMessage],
			parts: {
				[userMessage.message.id]: [userMessage.part],
				[assistantMessage.id]: [assistantPart],
			},
		});

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
		const node = state.materializedViews[SESSION_ID].nodesById['msg-msg-live-text'];
		expect(node).toMatchObject({ kind: 'assistant', content: 'Hello world!' });
	});
});

describe('chatStore materialized view streaming', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.handleSessionCreated(SESSION_ID);
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

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [userMsg, asstMsg],
			parts: { a1: [textPart] },
		});
		return useChatStore.getState();
	}

	it('creates materialized view on restoreSession', () => {
		const state = setupAssistantStreaming();
		const view = state.materializedViews[SESSION_ID];
		expect(view).toBeDefined();
		expect(view.nodeIds.length).toBe(2); // user + assistant
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode).toBeDefined();
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello');
		}
	});

	it('updates materialized view content on applyEvent delta', () => {
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
		const view = state.materializedViews[SESSION_ID];
		expect(view).toBeDefined();
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello world');
		}
	});

	it('updates materialized view content on applyBatch delta', () => {
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
		const view = state.materializedViews[SESSION_ID];
		expect(view).toBeDefined();
		const asstNode = view.nodesById['msg-p1'];
		expect(asstNode.kind).toBe('assistant');
		if (asstNode.kind === 'assistant') {
			expect(asstNode.content).toBe('Hello world!');
		}
		// Should be incremental (not structural)
		expect(view.lastUpdateWasStructural).toBe(false);
	});

	it('materialized view version increments on each delta', () => {
		setupAssistantStreaming();
		const v1 = useChatStore.getState().materializedViews[SESSION_ID].version;

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

		const v2 = useChatStore.getState().materializedViews[SESSION_ID].version;
		expect(v2).toBeGreaterThan(v1);
	});

	it('rebuilds cached materialized sections when MCP server names change', () => {
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

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [userMsg, asstMsg],
			parts: { a1: [toolPart] },
		});
		const before = useChatStore.getState().materializedViews[SESSION_ID];

		useSettingsStore.getState().actions.setMcpServers({ mcp: { type: 'local', command: 'node' } });

		const after = useChatStore.getState().materializedViews[SESSION_ID];
		expect(after).toBeDefined();
		expect(after.version).toBeGreaterThan(before.version);
		expect(after.lastUpdateWasStructural).toBe(true);
	});
});
