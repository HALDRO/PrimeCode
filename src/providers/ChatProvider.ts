import * as vscode from 'vscode';
import { mapPermissionRuntimePayloadToRequest } from '../common';
import { PERMISSION_CATEGORIES, type PermissionCategory } from '../common/permissions';
import type { WebviewCommand } from '../common/protocol';
import { resolveToolName } from '../common/toolRegistry';
import { OpenCodeExecutor } from '../core/executor/OpenCode';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { SessionGraph, SessionManager, SessionState } from '../core/SessionManager';
import { Settings } from '../core/Settings';
import { CommandRouter } from '../transport/CommandRouter';

import { OutboundBridge } from '../transport/OutboundBridge';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';
import { FileHandler } from './handlers/FileHandler';
import { McpHandler } from './handlers/McpHandler';
import { ProviderHandler } from './handlers/ProviderHandler';
import { RestoreHandler } from './handlers/RestoreHandler';
import { SessionHandler } from './handlers/SessionHandler';
import { SettingsHandler } from './handlers/SettingsHandler';
import { SseHandler } from './handlers/SseHandler';
import { ToolHandler } from './handlers/ToolHandler';
import type { HandlerContext } from './handlers/types';
import { UtilityHandler } from './handlers/UtilityHandler';

/** Commands whose errors should not be surfaced as chat messages (file/UI ops). */
const SILENT_COMMANDS = new Set(['openFile', 'openFileDiff', 'openExternal', 'getImageData']);

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private webviewDidLaunch = false;
	private readonly deferredUiOpens: Array<'openHistory' | 'openSettings'> = [];
	private cli: OpenCodeExecutor;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];
	private sessionGraph = new SessionGraph();
	private sessionManager = new SessionManager();

	/** Monotonic revision for server rendezvous updates sent to the webview. */
	private serverInfoRevision = 0;

	// Handlers
	private sessionHandler: SessionHandler;
	private settingsHandler: SettingsHandler;
	private mcpHandler: McpHandler;
	private providerHandler: ProviderHandler;
	private toolHandler: ToolHandler;
	private fileHandler: FileHandler;
	private sseHandler: SseHandler;
	private restoreHandler: RestoreHandler;
	private utilityHandler: UtilityHandler;

	/** Guards against duplicate syncAll calls during startup. */
	private hasSynced = false;
	private readonly bridge = new OutboundBridge();
	private readonly router = new CommandRouter();

	constructor(
		private context: vscode.ExtensionContext,
		private services: ServiceRegistry,
	) {
		this.settings = new Settings();
		this.sessionState = new SessionState();
		this.cli = new OpenCodeExecutor();
		// Wire up bridge for direct SDK event forwarding to webview
		this.cli.setBridge(this.bridge);

		// Initialize Handlers — single shared context
		const baseContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			bridge: this.bridge,
			sessionState: this.sessionState,
			sessionManager: this.sessionManager,
			services: this.services,
			sessionGraph: this.sessionGraph,
		};
		this.restoreHandler = new RestoreHandler(baseContext);

		const handlerContext: HandlerContext = {
			...baseContext,
			// Lazy getter — ToolHandler is created below but the closure captures `this`
			getPermissionPolicies: () => this.toolHandler.getPermissionPolicies(),
			getSessionAutoAccept: (sessionId: string) => this.toolHandler.isAutoAccept(sessionId),
			getSessionAutoAcceptState: (sessionId: string) =>
				this.toolHandler.getSessionAutoAcceptState(sessionId),
			clearSessionAutoAccept: (sessionId: string) =>
				this.toolHandler.clearSessionAutoAccept(sessionId),
			refreshAfterServerRestart: async () => {
				this.sendServerInfo(true);
				this.hasSynced = false;
				await this.syncAllOrDefer('manual-server-restart');
			},
		};

		this.sessionHandler = new SessionHandler(handlerContext);
		this.settingsHandler = new SettingsHandler(handlerContext);
		this.mcpHandler = new McpHandler(handlerContext);
		this.providerHandler = new ProviderHandler(handlerContext);
		this.toolHandler = new ToolHandler(handlerContext);
		this.fileHandler = new FileHandler(handlerContext);
		this.sseHandler = new SseHandler(handlerContext);
		this.utilityHandler = new UtilityHandler(handlerContext);

		// Build declarative command router
		this.buildRouter();

		// Register permission interceptor for auto-approve logic
		// This runs in the executor BEFORE SDK events are forwarded to the webview.
		this.cli.setPermissionInterceptor((sessionId, props) => {
			const request = mapPermissionRuntimePayloadToRequest(props, sessionId);
			if (!request) return false;

			let rootSessionId = sessionId;
			while (this.sessionGraph.getParent(rootSessionId)) {
				rootSessionId = this.sessionGraph.getParent(rootSessionId) ?? rootSessionId;
			}

			const autoRespond = (approved: boolean, alwaysAllow?: boolean) => {
				void this.cli
					.respondToPermission({ requestId: request.id, approved, alwaysAllow })
					.catch(error => logger.error('[ChatProvider] permission auto-response failed:', error));
			};

			const isAutoApprove = Boolean(this.settings.get('access.autoApprove'));
			const isAutoAccept = this.toolHandler.isAutoAccept(rootSessionId);
			if (isAutoApprove || isAutoAccept) {
				autoRespond(true);
				return true;
			}

			const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();
			const normalizedTool =
				resolveToolName(request.permission) ?? request.permission.toLowerCase();
			if (alwaysAllowByTool[normalizedTool]) {
				autoRespond(true, true);
				return true;
			}

			const policies = this.toolHandler.getPermissionPolicies();
			const policyCategory = PERMISSION_CATEGORIES.includes(
				request.permission as PermissionCategory,
			)
				? (request.permission as PermissionCategory)
				: undefined;
			const policyValue = policyCategory ? policies[policyCategory] : undefined;
			if (policyValue === 'allow' || policyValue === 'deny') {
				autoRespond(policyValue === 'allow');
				return true;
			}

			return false; // Not auto-approved — forward to webview
		});

		// Single-point OpenCode initialization with retry polling
		this.scheduleOpenCodeInit();

		// Forward CLI events to webview
		// NOTE: Legacy pipeline removed. SDK events now flow directly via bridge.sendSdkEvent().

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

		// Wire up McpConfigWatcher config change events
		this.disposables.push(
			this.services.mcpConfigWatcher.onConfigChanged(async e => {
				this.bridge.data('mcpConfigReloaded', { source: e.source, timestamp: e.timestamp });
				await this.settingsHandler.handleMessage({ type: 'getSettings' });
			}),
		);

		// Wire up ResourceWatcher — auto-refresh UI when .opencode/ resource files change
		this.disposables.push(
			this.services.resourceWatcher.onResourceChanged(async e => {
				logger.info(`[ChatProvider] Resource changed: ${e.resourceType}, refreshing UI`);
				try {
					if (e.resourceType === 'rules') {
						await this.settingsHandler.handleMessage({ type: 'getRules' });
						return;
					}
					// For skills: invalidate CLI cache and re-fetch via handler (uses CLI API)
					if (e.resourceType === 'skills') {
						this.cli.clearSkillsCache?.();
						await this.settingsHandler.handleMessage({ type: 'getSkills' });
						return;
					}
					// For commands: invalidate CLI cache and re-fetch via handler
					// (CLI GET /command includes builtins + .opencode/commands/ + MCP prompts)
					if (e.resourceType === 'commands') {
						this.cli.clearCommandsCache?.();
						await this.settingsHandler.handleMessage({ type: 'getCommands' });
						return;
					}
					// For subagents (.opencode/agents/): invalidate agents CLI cache
					// and re-fetch both agents (CLI API) and subagents (local files)
					if (e.resourceType === 'subagents') {
						this.cli.clearAgentsCache?.();
						await Promise.all([
							this.settingsHandler.handleMessage({ type: 'getSubagents' }),
							this.settingsHandler.handleMessage({ type: 'getAgents' }),
						]);
						return;
					}
				} catch (error) {
					logger.error(`[ChatProvider] Failed to refresh ${e.resourceType}:`, error);
				}
			}),
		);

		// Keep services in sync when workspace folders change at runtime
		this.disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceRoot) {
					logger.info('[ChatProvider] Workspace folder changed, updating services');
					this.services.setWorkspaceRoot(workspaceRoot);
				}
			}),
		);
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
			logger.info('[ChatProvider] OpenCode autoStart is disabled');
			return;
		}

		// Try immediately
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) {
			void this.doStartOpenCode(root);
			return;
		}

		// Workspace not ready yet — wait for the event instead of polling
		logger.info('[ChatProvider] Workspace root not available, waiting for event...');
		const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (workspaceRoot) {
				disposable.dispose();
				logger.info('[ChatProvider] Workspace root appeared via event, starting OpenCode');
				void this.doStartOpenCode(workspaceRoot);
			}
		});
		this.disposables.push(disposable);
	}

	private async doStartOpenCode(workspaceRoot: string): Promise<void> {
		// Update services that depend on workspace root
		this.services.setWorkspaceRoot(workspaceRoot);

		// Skip if server is already running
		const serverInfo = this.cli.getOpenCodeServerInfo();
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
			logger.info('[ChatProvider] Starting OpenCode server...');
			await this.cli.start(config);
			logger.info('[ChatProvider] OpenCode server started successfully');

			// Notify webview of server URL so it can establish SSE health polling
			this.sendServerInfo(true);

			// If webviewDidLaunch arrived before the server was ready, run deferred
			// session restoration NOW — before syncAll, which can take 10-15s.
			// Tab restoration only needs the CLI server, not providers/MCP/models.
			await this.sessionHandler.onServerReady();

			// Hydrate all UI-visible state after server connection (providers, proxy models, MCP, etc.)
			await this.syncAllOrDefer('opencode-start');
		} catch (error) {
			logger.warn('[ChatProvider] Failed to start OpenCode:', error);
			this.bridge.data('showNotification', {
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

		// Session
		r.register(
			this.sessionHandler,
			[
				'createSession',
				'switchSession',
				'closeSession',
				'sendMessage',
				'stopRequest',
				'cancelQueuedMessage',
				'forceQueuedMessage',
				'reorderQueue',
				'improvePromptRequest',
				'cancelImprovePrompt',
				'getConversationList',
				'loadConversation',
				'deleteConversation',
				'clearAllConversations',
				'renameConversation',
			],
			'session',
		);

		// Settings
		r.register(
			this.settingsHandler,
			[
				'getSettings',
				'updateSettings',
				'getCommands',
				'getSkills',
				'getSubagents',
				'getAgents',
				'getPlugins',
				'getRules',
				// Resource CRUD
				'createCommand',
				'deleteCommand',
				'createSkill',
				'deleteSkill',
				'createSubagent',
				'deleteSubagent',
				'addPlugin',
				'removePlugin',
				'toggleRule',
				'createRule',
				'deleteRule',
			],
			'settings',
		);

		// MCP
		r.register(
			this.mcpHandler,
			['loadMCPServers', 'saveMCPServer', 'deleteMCPServer', 'openMcpConfig'],
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
				'accessResponse',
				'questionResponse',
				'questionReject',
				'getPermissions',
				'setPermissions',
				'setAutoAccept',
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

		// SSE
		r.register(this.sseHandler, ['sseSubscribe', 'sseClose'], 'sse');

		// Restore
		r.register(this.restoreHandler, ['restoreMessage', 'unrevert'], 'restore');

		// Orchestration
		r.register(
			{
				handleMessage: async (msg: WebviewCommand) => {
					if (msg.type === 'webviewDidLaunch') {
						this.webviewDidLaunch = true;
						await this.sendInitialState();
						this.flushDeferredUiOpens();
						await this.syncAllOrDefer('webview-launch');
						await this.sessionHandler.handleMessage(msg);
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
			logger.info('[ChatProvider] syncAll deferred: webview not ready', { source });
			return;
		}
		// If the server isn't ready yet, defer — provider/model fetches would return
		// empty data, leaving the UI with only the hardcoded OpenAI Compatible entry.
		const serverReady = !!this.cli.getOpenCodeServerInfo()?.baseUrl;
		if (!serverReady) {
			logger.info('[ChatProvider] syncAll deferred: server not ready', { source });
			return;
		}
		// Prevent duplicate syncAll during startup (opencode-start vs webview-syncAll race).
		// Explicit webview requests ('webview-syncAll') bypass the guard so the user
		// can recover from partial failures without reloading the panel.
		if (this.hasSynced && source !== 'webview-syncAll') {
			logger.debug('[ChatProvider] syncAll skipped: already synced', { source });
			return;
		}
		this.hasSynced = true;
		logger.info('[ChatProvider] syncAll started', { source });
		await this.syncAll();
		logger.info('[ChatProvider] syncAll finished', { source });
	}

	private async syncAll(): Promise<void> {
		// Pull everything the UI can display. This keeps startup and reconnect logic simple.
		const startedAt = Date.now();

		// Send server URL first so webview can establish SSE health polling immediately
		this.sendServerInfo();

		const requests: Promise<unknown>[] = [
			this.settingsHandler.handleMessage({ type: 'getSettings' }),
			this.toolHandler.handleMessage({ type: 'getPermissions' }),
			this.toolHandler.handleMessage({ type: 'getAccess' }),
			this.settingsHandler.handleMessage({ type: 'getCommands' }),
			this.settingsHandler.handleMessage({ type: 'getSkills' }),
			this.settingsHandler.handleMessage({ type: 'getSubagents' }),
			this.settingsHandler.handleMessage({ type: 'getAgents' }),
			this.mcpHandler.handleMessage({ type: 'loadMCPServers' }),
			this.providerHandler.handleMessage({ type: 'reloadAllProviders' }),
			this.toolHandler.handleMessage({ type: 'checkDiscoveryStatus' }),
			this.settingsHandler.handleMessage({ type: 'getRules' }),
			this.refreshLspStatus(),
		];

		const results = await Promise.allSettled(requests);
		const rejected = results.filter(r => r.status === 'rejected').length;
		logger.info('[ChatProvider] syncAll requests complete', {
			total: results.length,
			rejected,
			durationMs: Date.now() - startedAt,
		});

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
			const results = await Promise.allSettled(endpointRequests);
			const rejected = results.filter(r => r.status === 'rejected').length;
			logger.info('[ChatProvider] Custom endpoint model fetch complete', {
				total: results.length,
				rejected,
			});
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		logger.info('[ChatProvider] resolveWebviewView called - webview is now initialized');
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
			logger.info('[ChatProvider] webview disposed — nulling bridge view');
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

			const errorSessionId = this.sessionState.activeSessionId;
			if (errorSessionId) {
				this.bridge.data('showNotification', {
					notification: {
						id: `error-${Date.now()}`,
						type: 'error',
						content: error instanceof Error ? error.message : 'Unknown error',
						timestamp: new Date().toISOString(),
					},
				});
				this.bridge.emit(errorSessionId, 'status', {
					status: 'error',
					statusText: 'Error',
				});
			} else {
				logger.warn(
					'[ChatProvider] Error in handleWebviewMessage but no active session to report to',
					{
						error: error instanceof Error ? error.message : 'Unknown error',
					},
				);
			}
		}
	}

	// ─── Legacy handleCliEvent + relay methods removed ──────────────────────
	// SDK events now flow directly: executor → bridge.sendSdkEvent() → webview.
	// Permission auto-approve is handled by the permission interceptor in the executor.

	private handleSettingsChange(): void {
		this.settings.refresh();
		void this.settingsHandler.handleMessage({ type: 'getSettings' });
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
		const serverInfo = this.cli.getOpenCodeServerInfo();
		if (serverInfo?.baseUrl) {
			this.bridge.data('serverInfo', {
				url: serverInfo.baseUrl,
				revision: this.serverInfoRevision,
			});
			return;
		}
		this.bridge.data('serverInfo', { url: '', revision: this.serverInfoRevision });
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
		await this.sessionHandler.handleMessage({ type: 'createSession' });
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
