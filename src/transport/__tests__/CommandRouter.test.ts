import { describe, expect, it, vi } from 'vitest';
import type { WebviewCommand } from '../../common/protocol';
import type { WebviewMessageHandler } from '../../providers/handlers/types';
import { CommandRouter } from '../CommandRouter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockHandler(): WebviewMessageHandler & { calls: WebviewCommand[] } {
	const calls: WebviewCommand[] = [];
	return {
		calls,
		handleMessage: vi.fn(async (msg: WebviewCommand) => {
			calls.push(msg);
		}),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandRouter', () => {
	it('dispatches a registered command to its handler', async () => {
		const router = new CommandRouter();
		const handler = mockHandler();
		router.register(handler, ['getSettings'], 'settings');

		const msg = { type: 'getSettings' } as WebviewCommand;
		const result = await router.dispatch(msg);

		expect(result).toBe(true);
		expect(handler.handleMessage).toHaveBeenCalledWith(msg);
		expect(handler.calls).toHaveLength(1);
	});

	it('returns false for unregistered commands', async () => {
		const router = new CommandRouter();
		const msg = { type: 'getSettings' } as WebviewCommand;
		const result = await router.dispatch(msg);

		expect(result).toBe(false);
	});

	it('registers multiple command types for one handler', async () => {
		const router = new CommandRouter();
		const handler = mockHandler();
		router.register(handler, ['getSettings', 'updateSettings'], 'settings');

		expect(router.has('getSettings')).toBe(true);
		expect(router.has('updateSettings')).toBe(true);
		expect(router.has('sendMessage')).toBe(false);
	});

	it('throws on duplicate route registration', () => {
		const router = new CommandRouter();
		const h1 = mockHandler();
		const h2 = mockHandler();
		router.register(h1, ['getSettings'], 'first');

		expect(() => router.register(h2, ['getSettings'], 'second')).toThrow(
			/Duplicate route.*getSettings.*first/,
		);
	});

	it('returns all registered types', () => {
		const router = new CommandRouter();
		router.register(mockHandler(), ['getSettings', 'updateSettings'], 'settings');
		router.register(mockHandler(), ['sendMessage'], 'session');

		const types = router.registeredTypes();
		expect(types).toContain('getSettings');
		expect(types).toContain('updateSettings');
		expect(types).toContain('sendMessage');
		expect(types).toHaveLength(3);
	});

	it('isolates handlers — each receives only its own commands', async () => {
		const router = new CommandRouter();
		const settingsHandler = mockHandler();
		const sessionHandler = mockHandler();
		router.register(settingsHandler, ['getSettings'], 'settings');
		router.register(sessionHandler, ['sendMessage'], 'session');

		await router.dispatch({ type: 'sendMessage' } as WebviewCommand);

		expect(settingsHandler.handleMessage).not.toHaveBeenCalled();
		expect(sessionHandler.handleMessage).toHaveBeenCalledOnce();
	});

	it('propagates handler errors to the caller', async () => {
		const router = new CommandRouter();
		const handler: WebviewMessageHandler = {
			handleMessage: vi.fn(async () => {
				throw new Error('boom');
			}),
		};
		router.register(handler, ['getSettings'], 'broken');

		await expect(router.dispatch({ type: 'getSettings' } as WebviewCommand)).rejects.toThrow(
			'boom',
		);
	});
});
