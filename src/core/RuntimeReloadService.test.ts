import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeReloadService } from './ServiceRegistry';

describe('RuntimeReloadService', () => {
	let service: RuntimeReloadService;
	let executor: ReturnType<typeof vi.fn<(source: string) => Promise<void>>>;

	beforeEach(() => {
		service = new RuntimeReloadService();
		executor = vi.fn<(source: string) => Promise<void>>(async () => {});
		service.setReloadExecutor(executor);
	});

	it('executes reload immediately when no sessions are busy', () => {
		service.requestReload('test');
		expect(executor).toHaveBeenCalledWith('test');
	});

	it('defers reload when sessions are busy', () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('config-change');

		expect(executor).not.toHaveBeenCalled();
		expect(service.hasPendingReload).toBe(true);
	});

	it('executes deferred reload when all sessions become idle', async () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('config-change');

		expect(executor).not.toHaveBeenCalled();

		service.updateSessionStatus('s1', { type: 'idle' });
		// Allow microtask to flush
		await vi.waitFor(() => expect(executor).toHaveBeenCalledWith('config-change'));
	});

	it('coalesces multiple reload requests while deferred', async () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('first');
		service.requestReload('second');
		service.requestReload('third');

		expect(executor).not.toHaveBeenCalled();

		service.updateSessionStatus('s1', { type: 'idle' });
		await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
		expect(executor).toHaveBeenCalledWith('third');
	});

	it('handles multiple busy sessions correctly', async () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.updateSessionStatus('s2', { type: 'busy' });
		service.requestReload('multi');

		service.updateSessionStatus('s1', { type: 'idle' });
		expect(executor).not.toHaveBeenCalled();

		service.updateSessionStatus('s2', { type: 'idle' });
		await vi.waitFor(() => expect(executor).toHaveBeenCalledWith('multi'));
	});

	it('forceReload executes immediately even when sessions are busy', () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.forceReload('user-action');

		expect(executor).toHaveBeenCalledWith('user-action');
	});

	it('forceReload clears pending reload', () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('deferred');
		service.forceReload('forced');

		expect(service.hasPendingReload).toBe(false);
		expect(executor).toHaveBeenCalledWith('forced');
	});

	it('removeSession unblocks deferred reload', async () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('cleanup');

		service.removeSession('s1');
		await vi.waitFor(() => expect(executor).toHaveBeenCalledWith('cleanup'));
	});

	it('hasBusySessions reflects current state', () => {
		expect(service.hasBusySessions).toBe(false);

		service.updateSessionStatus('s1', { type: 'busy' });
		expect(service.hasBusySessions).toBe(true);

		service.updateSessionStatus('s1', { type: 'idle' });
		expect(service.hasBusySessions).toBe(false);
	});

	it('does not execute without a registered executor', () => {
		const bare = new RuntimeReloadService();
		// Should not throw
		bare.requestReload('no-executor');
	});

	it('queues reload requested during execution', async () => {
		let resolveFirst!: () => void;
		const firstPromise = new Promise<void>(r => {
			resolveFirst = r;
		});
		executor.mockImplementationOnce(async () => {
			await firstPromise;
		});

		service.requestReload('first');
		// While first is executing, request another
		service.requestReload('second');

		resolveFirst?.();
		await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));
		expect(executor).toHaveBeenLastCalledWith('second');
	});

	it('dispose clears all state', () => {
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('pending');
		service.dispose();

		expect(service.hasBusySessions).toBe(false);
		expect(service.hasPendingReload).toBe(false);
	});

	it('prevents concurrent executions of the reload executor', async () => {
		let maxConcurrent = 0;
		let activeExecutions = 0;

		executor.mockImplementation(async () => {
			activeExecutions++;
			maxConcurrent = Math.max(maxConcurrent, activeExecutions);
			await new Promise(resolve => setTimeout(resolve, 30));
			activeExecutions--;
		});

		// First reload starts executing
		service.requestReload('first');

		// While first is running, a session goes busy then idle — triggers _executeReload directly
		service.updateSessionStatus('s1', { type: 'busy' });
		service.requestReload('second');
		service.updateSessionStatus('s1', { type: 'idle' });

		await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(2));

		// At no point should two reloads run concurrently
		expect(maxConcurrent).toBe(1);
	});
});
