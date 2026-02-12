/**
 * @file ToolHandler permission policy tests
 * @description Tests that ToolHandler correctly persists and returns permission policies,
 *              handles access responses with alwaysAllow, and exposes policies for
 *              ChatProvider auto-approval.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMockExtensionContext } from '../../__mocks__/vscode';
import { ToolHandler } from './ToolHandler';
import type { HandlerContext } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockHandlerContext(
	overrides: Partial<HandlerContext> = {},
): HandlerContext & { postedMessages: unknown[] } {
	const postedMessages: unknown[] = [];

	const mockCli = {
		respondToPermission: vi.fn().mockResolvedValue(undefined),
		getProvider: vi.fn().mockReturnValue('claude'),
	};

	const mockSettings = {
		get: vi.fn().mockReturnValue(undefined),
		set: vi.fn().mockResolvedValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockReturnValue({ autoApprove: false }),
		refresh: vi.fn(),
		getWorkspaceRoot: vi.fn().mockReturnValue('/mock/workspace'),
	};

	const ctx: HandlerContext = {
		extensionContext: createMockExtensionContext() as any,
		settings: mockSettings as any,
		cli: mockCli as any,
		view: {
			postMessage: (msg: unknown) => {
				postedMessages.push(msg);
			},
		},
		sessionState: {
			activeSessionId: 'test-session-1',
			startedSessions: new Set(['test-session-1']),
		},
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
		it('should return actual persisted policies, not hardcoded "ask"', async () => {
			const ctx = createMockHandlerContext();

			// Simulate user previously setting policies to 'allow'
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'allow',
				terminal: 'allow',
				network: 'allow',
			});

			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;

			expect(msg).toBeDefined();
			expect(msg.data.policies).toEqual({
				edit: 'allow',
				terminal: 'allow',
				network: 'allow',
			});
		});

		it('should default to "ask" when no policies have been persisted', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);
			await handler.handleMessage({ type: 'getPermissions' });

			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;

			expect(msg).toBeDefined();
			expect(msg.data.policies).toEqual({
				edit: 'ask',
				terminal: 'ask',
				network: 'ask',
			});
		});
	});

	describe('setPermissions', () => {
		it('should persist the policies from the incoming message', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			// Real webview sends: postMessage('setPermissions', { policies, provider })
			// postMessageToVSCode spreads data onto top-level: { type, ...data }
			await handler.handleMessage({
				type: 'setPermissions',
				policies: { edit: 'allow', terminal: 'allow', network: 'deny' },
				provider: 'opencode',
			} as any);

			const persisted = ctx.extensionContext.workspaceState.get(
				'primeCode.permissionPolicies',
			) as any;

			expect(persisted).toEqual({
				edit: 'allow',
				terminal: 'allow',
				network: 'deny',
			});

			// Verify the response message reflects the new policies
			const msg = ctx.postedMessages.find((m: any) => m.type === 'permissionsUpdated') as any;
			expect(msg.data.policies).toEqual({
				edit: 'allow',
				terminal: 'allow',
				network: 'deny',
			});
		});

		it('should reject invalid policy values', async () => {
			const ctx = createMockHandlerContext();
			const handler = new ToolHandler(ctx);

			await handler.handleMessage({
				type: 'setPermissions',
				policies: { edit: 'invalid_value', terminal: 'allow', network: 'allow' },
			} as any);

			// Invalid values should fall back to 'ask'
			const persisted = ctx.extensionContext.workspaceState.get(
				'primeCode.permissionPolicies',
			) as any;
			expect(persisted.edit).toBe('ask');
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
		it('should expose policies so ChatProvider can auto-approve edit tools', async () => {
			const ctx = createMockHandlerContext();

			// User set edit policy to 'allow'
			await ctx.extensionContext.workspaceState.update('primeCode.permissionPolicies', {
				edit: 'allow',
				terminal: 'ask',
				network: 'ask',
			});

			const handler = new ToolHandler(ctx);
			const policies = handler.getPermissionPolicies();

			expect(policies).toEqual({
				edit: 'allow',
				terminal: 'ask',
				network: 'ask',
			});
		});
	});
});
