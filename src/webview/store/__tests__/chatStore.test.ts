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
