import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => await import('../__mocks__/vscode.js'));

import { OutboundBridge } from '../transport/OutboundBridge';
import { ChatProvider } from './ChatProvider';

type PromptAsyncMock = ReturnType<typeof vi.fn>;
type SummarizeMock = ReturnType<typeof vi.fn>;

function createProvider(promptAsyncImpl?: PromptAsyncMock, summarizeImpl?: SummarizeMock) {
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
	const dispose = vi.fn(async () => {
		return {};
	});
	const clearAgentsCache = vi.fn();
	const clearCommandsCache = vi.fn();
	const clearSkillsCache = vi.fn();
	const clearMcpCache = vi.fn();

	const provider: any = Object.assign(Object.create(ChatProvider.prototype), {
		bridge: new OutboundBridge(),
		buildServerConfig: vi.fn(async (workspaceRoot: string) => ({
			provider: 'opencode',
			workspaceRoot,
			autoApprove: false,
		})),
		cli: {
			getSdkClient: vi.fn(() => ({
				instance: { dispose },
				session: { promptAsync, summarize },
			})),
			getAuthorizationHeader: vi.fn(() => null),
			restartServer: vi.fn(async () => {}),
			clearAgentsCache,
			clearCommandsCache,
			clearSkillsCache,
			clearMcpCache,
			getAdminInfo: vi.fn(() => ({
				baseUrl: 'http://127.0.0.1:4096',
				directory: 'C:\\repo',
			})),
		},
		backendStatusAbort: null,
		backendStatusKey: null,
		backendStatusRun: null,
		backendStatusWaiters: [],
		sendServerStatus: vi.fn(),
		stopBackendStatusBridge: vi.fn(),
		hasSynced: false,
	});

	return {
		provider,
		promptAsync,
		summarize,
		dispose,
		clearAgentsCache,
		clearCommandsCache,
		clearSkillsCache,
		clearMcpCache,
	};
}

describe('ChatProvider send pipeline', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		provider.sendServerStatus = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});
		provider.hasSynced = true;
		const restartManagedRuntime = vi.fn(async () => {});

		const utility: any = {
			context: {
				restartManagedRuntime,
				refreshAfterServerRestart: async () => {
					provider.sendServerInfo();
					provider.sendServerStatus('connected');
					provider.hasSynced = false;
					await provider.syncAllOrDefer('manual-server-restart');
				},
			},
		};

		await utility.context.restartManagedRuntime('manual-header');
		await utility.context.refreshAfterServerRestart();

		expect(restartManagedRuntime).toHaveBeenCalledWith('manual-header');
		expect(provider.sendServerInfo).toHaveBeenCalled();
		expect(provider.sendServerStatus).toHaveBeenCalledWith('connected');
		expect(provider.syncAllOrDefer).toHaveBeenCalledWith('manual-server-restart');
	});

	it('reloadOpenCodeRuntime calls instance.dispose() when SDK client is available', async () => {
		const { provider, dispose, clearAgentsCache } = createProvider();
		provider.backendStatusRun = Promise.resolve();
		provider.restartBackendStatusBridge = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});

		await provider.reloadOpenCodeRuntime('opencode-config:manual');

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(clearAgentsCache).toHaveBeenCalledTimes(1);
	});

	it('reloadOpenCodeRuntime calls instance.dispose() regardless of bridge state', async () => {
		const { provider, dispose, clearAgentsCache } = createProvider();
		provider.restartBackendStatusBridge = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});

		await provider.reloadOpenCodeRuntime('opencode-config:manual');

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(clearAgentsCache).toHaveBeenCalledTimes(1);
	});

	it('skips instance.dispose() when SDK client is unavailable', async () => {
		const { provider, dispose, clearAgentsCache } = createProvider();
		provider.cli.getSdkClient.mockReturnValue(null);
		provider.restartBackendStatusBridge = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});

		await provider.reloadOpenCodeRuntime('opencode-config:manual');

		expect(dispose).not.toHaveBeenCalled();
		expect(clearAgentsCache).toHaveBeenCalledTimes(1);
	});

	it('starts backend status bridge before notifying webview on startup', async () => {
		const { provider } = createProvider();
		provider.services = {
			setWorkspaceRoot: vi.fn(),
			openCodeClient: {
				syncPermissionPolicy: vi.fn(async () => {}),
				syncProxyProvidersFromPrimeCode: vi.fn(async () => {}),
			},
		};
		provider.settings = {
			get: vi.fn((key: string) => {
				if (key === 'opencode.agent') return undefined;
				if (key === 'opencode.serverTimeout') return undefined;
				if (key === 'opencode.serverUrl') return undefined;
				if (key === 'access.autoApprove') return false;
				return undefined;
			}),
			getWorkspaceRoot: vi.fn(() => 'C:\\repo'),
		};
		provider.toolHandler = {
			getPermissionPoliciesAsync: vi.fn(async () => ({})),
		};
		provider.cli.getAdminInfo = vi.fn().mockReturnValueOnce(null).mockReturnValue({
			baseUrl: 'http://127.0.0.1:4096',
			directory: 'C:\\repo',
		});
		provider.cli.ensureServer = vi.fn(async () => {});
		provider.reloadOpenCodeRuntimeOnStartup = vi.fn(async () => {});
		provider.startBackendStatusBridge = vi.fn();
		provider.sendServerStatus = vi.fn();
		provider.sendServerInfo = vi.fn();
		provider.syncAllOrDefer = vi.fn(async () => {});

		await provider.doStartOpenCode('C:\\repo');

		expect(provider.startBackendStatusBridge).toHaveBeenCalledTimes(1);
		expect(provider.sendServerStatus).toHaveBeenCalledWith('connected');
		expect(provider.sendServerInfo).toHaveBeenCalled();
		expect(provider.startBackendStatusBridge.mock.invocationCallOrder[0]).toBeLessThan(
			provider.sendServerInfo.mock.invocationCallOrder[0],
		);
	});

	it('recoverManagedRuntime reuses buildServerConfig for full restart config', async () => {
		const { provider } = createProvider();
		provider.settings = { getWorkspaceRoot: vi.fn(() => 'C:\repo') };
		provider.cli.tryReconnect = vi.fn(async () => false);
		provider.cli.restartServer = vi.fn(async () => {});
		provider.sendServerInfo = vi.fn();

		await provider.recoverManagedRuntime('C:\repo');

		expect(provider.buildServerConfig).toHaveBeenCalledWith('C:\repo');
		expect(provider.cli.restartServer).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRoot: 'C:\repo' }),
		);
		expect(provider.sendServerInfo).toHaveBeenCalled();
	});
});
