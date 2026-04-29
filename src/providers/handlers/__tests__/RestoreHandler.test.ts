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
					{
						info: {
							id: 'msg-2',
							sessionID: 'session-1',
							role: 'assistant',
							time: { created: 2 },
						},
						parts: [
							{
								id: 'tool-read',
								messageID: 'msg-2',
								sessionID: 'session-1',
								type: 'tool',
								tool: 'read',
								callID: 'call-read',
								state: {
									status: 'completed',
									input: { filePath: '/tmp/a.ts', offset: 10, limit: 20 },
									output: '<path>/tmp/a.ts</path>\n<content>very large file body</content>',
								},
							},
							{
								id: 'tool-grep',
								messageID: 'msg-2',
								sessionID: 'session-1',
								type: 'tool',
								tool: 'grep',
								callID: 'call-grep',
								state: {
									status: 'completed',
									input: { pattern: 'foo' },
									output:
										'Found 2 matches\n/tmp/a.ts:\n  Line 10: foo\n  Line 11: bar\n/tmp/b.ts:\n  Line 22: baz',
								},
							},
							{
								id: 'tool-skill',
								messageID: 'msg-2',
								sessionID: 'session-1',
								type: 'tool',
								tool: 'skill',
								callID: 'call-skill',
								state: {
									status: 'completed',
									input: { name: 'review' },
									output: '# giant skill content',
									metadata: { path: '/skills/review/SKILL.md' },
								},
							},
							{
								id: 'tool-apply-patch',
								messageID: 'msg-2',
								sessionID: 'session-1',
								type: 'tool',
								tool: 'apply_patch',
								callID: 'call-apply-patch',
								state: {
									status: 'completed',
									input: {
										patchText: '*** Begin Patch\n*** Update File: bin/app.exe\n*** End Patch',
									},
									output: 'Success',
									metadata: {
										diff: 'Index: C:\\repo\\bin\\app.exe\n@@ -1,2 +0,0 @@\n-\u0000MZ\u0001\u0002',
										files: [
											{
												filePath: 'C:\\repo\\bin\\app.exe',
												relativePath: 'bin/app.exe',
												type: 'delete',
												patch:
													'Index: C:\\repo\\bin\\app.exe\n@@ -1,2 +0,0 @@\n-\u0000MZ\u0001\u0002',
											},
										],
									},
								},
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

	it('normalizes read, grep and skill outputs for restore snapshots', async () => {
		await handler.handleMessage({
			type: 'restoreMessage',
			sessionId: 'session-1',
			messageId: 'msg-1',
		});

		const restoreCall = ctx.bridge.data.mock.calls.find(call => call[0] === 'restore_session');
		const payload = restoreCall?.[1] as { parts: Record<string, Record<string, unknown>[]> };
		const toolParts = payload.parts['msg-2'];

		expect(toolParts[0]?.state).toMatchObject({ output: '' });
		expect(toolParts[1]?.state).toMatchObject({
			output: 'Found 2 matches\n/tmp/a.ts\n/tmp/a.ts:10\n/tmp/a.ts:11\n/tmp/b.ts\n/tmp/b.ts:22',
		});
		expect(toolParts[2]?.state).toMatchObject({ output: '' });
		expect(toolParts[3]?.state).toMatchObject({ output: 'Success' });
		expect(
			(toolParts[3]?.state as { metadata?: { diff?: unknown; files?: Record<string, unknown>[] } })
				.metadata?.diff,
		).toBeUndefined();
		expect(
			(toolParts[3]?.state as { metadata?: { files?: Record<string, unknown>[] } }).metadata
				?.files?.[0],
		).toMatchObject({
			filePath: 'C:\\repo\\bin\\app.exe',
			relativePath: 'bin/app.exe',
			type: 'delete',
			binary: true,
		});
		expect(
			(toolParts[3]?.state as { metadata?: { files?: Record<string, unknown>[] } }).metadata
				?.files?.[0],
		).not.toHaveProperty('patch');
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
