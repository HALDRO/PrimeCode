import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => await import('../../__mocks__/vscode.js'));

import { OutboundBridge } from '../../transport/OutboundBridge';
import { ChatProvider } from '../ChatProvider';

function createBridgeProvider() {
	const postedMessages: unknown[] = [];
	const bridge = new OutboundBridge();
	vi.spyOn(bridge, 'send').mockImplementation((msg: unknown) => {
		postedMessages.push(msg);
	});

	const provider: any = Object.assign(Object.create(ChatProvider.prototype), {
		bridge,
		cli: {
			getAdminInfo: vi.fn(() => ({
				baseUrl: 'http://127.0.0.1:4096',
				directory: 'C:\\repo',
			})),
		},
		backendBusySessions: new Set<string>(),
		awaitingBackendBusy: new Set<string>(),
		pendingMessages: new Map(),
		sendingLock: new Set<string>(),
		pendingIdleDrain: new Set<string>(),
		suppressNextIdleDrain: new Set<string>(),
		healthMonitorTimer: null,
		healthConsecutiveFailures: 0,
	});

	return { provider, postedMessages, bridge };
}

describe('forwardBackendStatusEvent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('forwards all events to webview as opencodeEvent', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = { payload: { type: 'message.updated', properties: { sessionID: 'ses-1' } } };

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});

	it('extracts session.status with busy and forwards normalized status', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: {
				type: 'session.status',
				properties: {
					sessionID: 'ses-1',
					status: { type: 'busy' },
				},
			},
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual(
			expect.objectContaining({
				type: 'backendRuntimeStatus',
				data: expect.objectContaining({
					sessionId: 'ses-1',
					status: { type: 'busy' },
				}),
			}),
		);
	});

	it('extracts session.status with retry and preserves metadata', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: {
				type: 'session.status',
				properties: {
					sessionID: 'ses-1',
					status: { type: 'retry', attempt: 3, message: 'Rate limited', next: 1700000000 },
				},
			},
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual(
			expect.objectContaining({
				type: 'backendRuntimeStatus',
				data: expect.objectContaining({
					sessionId: 'ses-1',
					status: { type: 'retry', attempt: 3, message: 'Rate limited', next: 1700000000 },
				}),
			}),
		);
	});

	it('shows notification on session.error (non-abort)', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: {
				type: 'session.error',
				properties: {
					sessionID: 'ses-1',
					error: { name: 'ModelUnavailableError', message: 'Model is down' },
				},
			},
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual(
			expect.objectContaining({
				type: 'showNotification',
				data: expect.objectContaining({
					notification: expect.objectContaining({
						type: 'error',
					}),
				}),
			}),
		);
	});

	it('skips notification for MessageAbortedError', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: {
				type: 'session.error',
				properties: {
					sessionID: 'ses-1',
					error: { name: 'MessageAbortedError', message: 'Aborted by user' },
				},
			},
		};

		(provider as any).forwardBackendStatusEvent(event);

		const notifications = postedMessages.filter((msg: any) => msg.type === 'showNotification');
		expect(notifications).toHaveLength(0);
	});

	it('forwards events without payload.type without parsing status', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = { someField: 'value' };

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toHaveLength(1);
		expect(postedMessages[0]).toEqual({ type: 'opencodeEvent', data: event });
	});

	it('ignores session.idle for sessions not tracked as busy', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: { type: 'session.idle', properties: { sessionID: 'ses-unknown' } },
		};

		(provider as any).forwardBackendStatusEvent(event);

		const statusMessages = postedMessages.filter((msg: any) => msg.type === 'backendRuntimeStatus');
		expect(statusMessages).toHaveLength(0);
	});
});

describe('Health monitor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	it('starts polling on startHealthMonitor', () => {
		const { provider } = createBridgeProvider();

		(provider as any).startHealthMonitor();

		expect(provider.healthMonitorTimer).not.toBeNull();
	});

	it('stops polling on stopHealthMonitor', () => {
		const { provider } = createBridgeProvider();

		(provider as any).startHealthMonitor();
		(provider as any).stopHealthMonitor();

		expect(provider.healthMonitorTimer).toBeNull();
	});

	it('resets failure count on stopHealthMonitor + startHealthMonitor', () => {
		const { provider } = createBridgeProvider();
		provider.healthConsecutiveFailures = 5;

		(provider as any).startHealthMonitor();

		expect(provider.healthConsecutiveFailures).toBe(0);
	});

	it('does not call attemptReconnect (method removed)', () => {
		const { provider } = createBridgeProvider();

		expect((provider as any).attemptReconnect).toBeUndefined();
	});
});
