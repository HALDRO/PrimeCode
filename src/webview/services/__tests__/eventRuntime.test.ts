import { beforeEach, describe, expect, it, vi } from 'vitest';

const { flushQueuedMessagesMock, showRuntimeErrorMock } = vi.hoisted(() => {
	const flushQueuedMessagesMock = vi.fn(async () => {});
	const showRuntimeErrorMock = vi.fn();
	return { flushQueuedMessagesMock, showRuntimeErrorMock };
});

vi.mock('../opencodeRuntime', () => ({
	openCodeRuntime: {
		flushQueuedMessages: flushQueuedMessagesMock,
		showRuntimeError: showRuntimeErrorMock,
	},
}));

import { useChatStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { eventRuntime } from '../eventRuntime';

if (typeof globalThis.window === 'undefined') {
	Object.defineProperty(globalThis, 'window', {
		value: globalThis,
		configurable: true,
	});
}

async function flushQueuedTimers() {
	await vi.advanceTimersByTimeAsync(16);
}

// Intercept applyBatch calls by patching the store action
let appliedBatches: unknown[][] = [];

function resetStores() {
	useChatStore.setState(useChatStore.getInitialState(), true);
	useSettingsStore.setState(useSettingsStore.getInitialState(), true);
	useUIStore.setState(useUIStore.getInitialState(), true);
	appliedBatches = [];
	flushQueuedMessagesMock.mockClear();
	showRuntimeErrorMock.mockClear();
	// Patch applyBatch to capture calls
	const state = useChatStore.getState();
	const actions = state.actions;
	useChatStore.setState({
		...state,
		actions: {
			...actions,
			applyBatch: (events: unknown[]) => {
				appliedBatches.push(events);
			},
		},
	});
}

describe('eventRuntime', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		resetStores();
		eventRuntime.stop();
	});

	describe('start / stop lifecycle', () => {
		it('preserves existing status on start until health or events confirm connectivity', () => {
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			expect(useUIStore.getState().serverStatus).toBe('disconnected');
		});

		it('sets serverStatus to disconnected on stop', () => {
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			eventRuntime.stop();
			expect(useUIStore.getState().serverStatus).toBe('disconnected');
		});

		it('is a no-op when started with the same key', () => {
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			useUIStore.getState().actions.setServerStatus('error');

			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			// Should not have changed status back to connected
			expect(useUIStore.getState().serverStatus).toBe('error');
		});

		it('restarts when started with a different key', () => {
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			useUIStore.getState().actions.setServerStatus('error');

			eventRuntime.start('http://localhost:5000', 'C:\\Project');
			expect(useUIStore.getState().serverStatus).toBe('disconnected');
		});

		it('normalizes drive letter casing', () => {
			eventRuntime.start('http://localhost:4096', 'c:\\Project');
			useUIStore.getState().actions.setServerStatus('error');

			// Same path with uppercase drive letter — should be no-op
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			expect(useUIStore.getState().serverStatus).toBe('error');
		});
	});

	describe('handleExtensionMessage', () => {
		it('sets serverStatus to connected on opencodeEvent', () => {
			useUIStore.getState().actions.setServerStatus('disconnected');

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'server.connected' } },
			});

			expect(useUIStore.getState().serverStatus).toBe('connected');
		});

		it('forwards non-opencodeEvent messages to stores', () => {
			// This test verifies the message reaches chatStore handleExtensionMessage
			// by checking it doesn't throw and doesn't set serverStatus
			useUIStore.getState().actions.setServerStatus('disconnected');

			eventRuntime.handleExtensionMessage({ type: 'someOtherMessage', data: {} });

			// serverStatus should remain disconnected (not set to connected)
			expect(useUIStore.getState().serverStatus).toBe('disconnected');
		});
	});

	describe('event filtering (handleGlobalEnvelope)', () => {
		it('filters out server.connected in envelope format', async () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'server.connected' } },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(0);
		});

		it('filters out server.connected in direct format', async () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { type: 'server.connected' },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(0);
		});

		it('filters out sync events', async () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'sync' } },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(0);
		});

		it('enqueues message.updated events in envelope format', async () => {
			const event = {
				type: 'message.updated',
				properties: { sessionID: 'ses-1', info: { id: 'msg-1', role: 'assistant' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { directory: 'C:\\Project', payload: event },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
		});

		it('enqueues message.part.updated events in direct format', async () => {
			const event = {
				type: 'message.part.updated',
				properties: { part: { id: 'p-1', messageID: 'msg-1', sessionID: 'ses-1' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: event,
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
		});

		it('enqueues session.status events', async () => {
			const event = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'busy' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).not.toHaveBeenCalled();
		});

		it('flushes queued messages after canonical session.idle', async () => {
			const event = {
				type: 'session.idle',
				properties: { sessionID: 'ses-1' },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('ses-1');
		});

		it('flushes queued messages after canonical session.status idle', async () => {
			const event = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'idle' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('ses-1');
		});

		it('flushes queued messages for the full parent lineage when a child session becomes idle', async () => {
			useChatStore.setState(state => ({
				...state,
				sessions: [
					{ id: 'root' } as never,
					{ id: 'child', parentID: 'root' } as never,
					{ id: 'grandchild', parentID: 'child' } as never,
				],
			}));

			const event = {
				type: 'session.idle',
				properties: { sessionID: 'grandchild' },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			await flushQueuedTimers();

			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('grandchild');
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('child');
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('root');
		});

		it('forwards session.updated revert events into the store batch', async () => {
			const event = {
				type: 'session.updated',
				properties: {
					info: {
						id: 'ses-1',
						revert: { messageID: 'msg-2' },
					},
				},
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
		});
	});

	describe('event coalescing', () => {
		it('coalesces session.status events for the same session', async () => {
			const event1 = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'busy' } },
			};
			const event2 = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'idle' } },
			};

			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event1 } });
			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event2 } });
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			// Only the latest event should be in the batch
			expect(appliedBatches[0]).toEqual([event2]);
		});

		it('does not coalesce events for different sessions', async () => {
			const event1 = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'busy' } },
			};
			const event2 = {
				type: 'session.status',
				properties: { sessionID: 'ses-2', status: { type: 'busy' } },
			};

			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event1 } });
			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event2 } });
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event1, event2]);
		});

		it('does not coalesce message.updated events', async () => {
			const event1 = {
				type: 'message.updated',
				properties: { sessionID: 'ses-1', info: { id: 'msg-1' } },
			};
			const event2 = {
				type: 'message.updated',
				properties: { sessionID: 'ses-1', info: { id: 'msg-2' } },
			};

			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event1 } });
			eventRuntime.handleExtensionMessage({ type: 'opencodeEvent', data: { payload: event2 } });
			await flushQueuedTimers();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event1, event2]);
		});
	});

	describe('getLastEventAge', () => {
		it('returns time since last SSE event', () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'server.connected' } },
			});

			const age = eventRuntime.getLastEventAge();
			expect(age).toBeGreaterThanOrEqual(0);
			expect(age).toBeLessThan(100);
		});
	});
});
