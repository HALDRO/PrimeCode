import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { isSessionProcessing, useChatStore } from '../chatStore';
import { deriveSessionView } from '../derived';
import type { WebviewSdkEvent } from '../eventReducer';
import { useSettingsStore } from '../settingsStore';
import { useUIStore } from '../uiStore';

const SESSION_ID = 'session-1';

function resetStore() {
	useChatStore.setState(useChatStore.getInitialState(), true);
	useSettingsStore.setState(useSettingsStore.getInitialState(), true);
	useUIStore.setState(useUIStore.getInitialState(), true);
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

	it('stores session.error notifications with their origin sessionId', () => {
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);
		restoreFromEvents([
			{
				type: 'session.error',
				properties: {
					sessionID: SESSION_ID,
					error: { name: 'ModelUnavailableError', message: 'Model is down' },
				},
			} as never,
		]);

		expect(useUIStore.getState().notifications).toEqual([
			expect.objectContaining({
				type: 'error',
				content: 'Model is down',
				sessionId: SESSION_ID,
			}),
		]);
	});

	it('does not surface session.error from inactive sessions as top-level notifications', () => {
		useChatStore.getState().actions.applyTabState([SESSION_ID, 'session-2'], SESSION_ID);

		restoreFromEvents([
			{
				type: 'session.error',
				properties: {
					sessionID: 'session-2',
					error: { name: 'ModelUnavailableError', message: 'Background model is down' },
				},
			} as never,
		]);

		expect(useUIStore.getState().notifications).toEqual([]);
	});

	it('does not surface noisy unknown agent-not-found session errors', () => {
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);

		restoreFromEvents([
			{
				type: 'session.error',
				properties: {
					sessionID: SESSION_ID,
					error: {
						name: 'UnknownError',
						message:
							'Agent not found: "Sisyphus - Ultraworker". Available agents: build, explore, general, plan',
					},
				},
			} as never,
		]);

		expect(useUIStore.getState().notifications).toEqual([]);
	});

	it('does not surface wrapped unknown agent resolution errors', () => {
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);

		restoreFromEvents([
			{
				type: 'session.error',
				properties: {
					sessionID: SESSION_ID,
					error: {
						name: 'UnknownError',
						message:
							'UnknownError: UnknownError\n    at <anonymous> (B:/~BUN/root/chunk-4er2r1w8.js:1888:2246)\n    at SessionPrompt.createUserMessage (B:/~BUN/root/chunk-4er2r1w8.js:1889:370)\n    at SessionPrompt.prompt (B:/~BUN/root/chunk-zpgs2p4y.js:9:126643)',
					},
				},
			} as never,
		]);

		expect(useUIStore.getState().notifications).toEqual([]);
	});

	it('keeps inactive-session errors suppressed even when content matches the active session error', () => {
		restoreFromEvents([
			{
				type: 'session.error',
				properties: {
					sessionID: SESSION_ID,
					error: { name: 'ModelUnavailableError', message: 'Model is down' },
				},
			} as never,
			{
				type: 'session.error',
				properties: {
					sessionID: 'session-2',
					error: { name: 'ModelUnavailableError', message: 'Model is down' },
				},
			} as never,
		]);

		const notifications = useUIStore.getState().notifications;
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toEqual(
			expect.objectContaining({
				sessionId: SESSION_ID,
				content: 'Model is down',
				count: 1,
			}),
		);
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

	it('does not overwrite an explicit session model when global model is restored', () => {
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);

		useSettingsStore.getState().actions.setLastSelectedModel('anthropic/claude-sonnet-4');

		expect(useChatStore.getState().sessionModel[SESSION_ID]).toBe('openai/gpt-5');
	});

	it('does not overwrite an explicit session model when history is restored', () => {
		useChatStore.getState().actions.updateSessionModel('openai/gpt-5', SESSION_ID);
		const restored = createUserMessageWithModel('msg-restored', 'restored', {
			providerID: 'anthropic',
			modelID: 'claude-sonnet-4',
		});

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: restored.message,
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

	it('returns a plain queued message object from dequeueMessage', () => {
		useChatStore.getState().actions.enqueueMessage({
			sessionId: SESSION_ID,
			text: 'queued',
			agent: 'build',
			attachments: {
				images: [{ id: 'img-1', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }],
				files: ['src/index.ts'],
				codeSnippets: [
					{ filePath: 'src/index.ts', content: 'const x = 1', startLine: 1, endLine: 1 },
				],
			},
		});

		const entry = useChatStore.getState().actions.dequeueMessage(SESSION_ID);

		expect(entry).toBeDefined();
		expect(entry?.text).toBe('queued');
		expect(() => entry?.attachments?.images?.[0]?.name).not.toThrow();
		expect(entry?.attachments?.images?.[0]?.name).toBe('shot.png');
		expect(entry?.attachments?.files).toEqual(['src/index.ts']);
		expect(entry?.attachments?.codeSnippets?.[0]).toEqual(
			expect.objectContaining({ filePath: 'src/index.ts', content: 'const x = 1' }),
		);
	});

	it('cancels queued message and restores it into draft state', () => {
		const queueId = useChatStore.getState().actions.enqueueMessage({
			sessionId: SESSION_ID,
			text: 'restore me',
			agent: 'builder',
			attachments: {
				images: [{ id: 'img-1', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }],
			},
		});

		useChatStore.getState().actions.cancelQueuedMessage(SESSION_ID, queueId);

		const state = useChatStore.getState();
		expect(state.queuedMessagesBySession[SESSION_ID]).toBeUndefined();
		expect(state.sessionInput[SESSION_ID]).toBe('restore me');
		expect(state.draftAgent[SESSION_ID]).toBe('builder');
		expect(state.draftAttachments[SESSION_ID]).toEqual({
			images: [{ id: 'img-1', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' }],
		});
	});

	it('reorders queued messages deterministically', () => {
		const firstId = useChatStore.getState().actions.enqueueMessage({
			sessionId: SESSION_ID,
			text: 'first',
		});
		const secondId = useChatStore.getState().actions.enqueueMessage({
			sessionId: SESSION_ID,
			text: 'second',
		});
		const thirdId = useChatStore.getState().actions.enqueueMessage({
			sessionId: SESSION_ID,
			text: 'third',
		});

		useChatStore.getState().actions.reorderQueuedMessages(SESSION_ID, [thirdId, firstId, secondId]);

		expect(
			useChatStore.getState().queuedMessagesBySession[SESSION_ID]?.map(item => item.text),
		).toEqual(['third', 'first', 'second']);
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

	it('keeps the revert marker on the exact user message selected for restore', () => {
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
					revert: { messageID: 'msg-2' },
				} as never,
			],
		}));

		const view = deriveSessionView(useChatStore.getState(), SESSION_ID);
		expect(view.sections).toHaveLength(3);
		expect(view.sections[1].isRevertPoint).toBe(true);
		expect(view.sections[1].isReverted).toBe(true);
		expect(view.sections[2].isReverted).toBe(true);
		expect(view.sections[0].isRevertPoint).toBe(false);
	});

	it('moves the reverted range back to the earlier turn when restore is re-targeted', () => {
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

		useChatStore.setState(state => ({
			...state,
			sessions: [
				{
					id: SESSION_ID,
					revert: { messageID: 'msg-1' },
				} as never,
			],
		}));

		const view = deriveSessionView(useChatStore.getState(), SESSION_ID);
		expect(view.sections).toHaveLength(3);
		expect(view.sections[0].isRevertPoint).toBe(true);
		expect(view.sections[0].isReverted).toBe(true);
		expect(view.sections[1].isReverted).toBe(true);
		expect(view.sections[2].isReverted).toBe(true);
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

	it('treats parent session as processing when a descendant session is busy', () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				child: { type: 'busy' },
			},
			childSessionIdsByParentId: {
				...state.childSessionIdsByParentId,
				[SESSION_ID]: ['child'],
			},
		}));

		expect(isSessionProcessing(useChatStore.getState(), SESSION_ID)).toBe(true);
	});

	it('treats parent session as retrying when a descendant session is retrying', () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				child: { type: 'retry', attempt: 2, message: 'later', next: 12345 },
			},
			childSessionIdsByParentId: {
				...state.childSessionIdsByParentId,
				[SESSION_ID]: ['child'],
			},
		}));

		expect(isSessionProcessing(useChatStore.getState(), SESSION_ID)).toBe(true);
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

	it('stores idle session diff events even though idle panel no longer relies on them', () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: { ...state.sessionStatus, [SESSION_ID]: { type: 'idle' } },
			sessionDiff: { ...state.sessionDiff, [SESSION_ID]: [] },
		}));

		restoreFromEvents([
			{
				type: 'session.diff',
				properties: {
					sessionID: SESSION_ID,
					diff: [
						{
							file: 'config.yaml',
							patch: '',
							additions: 239,
							deletions: 143,
							status: 'modified',
						},
					],
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionDiff[SESSION_ID]).toEqual([
			expect.objectContaining({ file: 'config.yaml', additions: 239, deletions: 143 }),
		]);
	});

	it('updates session diff from live events while the session is busy', () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: { ...state.sessionStatus, [SESSION_ID]: { type: 'busy' } },
			sessionDiff: { ...state.sessionDiff, [SESSION_ID]: [] },
		}));

		restoreFromEvents([
			{
				type: 'session.diff',
				properties: {
					sessionID: SESSION_ID,
					diff: [
						{
							file: 'src/gui_web/static/app.js',
							patch: '',
							additions: 5,
							deletions: 0,
							status: 'modified',
						},
					],
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionDiff[SESSION_ID]).toEqual([
			expect.objectContaining({ file: 'src/gui_web/static/app.js', additions: 5, deletions: 0 }),
		]);
	});

	it('keeps only deltas that arrive after the current part snapshot', () => {
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
		expect(state.parts[assistantMessage.id][0]).toMatchObject({ text: 'Hello!' });
		const node = deriveSessionView(state, SESSION_ID).nodesById['msg-msg-live-text'];
		expect(node).toMatchObject({ kind: 'assistant', content: 'Hello!' });
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

	it('ignores child deltas that arrive before the initial part snapshot', () => {
		const userMsg: Message = {
			id: 'u-child-live',
			sessionID: 'child-live-1',
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-child-live',
			sessionID: 'child-live-1',
			role: 'assistant',
			parentID: 'u-child-live',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: { sessionID: 'child-live-1', info: userMsg },
			} as never,
			{
				type: 'message.updated',
				properties: { sessionID: 'child-live-1', info: asstMsg },
			} as never,
		]);

		useChatStore.getState().actions.applyBatch([
			{
				type: 'message.part.delta',
				properties: {
					messageID: 'a-child-live',
					partID: 'p-child-live',
					field: 'text',
					delta: 'Hello',
				},
			} as never,
			{
				type: 'message.part.delta',
				properties: {
					messageID: 'a-child-live',
					partID: 'p-child-live',
					field: 'text',
					delta: ' world',
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'p-child-live',
						messageID: 'a-child-live',
						sessionID: 'child-live-1',
						type: 'text',
						text: '',
					},
				},
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.parts['a-child-live'][0]).toMatchObject({ text: '' });
		const node = deriveSessionView(state, 'child-live-1').nodesById['msg-p-child-live'];
		expect(node).toBeUndefined();
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

	it('links child session to latest task tool call on session.created', () => {
		const userMsg: Message = {
			id: 'u-task',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-task',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u-task',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const taskPart: Part = {
			id: 'tool-task-1',
			messageID: 'a-task',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-1',
			state: { status: 'running', input: { description: 'delegate work' } },
			metadata: {},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: userMsg } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: asstMsg } } as never,
			{ type: 'message.part.updated', properties: { part: taskPart } } as never,
			{
				type: 'session.created',
				properties: { info: { id: 'child-task-1', parentID: SESSION_ID } },
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-1']).toBe('call-task-1');
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-task-1');
	});

	it('does not guess child task link when multiple task calls are unlinked', () => {
		const userMsg: Message = {
			id: 'u-task-ambiguous',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-task-ambiguous',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u-task-ambiguous',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const firstTaskPart: Part = {
			id: 'tool-task-a',
			messageID: 'a-task-ambiguous',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-a',
			state: { status: 'running', input: { description: 'first' } },
			metadata: {},
		} as unknown as Part;
		const secondTaskPart: Part = {
			id: 'tool-task-b',
			messageID: 'a-task-ambiguous',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-b',
			state: { status: 'running', input: { description: 'second' } },
			metadata: {},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: userMsg } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: asstMsg } } as never,
			{ type: 'message.part.updated', properties: { part: firstTaskPart } } as never,
			{ type: 'message.part.updated', properties: { part: secondTaskPart } } as never,
			{
				type: 'session.created',
				properties: { info: { id: 'child-task-ambiguous', parentID: SESSION_ID } },
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-ambiguous']).toBeUndefined();
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-task-ambiguous');
	});

	it('prefers the only unlinked running task call on session.created even if stale completed task calls exist', () => {
		const userMsg: Message = {
			id: 'u-task-running-preferred',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-task-running-preferred',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u-task-running-preferred',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const staleCompletedTaskPart: Part = {
			id: 'tool-task-stale-completed',
			messageID: 'a-task-running-preferred',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-stale-completed',
			state: { status: 'completed', input: { description: 'stale completed' }, output: 'done' },
			metadata: {},
		} as unknown as Part;
		const activeRunningTaskPart: Part = {
			id: 'tool-task-active-running',
			messageID: 'a-task-running-preferred',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-active-running',
			state: { status: 'running', input: { description: 'active running' } },
			metadata: {},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: userMsg } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: asstMsg } } as never,
			{ type: 'message.part.updated', properties: { part: staleCompletedTaskPart } } as never,
			{ type: 'message.part.updated', properties: { part: activeRunningTaskPart } } as never,
			{
				type: 'session.created',
				properties: { info: { id: 'child-task-running-preferred', parentID: SESSION_ID } },
			} as never,
		]);

		const state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-running-preferred']).toBe(
			'call-task-active-running',
		);
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-task-running-preferred');
	});

	it('prefers official task metadata sessionId over fallback task order', () => {
		const userMsg: Message = {
			id: 'u-task-metadata',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-task-metadata',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u-task-metadata',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const taskPart: Part = {
			id: 'tool-task-metadata',
			messageID: 'a-task-metadata',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-metadata',
			state: { status: 'completed', input: { description: 'official' }, output: 'done' },
			metadata: { sessionId: 'child-task-metadata' },
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: userMsg } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: asstMsg } } as never,
			{
				type: 'session.created',
				properties: { info: { id: 'other-child', parentID: SESSION_ID } },
			} as never,
			{ type: 'message.part.updated', properties: { part: taskPart } } as never,
		]);

		const state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-metadata']).toBe('call-task-metadata');
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-task-metadata');
	});

	it('preserves an early child link during reconcile before task metadata arrives', () => {
		const userMsg: Message = {
			id: 'u-task-preserve-link',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const asstMsg: Message = {
			id: 'a-task-preserve-link',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'u-task-preserve-link',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const runningTaskPart: Part = {
			id: 'tool-task-preserve-link',
			messageID: 'a-task-preserve-link',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'call-task-preserve-link',
			state: { status: 'running', input: { description: 'preserve early link' } },
			metadata: {},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: userMsg } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: asstMsg } } as never,
			{ type: 'message.part.updated', properties: { part: runningTaskPart } } as never,
			{
				type: 'session.created',
				properties: { info: { id: 'child-task-preserve-link', parentID: SESSION_ID } },
			} as never,
		]);

		let state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-preserve-link']).toBe(
			'call-task-preserve-link',
		);

		useChatStore.getState().actions.applyEvent({
			type: 'session.status',
			properties: {
				sessionID: 'child-task-preserve-link',
				status: { type: 'busy' },
			},
		} as never);

		state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-task-preserve-link']).toBe(
			'call-task-preserve-link',
		);
	});

	it('replays restored parent and child session snapshots together', () => {
		const rootUser: Message = {
			id: 'root-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const rootAsst: Message = {
			id: 'root-a1',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'root-u1',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now() },
		} as unknown as Message;
		const taskPart: Part = {
			id: 'root-task-part',
			messageID: 'root-a1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'root-task-call',
			state: { status: 'completed', input: { description: 'restore work' }, output: 'done' },
			metadata: {},
		} as unknown as Part;
		const childUser: Message = {
			id: 'child-u1',
			sessionID: 'child-hydrated-1',
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const childAsst: Message = {
			id: 'child-a1',
			sessionID: 'child-hydrated-1',
			role: 'assistant',
			parentID: 'child-u1',
			agent: 'build',
			tokens: { input: 2, output: 7, reasoning: 0, total: 9, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now(), completed: Date.now() + 15 },
		} as unknown as Message;
		const childToolPart: Part = {
			id: 'child-read-part',
			messageID: 'child-a1',
			sessionID: 'child-hydrated-1',
			type: 'tool',
			tool: 'read',
			callID: 'child-read-call',
			state: { status: 'completed', input: { filePath: '/tmp/file.txt' }, output: 'hello' },
		} as unknown as Part;

		useChatStore.getState().actions.replaySessionSnapshots([
			{
				session: { id: SESSION_ID } as never,
				messageEntries: [
					{ info: rootUser, parts: [] },
					{ info: rootAsst, parts: [taskPart] },
				],
				todos: [],
				diff: [],
				activate: true,
			},
			{
				session: { id: 'child-hydrated-1', parentID: SESSION_ID } as never,
				messageEntries: [
					{ info: childUser, parts: [] },
					{ info: childAsst, parts: [childToolPart] },
				],
				todos: [],
				diff: [],
				activate: false,
			},
		]);

		const state = useChatStore.getState();
		expect(state.originatingToolCallBySessionId['child-hydrated-1']).toBe('root-task-call');
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-hydrated-1');
		expect(state.sessionOrder).toEqual([SESSION_ID]);
		expect(state.activeSessionId).toBe(SESSION_ID);
		expect(state.sessions.map(session => session.id)).toContain('child-hydrated-1');
		expect(state.messages['child-hydrated-1']).toHaveLength(2);
		expect(state.parts['child-a1']).toEqual([childToolPart]);

		const parentView = deriveSessionView(state, SESSION_ID);
		const taskCardId = parentView.nodeIds.find(
			id => parentView.nodesById[id]?.kind === 'task_card',
		);
		const taskCard = taskCardId ? parentView.nodesById[taskCardId] : undefined;
		expect(taskCard?.kind).toBe('task_card');
		if (taskCard?.kind === 'task_card') {
			expect(taskCard.childSessionId).toBe('child-hydrated-1');
			expect(taskCard.childSummary.tokens?.total).toBe(9);
			expect(taskCard.childSummary.durationMs).toBeGreaterThan(0);
		}
	});

	it('keeps child task cards defined without file diff counters', () => {
		const rootUser: Message = {
			id: 'root-readonly-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const rootAsst: Message = {
			id: 'root-readonly-a1',
			sessionID: SESSION_ID,
			role: 'assistant',
			parentID: 'root-readonly-u1',
			agent: 'build',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now(), completed: Date.now() + 1 },
		} as unknown as Message;
		const taskPart: Part = {
			id: 'root-readonly-task',
			messageID: 'root-readonly-a1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'task',
			callID: 'root-readonly-task-call',
			state: { status: 'completed', input: { description: 'review' }, output: 'done' },
			metadata: { sessionId: 'child-readonly-1' },
		} as unknown as Part;
		const childSession = {
			id: 'child-readonly-1',
			parentID: SESSION_ID,
		} as never;
		const childUser: Message = {
			id: 'child-readonly-u1',
			sessionID: 'child-readonly-1',
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const childAsst: Message = {
			id: 'child-readonly-a1',
			sessionID: 'child-readonly-1',
			role: 'assistant',
			parentID: 'child-readonly-u1',
			agent: 'oracle',
			tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } },
			cost: 0,
			time: { created: Date.now(), completed: Date.now() + 1 },
		} as unknown as Message;
		const readPart: Part = {
			id: 'child-readonly-read',
			messageID: 'child-readonly-a1',
			sessionID: 'child-readonly-1',
			type: 'tool',
			tool: 'read',
			callID: 'child-readonly-read-call',
			state: { status: 'completed', input: { filePath: 'src/file.ts' }, output: 'content' },
		} as unknown as Part;

		useChatStore.getState().actions.replaySessionSnapshots([
			{
				session: { id: SESSION_ID } as never,
				messageEntries: [
					{ info: rootUser, parts: [] },
					{ info: rootAsst, parts: [taskPart] },
				],
				todos: [],
				diff: [],
				activate: true,
			},
			{
				session: childSession,
				messageEntries: [
					{ info: childUser, parts: [] },
					{ info: childAsst, parts: [readPart] },
				],
				todos: [],
				diff: [
					{
						file: 'src/file.ts',
						additions: 2,
						deletions: 43,
						status: 'modified',
					},
				],
				activate: false,
			},
		]);

		const parentView = deriveSessionView(useChatStore.getState(), SESSION_ID);
		const childSummary = parentView.nodeIds
			.map(id => parentView.nodesById[id])
			.find((node): node is Extract<typeof node, { kind: 'task_card' }> =>
				Boolean(node && node.kind === 'task_card'),
			)?.childSummary;

		expect(childSummary).toBeDefined();
		expect(childSummary?.childCount).toBe(0);
	});

	it('removes restored child sessions from corrupted persisted tab state without dropping hydration data', () => {
		useChatStore
			.getState()
			.actions.applyTabState([SESSION_ID, 'child-hydrated-1'], 'child-hydrated-1');

		const rootUser: Message = {
			id: 'root-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const childUser: Message = {
			id: 'child-u1',
			sessionID: 'child-hydrated-1',
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const childTextPart: Part = {
			id: 'child-text-part',
			messageID: 'child-u1',
			sessionID: 'child-hydrated-1',
			type: 'text',
			text: 'child prompt',
		} as Part;

		useChatStore.getState().actions.replaySessionSnapshots([
			{
				session: { id: SESSION_ID } as never,
				messageEntries: [{ info: rootUser, parts: [] }],
				todos: [],
				diff: [],
				activate: false,
			},
			{
				session: { id: 'child-hydrated-1', parentID: SESSION_ID } as never,
				messageEntries: [{ info: childUser, parts: [childTextPart] }],
				todos: [],
				diff: [],
				activate: true,
			},
		]);

		const state = useChatStore.getState();
		expect(state.sessionOrder).toEqual([SESSION_ID]);
		expect(state.activeSessionId).toBe(SESSION_ID);
		expect(state.childSessionIdsByParentId[SESSION_ID]).toContain('child-hydrated-1');
		expect(state.messages['child-hydrated-1']).toEqual([childUser]);
		expect(state.parts['child-u1']).toEqual([childTextPart]);
	});

	it('tracks owned files from mutating tool parts per session', () => {
		const user: Message = {
			id: 'msg-owned-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const toolPart: Part = {
			id: 'msg-owned-tool-1',
			messageID: 'msg-owned-u1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'write',
			callID: 'msg-owned-call-1',
			state: {
				status: 'completed',
				input: { path: 'src/owned.ts', content: 'export const owned = true;' },
				output: 'done',
			},
		} as unknown as Part;

		restoreFromEvents([
			{
				type: 'message.updated',
				properties: {
					sessionID: SESSION_ID,
					info: user,
				},
			} as never,
			{
				type: 'message.part.updated',
				properties: {
					part: toolPart,
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionOwnedFiles[SESSION_ID]).toEqual(['src/owned.ts']);
	});

	it('cleans owned file state when session is deleted', () => {
		useChatStore.setState(state => ({
			...state,
			sessions: [{ id: SESSION_ID } as never],
			messages: { [SESSION_ID]: [] },
			sessionOwnedFiles: { [SESSION_ID]: ['src/owned.ts'] },
		}));

		restoreFromEvents([
			{
				type: 'session.deleted',
				properties: {
					sessionID: SESSION_ID,
					info: { id: SESSION_ID } as never,
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionOwnedFiles[SESSION_ID]).toBeUndefined();
	});

	it('revokes owned files after truncating away the mutating message', () => {
		const oldUser: Message = {
			id: 'msg-old-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const editUser: Message = {
			id: 'msg-edit-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() + 1 },
		} as Message;
		const editPart: Part = {
			id: 'msg-edit-tool-1',
			messageID: 'msg-edit-u1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'edit',
			callID: 'msg-edit-call-1',
			state: {
				status: 'completed',
				input: { path: 'src/revert.ts', old_string: 'a', new_string: 'b' },
				output: 'done',
			},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: oldUser } } as never,
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: editUser } } as never,
			{ type: 'message.part.updated', properties: { part: editPart } } as never,
		]);

		useChatStore.getState().actions.truncateSessionMessages(SESSION_ID, 'msg-old-u1');

		expect(useChatStore.getState().sessionOwnedFiles[SESSION_ID]).toBeUndefined();
	});

	it('revokes owned files after removing the tool part', () => {
		const user: Message = {
			id: 'msg-remove-u1',
			sessionID: SESSION_ID,
			role: 'user',
			time: { created: Date.now() },
		} as Message;
		const toolPart: Part = {
			id: 'msg-remove-tool-1',
			messageID: 'msg-remove-u1',
			sessionID: SESSION_ID,
			type: 'tool',
			tool: 'write',
			callID: 'msg-remove-call-1',
			state: {
				status: 'completed',
				input: { path: 'src/remove.ts', content: 'x' },
				output: 'done',
			},
		} as unknown as Part;

		restoreFromEvents([
			{ type: 'message.updated', properties: { sessionID: SESSION_ID, info: user } } as never,
			{ type: 'message.part.updated', properties: { part: toolPart } } as never,
		]);

		restoreFromEvents([
			{
				type: 'message.part.removed',
				properties: {
					sessionID: SESSION_ID,
					messageID: 'msg-remove-u1',
					partID: 'msg-remove-tool-1',
				},
			} as never,
		]);

		expect(useChatStore.getState().sessionOwnedFiles[SESSION_ID]).toBeUndefined();
	});
});

describe('chatStore agent selection', () => {
	beforeEach(() => {
		resetStore();
		useChatStore.getState().actions.applyTabState([SESSION_ID], SESSION_ID);
	});

	it('stores Build as the implicit default agent', () => {
		const actions = useChatStore.getState().actions;

		actions.updateSessionAgent('sisyphus');
		expect(useChatStore.getState().sessionAgent[SESSION_ID]).toBe('sisyphus');

		actions.updateSessionAgent('build');
		expect(useChatStore.getState().sessionAgent[SESSION_ID]).toBeUndefined();
		expect(SESSION_ID in useChatStore.getState().sessionAgent).toBe(false);
	});
});
