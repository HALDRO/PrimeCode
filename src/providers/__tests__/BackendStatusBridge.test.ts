/**
 * @file BackendStatusBridge tests
 * @description Tests for extension host event handling: handleForwardedEvent (events forwarded
 *              from webview SSE) and sendServerStatus.
 */

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

	const autoRespondMock = vi.fn();
	const updateSessionStatusMock = vi.fn();
	const removeSessionMock = vi.fn();
	const handleModelNotFoundRecoveryMock = vi.fn();

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
		toolHandler: {
			autoRespondToSessionPermissions: autoRespondMock,
		},
		services: {
			runtimeReload: {
				updateSessionStatus: updateSessionStatusMock,
				removeSession: removeSessionMock,
			},
		},
		handleModelNotFoundRecovery: handleModelNotFoundRecoveryMock,
	});

	return {
		provider,
		postedMessages,
		bridge,
		autoRespondMock,
		updateSessionStatusMock,
		removeSessionMock,
		handleModelNotFoundRecoveryMock,
	};
}

describe('handleForwardedEvent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('tracks session.status for runtime reload', () => {
		const { provider, updateSessionStatusMock } = createBridgeProvider();

		(provider as any).handleForwardedEvent({
			type: 'session.status',
			properties: { sessionID: 'ses-1', status: { type: 'busy' } },
		});

		expect(updateSessionStatusMock).toHaveBeenCalledWith('ses-1', { type: 'busy' });
	});

	it('removes session tracking on session.deleted', () => {
		const { provider, removeSessionMock } = createBridgeProvider();

		(provider as any).handleForwardedEvent({
			type: 'session.deleted',
			properties: { sessionID: 'ses-1' },
		});

		expect(removeSessionMock).toHaveBeenCalledWith('ses-1');
	});

	it('auto-responds to permission.asked', () => {
		const { provider, autoRespondMock } = createBridgeProvider();

		(provider as any).handleForwardedEvent({
			type: 'permission.asked',
			properties: { sessionID: 'ses-1' },
		});

		expect(autoRespondMock).toHaveBeenCalledWith('ses-1');
	});

	it('triggers model recovery on session.error with ProviderModelNotFound', () => {
		const { provider, handleModelNotFoundRecoveryMock } = createBridgeProvider();

		(provider as any).handleForwardedEvent({
			type: 'session.error',
			properties: { sessionID: 'ses-1', message: 'ProviderModelNotFound: model xyz' },
		});

		expect(handleModelNotFoundRecoveryMock).toHaveBeenCalled();
	});

	it('does not trigger model recovery for other session errors', () => {
		const { provider, handleModelNotFoundRecoveryMock } = createBridgeProvider();

		(provider as any).handleForwardedEvent({
			type: 'session.error',
			properties: { sessionID: 'ses-1', message: 'Rate limit exceeded' },
		});

		expect(handleModelNotFoundRecoveryMock).not.toHaveBeenCalled();
	});
});

describe('sendServerStatus', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('pushes explicit server status messages to the webview', () => {
		const { provider, postedMessages } = createBridgeProvider();

		(provider as any).sendServerStatus('connected');

		expect(postedMessages).toContainEqual({
			type: 'serverStatus',
			data: { status: 'connected' },
		});
	});
});
