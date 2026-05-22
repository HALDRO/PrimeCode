/**
 * @file ToolHandler permission policy tests
 * @description Tests that ToolHandler correctly persists and returns all 16 permission
 *              categories, persists always-allow tool state, exposes policies
 *              for ChatProvider auto-approval, and syncs policies to the server with retry.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => await import('../../__mocks__/vscode.js'));

import { createMockExtensionContext } from '../../__mocks__/vscode';
import { OutboundBridge } from '../../transport/OutboundBridge';
import { ToolHandler } from './ToolHandler';
import type { HandlerContext } from './types';

// ---------------------------------------------------------------------------
// Constants — must match ToolHandler.DEFAULT_POLICIES
// ---------------------------------------------------------------------------

const DEFAULT_POLICIES = {
	read: 'allow',
	edit: 'ask',
	glob: 'allow',
	grep: 'allow',
	list: 'allow',
	bash: 'ask',
	task: 'ask',
	skill: 'allow',
	lsp: 'allow',
	todoread: 'allow',
	todowrite: 'allow',
	webfetch: 'ask',
	websearch: 'ask',
	codesearch: 'allow',
	external_directory: 'ask',
	doom_loop: 'ask',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHandlerContext(
	overrides: Partial<HandlerContext> = {},
): HandlerContext & { postedMessages: unknown[] } {
	const postedMessages: unknown[] = [];

	const mockCli = {
		respondToPermission: vi.fn().mockResolvedValue(undefined),
		getProvider: vi.fn().mockReturnValue('opencode'),
		getSdkClient: vi.fn().mockReturnValue(null),
		getAdminInfo: vi.fn().mockReturnValue({
			baseUrl: 'http://127.0.0.1:4096',
			directory: '/mock/workspace',
		}),
	};

	const mockSettings = {
		get: vi.fn().mockReturnValue(undefined),
		set: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockReturnValue({ autoApprove: false }),
		refresh: vi.fn(),
		getWorkspaceRoot: vi.fn().mockReturnValue('/mock/workspace'),
	};

	const bridge = new OutboundBridge();
	vi.spyOn(bridge, 'send').mockImplementation((msg: unknown) => {
		postedMessages.push(msg);
	});

	const ctx: HandlerContext = {
		extensionContext: createMockExtensionContext() as any,
		settings: mockSettings as any,
		cli: mockCli as any,
		bridge,
		services: {} as any,
		...overrides,
	};

	return Object.assign(ctx, { postedMessages });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolHandler', () => {
	describe('getPermissions', () => {
		it('should return default 16-category policies when nothing is persisted', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;

			expect(msg).toBeDefined();
			expect(msg.data.policies).toEqual(DEFAULT_POLICIES);
		});

		it('should merge persisted policies over defaults', async () => {
			const ctx = createMockHandlerContext();
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'allow',
				bash: 'allow',
				external_directory: 'deny',
			});

			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;

			expect(msg).toBeDefined();
			expect(msg.data.policies).toEqual({
				...DEFAULT_POLICIES,
				edit: 'allow',
				bash: 'allow',
				external_directory: 'deny',
			});
		});

		it('should ignore unknown keys from stored policies', async () => {
			const ctx = createMockHandlerContext();
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				terminal: 'allow',
				network: 'allow',
				edit: 'allow',
			});

			const handler = new ToolHandler(ctx);
			const policies = handler.getPermissionPolicies();

			expect(Object.keys(policies).sort()).toEqual(Object.keys(DEFAULT_POLICIES).sort());
			expect(policies.edit).toBe('allow');
			expect((policies as any).terminal).toBeUndefined();
			expect((policies as any).network).toBeUndefined();
		});

		it('should hydrate policies from project config before sending permissionsUpdated', async () => {
			const ctx = createMockHandlerContext({
				services: {
					openCodeConfig: {
						readProjectConfigForInspection: vi.fn().mockResolvedValue({
							permission: {
								edit: 'allow',
								bash: 'deny',
							},
						}),
					},
				} as any,
			});
			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg).toBeDefined();
			expect(msg.data.policies.edit).toBe('allow');
			expect(msg.data.policies.bash).toBe('deny');
			expect(msg.data.policies.read).toBe('allow');
		});

		it('should prefer project config over workspaceState when project config has simple permission values', async () => {
			const ctx = createMockHandlerContext({
				services: {
					openCodeConfig: {
						readProjectConfigForInspection: vi.fn().mockResolvedValue({
							permission: {
								edit: 'allow',
								bash: 'deny',
							},
						}),
					},
				} as any,
			});
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'deny',
				bash: 'allow',
			});

			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg.data.policies.edit).toBe('allow');
			expect(msg.data.policies.bash).toBe('deny');
		});

		it('should keep workspaceState policies when project config permission shape is unsupported', async () => {
			const ctx = createMockHandlerContext({
				services: {
					openCodeConfig: {
						readProjectConfigForInspection: vi.fn().mockResolvedValue({
							permission: {
								edit: { action: 'allow' },
							},
						}),
					},
				} as any,
			});
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'deny',
			});

			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg.data.policies.edit).toBe('deny');
		});
	});

	describe('setPermissionPolicy', () => {
		it('should persist a single normalized tool policy', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.setPermissionPolicy('bash', 'allow');

			const persisted = ctx.extensionContext.workspaceState.get(
				'primeCode.permissionPolicies',
			) as any;
			expect(persisted.bash).toBe('allow');
			expect(persisted.edit).toBe('ask');

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg.data.policies.bash).toBe('allow');
		});

		it('should leave other categories unchanged', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.setPermissionPolicy('edit', 'deny');

			const policies = handler.getPermissionPolicies();
			expect(policies.edit).toBe('deny');
			expect(policies.bash).toBe('ask');
			expect(policies.read).toBe('allow');
		});
	});

	describe('setAlwaysAllowTool', () => {
		it('should persist alwaysAllow per tool', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setAlwaysAllowTool',
				toolName: 'Write',
				allow: true,
			});

			const alwaysAllow = handler.getAlwaysAllowByTool();
			expect(alwaysAllow.write).toBe(true);
		});
	});

	describe('session auto-accept', () => {
		it('should persist explicit session auto-accept mode', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setAutoAccept',
				mode: 'on',
				sessionId: 'test-session-1',
			});

			expect(handler.getSessionAutoAcceptState('test-session-1')).toEqual({
				mode: 'on',
				effective: true,
			});
			expect(
				ctx.extensionContext.workspaceState.get('primeCode.permissionAutoAcceptBySession'),
			).toEqual({
				'test-session-1': 'on',
			});
		});

		it('should not fail when pending permission lookup is unavailable', async () => {
			const ctx = createMockHandlerContext({ services: {} as any });
			const handler = new ToolHandler(ctx);

			await expect(
				handler.handleMessage({
					type: 'setAutoAccept',
					mode: 'on',
					sessionId: 'test-session-1',
				}),
			).resolves.toBeUndefined();

			await Promise.resolve();
		});

		it('should clear explicit mode when switched to default', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setAutoAccept',
				mode: 'on',
				sessionId: 'test-session-1',
			});
			await handler.handleMessage({
				type: 'setAutoAccept',
				mode: 'default',
				sessionId: 'test-session-1',
			});

			expect(handler.getSessionAutoAcceptState('test-session-1')).toEqual({
				mode: 'default',
				effective: false,
			});
			expect(
				ctx.extensionContext.workspaceState.get('primeCode.permissionAutoAcceptBySession'),
			).toEqual({});
		});

		it('should persist auto-accept mode even when pending permission lookup exists', async () => {
			const ctx = createMockHandlerContext({
				services: {
					openCodeClient: {
						getSessionPermissions: vi.fn().mockResolvedValue([
							{
								id: 'perm-1',
								sessionID: 'test-session-1',
								permission: 'bash',
								patterns: [],
								metadata: {},
								always: [],
							},
						]),
					},
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setAutoAccept',
				mode: 'on',
				sessionId: 'test-session-1',
			});

			await Promise.resolve();
			expect(handler.getSessionAutoAcceptState('test-session-1')).toEqual({
				mode: 'on',
				effective: true,
			});
		});

		it('inherits auto-accept from parent sessions', async () => {
			const ctx = createMockHandlerContext({
				getParentSessionId: vi.fn(async (sessionId: string) =>
					sessionId === 'child-session' ? 'parent-session' : undefined,
				),
			});
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setAutoAccept',
				mode: 'on',
				sessionId: 'parent-session',
			});

			expect(await handler.isAutoAcceptAsync('child-session')).toBe(true);
		});
	});

	describe('policy-based auto-approval', () => {
		it('should expose all 16 policies for ChatProvider', async () => {
			const ctx = createMockHandlerContext();
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'allow',
				bash: 'deny',
			});

			const handler = new ToolHandler(ctx);
			const policies = handler.getPermissionPolicies();

			expect(policies.edit).toBe('allow');
			expect(policies.bash).toBe('deny');
			expect(policies.read).toBe('allow'); // default
			expect(policies.task).toBe('ask'); // default
			expect(Object.keys(policies)).toHaveLength(16);
		});
	});

	describe('autoRespondToSessionPermissions', () => {
		it('should auto-approve when session auto-accept is on', async () => {
			const replyMock = vi.fn().mockResolvedValue({});
			const listMock = vi.fn().mockResolvedValue({
				data: [
					{
						id: 'perm-1',
						sessionID: 'sess-1',
						permission: 'edit',
						patterns: [],
						metadata: {},
						always: [],
					},
				],
			});
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => ({ permission: { list: listMock, reply: replyMock } }),
					getProvider: () => 'opencode',
					getAdminInfo: () => ({ baseUrl: 'http://localhost', directory: '/ws' }),
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({ type: 'setAutoAccept', mode: 'on', sessionId: 'sess-1' });
			await handler.autoRespondToSessionPermissions('sess-1');

			expect(replyMock).toHaveBeenCalledWith({
				requestID: 'perm-1',
				directory: '/mock/workspace',
				reply: 'once',
			});
		});

		it('should auto-approve when accessAutoApprove setting is true', async () => {
			const replyMock = vi.fn().mockResolvedValue({});
			const listMock = vi.fn().mockResolvedValue({
				data: [
					{
						id: 'perm-2',
						sessionID: 'sess-2',
						permission: 'bash',
						patterns: [],
						metadata: {},
						always: [],
					},
				],
			});
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => ({ permission: { list: listMock, reply: replyMock } }),
					getProvider: () => 'opencode',
					getAdminInfo: () => ({ baseUrl: 'http://localhost', directory: '/ws' }),
				} as any,
				settings: {
					get: (key: string) => (key === 'access.autoApprove' ? true : undefined),
					getWorkspaceRoot: () => '/mock/workspace',
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await handler.autoRespondToSessionPermissions('sess-2');

			expect(replyMock).toHaveBeenCalledWith({
				requestID: 'perm-2',
				directory: '/mock/workspace',
				reply: 'once',
			});
		});

		it('should auto-approve when tool is in always-allow list', async () => {
			const replyMock = vi.fn().mockResolvedValue({});
			const listMock = vi.fn().mockResolvedValue({
				data: [
					{
						id: 'perm-3',
						sessionID: 'sess-3',
						permission: 'write',
						patterns: [],
						metadata: {},
						always: [],
					},
				],
			});
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => ({ permission: { list: listMock, reply: replyMock } }),
					getProvider: () => 'opencode',
					getAdminInfo: () => ({ baseUrl: 'http://localhost', directory: '/ws' }),
				} as any,
			});
			const handler = new ToolHandler(ctx);

			// Set always-allow for 'write' tool
			await handler.handleMessage({ type: 'setAlwaysAllowTool', toolName: 'write', allow: true });
			await handler.autoRespondToSessionPermissions('sess-3');

			expect(replyMock).toHaveBeenCalledWith({
				requestID: 'perm-3',
				directory: '/mock/workspace',
				reply: 'once',
			});
		});

		it('should NOT auto-approve when no override applies', async () => {
			const replyMock = vi.fn().mockResolvedValue({});
			const listMock = vi.fn().mockResolvedValue({
				data: [
					{
						id: 'perm-4',
						sessionID: 'sess-4',
						permission: 'bash',
						patterns: [],
						metadata: {},
						always: [],
					},
				],
			});
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => ({ permission: { list: listMock, reply: replyMock } }),
					getProvider: () => 'opencode',
					getAdminInfo: () => ({ baseUrl: 'http://localhost', directory: '/ws' }),
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await handler.autoRespondToSessionPermissions('sess-4');

			expect(replyMock).not.toHaveBeenCalled();
		});

		it('should not crash when SDK client is unavailable', async () => {
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => null,
					getProvider: () => 'opencode',
					getAdminInfo: () => null,
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await expect(handler.autoRespondToSessionPermissions('sess-5')).resolves.toBeUndefined();
		});

		it('should only respond to permissions for the target session', async () => {
			const replyMock = vi.fn().mockResolvedValue({});
			const listMock = vi.fn().mockResolvedValue({
				data: [
					{
						id: 'perm-a',
						sessionID: 'sess-a',
						permission: 'edit',
						patterns: [],
						metadata: {},
						always: [],
					},
					{
						id: 'perm-b',
						sessionID: 'sess-b',
						permission: 'edit',
						patterns: [],
						metadata: {},
						always: [],
					},
				],
			});
			const ctx = createMockHandlerContext({
				cli: {
					getSdkClient: () => ({ permission: { list: listMock, reply: replyMock } }),
					getProvider: () => 'opencode',
					getAdminInfo: () => ({ baseUrl: 'http://localhost', directory: '/ws' }),
				} as any,
				settings: {
					get: (key: string) => (key === 'access.autoApprove' ? true : undefined),
					getWorkspaceRoot: () => '/mock/workspace',
				} as any,
			});
			const handler = new ToolHandler(ctx);

			await handler.autoRespondToSessionPermissions('sess-a');

			expect(replyMock).toHaveBeenCalledTimes(1);
			expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({ requestID: 'perm-a' }));
		});
	});

	describe('debounced policy sync', () => {
		it('should debounce multiple rapid policy changes into one sync', async () => {
			const setProjectFieldMock = vi.fn().mockResolvedValue({ path: '/mock', contentHash: 'abc' });
			const reloadMock = vi.fn();
			const ctx = createMockHandlerContext({
				services: {
					openCodeConfig: { setProjectField: setProjectFieldMock },
					configFileWatcher: { notifyUiSave: vi.fn() },
				} as any,
				requestRuntimeReload: reloadMock,
			});
			const handler = new ToolHandler(ctx);

			// Fire 3 rapid policy changes without awaiting (simulates "Ask All" preset)
			const p1 = handler.setPermissionPolicy('read', 'ask');
			const p2 = handler.setPermissionPolicy('edit', 'ask');
			const p3 = handler.setPermissionPolicy('bash', 'ask');

			// Wait for debounce timer (300ms) + execution
			await new Promise(resolve => setTimeout(resolve, 500));
			await Promise.all([p1, p2, p3]);

			// Should have been called only once (debounced)
			expect(setProjectFieldMock).toHaveBeenCalledTimes(1);
			expect(reloadMock).toHaveBeenCalledTimes(1);

			// The final write should contain all 3 changes
			const writtenPermission = setProjectFieldMock.mock.calls[0][1];
			expect(writtenPermission.read).toBe('ask');
			expect(writtenPermission.edit).toBe('ask');
			expect(writtenPermission.bash).toBe('ask');
		});
	});
});
