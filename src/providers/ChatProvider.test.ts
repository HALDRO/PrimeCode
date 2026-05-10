import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => await import('../__mocks__/vscode.js'));

import { OutboundBridge } from '../transport/OutboundBridge';
import { ChatProvider } from './ChatProvider';

type PromptAsyncMock = ReturnType<typeof vi.fn>;
type SummarizeMock = ReturnType<typeof vi.fn>;

function createProvider(promptAsyncImpl?: PromptAsyncMock, summarizeImpl?: SummarizeMock) {
	const postedMessages: unknown[] = [];
	const bridge = new OutboundBridge();
	vi.spyOn(bridge, 'send').mockImplementation((msg: unknown) => {
		postedMessages.push(msg);
	});

	const promptAsync =
		promptAsyncImpl ??
		vi.fn(async () => {
			return {};
		});
	const summarize =
		summarizeImpl ??
		vi.fn(async () => {
			return {};
		});
	const abort = vi.fn(async () => {
		return {};
	});

	const provider: any = Object.assign(Object.create(ChatProvider.prototype), {
		bridge,
		cli: {
			getSdkClient: vi.fn(() => ({ session: { promptAsync, summarize, abort } })),
			getAdminInfo: vi.fn(() => ({
				baseUrl: 'http://127.0.0.1:4096',
				directory: 'C:\\repo',
			})),
		},
		backendBusySessions: new Set<string>(),
		awaitingBackendBusy: new Set<string>(),
		pendingMessages: new Map(),
		sendingLock: new Set<string>(),
		pendingIdleDrain: new Set<string>(),
		suppressNextIdleDrain: new Set<string>(),
		queueIdCounter: 0,
	});

	return { provider, postedMessages, promptAsync, summarize, abort };
}

describe('ChatProvider queue pipeline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('queues follow-up messages while the backend session is busy', async () => {
		const { provider, postedMessages, promptAsync } = createProvider();
		provider.backendBusySessions.add('ses-1');

		await (provider as any).handleSendMessageCommand({
			type: 'sendMessage',
			sessionId: 'ses-1',
			text: 'queued message',
		});

		expect(promptAsync).not.toHaveBeenCalled();
		expect(provider.pendingMessages.get('ses-1')).toHaveLength(1);
		expect(postedMessages).toContainEqual(
			expect.objectContaining({
				type: 'messageQueue',
				data: expect.objectContaining({
					action: 'enqueued',
					sessionId: 'ses-1',
				}),
			}),
		);
	});

	it('routes /compact through summarize instead of promptAsync', async () => {
		const { provider, promptAsync, summarize } = createProvider();

		await (provider as any).handleSendMessageCommand({
			type: 'sendMessage',
			sessionId: 'ses-1',
			text: '/compact',
			model: 'openai/gpt-5',
		});

		expect(promptAsync).not.toHaveBeenCalled();
		expect(summarize).toHaveBeenCalledTimes(1);
		expect((summarize as any).mock.calls[0][0]).toEqual(
			expect.objectContaining({
				sessionID: 'ses-1',
				directory: 'C:\\repo',
				providerID: 'openai',
				modelID: 'gpt-5',
				auto: false,
			}),
		);
	});

	it('drains queued messages one-by-one on each real busy -> idle turn completion', async () => {
		const { provider, promptAsync } = createProvider();
		provider.pendingMessages.set('ses-1', [
			{ queueId: 'q1', sessionId: 'ses-1', text: 'first', queuedAt: 1 },
			{ queueId: 'q2', sessionId: 'ses-1', text: 'second', queuedAt: 2 },
		]);
		provider.backendBusySessions.add('ses-1');

		(provider as any).forwardNormalizedBackendStatus('ses-1', { type: 'idle' }, 'session.idle');
		await Promise.resolve();

		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect((promptAsync as any).mock.calls[0][0]).toEqual(
			expect.objectContaining({ sessionID: 'ses-1' }),
		);
		expect(provider.pendingMessages.get('ses-1')).toHaveLength(1);

		(provider as any).forwardNormalizedBackendStatus('ses-1', { type: 'busy' }, 'session.status');
		(provider as any).forwardNormalizedBackendStatus('ses-1', { type: 'idle' }, 'session.idle');
		await Promise.resolve();

		expect(promptAsync).toHaveBeenCalledTimes(2);
		expect(provider.pendingMessages.get('ses-1')).toBeUndefined();
	});

	it('ignores trailing idle events that arrive before the new queued turn reports busy', async () => {
		const { provider, promptAsync } = createProvider();
		provider.pendingMessages.set('ses-1', [
			{ queueId: 'q1', sessionId: 'ses-1', text: 'first', queuedAt: 1 },
			{ queueId: 'q2', sessionId: 'ses-1', text: 'second', queuedAt: 2 },
		]);
		provider.backendBusySessions.add('ses-1');

		(provider as any).forwardNormalizedBackendStatus('ses-1', { type: 'idle' }, 'session.idle');
		await Promise.resolve();
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(provider.pendingMessages.get('ses-1')).toHaveLength(1);

		(provider as any).forwardNormalizedBackendStatus('ses-1', { type: 'idle' }, 'session.idle');
		await Promise.resolve();

		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(provider.pendingMessages.get('ses-1')).toHaveLength(1);
	});

	it('does not double-send when force sending a queued message during an active turn', async () => {
		const { provider, promptAsync, abort } = createProvider();
		provider.pendingMessages.set('ses-1', [
			{ queueId: 'q1', sessionId: 'ses-1', text: 'first', queuedAt: 1 },
			{ queueId: 'q2', sessionId: 'ses-1', text: 'second', queuedAt: 2 },
		]);
		provider.backendBusySessions.add('ses-1');

		await (provider as any).forceQueuedMessage('ses-1', 'q2');

		expect(abort).toHaveBeenCalledTimes(1);
		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect(provider.pendingMessages.get('ses-1')).toEqual([
			expect.objectContaining({ queueId: 'q1' }),
		]);
	});

	it('buildRequestParts preserves snippet line ranges and image mime types', () => {
		const { provider } = createProvider();

		const parts = (provider as any).buildRequestParts({
			sessionId: 'ses-1',
			text: '@[src/api.ts]#L10-L20 inspect image',
			attachments: {
				codeSnippets: [{ filePath: 'src/api.ts', startLine: 10, endLine: 20, content: '' }],
				images: [{ id: 'img-1', name: 'shot.webp', dataUrl: 'data:image/webp;base64,AAA' }],
			},
		});

		expect(parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ url: 'file://src/api.ts?start=10&end=20' }),
				expect.objectContaining({ url: 'data:image/webp;base64,AAA', mime: 'image/webp' }),
			]),
		);
	});

	it('sends large text to promptAsync without truncating it', async () => {
		const { provider, promptAsync } = createProvider();
		const text = 'large prompt '.repeat(20_000);

		await (provider as any).handleSendMessageCommand({
			type: 'sendMessage',
			sessionId: 'ses-1',
			text,
		});

		expect(promptAsync).toHaveBeenCalledTimes(1);
		expect((promptAsync as any).mock.calls[0][0].parts[0]).toEqual({ type: 'text', text });
	});

	it('surfaces structured promptAsync errors instead of Unknown error', async () => {
		const { provider } = createProvider(
			vi.fn(async () => ({ error: { data: { message: 'Request body too large' } } })),
		);

		await expect(
			(provider as any).handleSendMessageCommand({
				type: 'sendMessage',
				sessionId: 'ses-1',
				text: 'large message',
			}),
		).rejects.toThrow('Message send failed: Request body too large');
	});

	it('restartOpenCode path reloads runtime state and resyncs the webview', async () => {
		const { provider } = createProvider();
		provider.sendServerInfo = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});
		provider.hasSynced = true;
		const reloadOpenCodeRuntime = vi.fn(async () => {});

		const utility: any = {
			context: {
				reloadOpenCodeRuntime,
				refreshAfterServerRestart: async () => {
					provider.sendServerInfo(true);
					provider.hasSynced = false;
					await provider.syncAllOrDefer('manual-server-restart');
				},
			},
		};

		await utility.context.reloadOpenCodeRuntime('manual-header');
		await utility.context.refreshAfterServerRestart();

		expect(reloadOpenCodeRuntime).toHaveBeenCalledWith('manual-header');
		expect(provider.sendServerInfo).toHaveBeenCalledWith(true);
		expect(provider.syncAllOrDefer).toHaveBeenCalledWith('manual-server-restart');
	});
});
