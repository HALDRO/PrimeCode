import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../chatStore';

const SESSION_ID = 'session-1';

function resetStore() {
	useChatStore.setState(useChatStore.getInitialState(), true);
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

describe('chatStore revert', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.handleSessionCreated(SESSION_ID);
	});

	it('restores revert state from extension messages', () => {
		useChatStore.getState().actions.handleExtensionMessage({
			type: 'restoreState',
			data: {
				sessionId: SESSION_ID,
				action: 'success',
				revertedFromMessageId: 'msg-2',
				canUnrevert: true,
			},
		});

		let state = useChatStore.getState();
		expect(state.revertedFromMessageId[SESSION_ID]).toBe('msg-2');
		expect(state.sessionCanUnrevert[SESSION_ID]).toBe(true);

		useChatStore.getState().actions.handleExtensionMessage({
			type: 'restoreState',
			data: {
				sessionId: SESSION_ID,
				action: 'unrevert_available',
				available: false,
			},
		});

		state = useChatStore.getState();
		expect(state.revertedFromMessageId[SESSION_ID]).toBeNull();
		expect(state.sessionCanUnrevert[SESSION_ID]).toBe(false);
	});

	it('restores canonical session messages and parts for reverted sessions', () => {
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

		useChatStore.getState().actions.markRevertedFromMessageId('msg-2', SESSION_ID);

		const state = useChatStore.getState();
		expect(state.messages[SESSION_ID].map(message => message.id)).toEqual(['msg-1', 'msg-2']);
		expect(state.parts['msg-1'][0]).toMatchObject({ text: 'first' });
		expect(state.parts['msg-2'][0]).toMatchObject({ text: 'second' });
		expect(state.revertedFromMessageId[SESSION_ID]).toBe('msg-2');
	});

	it('drops removed messages and clears revert marker when caller resets it', () => {
		const first = createUserMessage('msg-1', 'first');
		const second = createUserMessage('msg-2', 'second');

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [first.message, second.message],
			parts: {
				[first.message.id]: [first.part],
				[second.message.id]: [second.part],
			},
		});
		useChatStore.getState().actions.markRevertedFromMessageId('msg-2', SESSION_ID);

		useChatStore.getState().actions.applyEvent({
			type: 'message.removed',
			properties: {
				sessionID: SESSION_ID,
				messageID: 'msg-2',
			},
		} as never);
		useChatStore.getState().actions.markRevertedFromMessageId(null, SESSION_ID);

		const state = useChatStore.getState();
		expect(state.messages[SESSION_ID].map(message => message.id)).toEqual(['msg-1']);
		expect(state.parts['msg-2']).toBeUndefined();
		expect(state.revertedFromMessageId[SESSION_ID]).toBeNull();
	});

	it('keeps deltas that arrive after a part update in the same batch', () => {
		const message = createUserMessage('msg-live', 'prompt');

		useChatStore.getState().actions.restoreSession(SESSION_ID, {
			messages: [message.message],
			parts: {
				[message.message.id]: [message.part],
			},
		});

		useChatStore.getState().actions.applyBatch([
			{
				type: 'message.part.delta',
				properties: {
					messageID: 'msg-live',
					partID: 'msg-live-text',
					field: 'text',
					delta: ' stale',
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
					delta: ' world',
				},
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.parts['msg-live'][0]).toMatchObject({ text: 'Hello world' });
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
});
