/**
 * @file ToolHandler permission policy tests
 * @description Tests that ToolHandler correctly persists and returns all 16 permission
 *              categories, handles access responses with alwaysAllow, exposes policies
 *              for ChatProvider auto-approval, and syncs policies to the server with retry.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext } from '../../__mocks__/vscode';
import { SessionGraph } from '../../core/SessionManager';
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

const ALL_ALLOW_POLICIES = Object.fromEntries(Object.keys(DEFAULT_POLICIES).map(k => [k, 'allow']));

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
		sessionState: {
			activeSessionId: 'test-session-1',
			startedSessions: new Set(['test-session-1']),
			stopGuardUntil: 0,
			isStopGuarded: () => false,
			activateStopGuard: () => {},
			clearStopGuard: () => {},
		},
		services: {} as any,
		sessionGraph: new SessionGraph(),
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

		it('should ignore unknown legacy keys from stored policies', async () => {
			const ctx = createMockHandlerContext();
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				terminal: 'allow', // legacy key — should be ignored
				network: 'allow', // legacy key — should be ignored
				edit: 'allow',
			});

			const handler = new ToolHandler(ctx);
			const policies = handler.getPermissionPolicies();

			// Should have all 16 keys, not legacy ones
			expect(Object.keys(policies).sort()).toEqual(Object.keys(DEFAULT_POLICIES).sort());
			expect(policies.edit).toBe('allow');
			expect((policies as any).terminal).toBeUndefined();
			expect((policies as any).network).toBeUndefined();
		});
	});

	describe('setPermissions', () => {
		it('should persist all 16 categories from incoming message', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setPermissions',
				policies: ALL_ALLOW_POLICIES,
				provider: 'opencode',
			} as any);

			const persisted = ctx.extensionContext.workspaceState.get(
				'primeCode.permissionPolicies',
			) as any;

			expect(persisted).toEqual(ALL_ALLOW_POLICIES);

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg.data.policies).toEqual(ALL_ALLOW_POLICIES);
		});

		it('should reject invalid policy values and keep default', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setPermissions',
				policies: { edit: 'invalid_value' as any, bash: 'allow' },
			} as any);

			const policies = handler.getPermissionPolicies();
			expect(policies.edit).toBe('ask'); // default, not 'invalid_value'
			expect(policies.bash).toBe('allow'); // valid, accepted
		});

		it('should ignore unknown keys in incoming policies', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setPermissions',
				policies: { terminal: 'allow', network: 'deny', edit: 'allow' } as any,
			} as any);

			const policies = handler.getPermissionPolicies();
			expect(policies.edit).toBe('allow');
			expect((policies as any).terminal).toBeUndefined();
			expect((policies as any).network).toBeUndefined();
		});

		it('should partially update — only override provided keys', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setPermissions',
				policies: { bash: 'allow' },
			} as any);

			const policies = handler.getPermissionPolicies();
			expect(policies.bash).toBe('allow');
			expect(policies.edit).toBe('ask'); // unchanged default
			expect(policies.read).toBe('allow'); // unchanged default
		});
	});

	describe('accessResponse with alwaysAllow', () => {
		it('should persist alwaysAllow per tool', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'accessResponse',
				id: 'req-1',
				toolName: 'Write',
				approved: true,
				alwaysAllow: true,
				response: 'always',
			});

			expect(ctx.cli.respondToPermission).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: 'req-1',
					approved: true,
					alwaysAllow: true,
				}),
			);

			const alwaysAllow = handler.getAlwaysAllowByTool();
			expect(alwaysAllow.Write).toBe(true);
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
