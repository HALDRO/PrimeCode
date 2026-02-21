/**
 * @file RestoreHandler tests
 * @description Tests for checkpoint restore, unrevert, commitId parsing,
 *              multi-chat isolation, and error handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RestoreHandler } from '../RestoreHandler';
import type { HandlerContext } from '../types';

// ---------------------------------------------------------------------------
// Mock vscode
// ---------------------------------------------------------------------------
vi.mock('vscode', () => ({
	workspace: {
		workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockContext {
	cli: {
		truncateSession: ReturnType<typeof vi.fn>;
		unrevertSession: ReturnType<typeof vi.fn>;
		getOpenCodeServerInfo: ReturnType<typeof vi.fn>;
	};
	bridge: {
		session: {
			restore: ReturnType<typeof vi.fn>;
		};
	};
	sessionState: {
		activeSessionId: string | undefined;
	};
}

function createMockContext(overrides: Partial<MockContext> = {}): MockContext & HandlerContext {
	const ctx: MockContext = {
		cli: {
			truncateSession: vi.fn().mockResolvedValue(undefined),
			unrevertSession: vi.fn().mockResolvedValue(undefined),
			getOpenCodeServerInfo: vi.fn().mockReturnValue({ baseUrl: 'http://localhost:3000' }),
			...overrides.cli,
		},
		bridge: {
			session: {
				restore: vi.fn(),
				...overrides.bridge?.session,
			},
			...overrides.bridge,
		},
		sessionState: {
			activeSessionId: 'session-1',
			...overrides.sessionState,
		},
	};
	return ctx as unknown as MockContext & HandlerContext;
}

function registerTestCheckpoint(
	handler: RestoreHandler,
	commitId: string,
	opts: {
		sessionId?: string;
		messageId?: string;
		associatedMessageId?: string;
	} = {},
) {
	handler.registerCheckpoint(commitId, {
		sessionId: opts.sessionId ?? 'session-1',
		messageId: opts.messageId ?? 'msg-1',
		associatedMessageId: opts.associatedMessageId ?? 'msg-1',
		isOpenCode: true,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RestoreHandler', () => {
	let handler: RestoreHandler;
	let ctx: MockContext & HandlerContext;

	beforeEach(() => {
		ctx = createMockContext();
		handler = new RestoreHandler(ctx);
	});

	// =========================================================================
	// commitId parsing
	// =========================================================================

	describe('commitId parsing', () => {
		it('should read commitId from msg.data.commitId (webview format)', async () => {
			registerTestCheckpoint(handler, 'cp-1');

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledOnce();
			expect(ctx.cli.truncateSession).toHaveBeenCalledWith(
				'session-1',
				'msg-1',
				expect.objectContaining({ workspaceRoot: '/test/workspace' }),
			);
		});

		it('should read commitId from msg.commitId (top-level fallback)', async () => {
			registerTestCheckpoint(handler, 'cp-2');

			await handler.handleMessage({
				type: 'restoreCommit',
				commitId: 'cp-2',
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledOnce();
		});

		it('should prefer msg.data.commitId over msg.commitId', async () => {
			registerTestCheckpoint(handler, 'cp-data');
			registerTestCheckpoint(handler, 'cp-top', {
				sessionId: 'session-other',
				messageId: 'msg-other',
			});

			await handler.handleMessage({
				type: 'restoreCommit',
				commitId: 'cp-top',
				data: { commitId: 'cp-data' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith('session-1', 'msg-1', expect.anything());
		});

		it('should do nothing when no commitId provided at all', async () => {
			await handler.handleMessage({ type: 'restoreCommit' } as any);

			expect(ctx.cli.truncateSession).not.toHaveBeenCalled();
			expect(ctx.bridge.session.restore).not.toHaveBeenCalled();
		});

		it('should do nothing when commitId is empty string', async () => {
			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: '' },
			} as any);

			expect(ctx.cli.truncateSession).not.toHaveBeenCalled();
		});

		it('should do nothing for unknown commitId', async () => {
			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'nonexistent' },
			} as any);

			expect(ctx.cli.truncateSession).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Revert flow
	// =========================================================================

	describe('revert flow', () => {
		it('should call truncateSession with correct sessionId and messageId', async () => {
			registerTestCheckpoint(handler, 'cp-1', {
				sessionId: 'sess-abc',
				messageId: 'msg-xyz',
			});

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith('sess-abc', 'msg-xyz', {
				provider: 'opencode',
				workspaceRoot: '/test/workspace',
			});
		});

		it('should notify UI with success + canUnrevert=true after revert', async () => {
			registerTestCheckpoint(handler, 'cp-1', {
				associatedMessageId: 'ui-msg-1',
			});

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.bridge.session.restore).toHaveBeenCalledWith('session-1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'ui-msg-1',
			});
		});

		it('should notify error when truncateSession fails', async () => {
			ctx.cli.truncateSession.mockRejectedValueOnce(new Error('Server down'));
			registerTestCheckpoint(handler, 'cp-1');

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.bridge.session.restore).toHaveBeenCalledWith('session-1', {
				action: 'error',
				message: expect.stringContaining('Server down'),
			});
		});
	});

	// =========================================================================
	// Unrevert flow
	// =========================================================================

	describe('unrevert flow', () => {
		it('should use activeSessionId for unrevert', async () => {
			ctx.sessionState.activeSessionId = 'sess-A';

			await handler.handleMessage({ type: 'unrevert' } as any);

			expect(ctx.cli.unrevertSession).toHaveBeenCalledWith(
				'sess-A',
				expect.objectContaining({ workspaceRoot: '/test/workspace' }),
			);
		});

		it('should notify UI with canUnrevert=false after unrevert', async () => {
			ctx.sessionState.activeSessionId = 'session-1';

			await handler.handleMessage({ type: 'unrevert' } as any);

			expect(ctx.bridge.session.restore).toHaveBeenCalledWith('session-1', {
				action: 'success',
				canUnrevert: false,
			});
			expect(ctx.bridge.session.restore).toHaveBeenCalledWith('session-1', {
				action: 'unrevert_available',
				available: false,
			});
		});

		it('should notify error when unrevertSession fails', async () => {
			ctx.cli.unrevertSession.mockRejectedValueOnce(new Error('Unrevert failed'));

			await handler.handleMessage({ type: 'unrevert' } as any);

			expect(ctx.bridge.session.restore).toHaveBeenCalledWith('session-1', {
				action: 'error',
				message: expect.stringContaining('Unrevert failed'),
			});
		});

		it('should do nothing when no active session', async () => {
			ctx.sessionState.activeSessionId = undefined;

			await handler.handleMessage({ type: 'unrevert' } as any);

			expect(ctx.cli.unrevertSession).not.toHaveBeenCalled();
		});
	});

	// =========================================================================
	// Multi-chat isolation
	// =========================================================================

	describe('multi-chat isolation', () => {
		it('checkpoints from different sessions are isolated', async () => {
			registerTestCheckpoint(handler, 'cp-A', {
				sessionId: 'sess-A',
				messageId: 'msg-A1',
				associatedMessageId: 'ui-A1',
			});
			registerTestCheckpoint(handler, 'cp-B', {
				sessionId: 'sess-B',
				messageId: 'msg-B1',
				associatedMessageId: 'ui-B1',
			});

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-A' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith('sess-A', 'msg-A1', expect.anything());

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-B' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith('sess-B', 'msg-B1', expect.anything());
		});

		it('revert in A then unrevert targets active session (B if switched)', async () => {
			registerTestCheckpoint(handler, 'cp-A', { sessionId: 'sess-A' });

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-A' },
			} as any);

			// Switch to session B
			ctx.sessionState.activeSessionId = 'sess-B';

			// Unrevert targets active session (B), not A
			await handler.handleMessage({ type: 'unrevert' } as any);

			expect(ctx.cli.unrevertSession).toHaveBeenCalledWith('sess-B', expect.anything());
		});
	});

	// =========================================================================
	// Checkpoint registration
	// =========================================================================

	describe('checkpoint registration', () => {
		it('should register and retrieve checkpoints', async () => {
			registerTestCheckpoint(handler, 'cp-1', {
				sessionId: 'sess-1',
				messageId: 'msg-1',
			});

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith('sess-1', 'msg-1', expect.anything());
		});

		it('should overwrite checkpoint with same commitId', async () => {
			registerTestCheckpoint(handler, 'cp-1', { messageId: 'msg-old' });
			registerTestCheckpoint(handler, 'cp-1', { messageId: 'msg-new' });

			await handler.handleMessage({
				type: 'restoreCommit',
				data: { commitId: 'cp-1' },
			} as any);

			expect(ctx.cli.truncateSession).toHaveBeenCalledWith(
				'session-1',
				'msg-new',
				expect.anything(),
			);
		});
	});
});
