import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	abortMock,
	statusMock,
	revertMock,
	unrevertMock,
	createClientMock,
	postMessageMock,
	proxyFetchMock,
} = vi.hoisted(() => {
	const abortMock = vi.fn(async () => {});
	const statusMock = vi.fn(async () => ({ data: {} }));
	const revertMock = vi.fn(async () => ({}));
	const unrevertMock = vi.fn(async () => ({}));
	const proxyFetchMock = vi.fn(async () => new Response('', { status: 200, statusText: 'OK' }));
	const createClientMock = vi.fn(() => ({
		session: {
			abort: abortMock,
			status: statusMock,
			revert: revertMock,
			unrevert: unrevertMock,
		},
	}));
	const postMessageMock = vi.fn();
	return {
		abortMock,
		statusMock,
		revertMock,
		unrevertMock,
		createClientMock,
		postMessageMock,
		proxyFetchMock,
	};
});

vi.mock('@opencode-ai/sdk/v2/client', () => ({
	createOpencodeClient: createClientMock,
}));

vi.mock('../utils/vscode', () => ({
	vscode: {
		postMessage: postMessageMock,
	},
}));

vi.mock('../utils/proxyFetch', () => ({
	proxyFetch: proxyFetchMock,
}));

// Provide window global for Node test environment
if (typeof globalThis.window === 'undefined') {
	(globalThis as unknown as Record<string, unknown>).window = globalThis;
}

import { useChatStore } from '../../store/chatStore';
import { useUIStore } from '../../store/uiStore';
import { openCodeRuntime } from '../opencodeRuntime';

describe('openCodeRuntime status recovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		useChatStore.setState(useChatStore.getInitialState(), true);
		useUIStore.setState(useUIStore.getInitialState(), true);
		useUIStore.setState({
			serverUrl: 'http://127.0.0.1:4096',
			workspaceRoot: 'C:\\repo',
		});
	});

	it('re-polls session status after abort when UI still shows busy', async () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				'ses-1': { type: 'busy' },
			},
		}));

		const abortPromise = openCodeRuntime.abortSession('ses-1');
		await abortPromise;

		expect(abortMock).toHaveBeenCalledWith({
			sessionID: 'ses-1',
			directory: 'C:\\repo',
		});
		expect(statusMock).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(2000);

		expect(statusMock).toHaveBeenCalledWith({ directory: 'C:\\repo' });
	});

	it('aborts busy descendant sessions when parent session is stopped', async () => {
		useChatStore.setState(state => ({
			...state,
			sessionStatus: {
				...state.sessionStatus,
				child: { type: 'busy' },
			},
			childSessionIdsByParentId: {
				...state.childSessionIdsByParentId,
				root: ['child'],
			},
		}));

		await openCodeRuntime.abortSession('root');

		expect(abortMock).toHaveBeenCalledWith({
			sessionID: 'child',
			directory: 'C:\\repo',
		});
	});

	it('restores the selected message by calling session.revert with the same message ID', async () => {
		await openCodeRuntime.restoreMessage('ses-1', 'msg-7');

		expect(revertMock).toHaveBeenCalledWith({
			sessionID: 'ses-1',
			messageID: 'msg-7',
			directory: 'C:\\repo',
		});
		expect(unrevertMock).not.toHaveBeenCalled();
	});

	it('surfaces runtime errors returned by revert operations', async () => {
		revertMock.mockResolvedValueOnce({
			error: {
				name: 'RuntimeError',
				data: { message: 'restore failed' },
			},
		});

		await expect(openCodeRuntime.restoreMessage('ses-1', 'msg-7')).rejects.toThrow(
			'restore failed',
		);
	});

	it('surfaces runtime errors returned by unrevert operations', async () => {
		unrevertMock.mockResolvedValueOnce({
			error: {
				name: 'RuntimeError',
				data: { message: 'unrevert failed' },
			},
		});

		await expect(openCodeRuntime.unrevert('ses-1')).rejects.toThrow('unrevert failed');
	});

	it('edits already-reverted history without deleting messages again', async () => {
		await openCodeRuntime.editMessage({
			sessionId: 'ses-1',
			messageId: 'msg-7',
			text: 'edited prompt',
			mode: 'replace_history',
			isAlreadyReverted: true,
		});

		expect(proxyFetchMock).not.toHaveBeenCalled();
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'sendMessage',
				sessionId: 'ses-1',
				text: 'edited prompt',
			}),
		);
	});

	it('uses delete flow when editing history without restoring files', async () => {
		await openCodeRuntime.editMessage({
			sessionId: 'ses-1',
			messageId: 'msg-7',
			text: 'edited prompt',
			mode: 'replace_history',
			isAlreadyReverted: false,
		});

		expect(proxyFetchMock).toHaveBeenCalled();
		expect(revertMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ sessionID: 'ses-1', messageID: 'msg-7' }),
		);
	});

	it('uses revert flow without manual deletes when editing with file restore', async () => {
		await openCodeRuntime.editMessage({
			sessionId: 'ses-1',
			messageId: 'msg-7',
			text: 'edited prompt',
			mode: 'restore_and_send',
			isAlreadyReverted: false,
		});

		expect(revertMock).toHaveBeenCalledWith({
			sessionID: 'ses-1',
			messageID: 'msg-7',
			directory: 'C:\\repo',
		});
		expect(proxyFetchMock).not.toHaveBeenCalled();
	});

	it('promotes replace_history to revert flow when session is already reverted', async () => {
		await openCodeRuntime.editMessage({
			sessionId: 'ses-1',
			messageId: 'msg-7',
			text: 'edited prompt',
			mode: 'replace_history',
			isAlreadyReverted: true,
		});

		expect(proxyFetchMock).not.toHaveBeenCalled();
		expect(postMessageMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'sendMessage',
				sessionId: 'ses-1',
				text: 'edited prompt',
			}),
		);
	});
});
