import * as vscode from 'vscode';
import {
	mapPermissionRuntimePayloadToRequest,
	mapQuestionRuntimePayloadToRequest,
} from '../common';
import { PERMISSION_CATEGORIES, type PermissionCategory } from '../common/permissions';
import type { WebviewCommand } from '../common/protocol';
import {
	computeDiffLineStats,
	extractPatchFilePaths,
	isFileEditTool,
	isTaskTool,
	resolveToolName,
} from '../common/toolRegistry';
import { extractFilePath } from '../core/eventToMessage';
import { OpenCodeExecutor } from '../core/executor/OpenCode';
import type { CLIEvent } from '../core/executor/types';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { SessionGraph, SessionState } from '../core/SessionManager';
import { Settings } from '../core/Settings';
import { SubtaskManager } from '../core/SubtaskManager';
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

/**
 * Short tool activity labels shown during execution.
 * Maps canonical lowercase tool names to concise status text.
 */
const TOOL_ACTIVITY_LABELS: ReadonlyMap<string, string> = new Map([
	['write', 'Writing'],
	['edit', 'Editing'],
	['multiedit', 'Editing'],
	['patch', 'Patching'],
	['apply_patch', 'Patching'],
	['read', 'Reading'],
	['bash', 'Running'],
	['grep', 'Searching'],
	['glob', 'Searching'],
	['codesearch', 'Searching'],
	['list', 'Listing'],
	['task', 'Delegating'],
	['lsp', 'Analyzing'],
	['websearch', 'Searching'],
	['webfetch', 'Fetching'],
	['todowrite', 'Planning'],
	['todoread', 'Planning'],
	['skill', 'Loading'],
	['batch', 'Running'],
]);

function getToolActivityLabel(canonicalName: string): string {
	return TOOL_ACTIVITY_LABELS.get(canonicalName) ?? 'Working';
}

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private cli: OpenCodeExecutor;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];
	private sessionGraph = new SessionGraph();

	// Session / subtask tracking (delegated to SubtaskManager)
	private readonly subtaskManager: SubtaskManager;
	private readonly activeThinkingPartIds = new Map<string, { partId: string; startTime: number }>();
	private readonly activeAssistantPartIds = new Map<string, string>();
	/** Per-session tool call counter — reset on 'finished' for turn summary log. */
	private readonly turnToolCounts = new Map<string, number>();
	/** Monotonic revision for server rendezvous updates sent to the webview. */
	private serverInfoRevision = 0;
	/** Buffered child messages waiting for parent routing to become available. */
	private readonly pendingChildMessages = new Map<
		string,
		import('../common').SessionMessageData[]
	>();

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

	private pendingSyncAll = false;
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
		this.subtaskManager = new SubtaskManager(this.sessionGraph);

		// Initialize Handlers — single shared context
		// RestoreHandler is created first so registerCheckpoint can be wired into the context
		const baseContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			bridge: this.bridge,
			sessionState: this.sessionState,
			services: this.services,
			sessionGraph: this.sessionGraph,
		};
		this.restoreHandler = new RestoreHandler(baseContext);

		const handlerContext: HandlerContext = {
			...baseContext,
			// Lazy getter — ToolHandler is created below but the closure captures `this`
			getPermissionPolicies: () => this.toolHandler.getPermissionPolicies(),
			getSessionAutoAccept: (sessionId: string) => this.toolHandler.isAutoAccept(sessionId),
			clearSessionAutoAccept: (sessionId: string) =>
				this.toolHandler.clearSessionAutoAccept(sessionId),
			registerCheckpoint: (commitId, record) =>
				this.restoreHandler.registerCheckpoint(commitId, record),
			cleanupSessionRestore: sessionId => this.restoreHandler.cleanupSession(sessionId),
			cleanupPendingChildMessages: sessionId => this.cleanupPendingChildMessages(sessionId),
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

		// Single-point OpenCode initialization with retry polling
		this.scheduleOpenCodeInit();

		// Forward CLI events to webview
		this.cli.on('event', event => this.handleCliEvent(event));

		// Handle server reconnection — re-sync all UI state
		this.cli.on('event', event => {
			if (event.type === 'server_reconnected') {
				logger.info('[ChatProvider] Server reconnected, re-syncing UI...');
				this.sendServerInfo(true);
				this.hasSynced = false;
				void this.syncAllOrDefer('server-reconnected');
			}
		});

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
			autoApprove: Boolean(
				this.settings.get('access.autoApprove') || this.settings.get('access.yoloMode') || false,
			),
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

			// Start background health monitor for auto-reconnect
			this.cli.startHealthMonitor();

			// If webviewDidLaunch arrived before the server was ready, run deferred
			// session restoration NOW — before syncAll, which can take 10-15s.
			// Tab restoration only needs the CLI server, not providers/MCP/models.
			await this.sessionHandler.onServerReady();

			// Hydrate all UI-visible state after server connection (providers, proxy models, MCP, etc.)
			await this.syncAllOrDefer('opencode-start');
		} catch (error) {
			logger.warn('[ChatProvider] Failed to start OpenCode:', error);
			this.sessionHandler.postSessionMessage({
				id: `system_notice-${Date.now()}`,
				type: 'system_notice',
				content:
					'Failed to start OpenCode server. Models/providers may be unavailable until it is running. See extension logs for details.',
				timestamp: new Date().toISOString(),
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
				'webviewDidLaunch',
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
			['openFile', 'openFileDiff', 'openExternal', 'getImageData', 'browseFiles'],
			'file',
		);

		// SSE
		r.register(this.sseHandler, ['sseSubscribe', 'sseClose'], 'sse');

		// Restore
		r.register(this.restoreHandler, ['restoreCommit', 'unrevert'], 'restore');

		// Orchestration
		r.register(
			{
				handleMessage: async () => {
					await this.syncAllOrDefer('webview-syncAll');
				},
			},
			['syncAll'],
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
			this.pendingSyncAll = true;
			return;
		}
		// If the server isn't ready yet, defer — provider/model fetches would return
		// empty data, leaving the UI with only the hardcoded OpenAI Compatible entry.
		const serverReady = !!this.cli.getOpenCodeServerInfo()?.baseUrl;
		if (!serverReady) {
			logger.info('[ChatProvider] syncAll deferred: server not ready', { source });
			this.pendingSyncAll = true;
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
		this.pendingSyncAll = false;
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
			this.bridge.clearView();
		});

		// Reset sync flag so full state is re-sent when webview is re-created
		this.hasSynced = false;

		this.sendInitialState();
		this.bridge.data('accessData', []);

		// Sync when webview is (re-)created, but ONLY if the server is actually ready.
		// If the server hasn't started yet, doStartOpenCode will call syncAllOrDefer
		// once it's up — and at that point this.view will exist, so it will proceed.
		const serverReady = !!this.cli.getOpenCodeServerInfo()?.baseUrl;
		if (this.pendingSyncAll || serverReady) {
			void this.syncAllOrDefer(
				this.pendingSyncAll ? 'deferred-after-view-ready' : 'webview-recreated',
			);
		}
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
				this.sessionHandler.postSessionMessage(
					{
						id: `error-${Date.now()}`,
						type: 'error',
						content: error instanceof Error ? error.message : 'Unknown error',
						isError: true,
						timestamp: new Date().toISOString(),
					},
					errorSessionId,
				);
				this.sessionHandler.postStatus(errorSessionId, 'error', 'Error');
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

	private handleCliEvent(event: CLIEvent): void {
		const now = Date.now();
		// Only trace high-volume events; skip normalized_log entirely
		if (event.type === 'normalized_log') {
			// no-op: normalized_log is handled silently
		} else if (event.type !== 'thinking' && event.type !== 'message') {
			const e = event.data as Record<string, unknown> | undefined;
			logger.trace(`[ChatProvider] handleCliEvent: ${event.type}`, {
				sessionId: event.sessionId,
				id: e?.id ?? e?.tool_use_id,
				name: e?.name,
				state: e?.state,
			});
		}

		if (event.type === 'session_updated') {
			const updatedSessionId = event.sessionId;
			if (updatedSessionId) {
				this.flushPendingChildMessages(updatedSessionId);
			}

			if (updatedSessionId && this.sessionGraph.isChild(updatedSessionId)) {
				const record = event.data as Record<string, unknown> | undefined;
				const status = record?.status as
					| { type?: string; attempt?: number; message?: string; next?: number }
					| undefined;
				if (status?.type === 'retry') {
					this.updateSubtaskLifecycle(updatedSessionId, {
						status: 'running',
						retryInfo: {
							attempt: typeof status.attempt === 'number' ? status.attempt : 1,
							message: typeof status.message === 'string' ? status.message : 'Retrying…',
							nextRetryAt:
								typeof status.next === 'number' ? new Date(status.next).toISOString() : undefined,
						},
						timestamp: new Date().toISOString(),
					});
				} else if (status?.type === 'busy') {
					this.updateSubtaskLifecycle(updatedSessionId, {
						status: 'running',
						retryInfo: undefined,
						timestamp: new Date().toISOString(),
					});
				} else if (status?.type === 'idle') {
					this.updateSubtaskLifecycle(updatedSessionId, {
						retryInfo: undefined,
						timestamp: new Date().toISOString(),
					});
				}

				// Propagate cumulative totalStats from child session_updated onto the parent subtask card
				const totalStats = record?.totalStats as
					| {
							contextTokens?: number;
							outputTokens?: number;
							totalTokens?: number;
							cacheReadTokens?: number;
					  }
					| undefined;
				if (totalStats && (totalStats.totalTokens ?? 0) > 0) {
					const routing = this.subtaskManager.resolveRouting(updatedSessionId);
					if (routing) {
						this.sessionHandler.postSessionMessage(
							{
								id: routing.toolUseId,
								type: 'subtask' as const,
								childTokens: {
									input: totalStats.contextTokens ?? 0,
									output: totalStats.outputTokens ?? 0,
									total: totalStats.totalTokens ?? 0,
									cacheRead: totalStats.cacheReadTokens,
								},
								timestamp: new Date().toISOString(),
							} satisfies import('../common').SessionMessageUpdate,
							routing.parentSessionId,
						);
					}
				}

				// Propagate modelID from child session_updated onto the parent subtask message
				const modelID = record && typeof record.modelID === 'string' ? record.modelID : undefined;
				if (modelID) {
					const routing = this.subtaskManager.resolveRouting(updatedSessionId);
					if (routing) {
						this.sessionHandler.postSessionMessage(
							{
								id: routing.toolUseId,
								type: 'subtask' as const,
								childModelId: modelID,
								timestamp: new Date().toISOString(),
							} satisfies import('../common').SessionMessageUpdate,
							routing.parentSessionId,
						);
					}
				}
			}

			this.sessionHandler.handleSessionUpdatedEvent(event.data, event.sessionId);
			return;
		}

		if (event.type === 'session_created') {
			const data = event.data as { sessionID?: string; parentID?: string };
			const childSessionId = data.sessionID;
			const parentSessionId = data.parentID;

			if (childSessionId && parentSessionId) {
				const pendingToolUseId = this.subtaskManager.getOldestPendingToolUseId(parentSessionId);
				if (pendingToolUseId) {
					this.linkKnownChildSession(pendingToolUseId, parentSessionId, childSessionId);
				}
			}
			return;
		}

		// Resolve target session: events always go to their own session bucket.
		// EXCEPT child session events — those are aggregated into the parent subtask's transcript.
		// STRICT: never fallback to activeSessionId — if event has no sessionId, drop it.
		const targetSessionId = event.sessionId;

		if (!targetSessionId) {
			logger.warn(`[ChatProvider] Dropping event ${event.type}: no sessionId in event payload`);
			return;
		}

		// Determine if this event belongs to a known child session
		const isChildSession = this.sessionGraph.isChild(targetSessionId);

		if (event.type === 'permission') {
			this.handlePermissionRuntimeEvent(event, targetSessionId);
			return;
		}

		if (event.type === 'question') {
			this.handleQuestionRuntimeEvent(event, targetSessionId);
			return;
		}

		if (event.type === 'todo') {
			this.bridge.session.todo(targetSessionId, event.data.todos);
			return;
		}

		if (event.type === 'permission_replied') {
			const reply = event.data;
			const replyTargetSessionId = this.sessionGraph.isChild(targetSessionId)
				? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
				: targetSessionId;
			if (reply.requestID) {
				this.bridge.session.permissionRemove(replyTargetSessionId, reply.requestID, reply.reply);
			}
			return;
		}

		if (event.type === 'question_replied') {
			const reply = event.data;
			const replyTargetSessionId = this.sessionGraph.isChild(targetSessionId)
				? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
				: targetSessionId;
			if (reply.requestID) {
				this.bridge.session.questionRemove(
					replyTargetSessionId,
					reply.requestID,
					reply.answers,
					reply.rejected,
				);
			}
			return;
		}

		switch (event.type) {
			case 'normalized_log': {
				break;
			}

			case 'turn_tokens': {
				if (isChildSession) {
					// Child token stats are handled via cumulative totalStats in session_updated
					break;
				}
				this.sessionHandler.postTurnTokens(event.data, targetSessionId);
				break;
			}

			case 'finished': {
				// Complete thinking block first (so durationMs is computed)
				this.completeActiveThinking(targetSessionId);
				const finishedPartId = this.activeAssistantPartIds.get(targetSessionId);
				if (finishedPartId) {
					if (isChildSession) {
						// For child sessions, mark the assistant message as done.
						// Use isDelta so mergeOrAddMessage concatenates empty string
						// (no-op) instead of overwriting real content via Object.assign.
						this.routeToParentTranscript(targetSessionId, {
							id: `complete-${finishedPartId}`,
							type: 'assistant',
							partId: finishedPartId,
							content: '',
							isDelta: true,
							isStreaming: false,
							timestamp: new Date().toISOString(),
						});
					} else {
						this.sessionHandler.postComplete(finishedPartId, finishedPartId, targetSessionId);
					}
					this.activeAssistantPartIds.delete(targetSessionId);
				}

				// Turn finished summary — compact lifecycle log
				const toolCount = this.turnToolCounts.get(targetSessionId) ?? 0;
				logger.info('[ChatProvider] Turn finished', {
					sessionId: targetSessionId,
					toolCount,
					isChild: isChildSession,
				});
				this.turnToolCounts.delete(targetSessionId);
				break;
			}

			case 'message': {
				this.completeActiveThinking(targetSessionId);

				const e = event.data;
				const partId =
					e.partId || this.activeAssistantPartIds.get(targetSessionId) || `part-${now}`;
				this.activeAssistantPartIds.set(targetSessionId, partId);
				const isMsgId = partId.startsWith('msg-') || partId.startsWith('msg_');
				const messageId = isMsgId ? partId : `msg-${partId}`;

				const msgData: import('../common').SessionMessageData = {
					id: messageId,
					type: 'assistant',
					partId,
					content: e.content || '',
					isStreaming: true,
					isDelta: e.isDelta ?? true,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				};

				if (isChildSession) {
					this.routeToParentTranscript(targetSessionId, msgData);
				} else {
					this.sessionHandler.postSessionMessage(msgData, targetSessionId);
				}
				break;
			}

			case 'thinking': {
				const e = event.data;
				const partId = e.partId || `thinking-${now}`;

				const prevThinking = this.activeThinkingPartIds.get(targetSessionId);
				if (prevThinking && prevThinking.partId !== partId) {
					if (isChildSession) {
						const prevDuration = Date.now() - prevThinking.startTime;
						this.routeToParentTranscript(targetSessionId, {
							id: `thinking-${prevThinking.partId}`,
							type: 'thinking',
							partId: prevThinking.partId,
							isStreaming: false,
							durationMs: prevDuration,
							timestamp: new Date().toISOString(),
						});
					} else {
						this.sessionHandler.postComplete(
							prevThinking.partId,
							prevThinking.partId,
							targetSessionId,
						);
					}
				}
				const thinkingStartTime = Date.now();
				this.activeThinkingPartIds.set(targetSessionId, { partId, startTime: thinkingStartTime });

				const isThinkingId = partId.startsWith('thinking-') || partId.startsWith('thinking_');
				const thinkingId = isThinkingId ? partId : `thinking-${partId}`;
				const isFirstChunk = !prevThinking || prevThinking.partId !== partId;

				const thinkingData: import('../common').SessionMessageData = {
					id: thinkingId,
					type: 'thinking',
					partId,
					content: e.content || '',
					isDelta: e.isDelta ?? false,
					isStreaming: true,
					...(isFirstChunk ? { startTime: Date.now() } : {}),
					timestamp: new Date().toISOString(),
				};

				if (isChildSession) {
					this.routeToParentTranscript(targetSessionId, thinkingData);
				} else {
					this.sessionHandler.postSessionMessage(thinkingData, targetSessionId);
				}
				break;
			}

			case 'tool_use': {
				this.completeActiveThinking(targetSessionId);
				this.turnToolCounts.set(
					targetSessionId,
					(this.turnToolCounts.get(targetSessionId) ?? 0) + 1,
				);
				this.handleToolUse(event, targetSessionId, isChildSession);
				break;
			}

			case 'tool_streaming': {
				const e = event.data;
				if (e.id) {
					// For task tools: link child session from metadata if available,
					// but do NOT dispatch a tool_use update — it would overwrite the
					// subtask message type via Object.assign in mergeOrAddMessage.
					// Task tool metadata updates are handled via re-emitted tool_use
					// events from handleToolPart.
					if (e.name && isTaskTool(e.name)) {
						if (e.metadata) {
							const meta = e.metadata as Record<string, unknown>;
							const childSessionId = ChatProvider.safeString(meta.sessionId);
							if (childSessionId && this.subtaskManager.isRegistered(e.id)) {
								this.linkKnownChildSession(e.id, targetSessionId, childSessionId);
							}
						}
						break;
					}

					const updateMsg: import('../common').SessionMessageUpdate = {
						id: e.id,
						type: 'tool_use' as const,
						timestamp: new Date().toISOString(),
					};
					if (e.streamingOutput) updateMsg.streamingOutput = e.streamingOutput;
					if (e.metadata) updateMsg.metadata = e.metadata;
					this.dispatchSessionMessage(targetSessionId, isChildSession, updateMsg);
				}
				break;
			}

			case 'tool_result': {
				this.handleToolResult(event, targetSessionId, isChildSession);
				break;
			}

			case 'session_diff': {
				const diffData = event.data;
				this.bridge.session.fileDiffUpdated(targetSessionId, diffData.diff);
				break;
			}

			case 'error': {
				// Suppress abort errors when the user explicitly stopped the session.
				// The backend emits a session.error ("The operation was aborted") after
				// we call abortSession(), but the user already sees "Stopped by user"
				// via the 'interrupted' message — showing the abort error is redundant.
				const errorMsg = event.data.message || '';
				if (this.sessionState.isStopGuarded(targetSessionId) && /abort/i.test(errorMsg)) {
					break;
				}

				const errorId = `error-${now}`;
				const errorData: import('../common').SessionMessageData = {
					id: errorId,
					type: 'error',
					content: errorMsg || 'Unknown error',
					isError: true,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				};

				if (isChildSession) {
					this.updateSubtaskLifecycle(targetSessionId, {
						status: 'error',
						timestamp: new Date().toISOString(),
					});
					this.routeToParentTranscript(targetSessionId, errorData);
				} else {
					this.sessionHandler.postSessionMessage(errorData, targetSessionId);
					this.sessionHandler.postStatus(targetSessionId, 'error', 'Error');
				}
				break;
			}
			default:
				break;
		}
	}

	private handlePermissionRuntimeEvent(event: CLIEvent, targetSessionId: string): void {
		const isChildPermission = this.sessionGraph.isChild(targetSessionId);
		const permissionTargetSessionId = isChildPermission
			? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
			: targetSessionId;
		const request = mapPermissionRuntimePayloadToRequest(event.data, permissionTargetSessionId);
		if (!request) return;

		this.bridge.session.permissionUpsert(permissionTargetSessionId, request);
		const requestId = request.id;
		const tool = request.permission;

		const autoRespond = (approved: boolean, alwaysAllow?: boolean) => {
			void this.cli
				.respondToPermission({ requestId, approved, alwaysAllow })
				.catch(error => logger.error('[ChatProvider] auto-response failed:', error));
			this.bridge.session.permissionRemove(
				permissionTargetSessionId,
				requestId,
				approved ? (alwaysAllow ? 'always' : 'once') : 'reject',
			);
			this.bridge.session.accessResponse(permissionTargetSessionId, {
				requestId,
				approved,
				...(alwaysAllow ? { alwaysAllow } : {}),
			});
		};

		const isYolo = Boolean(this.settings.get('access.yoloMode'));
		const isAutoApprove = Boolean(this.settings.get('access.autoApprove'));
		const isAutoAccept = this.toolHandler.isAutoAccept(permissionTargetSessionId);
		if (isYolo || isAutoApprove || isAutoAccept) {
			autoRespond(true);
			return;
		}

		const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();
		if (alwaysAllowByTool[tool]) {
			autoRespond(true, true);
			return;
		}

		const policies = this.toolHandler.getPermissionPolicies();
		const policyCategory = PERMISSION_CATEGORIES.includes(tool as PermissionCategory)
			? (tool as PermissionCategory)
			: undefined;
		const policyValue = policyCategory ? policies[policyCategory] : undefined;
		if (policyValue === 'allow' || policyValue === 'deny') {
			autoRespond(policyValue === 'allow');
		}
	}

	private handleQuestionRuntimeEvent(event: CLIEvent, targetSessionId: string): void {
		const isChildQuestion = this.sessionGraph.isChild(targetSessionId);
		const questionTargetSessionId = isChildQuestion
			? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
			: targetSessionId;
		const childToolUseId = isChildQuestion
			? this.subtaskManager.getToolUseId(targetSessionId)
			: undefined;
		const request = mapQuestionRuntimePayloadToRequest(
			event.data,
			questionTargetSessionId,
			childToolUseId,
		);
		if (!request) return;

		this.bridge.session.questionUpsert(questionTargetSessionId, request);
	}

	private handleToolUse(event: CLIEvent, targetSessionId: string, isChildSession: boolean): void {
		const now = Date.now();
		const e = event.data as Record<string, unknown>;
		const toolUseId = (e.id as string) || `tool-${now}`;
		const toolName = (e.name as string) || (e.tool as string) || 'unknown';

		if (isTaskTool(toolName)) {
			// Task tool_use comes from the PARENT's SSE stream.
			const parentSessionId = event.sessionId;

			if (!parentSessionId) {
				logger.warn(
					'[ChatProvider] Task tool_use event has no sessionId, subtask card will be dropped',
					{ toolUseId },
				);
				return;
			}

			const input = (e.input as Record<string, unknown>) || {};
			const metadata = (e.metadata as Record<string, unknown> | undefined) ?? undefined;
			const knownChildSessionId = ChatProvider.safeString(metadata?.sessionId);

			// Re-emitted tool_use with input that was missing on first emission.
			// Update the existing subtask card with prompt/description/agent.
			if (this.subtaskManager.isRegistered(toolUseId)) {
				if (knownChildSessionId) {
					this.linkKnownChildSession(toolUseId, parentSessionId, knownChildSessionId);
				}
				const hasInput = Object.keys(input).length > 0;
				if (hasInput) {
					this.sessionHandler.postSessionMessage(
						{
							id: toolUseId,
							type: 'subtask' as const,
							agent: ChatProvider.safeString(input.subagent_type),
							prompt: ChatProvider.safeString(input.prompt),
							description: ChatProvider.safeString(input.description),
							...(knownChildSessionId
								? { childSessionId: knownChildSessionId, parentSessionId }
								: { parentSessionId }),
							toolInput: JSON.stringify(e.input),
							rawInput: input,
							timestamp: new Date().toISOString(),
						} satisfies import('../common').SessionMessageUpdate,
						parentSessionId,
					);
				}
				return;
			}

			// Create the subtask card immediately and register the subtask.
			// Post the message BEFORE registerSubtask — registerSubtask with a
			// known childSessionId immediately links the child, which means child
			// events will start routing via subtaskTranscript right away.
			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					toolUseId,
					toolName,
					agent: ChatProvider.safeString(input.subagent_type) || 'subagent',
					prompt: ChatProvider.safeString(input.prompt) || '',
					description: ChatProvider.safeString(input.description) || 'Running subtask...',
					...(knownChildSessionId
						? { childSessionId: knownChildSessionId, parentSessionId }
						: { parentSessionId }),
					status: 'running',
					startTime: new Date().toISOString(),
					toolInput: e.input ? JSON.stringify(e.input) : '',
					rawInput: input,
					isRunning: true,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
				parentSessionId,
			);

			this.subtaskManager.registerSubtask(toolUseId, parentSessionId, knownChildSessionId);

			return;
		}

		// Non-task tool
		const toolData: import('../common').SessionMessageData = {
			id: toolUseId,
			type: 'tool_use',
			partId: toolUseId,
			toolUseId,
			toolName,
			toolInput: e.input ? JSON.stringify(e.input) : '',
			rawInput: (e.input as Record<string, unknown>) || {},
			isRunning: true,
			timestamp: new Date().toISOString(),
			normalizedEntry: event.normalizedEntry,
		};

		if (isChildSession) {
			this.routeToParentTranscript(targetSessionId, toolData);

			// Emit tool activity to the PARENT session so the subtask card
			// can show what the child agent is doing (e.g. "Writing file: foo.ts").
			const parentSessionId = this.sessionGraph.getParent(targetSessionId);
			if (parentSessionId) {
				const canonicalName = resolveToolName(toolName) ?? toolName;
				const label = getToolActivityLabel(canonicalName);
				this.bridge.session.status(parentSessionId, 'busy', label, undefined, {
					toolName: canonicalName,
					label,
					toolUseId,
				});
			}
		} else {
			this.sessionHandler.postSessionMessage(toolData, targetSessionId);

			// Emit tool-specific activity status so the UI can show granular progress
			// (e.g. "Writing file...", "Running command...") instead of generic "Working...".
			const canonicalName = resolveToolName(toolName) ?? toolName;
			const label = getToolActivityLabel(canonicalName);
			this.bridge.session.status(targetSessionId, 'busy', label, undefined, {
				toolName: canonicalName,
				label,
				toolUseId,
			});
		}
	}

	private handleToolResult(
		event: CLIEvent,
		targetSessionId: string,
		isChildSession: boolean,
	): void {
		const now = Date.now();
		const e = event.data as Record<string, unknown>;
		const toolUseId = (e.tool_use_id as string) || (e.id as string) || `tool-${now}`;
		const toolName = (e.name as string) || (e.tool as string) || 'unknown';

		// Clear tool activity on tool completion.
		if (!isChildSession) {
			this.bridge.session.status(targetSessionId, 'busy', 'Working...', undefined, null);
		} else {
			// For child sessions, clear tool activity on the parent session.
			const parentSessionId = this.sessionGraph.getParent(targetSessionId);
			if (parentSessionId) {
				this.bridge.session.status(parentSessionId, 'busy', 'Working...', undefined, null);
			}
		}

		if (isTaskTool(toolName)) {
			const metadata =
				e.metadata && typeof e.metadata === 'object'
					? (e.metadata as Record<string, unknown>)
					: undefined;
			const content =
				typeof e.content === 'string'
					? (e.content as string)
					: e.content
						? JSON.stringify(e.content)
						: '';
			const metadataChildSessionId = ChatProvider.safeString(metadata?.sessionId);
			const storedParent = this.subtaskManager.getParentSession(toolUseId);

			const childSessionId =
				this.subtaskManager.getChildSessionId(toolUseId) ??
				this.sessionGraph.getChildByTaskId(toolUseId) ??
				metadataChildSessionId;

			const parentSessionId =
				(childSessionId && this.sessionGraph.getParent(childSessionId)) ||
				storedParent ||
				event.sessionId;
			if (childSessionId && parentSessionId) {
				this.linkKnownChildSession(toolUseId, parentSessionId, childSessionId);
			}

			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					status: e.is_error ? 'error' : 'completed',
					result: content,
					...(childSessionId ? { childSessionId } : {}),
					...(parentSessionId ? { parentSessionId } : {}),
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
				parentSessionId,
			);
			this.sessionHandler.postComplete(toolUseId, toolUseId, parentSessionId);
			this.subtaskManager.completeSubtask(toolUseId);
			return;
		}

		// Non-task tool result
		const toolInputRaw = e.input;
		if (toolInputRaw && typeof toolInputRaw === 'object') {
			const toolInput = toolInputRaw as Record<string, unknown>;
			const filePath = extractFilePath(toolInput);
			const toolUseData: import('../common').SessionMessageData = {
				id: toolUseId,
				type: 'tool_use',
				partId: toolUseId,
				toolUseId,
				toolName,
				toolInput: JSON.stringify(toolInput),
				rawInput: toolInput,
				filePath,
				isRunning: false,
				timestamp: new Date().toISOString(),
				normalizedEntry: event.normalizedEntry,
			};

			if (isChildSession) {
				this.routeToParentTranscript(targetSessionId, toolUseData);
			} else {
				this.sessionHandler.postSessionMessage(toolUseData, targetSessionId);
			}

			if (filePath && isFileEditTool(toolName)) {
				const oldContent =
					typeof toolInput.old_string === 'string'
						? toolInput.old_string
						: typeof toolInput.old_str === 'string'
							? toolInput.old_str
							: typeof toolInput.oldString === 'string'
								? toolInput.oldString
								: '';

				const newContent =
					typeof toolInput.new_string === 'string'
						? toolInput.new_string
						: typeof toolInput.new_str === 'string'
							? toolInput.new_str
							: typeof toolInput.newString === 'string'
								? toolInput.newString
								: typeof toolInput.content === 'string'
									? toolInput.content
									: '';

				const diffStats = computeDiffLineStats(oldContent, newContent);

				this.bridge.session.fileChanged(targetSessionId, {
					filePath,
					fileName: filePath.split(/[/\\]/).pop() || filePath,
					linesAdded: diffStats.added,
					linesRemoved: diffStats.removed,
					toolUseId,
				});
			} else if (!filePath && resolveToolName(toolName) === 'apply_patch') {
				// apply_patch has no single filePath — prefer metadata.files (accurate stats),
				// fall back to path extraction from the patch text.
				const meta = e.metadata as Record<string, unknown> | undefined;
				const metaFiles = meta?.files;
				if (Array.isArray(metaFiles) && metaFiles.length > 0) {
					for (const mf of metaFiles as Record<string, unknown>[]) {
						const fp =
							typeof mf.filePath === 'string'
								? mf.filePath
								: typeof mf.relativePath === 'string'
									? mf.relativePath
									: '';
						if (!fp) continue;
						this.bridge.session.fileChanged(targetSessionId, {
							filePath: fp,
							fileName: fp.split(/[/\\]/).pop() || fp,
							linesAdded: typeof mf.additions === 'number' ? mf.additions : 0,
							linesRemoved: typeof mf.deletions === 'number' ? mf.deletions : 0,
							toolUseId,
						});
					}
				} else {
					const patchPaths = extractPatchFilePaths(toolInput);
					for (const patchPath of patchPaths) {
						this.bridge.session.fileChanged(targetSessionId, {
							filePath: patchPath,
							fileName: patchPath.split(/[/\\]/).pop() || patchPath,
							linesAdded: 0,
							linesRemoved: 0,
							toolUseId,
						});
					}
				}
			}
		}

		const content =
			typeof e.content === 'string'
				? (e.content as string)
				: e.content
					? JSON.stringify(e.content)
					: '';
		const resultData: import('../common').SessionMessageData = {
			id: `${toolUseId}-result-${now}`,
			type: 'tool_result',
			partId: toolUseId,
			toolUseId,
			toolName,
			content,
			isError: Boolean(e.is_error),
			title: typeof e.title === 'string' ? e.title : undefined,
			metadata:
				e.metadata && typeof e.metadata === 'object'
					? (e.metadata as Record<string, unknown>)
					: undefined,
			timestamp: new Date().toISOString(),
			normalizedEntry: event.normalizedEntry,
		};

		if (isChildSession) {
			this.routeToParentTranscript(targetSessionId, resultData);
		} else {
			this.sessionHandler.postSessionMessage(resultData, targetSessionId);
			this.sessionHandler.postComplete(toolUseId, toolUseId, targetSessionId);
		}

		// Compact tool lifecycle summary — one line per completed tool
		logger.debug('[ChatProvider] Tool completed', {
			sessionId: targetSessionId,
			toolUseId,
			toolName,
			isError: Boolean(e.is_error),
		});
	}

	private handleSettingsChange(): void {
		this.settings.refresh();
		// Use the same merge path as syncAll/getSettings so opencode.json
		// endpoints are always included. Without this, any VS Code config
		// change would temporarily strip opencode.json-only endpoints from
		// the webview, causing them to flicker or disappear.
		void this.settingsHandler.handleMessage({ type: 'getSettings' });
	}

	private sendInitialState(): void {
		// Delegate to settingsHandler so opencode.json endpoints are merged.
		void this.settingsHandler.handleMessage({ type: 'getSettings' });
		this.bridge.data(
			'accessData',
			Object.entries(this.toolHandler.getAlwaysAllowByTool())
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		);
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

		// Logging is handled by OutboundBridge.send() — no need to duplicate here.
		this.view.webview.postMessage(msg);
	}

	// ─── Child → Parent Transcript Routing ───────────────────────────────────

	/** Safely extract a non-empty string from unknown LLM input. */
	private static safeString(val: unknown): string | undefined {
		return typeof val === 'string' && val.trim().length > 0 ? val : undefined;
	}

	/** Dispatch a message to the correct target — child routes to parent transcript, otherwise direct post. */
	private dispatchSessionMessage(
		targetSessionId: string,
		isChildSession: boolean,
		msg: import('../common').SessionMessageData | import('../common').SessionMessageUpdate,
	): void {
		if (isChildSession) {
			this.routeToParentTranscript(targetSessionId, msg as import('../common').SessionMessageData);
		} else {
			this.sessionHandler.postSessionMessage(msg, targetSessionId);
		}
	}

	private linkKnownChildSession(
		toolUseId: string,
		parentSessionId: string,
		childSessionId: string,
	): void {
		const linked = this.subtaskManager.linkChildSession(childSessionId, toolUseId, parentSessionId);
		if (!linked) return;
		this.completeActiveThinking(parentSessionId);
		// IMPORTANT: Update the subtask card with childSessionId BEFORE flushing
		// pending child messages. flushPendingChildMessages sends subtask_transcript
		// events — the subtask card must already be up-to-date in the webview store
		// by the time those transcript events arrive.
		this.sessionHandler.postSessionMessage(
			{
				id: toolUseId,
				type: 'subtask' as const,
				childSessionId,
				parentSessionId,
				timestamp: new Date().toISOString(),
			},
			parentSessionId,
		);
		this.flushPendingChildMessages(childSessionId);
	}

	private updateSubtaskLifecycle(
		childSessionId: string,
		update: Partial<Extract<import('../common').SessionMessageData, { type: 'subtask' }>> & {
			timestamp?: string;
		},
	): void {
		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) return;
		this.sessionHandler.postSessionMessage(
			{
				id: routing.toolUseId,
				type: 'subtask' as const,
				childSessionId,
				parentSessionId: routing.parentSessionId,
				...update,
				timestamp: update.timestamp || new Date().toISOString(),
			},
			routing.parentSessionId,
		);
	}

	/**
	 * Route a child session message into the parent subtask's transcript.
	 * Returns true if the message was routed, false if no parent/subtask found.
	 * When routing fails, the message is buffered and will be flushed when
	 * an explicit child session link becomes available.
	 */
	private routeToParentTranscript(
		childSessionId: string,
		childMessage: import('../common').SessionMessageData,
	): boolean {
		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) {
			// Buffer the message — it will be flushed when the child is linked
			let queue = this.pendingChildMessages.get(childSessionId);
			if (!queue) {
				queue = [];
				this.pendingChildMessages.set(childSessionId, queue);
			}
			queue.push(childMessage);
			logger.debug('[ChatProvider] Buffered unroutable child message', {
				childSessionId,
				type: childMessage.type,
				queueSize: queue.length,
			});
			return false;
		}
		this.bridge.session.subtaskTranscript(routing.parentSessionId, routing.toolUseId, childMessage);
		return true;
	}

	/**
	 * Flush any buffered child messages that were waiting for routing.
	 * Called after a deterministic child session link is established.
	 */
	private flushPendingChildMessages(childSessionId: string): void {
		const queue = this.pendingChildMessages.get(childSessionId);
		if (!queue || queue.length === 0) return;
		this.pendingChildMessages.delete(childSessionId);

		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) {
			logger.warn('[ChatProvider] flushPendingChildMessages: routing still unavailable', {
				childSessionId,
				droppedCount: queue.length,
			});
			return;
		}

		logger.info('[ChatProvider] Flushing buffered child messages', {
			childSessionId,
			count: queue.length,
		});
		for (const msg of queue) {
			this.bridge.session.subtaskTranscript(routing.parentSessionId, routing.toolUseId, msg);
		}
	}

	// ─── Thinking Block Lifecycle ────────────────────────────────────────────

	/** Complete (close) the active thinking block for a session, if any. */
	private completeActiveThinking(sessionId: string): void {
		const activeThinking = this.activeThinkingPartIds.get(sessionId);
		if (activeThinking) {
			const { partId, startTime } = activeThinking;
			if (this.sessionGraph.isChild(sessionId)) {
				// handleCompleteEvent only iterates top-level messages and would
				// never reach the child thinking message. Send an explicit update
				// with durationMs so the transcript shows the final duration.
				this.routeToParentTranscript(sessionId, {
					id: `thinking-${partId}`,
					type: 'thinking',
					partId,
					isStreaming: false,
					durationMs: Date.now() - startTime,
					timestamp: new Date().toISOString(),
				});
			} else {
				this.sessionHandler.postComplete(partId, partId, sessionId);
			}
			this.activeThinkingPartIds.delete(sessionId);
		}
	}

	/**
	 * Clean up pendingChildMessages for a session and all its children.
	 * Called when sessions are closed or deleted to prevent memory leaks
	 * from orphaned child message buffers.
	 */
	cleanupPendingChildMessages(sessionId: string): void {
		this.pendingChildMessages.delete(sessionId);
		for (const childId of this.sessionGraph.getChildren(sessionId)) {
			this.pendingChildMessages.delete(childId);
		}
	}

	dispose(): void {
		this.subtaskManager.clearAll();
		this.pendingChildMessages.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
