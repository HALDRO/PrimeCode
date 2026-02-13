/**
 * @file CLIRunner OpenCode contract tests
 * @description Verifies PrimeCode's OpenCode integration against expected protocol
 *              semantics (permission replies, model parsing, and SSE event framing).
 *              Tests avoid spawning external processes and instead exercise the
 *              in-memory OpenCode executor via the CLIRunner facade.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIRunner } from './CLIRunner';
import type { OpenCodeExecutor } from './executor/OpenCode';

type FetchMock = ReturnType<typeof vi.fn>;

function getOpenCodeExecutorForTest(): any {
	const runner = new CLIRunner();
	return (runner as unknown as { executor: OpenCodeExecutor }).executor as OpenCodeExecutor;
}

function asJsonBody(fetchCallArgs: unknown[]): unknown {
	const init = fetchCallArgs[1] as { body?: unknown } | undefined;
	if (!init || typeof init !== 'object') {
		throw new Error('Missing fetch init');
	}
	if (typeof init.body !== 'string') {
		throw new Error('Expected fetch init.body to be a string');
	}
	return JSON.parse(init.body);
}

function mockOkFetch(): FetchMock {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: vi.fn().mockResolvedValue(''),
	});

	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(data);
			controller.close();
		},
	});
}

function sseEvent({ id, data }: { id: string; data: unknown }): string {
	return `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('OpenCode permission reply payload', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends { reply: "once" } when approved (default)', async () => {
		const exec = getOpenCodeExecutorForTest();
		exec.serverUrl = 'http://127.0.0.1:1234';
		exec.directory = 'C:/repo';

		const fetchMock = mockOkFetch();

		await exec.respondToPermission({ requestId: 'req-1', approved: true });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url] = fetchMock.mock.calls[0] as unknown[];
		expect(String(url)).toContain('/permission/req-1/reply');
		expect(String(url)).toContain('directory=');

		const body = asJsonBody(fetchMock.mock.calls[0] as unknown[]);
		expect(body).toEqual({ reply: 'once' });
	});

	it('sends { reply: "reject", message } when rejected', async () => {
		const exec = getOpenCodeExecutorForTest();
		exec.serverUrl = 'http://127.0.0.1:1234';
		exec.directory = 'C:/repo';

		const fetchMock = mockOkFetch();

		await exec.respondToPermission({ requestId: 'req-2', approved: false });

		const body = asJsonBody(fetchMock.mock.calls[0] as unknown[]);
		expect(body).toMatchObject({ reply: 'reject' });
		expect((body as { message?: unknown }).message).toEqual(expect.any(String));
	});

	it('respects explicit response override', async () => {
		const exec = getOpenCodeExecutorForTest();
		exec.serverUrl = 'http://127.0.0.1:1234';
		exec.directory = 'C:/repo';

		const fetchMock = mockOkFetch();

		await exec.respondToPermission({
			requestId: 'req-3',
			approved: true,
			response: 'always',
		});

		const body = asJsonBody(fetchMock.mock.calls[0] as unknown[]);
		expect(body).toEqual({ reply: 'always' });
	});
});

describe('OpenCode model parsing', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('omits model override when provider-only model is passed', async () => {
		const exec = getOpenCodeExecutorForTest();
		exec.serverUrl = 'http://127.0.0.1:1234';
		exec.directory = 'C:/repo';

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: vi.fn().mockResolvedValue('{"info":{},"parts":[]}'),
		});
		vi.stubGlobal('fetch', fetchMock);

		await exec.sendPrompt('C:/repo', 's-1', 'hi', {
			provider: 'opencode',
			workspaceRoot: 'C:/repo',
			model: 'anthropic',
		});

		const body = asJsonBody(fetchMock.mock.calls[0] as unknown[]) as any;
		expect(body.model).toBeUndefined();
	});

	it('sends model override when provider/model is passed', async () => {
		const exec = getOpenCodeExecutorForTest();
		exec.serverUrl = 'http://127.0.0.1:1234';
		exec.directory = 'C:/repo';

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			text: vi.fn().mockResolvedValue('{"info":{},"parts":[]}'),
		});
		vi.stubGlobal('fetch', fetchMock);

		await exec.sendPrompt('C:/repo', 's-1', 'hi', {
			provider: 'opencode',
			workspaceRoot: 'C:/repo',
			model: 'anthropic/claude-3-5-sonnet-20241022',
		});

		const body = asJsonBody(fetchMock.mock.calls[0] as unknown[]) as any;
		expect(body.model).toEqual({
			providerID: 'anthropic',
			modelID: 'claude-3-5-sonnet-20241022',
		});
	});
});

describe('OpenCode SSE framing', () => {
	it('parses SSE id + JSON data', async () => {
		const exec = getOpenCodeExecutorForTest();
		const body = streamFromString(
			sseEvent({ id: 'e1', data: { type: 'session.idle', properties: { sessionID: 's-1' } } }),
		);

		const gen = exec.iterSseEvents(body);
		const first = await gen.next();

		expect(first.done).toBe(false);
		expect(first.value).toEqual({
			id: 'e1',
			data: { type: 'session.idle', properties: { sessionID: 's-1' } },
		});
	});

	it('adds Last-Event-ID header when reconnecting', async () => {
		const exec = getOpenCodeExecutorForTest();

		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: 'OK',
			body: streamFromString(''),
			text: vi.fn().mockResolvedValue(''),
		});
		vi.stubGlobal('fetch', fetchMock);

		const controller = new AbortController();
		await exec.connectEventStream('http://127.0.0.1:1234', 'C:/repo', controller.signal, 'e1');

		const init = fetchMock.mock.calls[0]?.[1] as any;
		// Headers can be a plain object (as we send) or a Headers instance (in some runtimes)
		const lastEventId =
			init?.headers instanceof Headers
				? init.headers.get('Last-Event-ID')
				: (init?.headers?.['Last-Event-ID'] as unknown);
		expect(lastEventId).toBe('e1');
	});
});
