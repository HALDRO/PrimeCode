import { beforeEach, describe, expect, it, vi } from 'vitest';

const flushQueuedMessagesMock = vi.fn(async () => {});
const showRuntimeErrorMock = vi.fn();

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

// Mock window.requestAnimationFrame/cancelAnimationFrame for Node environment
let rafCallbacks: Array<() => void> = [];
Object.defineProperty(globalThis, 'window', {
	value: {
		requestAnimationFrame: vi.fn((cb: () => void) => {
			rafCallbacks.push(cb);
			return rafCallbacks.length;
		}),
		cancelAnimationFrame: vi.fn(),
	},
	configurable: true,
});

function flushRaf() {
	const cbs = rafCallbacks.slice();
	rafCallbacks = [];
	for (const cb of cbs) cb();
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
		resetStores();
		eventRuntime.stop();
		rafCallbacks = [];
	});

	describe('start / stop lifecycle', () => {
		it('sets serverStatus to connected on start', () => {
			eventRuntime.start('http://localhost:4096', 'C:\\Project');
			expect(useUIStore.getState().serverStatus).toBe('connected');
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
			expect(useUIStore.getState().serverStatus).toBe('connected');
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
		it('filters out server.connected in envelope format', () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'server.connected' } },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(0);
		});

		it('filters out server.connected in direct format', () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { type: 'server.connected' },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(0);
		});

		it('filters out sync events', () => {
			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: { type: 'sync' } },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(0);
		});

		it('enqueues message.updated events in envelope format', () => {
			const event = {
				type: 'message.updated',
				properties: { sessionID: 'ses-1', info: { id: 'msg-1', role: 'assistant' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { directory: 'C:\\Project', payload: event },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
		});

		it('enqueues message.part.updated events in direct format', () => {
			const event = {
				type: 'message.part.updated',
				properties: { part: { id: 'p-1', messageID: 'msg-1', sessionID: 'ses-1' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: event,
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
		});

		it('enqueues session.status events', () => {
			const event = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'busy' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).not.toHaveBeenCalled();
		});

		it('flushes queued messages after canonical session.idle', () => {
			const event = {
				type: 'session.idle',
				properties: { sessionID: 'ses-1' },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('ses-1');
		});

		it('flushes queued messages after canonical session.status idle', () => {
			const event = {
				type: 'session.status',
				properties: { sessionID: 'ses-1', status: { type: 'idle' } },
			};

			eventRuntime.handleExtensionMessage({
				type: 'opencodeEvent',
				data: { payload: event },
			});
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event]);
			expect(flushQueuedMessagesMock).toHaveBeenCalledWith('ses-1');
		});
	});

	describe('event coalescing', () => {
		it('coalesces session.status events for the same session', () => {
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
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			// Only the latest event should be in the batch
			expect(appliedBatches[0]).toEqual([event2]);
		});

		it('does not coalesce events for different sessions', () => {
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
			flushRaf();

			expect(appliedBatches).toHaveLength(1);
			expect(appliedBatches[0]).toEqual([event1, event2]);
		});

		it('does not coalesce message.updated events', () => {
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
			flushRaf();

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
