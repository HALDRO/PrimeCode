import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as vscode from 'vscode';
import { generateId, parseModelId } from '../common';
import type { QueuedMessageData, SendMessageAttachments, WebviewCommand } from '../common/protocol';
import { OpenCodeExecutor } from '../core/executor/OpenCode';
import { buildPromptParts } from '../core/promptParts';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { Settings } from '../core/Settings';
import { CommandRouter } from '../transport/CommandRouter';

import { OutboundBridge } from '../transport/OutboundBridge';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';
import { FileHandler } from './handlers/FileHandler';
import { McpHandler } from './handlers/McpHandler';
import { ProviderHandler } from './handlers/ProviderHandler';
import { SettingsHandler } from './handlers/SettingsHandler';
import { ToolHandler } from './handlers/ToolHandler';
import type { HandlerContext } from './handlers/types';
import { UtilityHandler } from './handlers/UtilityHandler';

/** Commands whose errors should not be surfaced as chat messages (file/UI ops). */
const SILENT_COMMANDS = new Set([
	'openFile',
	'openFileDiff',
	'openExternal',
	'getImageData',
	'stopRequest',
]);

const MAX_MESSAGE_QUEUE_SIZE = 4;

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
	private readonly backendBusySessions = new Set<string>();
	private readonly awaitingBackendBusy = new Set<string>();
	// This backend-owned queue layer is intentionally kept in the extension.
	// The webview-only approach looked simpler, but status/idle ordering across
	// the SDK stream, webview runtime, and VS Code bridge caused repeat races.
	// Keeping queue ownership next to the normalized backend lifecycle makes
	// dequeue happen from one authority instead of several competing consumers.
	private readonly pendingMessages = new Map<string, QueuedMessageData[]>();
	private readonly sendingLock = new Set<string>();
	private readonly pendingIdleDrain = new Set<string>();
	private readonly suppressNextIdleDrain = new Set<string>();
	private queueIdCounter = 0;

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
		const sdkClient = this.cli.getSdkClient();
		if (!sdkClient) return;

		try {
			await sdkClient.instance.dispose();
			this.cli.clearAgentsCache?.();
			this.cli.clearCommandsCache?.();
			this.cli.clearSkillsCache?.();
			this.cli.clearMcpCache?.();
		} catch (error) {
			logger.error('[ChatProvider] Failed to reload OpenCode runtime:', { source, error });
		}
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
					this.cli.clearCommandsCache?.();
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'command' });
					return;
				case 'skills':
					this.cli.clearSkillsCache?.();
					await this.settingsHandler.handleMessage({ type: 'getResources', kind: 'skill' });
					return;
				case 'subagents':
					this.cli.clearAgentsCache?.();
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
		const policies = this.toolHandler.getPermissionPolicies();

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
			['sendMessage', 'stopRequest', 'cancelQueuedMessage', 'forceQueuedMessage', 'reorderQueue'],
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
		void startedAt;
		void results;

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
		try {
			const handled = await this.router.dispatch(msg);
			if (!handled) {
				logger.warn(`[ChatProvider] Unhandled webview command: ${msg.type}`);
			}
		} catch (error) {
			logger.error(`[ChatProvider] Error handling message:`, error);

			// Don't surface file/UI operation errors as chat messages — they are not actionable for the user
			if (SILENT_COMMANDS.has(msg.type)) return;

			this.bridge.showNotification({
				notification: {
					id: `error-${Date.now()}`,
					type: 'error',
					content: error instanceof Error ? error.message : 'Unknown error',
					timestamp: new Date().toISOString(),
				},
			});
		}
	}

	private async handleSessionCommand(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'sendMessage':
				await this.handleSendMessageCommand(msg);
				return;
			case 'stopRequest':
				await this.abortSession(msg.sessionId);
				this.forceIdleWithoutDrain(msg.sessionId, 'local.stop');
				return;
			case 'cancelQueuedMessage':
				this.cancelQueuedMessage(msg.sessionId, msg.queueId);
				return;
			case 'forceQueuedMessage':
				await this.forceQueuedMessage(msg.sessionId, msg.queueId);
				return;
			case 'reorderQueue':
				this.reorderQueue(msg.sessionId, msg.queueIds);
				return;
		}
	}

	private updateQueue(
		sessionId: string,
		mutator: (queue: QueuedMessageData[]) => QueuedMessageData[],
	): QueuedMessageData[] {
		const current = this.pendingMessages.get(sessionId) ?? [];
		const next = mutator([...current]);
		if (next.length === 0) this.pendingMessages.delete(sessionId);
		else this.pendingMessages.set(sessionId, next);
		return next;
	}

	private isBackendSessionBusy(sessionId: string): boolean {
		return this.backendBusySessions.has(sessionId) || this.sendingLock.has(sessionId);
	}

	private enqueueMessage(params: BackendSendParams): void {
		const queue = this.pendingMessages.get(params.sessionId) ?? [];
		if (queue.length >= MAX_MESSAGE_QUEUE_SIZE) {
			this.bridge.showNotification({
				notification: {
					type: 'system_notice',
					content: 'Message queue is full. Wait for the current response to finish.',
					timestamp: new Date().toISOString(),
				},
			});
			return;
		}

		const entry: QueuedMessageData = {
			queueId: `q-${Date.now()}-${++this.queueIdCounter}`,
			messageId: params.messageID,
			sessionId: params.sessionId,
			text: params.text,
			model: params.model,
			agent: params.agent,
			variant: params.variant,
			attachments: params.attachments,
			queuedAt: Date.now(),
		};
		queue.push(entry);
		this.pendingMessages.set(params.sessionId, queue);
		this.bridge.queueUpdate('enqueued', params.sessionId, [...queue]);
	}

	private async handleSendMessageCommand(
		msg: Extract<WebviewCommand, { type: 'sendMessage' }>,
	): Promise<void> {
		if (!msg.sessionId) return;
		if (this.isBackendSessionBusy(msg.sessionId)) {
			this.enqueueMessage({
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

		await this.sendPromptAsync({
			sessionId: msg.sessionId,
			text: msg.text,
			messageID: msg.messageID,
			model: msg.model,
			agent: msg.agent,
			variant: msg.variant,
			attachments: msg.attachments,
		});
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

		this.sendingLock.add(params.sessionId);
		this.suppressNextIdleDrain.delete(params.sessionId);
		this.awaitingBackendBusy.add(params.sessionId);
		this.sendBackendRuntimeStatus(params.sessionId, 'busy', 'local.compact');
		try {
			const result = await compactionClient.session.summarize({
				sessionID: params.sessionId,
				directory: admin.directory,
				providerID: parsedModel.providerId,
				modelID: parsedModel.modelId,
				auto: false,
			});
			if (result?.error) {
				throw new Error(`Compaction failed: ${JSON.stringify(result.error)}`);
			}
		} catch (error) {
			this.awaitingBackendBusy.delete(params.sessionId);
			this.sendBackendRuntimeStatus(params.sessionId, 'idle', 'local.error');
			throw error;
		} finally {
			this.sendingLock.delete(params.sessionId);
			if (this.pendingIdleDrain.delete(params.sessionId)) {
				void this.processQueueOnIdle(params.sessionId);
			}
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

		this.sendingLock.add(params.sessionId);
		this.suppressNextIdleDrain.delete(params.sessionId);
		this.awaitingBackendBusy.add(params.sessionId);
		this.sendBackendRuntimeStatus(params.sessionId, 'busy', 'local.send');
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
				throw new Error(`Message send failed: ${JSON.stringify(result.error)}`);
			}
		} catch (error) {
			this.awaitingBackendBusy.delete(params.sessionId);
			this.sendBackendRuntimeStatus(params.sessionId, 'idle', 'local.error');
			throw error;
		} finally {
			this.sendingLock.delete(params.sessionId);
			if (this.pendingIdleDrain.delete(params.sessionId)) {
				void this.processQueueOnIdle(params.sessionId);
			}
		}
	}

	private sendBackendRuntimeStatus(sessionId: string, status: string, reason: string): void {
		this.bridge.data('backendRuntimeStatus', {
			sessionId,
			status,
			reason,
			timestamp: new Date().toISOString(),
		});
	}

	private buildRequestParts(params: BackendSendParams): Record<string, unknown>[] {
		return buildPromptParts({
			text: params.text,
			attachments: params.attachments,
		}) as Record<string, unknown>[];
	}

	private cancelQueuedMessage(sessionId: string, queueId: string): void {
		let removed: QueuedMessageData | undefined;
		const queue = this.updateQueue(sessionId, items => {
			const index = items.findIndex(item => item.queueId === queueId);
			if (index >= 0) removed = items.splice(index, 1)[0];
			return items;
		});
		if (!removed) return;
		this.bridge.queueUpdate(
			'cancelled',
			sessionId,
			[...queue],
			removed.text,
			removed.attachments?.images ? { images: removed.attachments.images } : undefined,
			removed.agent,
		);
	}

	private reorderQueue(sessionId: string, queueIds: string[]): void {
		const queue = this.pendingMessages.get(sessionId);
		if (!queue || queue.length < 2) return;
		const byId = new Map(queue.map(item => [item.queueId, item]));
		const reordered = queueIds
			.map(id => byId.get(id))
			.filter((item): item is QueuedMessageData => Boolean(item));
		for (const item of queue) {
			if (!queueIds.includes(item.queueId)) reordered.push(item);
		}
		this.updateQueue(sessionId, () => reordered);
		this.bridge.queueUpdate('enqueued', sessionId, [...reordered]);
	}

	private async forceQueuedMessage(sessionId: string, queueId: string): Promise<void> {
		let entry: QueuedMessageData | undefined;
		const queue = this.updateQueue(sessionId, items => {
			const index = items.findIndex(item => item.queueId === queueId);
			if (index >= 0) entry = items.splice(index, 1)[0];
			return items;
		});
		if (!entry) return;
		if (this.backendBusySessions.has(sessionId)) {
			this.suppressNextIdleDrain.add(sessionId);
			await this.abortSession(sessionId);
			this.forceIdleWithoutDrain(sessionId, 'local.force');
		}
		this.bridge.queueUpdate('dequeued', sessionId, [...queue]);
		await this.sendPromptAsync(entry);
	}

	private async processQueueOnIdle(sessionId: string): Promise<void> {
		if (this.sendingLock.has(sessionId)) {
			this.pendingIdleDrain.add(sessionId);
			return;
		}
		let entry: QueuedMessageData | undefined;
		const remaining = this.updateQueue(sessionId, queue => {
			entry = queue.shift();
			return queue;
		});
		if (!entry) return;
		this.bridge.queueUpdate('dequeued', sessionId, [...remaining]);
		try {
			await this.sendPromptAsync(entry);
		} catch (error) {
			logger.error('[ChatProvider] Failed to send queued message', error);
			this.bridge.queueUpdate(
				'cancelled',
				sessionId,
				[...remaining],
				entry.text,
				entry.attachments?.images ? { images: entry.attachments.images } : undefined,
				entry.agent,
			);
		}
	}

	private async abortSession(sessionId: string): Promise<void> {
		const client = this.cli.getSdkClient();
		const admin = this.cli.getAdminInfo();
		if (!client || !admin?.directory) return;
		await client.session
			.abort({ sessionID: sessionId, directory: admin.directory })
			.catch(error => {
				logger.debug('[ChatProvider] Abort request ignored', { sessionId, error });
			});
	}

	private forceIdleWithoutDrain(sessionId: string, reason: string): void {
		this.awaitingBackendBusy.delete(sessionId);
		this.backendBusySessions.delete(sessionId);
		this.pendingIdleDrain.delete(sessionId);
		this.suppressNextIdleDrain.delete(sessionId);
		this.sendBackendRuntimeStatus(sessionId, 'idle', reason);
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
		this.backendBusySessions.clear();
		this.awaitingBackendBusy.clear();
		this.pendingIdleDrain.clear();
		this.suppressNextIdleDrain.clear();
	}

	private forwardNormalizedBackendStatus(
		sessionId: string,
		status: string,
		reason: 'session.idle' | 'session.status',
	): void {
		if (status === 'idle') {
			if (this.awaitingBackendBusy.has(sessionId)) return;
			if (!this.backendBusySessions.has(sessionId)) return;
			this.backendBusySessions.delete(sessionId);
			const shouldDrain = !this.suppressNextIdleDrain.delete(sessionId);
			this.sendBackendRuntimeStatus(sessionId, 'idle', reason);
			if (shouldDrain) {
				void this.processQueueOnIdle(sessionId);
			}
			return;
		}

		if (status === 'busy' || status === 'retry') {
			this.awaitingBackendBusy.delete(sessionId);
			this.backendBusySessions.add(sessionId);
		}

		this.sendBackendRuntimeStatus(sessionId, status, reason);
	}

	private async runBackendStatusBridge(
		baseUrl: string,
		directory: string,
		signal: AbortSignal,
	): Promise<void> {
		const client = createOpencodeClient({ baseUrl, directory });

		while (!signal.aborted) {
			try {
				const subscription = await client.event.subscribe(
					{ directory },
					{
						signal,
						onSseError: () => {
							// Webview owns connection chrome; this bridge is only for backend-owned session status.
						},
					},
				);

				for await (const event of subscription.stream as AsyncGenerator<unknown>) {
					if (signal.aborted) break;
					this.forwardBackendStatusEvent(event);
				}
			} catch (error) {
				if (signal.aborted) break;
				logger.warn('[ChatProvider] Backend status bridge stream failed', {
					baseUrl,
					error,
				});
				await new Promise(resolve => setTimeout(resolve, 250));
			}
		}
	}

	private forwardBackendStatusEvent(event: unknown): void {
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

		if (payload.type === 'session.idle') {
			const properties = payload.properties as Record<string, unknown>;
			const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
			if (!sessionId) return;
			this.forwardNormalizedBackendStatus(sessionId, 'idle', 'session.idle');
			return;
		}

		if (payload.type === 'session.status') {
			const properties = payload.properties as Record<string, unknown>;
			const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : null;
			const status =
				typeof properties.status === 'object' && properties.status !== null
					? (properties.status as Record<string, unknown>)
					: null;
			const statusType = typeof status?.type === 'string' ? status.type : null;
			if (!sessionId || !statusType) return;
			this.forwardNormalizedBackendStatus(sessionId, statusType, 'session.status');
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
		this.postMessage({ type: 'requestNewSession' });
	}

	dispose(): void {
		this.stopBackendStatusBridge();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
	}
}
