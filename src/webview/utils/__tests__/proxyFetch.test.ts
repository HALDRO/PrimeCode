import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock window for Node environment
const messageListeners: Array<(event: MessageEvent) => void> = [];
vi.stubGlobal('window', {
	addEventListener: vi.fn((type: string, handler: (event: MessageEvent) => void) => {
		if (type === 'message') messageListeners.push(handler);
	}),
	removeEventListener: vi.fn(),
	setTimeout: globalThis.setTimeout,
	clearTimeout: globalThis.clearTimeout,
});
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Date.now()}-${Math.random()}` });

// Mock vscode postMessage
const postedMessages: unknown[] = [];
vi.mock('../../utils/vscode', () => ({
	vscode: {
		postMessage: vi.fn((msg: unknown) => {
			postedMessages.push(msg);
		}),
	},
}));

// Must import after mock setup
import { proxyFetch } from '../../utils/proxyFetch';

function simulateResponse(
	id: string,
	opts: {
		ok?: boolean;
		status?: number;
		statusText?: string;
		headers?: Record<string, string>;
		bodyText?: string;
		error?: string;
		isStream?: boolean;
	},
) {
	const event = new MessageEvent('message', {
		data: {
			type: 'proxyFetchResult',
			id,
			ok: opts.ok ?? true,
			status: opts.status ?? 200,
			statusText: opts.statusText ?? 'OK',
			headers: opts.headers ?? {},
			bodyText: opts.bodyText ?? '',
			error: opts.error,
			isStream: opts.isStream ?? false,
		},
	});
	for (const listener of messageListeners) listener(event);
}

function simulateNetworkFailure(id: string, error: string) {
	const event = new MessageEvent('message', {
		data: {
			type: 'proxyFetchResult',
			id,
			ok: false,
			status: undefined,
			error,
		},
	});
	for (const listener of messageListeners) listener(event);
}

function getLastPostedId(): string {
	const msg = postedMessages[postedMessages.length - 1] as { id?: string };
	return msg?.id ?? '';
}

describe('proxyFetch', () => {
	beforeEach(() => {
		postedMessages.length = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends proxyFetch message to extension host', async () => {
		const promise = proxyFetch('http://localhost:4096/test', { method: 'GET' });
		const id = getLastPostedId();

		simulateResponse(id, { ok: true, status: 200, bodyText: '{"ok":true}' });
		const response = await promise;

		expect(response.status).toBe(200);
		expect(postedMessages[0]).toEqual(
			expect.objectContaining({
				type: 'proxyFetch',
				url: 'http://localhost:4096/test',
				options: expect.objectContaining({ method: 'GET' }),
			}),
		);
	});

	it('resolves with Response for HTTP 4xx/5xx (does not reject)', async () => {
		const promise = proxyFetch('http://localhost:4096/missing');
		const id = getLastPostedId();

		simulateResponse(id, {
			ok: false,
			status: 404,
			statusText: 'Not Found',
			bodyText: 'not found',
		});
		const response = await promise;

		expect(response.status).toBe(404);
		expect(response.ok).toBe(false);
		const text = await response.text();
		expect(text).toBe('not found');
	});

	it('rejects on network failure (no status)', async () => {
		const promise = proxyFetch('http://localhost:4096/dead');
		const id = getLastPostedId();

		simulateNetworkFailure(id, 'ECONNREFUSED');

		await expect(promise).rejects.toThrow('ECONNREFUSED');
	});

	it('rejects immediately if signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			proxyFetch('http://localhost:4096/test', { signal: controller.signal }),
		).rejects.toThrow('Aborted');
	});

	it('rejects with AbortError when signal is aborted after send', async () => {
		const controller = new AbortController();
		const promise = proxyFetch('http://localhost:4096/slow', { signal: controller.signal });

		controller.abort();

		await expect(promise).rejects.toThrow('Aborted');
	});

	it('cleans up abort listener after successful response', async () => {
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

		const promise = proxyFetch('http://localhost:4096/test', { signal: controller.signal });
		const id = getLastPostedId();

		simulateResponse(id, { ok: true, status: 200, bodyText: 'ok' });
		await promise;

		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('cleans up abort listener after network failure', async () => {
		const controller = new AbortController();
		const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

		const promise = proxyFetch('http://localhost:4096/dead', { signal: controller.signal });
		const id = getLastPostedId();

		simulateNetworkFailure(id, 'Network error');

		await expect(promise).rejects.toThrow('Network error');
		expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
	});

	it('serializes headers from Headers object', async () => {
		const headers = new Headers({ 'Content-Type': 'application/json', Authorization: 'Bearer x' });
		const promise = proxyFetch('http://localhost:4096/api', { method: 'POST', headers });
		const id = getLastPostedId();

		simulateResponse(id, { ok: true, status: 200 });
		await promise;

		const sent = postedMessages[0] as { options?: { headers?: Record<string, string> } };
		expect(sent.options?.headers?.['content-type']).toBe('application/json');
		expect(sent.options?.headers?.authorization).toBe('Bearer x');
	});

	it('serializes string body', async () => {
		const body = JSON.stringify({ text: 'hello' });
		const promise = proxyFetch('http://localhost:4096/api', { method: 'POST', body });
		const id = getLastPostedId();

		simulateResponse(id, { ok: true, status: 200 });
		await promise;

		const sent = postedMessages[0] as { options?: { body?: string } };
		expect(sent.options?.body).toBe(body);
	});
});
