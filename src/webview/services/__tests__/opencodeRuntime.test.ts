import { beforeEach, describe, expect, it, vi } from 'vitest';

const abortMock = vi.fn(async () => {});
const statusMock = vi.fn(async () => ({ data: {} }));
const createClientMock = vi.fn(() => ({
	session: {
		abort: abortMock,
		status: statusMock,
	},
}));

const postMessageMock = vi.fn();

vi.mock('@opencode-ai/sdk/v2/client', () => ({
	createOpencodeClient: createClientMock,
}));

vi.mock('../utils/vscode', () => ({
	vscode: {
		postMessage: postMessageMock,
	},
}));

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
});
