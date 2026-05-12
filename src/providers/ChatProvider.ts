import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as vscode from 'vscode';
import { generateId, parseModelId } from '../common';
import type { SendMessageAttachments, WebviewCommand } from '../common/protocol';
import { OpenCodeExecutor } from '../core/executor/OpenCode';
import { buildPromptParts } from '../core/promptParts';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { Settings } from '../core/Settings';
import { CommandRouter } from '../transport/CommandRouter';

import { OutboundBridge } from '../transport/OutboundBridge';
import { extractErrorInfo } from '../utils/errorInfo';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';
import { FileHandler } from './handlers/FileHandler';
import { McpHandler } from './handlers/McpHandler';
import { ProviderHandler } from './handlers/ProviderHandler';
import { SettingsHandler } from './handlers/SettingsHandler';
import { ToolHandler } from './handlers/ToolHandler';
import type { HandlerContext } from './handlers/types';
import { UtilityHandler } from './handlers/UtilityHandler';

type BackendSendParams = {
	sessionId: string;
	text: string;
	messageID?: string;
	model?: string;
	agent?: string;
	variant?: string;
	attachments?: SendMessageAttachments;
};

function getSlashCommand(text: string): string | undefined {
	const match = text.trim().match(/^\/(\S+)(?:\s+.*)?$/);
	return match?.[1]?.toLowerCase();
}

function isCompactionCommand(text: string): boolean {
	const slashCommand = getSlashCommand(text);
	return slashCommand === 'compact' || slashCommand === 'summarize';
}

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private webviewDidLaunch = false;
	private readonly deferredUiOpens: Array<'openHistory' | 'openSettings'> = [];
	private cli: OpenCodeExecutor;
	private settings: Settings;
	private disposables: vscode.Disposable[] = [];

	/** Monotonic revision for server rendezvous updates sent to the webview. */
	private serverInfoRevision = 0;
	private backendStatusAbort: AbortController | null = null;
	private backendStatusRun: Promise<void> | null = null;
	private backendStatusKey: string | null = null;
	private healthMonitorTimer: ReturnType<typeof setInterval> | null = null;
	private healthConsecutiveFailures = 0;

	// Handlers
	private settingsHandler: SettingsHandler;
	private mcpHandler: McpHandler;
	private providerHandler: ProviderHandler;
	private toolHandler: ToolHandler;
	private fileHandler: FileHandler;
	private utilityHandler: UtilityHandler;

	/** Guards against duplicate syncAll calls during startup. */
	private hasSynced = false;
	private didStartupRuntimeReload = false;
	private readonly bridge = new OutboundBridge();
	private readonly router = new CommandRouter();

	constructor(
		private context: vscode.ExtensionContext,
		private services: ServiceRegistry,
	) {
		this.settings = new Settings();
		this.cli = new OpenCodeExecutor();

		// Initialize Handlers — single shared context
		const baseContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			bridge: this.bridge,
			services: this.services,
		};
		const handlerContext: HandlerContext = {
			...baseContext,
			// Lazy getter — ToolHandler is created below but the closure captures `this`
			getPermissionPolicies: () => this.toolHandler.getPermissionPolicies(),
			getPermissionPoliciesAsync: () => this.toolHandler.getPermissionPoliciesAsync(),
			setPermissionPolicy: (category, policy) =>
				this.toolHandler.setPermissionPolicy(category, policy),
			getSessionAutoAccept: (sessionId: string) => this.toolHandler.isAutoAcceptAsync(sessionId),
			getSessionAutoAcceptState: (sessionId: string) =>
				this.toolHandler.getSessionAutoAcceptState(sessionId),
			getParentSessionId: async (sessionId: string) => {
				const client = this.cli.getSdkClient() as {
					session?: {
						get?: (input: {
							sessionID: string;
							directory: string;
						}) => Promise<{ data?: { parentID?: string } }>;
					};
				} | null;
				const directory = this.settings.getWorkspaceRoot();
				if (!client?.session?.get || !directory) return undefined;
				const result = await client.session.get({ sessionID: sessionId, directory });
				return typeof result.data?.parentID === 'string' ? result.data.parentID : undefined;
			},
			clearSessionAutoAccept: (sessionId: string) =>
				this.toolHandler.clearSessionAutoAccept(sessionId),
			refreshAfterServerRestart: async () => {
				this.sendServerInfo(true);
				this.hasSynced = false;
				await this.syncAllOrDefer('manual-server-restart');
			},
			reloadOpenCodeRuntime: source => this.reloadOpenCodeRuntime(source),
		};

		this.settingsHandler = new SettingsHandler(handlerContext);
		this.mcpHandler = new McpHandler(handlerContext);
		this.providerHandler = new ProviderHandler(handlerContext);
		this.toolHandler = new ToolHandler(handlerContext);
		this.fileHandler = new FileHandler(handlerContext);
		this.utilityHandler = new UtilityHandler(handlerContext);

		// Build declarative command router
		this.buildRouter();

		// Single-point OpenCode initialization with retry polling
		this.scheduleOpenCodeInit();

		// Watch settings changes
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('primeCode')) {
					this.handleSettingsChange();
				}
			}),
		);

		// Wire up MCP messages from registry
		this.disposables.push(
			this.services.onMcpMessage(msg => {
				this.bridge.send(msg);
			}),
		);

		this.services.mcpConfigWatcher.start(async source => {
			this.hasSynced = false;
			await this.reloadOpenCodeRuntime(`opencode-config:${source}`);
			await this.mcpHandler.handleMessage({ type: 'loadMCPServers' });
			await this.syncAllOrDefer(`opencode-config-${source}`);
		});

		this.services.resourceWatcher.start(resourceType => this.handleResourceChange(resourceType));

		// Keep services in sync when workspace folders change at runtime
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceRoot) {
					this.services.setWorkspaceRoot(workspaceRoot);
					this.restartWorkspaceWatchers();
				}
			}),
		);
	}

	private restartWorkspaceWatchers(): void {
		this.services.mcpConfigWatcher.dispose();
		this.services.resourceWatcher.dispose();
		this.services.mcpConfigWatcher.start(async source => {
			this.hasSynced = false;
			await this.reloadOpenCodeRuntime(`opencode-config:${source}`);
			await this.mcpHandler.handleMessage({ type: 'loadMCPServers' });
			await this.syncAllOrDefer(`opencode-config-${source}`);
		});
		this.services.resourceWatcher.start(resourceType => this.handleResourceChange(resourceType));
	}

	private async reloadOpenCodeRuntime(source: string): Promise<void> {
		logger.debug('[ChatProvider] Invalidating OpenCode runtime caches', { source });
		this.clearOpenCodeRuntimeCaches();
	}

	private clearOpenCodeRuntimeCaches(): void {
		this.cli.clearAgentsCache?.();
		this.cli.clearCommandsCache?.();
		this.cli.clearSkillsCache?.();
		this.cli.clearMcpCache?.();
	}

	private async handleResourceChange(
		resourceType: 'commands' | 'skills' | 'subagents' | 'plugins' | 'rules',
	): Promise<void> {
		try {
			await this.reloadOpenCodeRuntime(`resource:${resourceType}`);
			if (resourceType === 'rules') {
				await this.settingsHandler.handleMessage({ type: 'getRules' });
				return;
			}

			switch (resourceType) {
				case 'commands':
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'command' });
					return;
				case 'skills':
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'skill' });
					return;
				case 'subagents':
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'agent' });
					return;
				case 'plugins':
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'plugin' });
					return;
			}
		} catch (error) {
			logger.error(`[ChatProvider] Failed to refresh ${resourceType}:`, error);
		}
	}

	private async reloadOpenCodeRuntimeOnStartup(): Promise<void> {
		if (this.didStartupRuntimeReload) return;
		this.didStartupRuntimeReload = true;
		await this.reloadOpenCodeRuntime('startup');
	}

	/**
	 * Single-point OpenCode initialization.
	 * Uses onDidChangeWorkspaceFolders event instead of polling when
	 * workspace root is not immediately available.
	 */
	private scheduleOpenCodeInit(): void {
		if (this.cli.getProvider() !== 'opencode') return;

		const autoStart = this.settings.get('opencode.autoStart') !== false;
		if (!autoStart) {
			return;
		}

		// Try immediately
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) {
			void this.doStartOpenCode(root);
			return;
		}

		// Workspace not ready yet — wait for the event instead of polling
		const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				disposable.dispose();
				void this.doStartOpenCode(workspaceRoot);
			}
		});
		this.disposables.push(disposable);
	}

	private async doStartOpenCode(workspaceRoot: string): Promise<void> {
		// Update services that depend on workspace root
		this.services.setWorkspaceRoot(workspaceRoot);

		// Skip if server is already running
		const serverInfo = this.cli.getAdminInfo();
		if (serverInfo?.baseUrl) {
			logger.debug('[ChatProvider] OpenCode server already running');
			return;
		}

		const opencodeAgent = this.settings.get('opencode.agent');
		const opencodeServerTimeout = this.settings.get('opencode.serverTimeout');
		const opencodeServerUrl = this.settings.get('opencode.serverUrl');
		const policies = await this.toolHandler.getPermissionPoliciesAsync();

		const config = {
			provider: 'opencode' as const,
			workspaceRoot,
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			autoApprove: Boolean(this.settings.get('access.autoApprove') || false),
			policies: { ...policies },
			serverTimeoutMs:
				typeof opencodeServerTimeout === 'number' && Number.isFinite(opencodeServerTimeout)
					? Math.max(0, opencodeServerTimeout) * 1000
					: undefined,
			serverUrl:
				typeof opencodeServerUrl === 'string' && opencodeServerUrl.trim().length > 0
					? opencodeServerUrl.trim()
					: undefined,
		};

		try {
			await this.cli.ensureServer(config);
			await this.reloadOpenCodeRuntimeOnStartup();

			// Notify webview of server URL so it can establish SSE health polling
			this.sendServerInfo(true);
			this.startBackendStatusBridge();
			this.startHealthMonitor();

			// Hydrate all UI-visible state after server connection (providers, proxy models, MCP, etc.)
			await this.syncAllOrDefer('opencode-start');
		} catch (error) {
			logger.warn('[ChatProvider] Failed to start OpenCode:', error);
			this.bridge.showNotification({
				notification: {
					id: `system_notice-${Date.now()}`,
					type: 'system_notice',
					content:
						'Failed to start OpenCode server. Models/providers may be unavailable until it is running. See extension logs for details.',
					timestamp: new Date().toISOString(),
				},
			});
		}
	}

	/**
	 * Registers all command handlers in the declarative router.
	 * Called once from the constructor after all handlers are created.
	 */
	private buildRouter(): void {
		const r = this.router;

		r.register(
			{
				handleMessage: msg => this.handleSessionCommand(msg),
			},
			['sendMessage'],
			'session',
		);

		// Settings
		r.register(
			this.settingsHandler,
			[
				'getSettings',
				'updateSettings',
				'getRules',
				'getResources',
				'mutateResource',
				'applyResourceAction',
				'deleteSubagent',
				'createRule',
				'deleteRule',
			],
			'settings',
		);

		// MCP
		r.register(
			this.mcpHandler,
			[
				'loadMCPServers',
				'saveMCPServer',
				'setMCPServerEnabled',
				'deleteMCPServer',
				'openMcpConfig',
			],
			'mcp',
		);

		// Provider
		r.register(
			this.providerHandler,
			[
				'reloadAllProviders',
				'checkOpenCodeStatus',
				'loadOpenCodeProviders',
				'loadAvailableProviders',
				'setOpenCodeProviderAuth',
				'disconnectOpenCodeProvider',
				'setOpenCodeModel',
				'selectModel',
				'loadProxyModels',
				'syncProxyModels',
				'removeProxyEndpoint',
			],
			'provider',
		);

		// Tool / Access
		r.register(
			this.toolHandler,
			[
				'getPermissions',
				'setPermissionPolicy',
				'setAutoAccept',
				'setAlwaysAllowTool',
				'checkDiscoveryStatus',
				'getAccess',
				'checkCLIDiagnostics',
			],
			'tool',
		);

		// File
		r.register(
			this.fileHandler,
			['openFile', 'openFileDiff', 'openExternal', 'getImageData', 'browseFiles', 'browseFolders'],
			'file',
		);

		// Orchestration
		r.register(
			{
				handleMessage: async (msg: WebviewCommand) => {
					if (msg.type === 'webviewDidLaunch') {
						this.webviewDidLaunch = true;
						await this.sendInitialState();
						this.flushDeferredUiOpens();
						await this.syncAllOrDefer('webview-launch');
						return;
					}
					await this.syncAllOrDefer('webview-syncAll');
				},
			},
			['webviewDidLaunch', 'syncAll'],
			'orchestration',
		);

		// Utility (proxy fetch, resource files, git stage, workspace files, version check, connection status)
		r.register(
			this.utilityHandler,
			[
				'proxyFetch',
				'proxyFetchAbort',
				'openCommandFile',
				'openSkillFile',
				'openPluginFile',
				'openSubagentFile',
				'acceptFile',
				'acceptAllFiles',
				'getWorkspaceFiles',
				'checkExtensionVersion',
				'restartOpenCode',
				'reloadExtension',
				'getConnectionDetails',
			],
			'utility',
		);
	}

	private async syncAllOrDefer(source: string): Promise<void> {
		// When called from OpenCode startup, webview might not be ready yet.
		if (!this.view) {
			return;
		}
		// If the server isn't ready yet, defer — provider/model fetches would return
		// empty data, leaving the UI with only the hardcoded OpenAI Compatible entry.
		const serverReady = !!this.cli.getAdminInfo()?.baseUrl;
		if (!serverReady) {
			return;
		}
		// Prevent duplicate syncAll during startup (opencode-start vs webview-syncAll race).
		// Explicit webview requests ('webview-syncAll') bypass the guard so the user
		// can recover from partial failures without reloading the panel.
		if (this.hasSynced && source !== 'webview-syncAll') {
			return;
		}
		this.hasSynced = true;
		await this.syncAll();
	}

	private async syncAll(): Promise<void> {
		// Pull everything the UI can display. This keeps startup and reconnect logic simple.
		logger.debug('[ChatProvider] syncAll started');
		const startedAt = Date.now();

		// Send server URL first so webview can establish SSE health polling immediately
		this.sendServerInfo();
		this.startBackendStatusBridge();

		await this.providerHandler.handleMessage({ type: 'reloadAllProviders' });

		const requests: Promise<unknown>[] = [
			this.settingsHandler.handleMessage({ type: 'getSettings' }),
			this.toolHandler.handleMessage({ type: 'getPermissions' }),
			this.toolHandler.handleMessage({ type: 'getAccess' }),
			this.settingsHandler.handleMessage({ type: 'getResources' }),
			this.mcpHandler.handleMessage({ type: 'loadMCPServers' }),
			this.toolHandler.handleMessage({ type: 'checkDiscoveryStatus' }),
			this.settingsHandler.handleMessage({ type: 'getRules' }),
			this.refreshLspStatus(),
		];

		const results = await Promise.allSettled(requests);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		if (failures.length > 0) {
			logger.warn('[ChatProvider] syncAll completed with failed tasks', {
				failures: failures.map(result => extractErrorInfo(result.reason)),
			});
		}
		logger.debug('[ChatProvider] syncAll completed', { durationMs: Date.now() - startedAt });

		// Auto-fetch models for custom proxy endpoints so they appear in the UI
		// after restart without requiring the user to click "Fetch" manually.
		// This runs after the main sync so that settings (proxy.endpoints) are already loaded.
		this.fetchCustomEndpointModels().catch(err => {
			logger.warn('[ChatProvider] fetchCustomEndpointModels failed:', err);
		});
	}

	/**
	 * Read custom proxy endpoints from merged settings (VS Code + opencode.json),
	 * then trigger loadProxyModels for each one that has a baseUrl.
	 * Uses SettingsHandler.getResolvedEndpoints() to avoid re-reading opencode.json.
	 */
	private async fetchCustomEndpointModels(): Promise<void> {
		const endpoints = await this.settingsHandler.getResolvedEndpoints();
		if (!endpoints.length) return;

		const endpointRequests = endpoints
			.filter(ep => ep.baseUrl?.trim())
			.map(ep =>
				this.providerHandler.handleMessage({
					type: 'loadProxyModels',
					baseUrl: ep.baseUrl,
					apiKey: ep.apiKey ?? '',
					endpointId: ep.id,
					headers: ep.headers,
					protocol: ep.protocol,
				}),
			);

		if (endpointRequests.length > 0) {
			await Promise.allSettled(endpointRequests);
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		this.bridge.setView({ postMessage: msg => this.postMessage(msg) });

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		const scriptUri = webviewView.webview
			.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'))
			.toString();
		const styleUri = webviewView.webview
			.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'))
			.toString();
		const cspSource = webviewView.webview.cspSource;

		webviewView.webview.html = getHtml(
			scriptUri,
			styleUri,
			cspSource,
			false,
			vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
		);

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg)),
		);

		// Null out bridge view on dispose so messages are queued, not lost
		webviewView.onDidDispose(() => {
			this.webviewDidLaunch = false;
			this.bridge.clearView();
		});

		// Reset sync flag so full state is re-sent when webview is re-created
		this.hasSynced = false;

		// Initial state is sent only after the webview handshake (`webviewDidLaunch`).
		// This avoids racing the first postMessage against the webview listener setup.
	}

	private async handleWebviewMessage(msg: WebviewCommand): Promise<void> {
		// Forward webview diagnostic logs to the Output channel
		if (msg.type === 'webviewLog') {
			const logFn = logger[msg.level] as (m: string, ...args: unknown[]) => void;
			const line = msg.details
				? `[WebView][${msg.component}] ${msg.message} ${msg.details}`
				: `[WebView][${msg.component}] ${msg.message}`;
			logFn(line);
			return;
		}

		try {
			const handled = await this.router.dispatch(msg);
			if (!handled) {
				logger.warn(`[ChatProvider] Unhandled webview command: ${msg.type}`);
			}
		} catch (error) {
			const errorInfo = extractErrorInfo(error);

			// CodeExpectedError = VS Code refusing to open a file (too large, binary).
			// Not our bug — VS Code's own limitation. Log at debug, don't surface.
			if (errorInfo.name === 'CodeExpectedError') {
				logger.debug(
					`[ChatProvider] VS Code refused to open file (${msg.type}):`,
					errorInfo.message,
				);
				return;
			}

			logger.error(`[ChatProvider] Error handling "${msg.type}" command:`, errorInfo);
			// Command errors are extension bugs, not actionable for the user.
			// Full context is available in the Output channel (Developer: Show Output → PrimeCode).
		}
	}

	private async handleSessionCommand(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'sendMessage':
				logger.info(`[ChatProvider] User sent message in session ${msg.sessionId}`, {
					agent: (msg as { agent?: string }).agent,
					model: (msg as { model?: string }).model,
				});
				await this.handleSendMessageCommand(msg);
				return;
		}
	}

	private async handleSendMessageCommand(
		msg: Extract<WebviewCommand, { type: 'sendMessage' }>,
	): Promise<void> {
		if (!msg.sessionId) return;
		if (isCompactionCommand(msg.text)) {
			await this.sendCompactionAsync({
				sessionId: msg.sessionId,
				text: msg.text,
				messageID: msg.messageID,
				model: msg.model,
				agent: msg.agent,
				variant: msg.variant,
				attachments: msg.attachments,
			});
			return;
		}

		const params: BackendSendParams = {
			sessionId: msg.sessionId,
			text: msg.text,
			messageID: msg.messageID,
			model: msg.model,
			agent: msg.agent,
			variant: msg.variant,
			attachments: msg.attachments,
		};

		try {
			await this.sendPromptAsync(params);
		} catch (error) {
			if (!params.model) throw error;
			// Model may have been removed externally (another VS Code instance).
			// Refresh providers and retry once before giving up.
			logger.info(
				`[ChatProvider] Send failed with model "${params.model}", refreshing and retrying`,
			);
			try {
				await this.reloadOpenCodeRuntime('model-retry');
				await this.settingsHandler.handleMessage({ type: 'getSettings' });
				await this.providerHandler.handleMessage({ type: 'loadOpenCodeProviders' });
			} catch (refreshError) {
				logger.warn('[ChatProvider] Provider refresh failed during retry:', refreshError);
			}
			await this.sendPromptAsync(params);
		}
	}

	private async sendCompactionAsync(params: BackendSendParams): Promise<void> {
		const client = this.cli.getSdkClient();
		const admin = this.cli.getAdminInfo();
		if (!client || !admin?.directory) {
			throw new Error('OpenCode server is unavailable');
		}

		const parsedModel = params.model ? parseModelId(params.model) : undefined;
		if (!parsedModel) {
			throw new Error('Compaction requires an explicit OpenCode model');
		}

		const compactionClient = client as typeof client & {
			session: typeof client.session & {
				summarize?: (input: {
					sessionID: string;
					directory: string;
					providerID: string;
					modelID: string;
					auto?: boolean;
				}) => Promise<{ error?: unknown }>;
			};
		};
		if (!compactionClient.session.summarize) {
			throw new Error('Session summarize API unavailable');
		}

		try {
			const result = await compactionClient.session.summarize({
				sessionID: params.sessionId,
				directory: admin.directory,
				providerID: parsedModel.providerId,
				modelID: parsedModel.modelId,
				auto: false,
			});
			if (result?.error) {
				const errorInfo = extractErrorInfo(result.error);
				throw new Error(errorInfo.message);
			}
		} catch (error) {
			const errorInfo = extractErrorInfo(error);
			logger.error(`[ChatProvider] Compaction failed for session ${params.sessionId}:`, errorInfo);
			throw error;
		}
	}

	private async sendPromptAsync(params: BackendSendParams): Promise<void> {
		const client = this.cli.getSdkClient();
		const admin = this.cli.getAdminInfo();
		if (!client || !admin?.directory) {
			throw new Error('OpenCode server is unavailable');
		}

		const messageID = params.messageID ?? generateId('msg');
		const parsedModel = params.model ? parseModelId(params.model) : undefined;
		const promptClient = client as typeof client & {
			session: typeof client.session & {
				promptAsync?: (input: {
					sessionID: string;
					messageID: string;
					agent?: string;
					variant?: string;
					model?: { providerID: string; modelID: string };
					parts: Record<string, unknown>[];
				}) => Promise<{ error?: unknown }>;
			};
		};
		if (!promptClient.session.promptAsync) {
			throw new Error('Session promptAsync API unavailable');
		}

		try {
			const result = await promptClient.session.promptAsync({
				sessionID: params.sessionId,
				messageID,
				agent: params.agent,
				variant: params.variant,
				...(parsedModel
					? { model: { providerID: parsedModel.providerId, modelID: parsedModel.modelId } }
					: {}),
				parts: this.buildRequestParts(params),
			});
			if (result?.error) {
				const errorInfo = extractErrorInfo(result.error);
				throw Object.assign(new Error(`Message send failed: ${errorInfo.message}`), {
					code: errorInfo.code,
					cause: result.error,
				});
			}
		} catch (error) {
			const errorInfo = extractErrorInfo(error);
			logger.error(
				`[ChatProvider] sendPromptAsync failed for session ${params.sessionId}:`,
				errorInfo,
			);
			throw error;
		}
	}

	private buildRequestParts(params: BackendSendParams): Record<string, unknown>[] {
		return buildPromptParts({
			text: params.text,
			attachments: params.attachments,
		}) as Record<string, unknown>[];
	}

	private handleSettingsChange(): void {
		this.settings.refresh();
		void this.settingsHandler.handleMessage({ type: 'getSettings' });
	}

	private startBackendStatusBridge(): void {
		const admin = this.cli.getAdminInfo();
		if (!admin?.baseUrl || !admin.directory) return;

		const nextKey = `${admin.baseUrl}::${admin.directory}`;
		if (this.backendStatusKey === nextKey && this.backendStatusRun) return;

		this.stopBackendStatusBridge();
		this.backendStatusKey = nextKey;
		this.backendStatusAbort = new AbortController();
		this.backendStatusRun = this.runBackendStatusBridge(
			admin.baseUrl,
			admin.directory,
			this.backendStatusAbort.signal,
		).finally(() => {
			this.backendStatusRun = null;
			this.backendStatusAbort = null;
			this.backendStatusKey = null;
		});
	}

	private stopBackendStatusBridge(): void {
		this.backendStatusAbort?.abort();
		this.backendStatusAbort = null;
		this.backendStatusRun = null;
		this.backendStatusKey = null;
	}

	// ─── Server Health Monitor & Reconnect ──────────────────────────────

	private static readonly HEALTH_POLL_MS = 15_000;
	private static readonly HEALTH_RECONNECT_THRESHOLD = 3;

	private startHealthMonitor(): void {
		this.stopHealthMonitor();
		this.healthConsecutiveFailures = 0;
		this.healthMonitorTimer = setInterval(() => {
			void this.checkServerHealth();
		}, ChatProvider.HEALTH_POLL_MS);
	}

	private stopHealthMonitor(): void {
		if (this.healthMonitorTimer) {
			clearInterval(this.healthMonitorTimer);
			this.healthMonitorTimer = null;
		}
	}

	private async checkServerHealth(): Promise<void> {
		const admin = this.cli.getAdminInfo();
		if (!admin?.baseUrl) return;

		try {
			const res = await fetch(`${admin.baseUrl}/global/health`, {
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok) {
				this.healthConsecutiveFailures = 0;
				return;
			}
		} catch {
			// Network error or timeout
		}

		this.healthConsecutiveFailures++;
		if (this.healthConsecutiveFailures >= ChatProvider.HEALTH_RECONNECT_THRESHOLD) {
			logger.warn('[ChatProvider] Server health check failing', {
				failures: this.healthConsecutiveFailures,
			});
			// Do NOT auto-reconnect: killing the SSE stream mid-conversation is destructive.
			// The backend status bridge has its own reconnect logic with exponential backoff.
			// Health monitor only tracks status for diagnostics.
		}
	}

	private async runBackendStatusBridge(
		baseUrl: string,
		directory: string,
		signal: AbortSignal,
	): Promise<void> {
		const client = createOpencodeClient({ baseUrl, directory });
		const BASE_RETRY_MS = 250;
		const MAX_RETRY_MS = 30_000;
		let consecutiveFailures = 0;

		while (!signal.aborted) {
			// Child controller per iteration prevents abort-listener accumulation on the parent signal.
			// SDK internally calls signal.addEventListener('abort', ...) without cleanup on stream end,
			// so reusing the same signal across iterations leaks listeners indefinitely.
			const iterationController = new AbortController();
			const onParentAbort = () => iterationController.abort();
			signal.addEventListener('abort', onParentAbort);

			try {
				logger.info('[ChatProvider] SSE bridge: subscribing to global events...', { baseUrl });
				const subscription = await client.global.event({
					signal: iterationController.signal,
					onSseError: () => {
						// Webview owns connection chrome; this bridge is only for backend-owned session status.
					},
				});

				for await (const event of subscription.stream as AsyncGenerator<unknown>) {
					if (signal.aborted) break;
					consecutiveFailures = 0;
					this.forwardBackendStatusEvent(event);
				}
			} catch (error) {
				if (signal.aborted) break;
				consecutiveFailures++;
				logger.warn('[ChatProvider] Backend status bridge stream failed', {
					baseUrl,
					error,
					attempt: consecutiveFailures,
				});
			} finally {
				signal.removeEventListener('abort', onParentAbort);
				iterationController.abort();
			}

			if (signal.aborted) break;
			const backoff = Math.min(BASE_RETRY_MS * 2 ** (consecutiveFailures - 1), MAX_RETRY_MS);
			await new Promise(resolve => setTimeout(resolve, backoff));
		}
	}

	private forwardBackendStatusEvent(event: unknown): void {
		this.bridge.data('opencodeEvent', event);

		const payload =
			typeof event === 'object' &&
			event !== null &&
			'payload' in event &&
			typeof (event as { payload?: unknown }).payload === 'object'
				? ((event as { payload?: unknown }).payload as Record<string, unknown>)
				: (event as Record<string, unknown> | null);

		if (!payload || typeof payload.type !== 'string' || typeof payload.properties !== 'object') {
			return;
		}

		const properties = payload.properties as Record<string, unknown>;

		if (payload.type === 'session.idle') {
			const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
			if (!sessionId) return;
			return;
		}

		if (payload.type === 'session.status') {
			const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
			const rawStatus =
				typeof properties.status === 'object' && properties.status !== null
					? (properties.status as Record<string, unknown>)
					: null;
			const statusType = typeof rawStatus?.type === 'string' ? rawStatus.type : null;
			if (!sessionId || !rawStatus || !statusType) return;

			// Reconstruct the full SessionStatus from the raw event payload so
			// retry metadata (attempt, message, next) reaches the webview intact.
			return;
		}
	}

	private async sendInitialState(): Promise<void> {
		await this.settingsHandler.handleMessage({ type: 'getSettings' });
		this.bridge.data(
			'accessData',
			Object.entries(this.toolHandler.getAlwaysAllowByTool())
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		);
	}

	private async refreshLspStatus(): Promise<void> {
		try {
			const client = this.cli.getSdkClient();
			if (!client) {
				this.bridge.data('lspStatus', { items: [] });
				return;
			}

			const items = await this.services.openCodeClient.getLspStatus(client);
			this.bridge.data('lspStatus', { items });
		} catch (error) {
			logger.warn('[ChatProvider] Failed to refresh LSP status:', error);
			this.bridge.data('lspStatus', { items: [] });
		}
	}

	/** Notify webview of the current server URL so it can establish SSE health polling. */
	private sendServerInfo(forceRevisionBump = false): void {
		if (forceRevisionBump) {
			this.serverInfoRevision += 1;
		}
		const serverInfo = this.cli.getAdminInfo();
		const workspaceRoot = this.settings.getWorkspaceRoot() ?? '';
		if (serverInfo?.baseUrl) {
			this.bridge.data('serverInfo', {
				url: serverInfo.baseUrl,
				revision: this.serverInfoRevision,
				workspaceRoot,
			});
			return;
		}
		this.bridge.data('serverInfo', {
			url: '',
			revision: this.serverInfoRevision,
			workspaceRoot,
		});
	}

	public postMessage(msg: unknown): void {
		if (!this.view) {
			logger.error('[ChatProvider] postMessage called but view is not initialized!', {
				messageType: (msg as { type?: string })?.type,
			});
			return;
		}
		this.view.webview.postMessage(msg);
	}

	public reveal(): void {
		this.view?.show?.(true);
	}

	public openHistoryPanel(): void {
		this.openUiPanel('openHistory');
	}

	public openSettingsPanel(): void {
		this.openUiPanel('openSettings');
	}

	private openUiPanel(type: 'openHistory' | 'openSettings'): void {
		if (this.webviewDidLaunch) {
			this.bridge.data(type);
			return;
		}
		if (!this.deferredUiOpens.includes(type)) {
			this.deferredUiOpens.push(type);
		}
	}

	private flushDeferredUiOpens(): void {
		if (this.deferredUiOpens.length === 0) return;
		const pending = [...this.deferredUiOpens];
		this.deferredUiOpens.length = 0;
		for (const type of pending) {
			this.bridge.data(type);
		}
	}

	public async createSessionFromCommand(): Promise<void> {
		logger.info('[ChatProvider] User requested new chat');
		this.postMessage({ type: 'requestNewSession' });
	}

	dispose(): void {
		this.stopHealthMonitor();
		this.stopBackendStatusBridge();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
	}
}
