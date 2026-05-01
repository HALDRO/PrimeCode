/**
 * @file ToolHandler permission policy tests
 * @description Tests that ToolHandler correctly persists and returns all 16 permission
 *              categories, persists always-allow tool state, exposes policies
 *              for ChatProvider auto-approval, and syncs policies to the server with retry.
 */

import { describe, expect, it, vi } from 'vitest';
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
});
