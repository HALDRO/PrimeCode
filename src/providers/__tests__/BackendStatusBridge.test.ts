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
		settings: {
			getWorkspaceRoot: vi.fn(() => 'C:\\repo'),
		},
		cli: {
			getAdminInfo: vi.fn(() => ({
				baseUrl: 'http://127.0.0.1:4096',
				directory: 'C:\\repo',
			})),
		},
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

	it('extracts session.status with busy and forwards canonical event only', () => {
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

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});

	it('extracts session.status with retry and preserves metadata in canonical event', () => {
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

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});

	it('forwards session.error through canonical opencodeEvent without showNotification', () => {
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

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
		expect(postedMessages.filter((msg: any) => msg.type === 'showNotification')).toHaveLength(0);
	});

	it('forwards aborted session.error without direct notification side-channel', () => {
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

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
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

	it('forwards session.idle for untracked sessions without local mutation', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: { type: 'session.idle', properties: { sessionID: 'ses-unknown' } },
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});

	it('forwards tracked session idle without local normalization', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: { type: 'session.idle', properties: { sessionID: 'ses-1' } },
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});

	it('forwards session.updated events carrying revert metadata', () => {
		const { provider, postedMessages } = createBridgeProvider();
		const event = {
			payload: {
				type: 'session.updated',
				properties: {
					info: {
						id: 'ses-1',
						revert: { messageID: 'msg-2' },
					},
				},
			},
		};

		(provider as any).forwardBackendStatusEvent(event);

		expect(postedMessages).toContainEqual({ type: 'opencodeEvent', data: event });
	});
});
