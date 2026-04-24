import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreHandler } from '../RestoreHandler';
import type { HandlerContext } from '../types';

vi.mock('vscode', () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
	},
}));

interface MockContext {
	cli: {
		truncateSession: ReturnType<typeof vi.fn>;
		unrevertSession: ReturnType<typeof vi.fn>;
		getSdkClient: ReturnType<typeof vi.fn>;
	};
	bridge: {
		sendSdkEvent: ReturnType<typeof vi.fn>;
		data: ReturnType<typeof vi.fn>;
	};
	sessionManager: {
		setSession: ReturnType<typeof vi.fn>;
	};
	extensionContext: {
		workspaceState: {
			update: ReturnType<typeof vi.fn>;
		};
	};
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext & HandlerContext {
	const sdkClient = {
		session: {
			get: vi.fn().mockResolvedValue({
				data: { id: 'session-1', title: 'Session', revert: { messageID: 'msg-1' } },
				error: null,
			}),
			messages: vi.fn().mockResolvedValue({
				data: [
					{
						info: {
							id: 'msg-1',
							sessionID: 'session-1',
							role: 'user',
							time: { created: 1 },
						},
						parts: [
							{
								id: 'msg-1-text',
								messageID: 'msg-1',
								sessionID: 'session-1',
								type: 'text',
								text: 'hello',
							},
						],
					},
				],
				error: null,
			}),
			diff: vi.fn().mockResolvedValue({ data: [] }),
			todo: vi.fn().mockResolvedValue({ data: [] }),
			status: vi.fn().mockResolvedValue({ data: { 'session-1': { type: 'idle' } } }),
		},
	};

	const ctx: MockContext = {
		cli: {
			truncateSession: vi.fn().mockResolvedValue(undefined),
			unrevertSession: vi.fn().mockResolvedValue(undefined),
			getSdkClient: vi.fn().mockReturnValue(sdkClient),
			...overrides.cli,
		},
		bridge: {
			sendSdkEvent: vi.fn(),
			data: vi.fn(),
			...overrides.bridge,
		},
		sessionManager: {
			setSession: vi.fn(),
			...overrides.sessionManager,
		},
		extensionContext: {
			workspaceState: {
				update: vi.fn().mockResolvedValue(undefined),
			},
		},
	};

	return ctx as unknown as MockContext & HandlerContext;
}

describe('RestoreHandler', () => {
	let handler: RestoreHandler;
	let ctx: MockContext & HandlerContext;

	beforeEach(() => {
		ctx = createMockContext();
		handler = new RestoreHandler(ctx);
	});

	it('restores a session to a concrete message', async () => {
		await handler.handleMessage({
			type: 'restoreMessage',
			sessionId: 'session-1',
			messageId: 'msg-1',
		});

		expect(ctx.cli.truncateSession).toHaveBeenCalledWith('session-1', 'msg-1', {
			provider: 'opencode',
			workspaceRoot: '/test/workspace',
		});
		expect(ctx.bridge.data).toHaveBeenCalledWith('restore_session', expect.any(Object));
	});

	it('unreverts a concrete session', async () => {
		await handler.handleMessage({
			type: 'unrevert',
			sessionId: 'session-1',
		});

		expect(ctx.cli.unrevertSession).toHaveBeenCalledWith('session-1', {
			provider: 'opencode',
			workspaceRoot: '/test/workspace',
		});
		expect(ctx.bridge.data).toHaveBeenCalledWith('restore_session', expect.any(Object));
	});

	it('shows notification on restore failure', async () => {
		ctx.cli.truncateSession.mockRejectedValueOnce(new Error('restore failed'));

		await handler.handleMessage({
			type: 'restoreMessage',
			sessionId: 'session-1',
			messageId: 'msg-1',
		});

		expect(ctx.bridge.data).toHaveBeenCalledWith(
			'showNotification',
			expect.objectContaining({
				notification: expect.objectContaining({
					content: expect.stringContaining('restore failed'),
				}),
			}),
		);
	});
});
