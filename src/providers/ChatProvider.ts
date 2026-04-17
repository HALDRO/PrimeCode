import * as vscode from 'vscode';
import {
	extractCanonicalTaskResult,
	formatModelId,
	mapPermissionRuntimePayloadToRequest,
	mapQuestionRuntimePayloadToRequest,
	remapLspDiagnosticsToFilePaths,
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

function buildTaskMessagePart(
	e: Record<string, unknown>,
	parentSessionId: string,
	toolUseId: string,
	toolName: string,
	normalizedEntry: CLIEvent['normalizedEntry'],
	status: 'pending' | 'running' | 'completed' | 'error',
	input?: Record<string, unknown>,
	metadata?: Record<string, unknown>,
): import('../common').SessionMessagePartPayload['part'] {
	return {
		id: typeof e.partId === 'string' ? e.partId : toolUseId,
		messageId: typeof e.messageID === 'string' ? e.messageID : toolUseId,
		sessionId: parentSessionId,
		type: 'tool',
		callId: toolUseId,
		toolName,
		state: {
			status,
			...(input ? { input } : {}),
			...(metadata ? { metadata } : {}),
			...(typeof e.content === 'string' ? { output: e.content as string } : {}),
			...(typeof e.title === 'string' ? { title: e.title } : {}),
		},
		...(normalizedEntry ? { normalizedEntry } : {}),
	};
}

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

function extractFilePath(input: Record<string, unknown>): string | undefined {
	if (typeof input.filePath === 'string') return input.filePath;
	if (typeof input.file_path === 'string') return input.file_path;
	if (typeof input.path === 'string') return input.path;
	return undefined;
}

function collectChangedFilePaths(
	toolName: string,
	toolInput: Record<string, unknown>,
	metadata: Record<string, unknown> | undefined,
): string[] {
	const filePath = extractFilePath(toolInput);
	if (filePath && isFileEditTool(toolName)) return [filePath];
	if (resolveToolName(toolName) !== 'apply_patch') return [];

	const metaFiles = metadata?.files;
	if (Array.isArray(metaFiles) && metaFiles.length > 0) {
		return metaFiles
			.map(file => {
				const item = file as Record<string, unknown>;
				return typeof item.filePath === 'string'
					? item.filePath
					: typeof item.relativePath === 'string'
						? item.relativePath
						: typeof item.path === 'string'
							? item.path
							: '';
			})
			.filter((path): path is string => path.length > 0);
	}

	return extractPatchFilePaths(toolInput);
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
			getSessionAutoAcceptState: (sessionId: string) =>
				this.toolHandler.getSessionAutoAcceptState(sessionId),
			clearSessionAutoAccept: (sessionId: string) =>
				this.toolHandler.clearSessionAutoAccept(sessionId),
			registerCheckpoint: (commitId, record) =>
				this.restoreHandler.registerCheckpoint(commitId, record),
			cleanupSessionRestore: sessionId => this.restoreHandler.cleanupSession(sessionId),
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

		// Single-point OpenCode initialization with retry polling
		this.scheduleOpenCodeInit();

		// Forward CLI events to webview
		this.cli.on('event', event => this.handleCliEvent(event));

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
			this.bridge.emit(this.sessionState.activeSessionId ?? '', 'notification', {
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
				handleMessage: async (msg: WebviewCommand) => {
					if (msg.type === 'webviewDidLaunch') {
						await this.sendInitialState();
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
				this.bridge.emit(errorSessionId, 'notification', {
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

	private handleCliEvent(event: CLIEvent): void {
		const now = Date.now();
		this.traceCliEvent(event);

		if (event.type === 'lsp_updated') {
			void this.refreshLspStatus();
			return;
		}

		if (event.type === 'session_updated') {
			this.handleSessionUpdatedCliEvent(event);
			this.sessionHandler.handleSessionUpdatedEvent(event.data, event.sessionId);
			return;
		}

		if (event.type === 'error' && !event.sessionId) {
			const activeSessionId = this.sessionState.activeSessionId;
			if (!activeSessionId) {
				return;
			}

			this.bridge.emit(activeSessionId, 'notification', {
				notification: {
					id: `error-${now}`,
					type: 'error',
					content: event.data.message || 'Unknown error',
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
			});
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
		// Child session events stay in the child session and are projected into the parent subtask UI.
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
			this.bridge.emit(targetSessionId, 'todo', { todos: event.data.todos });
			return;
		}

		if (event.type === 'permission_replied') {
			const reply = event.data;
			const replyTargetSessionId = this.sessionGraph.isChild(targetSessionId)
				? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
				: targetSessionId;
			if (reply.requestID) {
				this.bridge.emit(replyTargetSessionId, 'permission', {
					action: 'remove',
					requestId: reply.requestID,
					response: reply.reply,
				});
			}
			return;
		}

		if (event.type === 'question_replied') {
			const reply = event.data;
			const replyTargetSessionId = this.sessionGraph.isChild(targetSessionId)
				? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
				: targetSessionId;
			if (reply.requestID) {
				this.bridge.emit(replyTargetSessionId, 'question', {
					action: 'remove',
					requestId: reply.requestID,
					answers: reply.answers,
					rejected: reply.rejected,
				});
			}
			return;
		}

		if (event.type === 'message_record') {
			this.bridge.emit(targetSessionId, 'message_record', {
				message: {
					id: event.data.id,
					sessionId: event.data.sessionID,
					role: event.data.role,
					parentId: event.data.parentID,
					createdAt: event.data.createdAt,
					completedAt: event.data.completedAt,
					modelId: event.data.modelID,
					providerId: event.data.providerID,
					agent: event.data.agent,
					tokens: event.data.tokens,
					cost: event.data.cost,
				},
			});
			return;
		}

		if (event.type === 'message_record_removed') {
			this.bridge.emit(targetSessionId, 'message_record_removed', {
				messageId: event.data.messageID,
			});
			return;
		}

		if (event.type === 'message_part') {
			if (
				event.data.type === 'tool' &&
				typeof event.data.tool === 'string' &&
				isTaskTool(event.data.tool)
			) {
				return;
			}
			this.bridge.emit(targetSessionId, 'message_part', {
				part: {
					id: event.data.id,
					messageId: event.data.messageID,
					sessionId: event.data.sessionID,
					type: event.data.type,
					text: event.data.text,
					callId: event.data.callID,
					toolName: event.data.tool,
					state: event.data.state,
					createdAt: event.data.createdAt,
					completedAt: event.data.completedAt,
					mime: event.data.mime,
					url: event.data.url,
					filename: event.data.filename,
					synthetic: event.data.synthetic,
					auto: event.data.auto,
					normalizedEntry: event.normalizedEntry,
				},
			});
			return;
		}

		if (event.type === 'message_part_delta') {
			this.bridge.emit(targetSessionId, 'message_part_delta', {
				messageId: event.data.messageID,
				partId: event.data.partID,
				field: event.data.field,
				delta: event.data.delta,
			});
			return;
		}

		if (event.type === 'message_part_removed') {
			this.bridge.emit(targetSessionId, 'message_part_removed', {
				messageId: event.data.messageID,
				partId: event.data.partID,
			});
			return;
		}

		switch (event.type) {
			case 'normalized_log': {
				break;
			}

			case 'turn_tokens': {
				if (isChildSession) {
					this.syncChildSubtaskTotalsFromTurnTokens(
						targetSessionId,
						event.data as unknown as Record<string, unknown> | undefined,
					);
					break;
				}
				this.bridge.emit(targetSessionId, 'turn_tokens', event.data);
				break;
			}

			case 'finished': {
				// Complete thinking block first (so durationMs is computed)
				this.completeActiveThinking(targetSessionId);
				const finishedPartId = this.activeAssistantPartIds.get(targetSessionId);
				if (finishedPartId) {
					if (!isChildSession) {
						this.bridge.emit(targetSessionId, 'complete', {
							partId: finishedPartId,
							toolUseId: finishedPartId,
							completedAt: now,
						});
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

					this.bridge.emit(targetSessionId, 'message_part', {
						part: {
							id:
								typeof e.partId === 'string'
									? e.partId
									: typeof e.id === 'string'
										? e.id
										: `tool-${Date.now()}`,
							messageId:
								typeof e.messageID === 'string'
									? e.messageID
									: typeof e.id === 'string'
										? e.id
										: `tool-${Date.now()}`,
							sessionId: targetSessionId,
							type: 'tool',
							callId: e.id,
							toolName: typeof e.name === 'string' ? e.name : 'unknown',
							state: {
								status: 'running',
								...(e.streamingOutput ? { output: e.streamingOutput } : {}),
								...(e.metadata ? { metadata: e.metadata } : {}),
							},
							normalizedEntry: event.normalizedEntry,
						},
					});
				}
				break;
			}

			case 'tool_result': {
				this.handleToolResult(event, targetSessionId, isChildSession);
				break;
			}

			case 'session_diff': {
				const diffData = event.data;
				this.bridge.emit(targetSessionId, 'file_diff', { diffs: diffData.diff });
				break;
			}

			case 'error': {
				// Suppress abort errors when the user explicitly stopped the session.
				// The backend may still emit a late abort error after stop; showing it
				// would replace the expected idle/stopped state with noise.
				const errorMsg = event.data.message || '';
				if (this.sessionState.isStopGuarded(targetSessionId) && /abort/i.test(errorMsg)) {
					break;
				}

				const errorId = `error-${now}`;
				const errorData = {
					id: errorId,
					type: 'error' as const,
					content: errorMsg || 'Unknown error',
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				};

				if (isChildSession) {
					this.updateSubtaskLifecycle(targetSessionId, {
						status: 'error',
						timestamp: new Date().toISOString(),
					});
				} else {
					this.bridge.emit(targetSessionId, 'notification', {
						notification: errorData,
					});
					this.bridge.emit(targetSessionId, 'status', {
						status: 'error',
						statusText: 'Error',
					});
				}
				break;
			}
			default:
				break;
		}
	}

	private traceCliEvent(event: CLIEvent): void {
		if (event.type === 'normalized_log') {
			return;
		}
		const e = event.data as Record<string, unknown> | undefined;
		logger.trace(`[ChatProvider] handleCliEvent: ${event.type}`, {
			sessionId: event.sessionId,
			id: e?.id ?? e?.tool_use_id,
			name: e?.name,
			state: e?.state,
		});
	}

	private handleSessionUpdatedCliEvent(event: CLIEvent): void {
		const updatedSessionId = event.sessionId;
		if (!updatedSessionId || !this.sessionGraph.isChild(updatedSessionId)) {
			return;
		}

		const record = event.data as Record<string, unknown> | undefined;
		this.syncChildSubtaskStatus(updatedSessionId, record);
		this.syncChildSubtaskModel(updatedSessionId, record);
	}

	private syncChildSubtaskStatus(
		updatedSessionId: string,
		record: Record<string, unknown> | undefined,
	): void {
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
			return;
		}
		if (status?.type === 'busy') {
			this.updateSubtaskLifecycle(updatedSessionId, {
				status: 'running',
				retryInfo: undefined,
				timestamp: new Date().toISOString(),
			});
			return;
		}
		if (status?.type === 'idle') {
			this.updateSubtaskLifecycle(updatedSessionId, {
				retryInfo: undefined,
				timestamp: new Date().toISOString(),
			});
		}
	}

	private syncChildSubtaskTotalsFromTurnTokens(
		childSessionId: string,
		payload: Record<string, unknown> | undefined,
	): void {
		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) return;

		const delta = {
			inputTokens: typeof payload?.inputTokens === 'number' ? payload.inputTokens : 0,
			outputTokens: typeof payload?.outputTokens === 'number' ? payload.outputTokens : 0,
			totalTokens: typeof payload?.totalTokens === 'number' ? payload.totalTokens : 0,
			cacheReadTokens: typeof payload?.cacheReadTokens === 'number' ? payload.cacheReadTokens : 0,
			durationMs: typeof payload?.durationMs === 'number' ? payload.durationMs : 0,
		};
		if (delta.totalTokens <= 0) return;

		const accumulated = this.subtaskManager.accumulateTokens(routing.toolUseId, delta);
		this.bridge.emit(routing.parentSessionId, 'subtask', {
			subtask: {
				id: routing.toolUseId,
				...(routing.parentMessageId ? { messageID: routing.parentMessageId } : {}),
				childTokens: accumulated,
				...(typeof accumulated.durationMs === 'number' && accumulated.durationMs > 0
					? { durationMs: accumulated.durationMs }
					: {}),
				timestamp: new Date().toISOString(),
				agent: 'subagent',
				prompt: '',
				description: 'Subtask',
				status: 'running',
			},
		});
	}

	private syncChildSubtaskModel(
		updatedSessionId: string,
		record: Record<string, unknown> | undefined,
	): void {
		const childModelId = formatModelId(
			record && typeof record.providerID === 'string' ? record.providerID : undefined,
			record && typeof record.modelID === 'string' ? record.modelID : undefined,
		);
		if (!childModelId) return;
		const routing = this.subtaskManager.resolveRouting(updatedSessionId);
		if (!routing) return;
		this.bridge.emit(routing.parentSessionId, 'subtask', {
			subtask: {
				id: routing.toolUseId,
				...(routing.parentMessageId ? { messageID: routing.parentMessageId } : {}),
				childModelId,
				timestamp: new Date().toISOString(),
				agent: 'subagent',
				prompt: '',
				description: 'Subtask',
				status: 'running',
			},
		});
	}

	private getMetadataModelId(metadata: Record<string, unknown> | undefined): string | undefined {
		const metadataModel =
			metadata?.model && typeof metadata.model === 'object'
				? (metadata.model as Record<string, unknown>)
				: undefined;
		return formatModelId(
			metadataModel && typeof metadataModel.providerID === 'string'
				? metadataModel.providerID
				: undefined,
			metadataModel && typeof metadataModel.modelID === 'string'
				? metadataModel.modelID
				: undefined,
		);
	}

	private handlePermissionRuntimeEvent(event: CLIEvent, targetSessionId: string): void {
		const isChildPermission = this.sessionGraph.isChild(targetSessionId);
		const permissionTargetSessionId = isChildPermission
			? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
			: targetSessionId;
		const request = mapPermissionRuntimePayloadToRequest(event.data, permissionTargetSessionId);
		if (!request) return;

		this.bridge.emit(permissionTargetSessionId, 'permission', {
			action: 'upsert',
			request,
		});
		const requestId = request.id;
		const tool = request.permission;

		const autoRespond = (approved: boolean, alwaysAllow?: boolean) => {
			void this.cli
				.respondToPermission({ requestId, approved, alwaysAllow })
				.catch(error => logger.error('[ChatProvider] auto-response failed:', error));
			this.bridge.emit(permissionTargetSessionId, 'permission', {
				action: 'remove',
				requestId,
				response: approved ? (alwaysAllow ? 'always' : 'once') : 'reject',
			});
			this.bridge.emit(permissionTargetSessionId, 'access', {
				action: 'response',
				requestId,
				approved,
				...(alwaysAllow ? { alwaysAllow } : {}),
			});
		};

		const isAutoApprove = Boolean(this.settings.get('access.autoApprove'));
		const isAutoAccept = this.toolHandler.isAutoAccept(permissionTargetSessionId);
		if (isAutoApprove || isAutoAccept) {
			autoRespond(true);
			return;
		}

		const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();
		const normalizedTool = resolveToolName(tool) ?? tool.toLowerCase();
		if (alwaysAllowByTool[normalizedTool]) {
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

		this.bridge.emit(questionTargetSessionId, 'question', {
			action: 'upsert',
			request,
		});
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
			const metadataModelId = this.getMetadataModelId(metadata);

			const emitTaskPart = (status: 'pending' | 'running' | 'completed' | 'error') => {
				this.bridge.emit(parentSessionId, 'message_part', {
					part: buildTaskMessagePart(
						e,
						parentSessionId,
						toolUseId,
						toolName,
						event.normalizedEntry,
						status,
						input,
						metadata,
					),
				});
			};

			emitTaskPart('running');

			// Re-emitted tool_use with input that was missing on first emission.
			// Update the existing subtask card with prompt/description/agent.
			if (this.subtaskManager.isRegistered(toolUseId)) {
				if (knownChildSessionId) {
					this.linkKnownChildSession(toolUseId, parentSessionId, knownChildSessionId);
				}
				const hasInput = Object.keys(input).length > 0;
				if (hasInput) {
					this.bridge.emit(parentSessionId, 'subtask', {
						subtask: {
							id: toolUseId,
							...(typeof e.messageID === 'string' ? { messageID: e.messageID } : {}),
							...(knownChildSessionId
								? { childSessionId: knownChildSessionId, parentSessionId }
								: { parentSessionId }),
							agent: ChatProvider.safeString(input.subagent_type) || 'subagent',
							prompt: ChatProvider.safeString(input.prompt) || '',
							description: ChatProvider.safeString(input.description) || 'Subtask',
							toolInput: JSON.stringify(e.input),
							rawInput: input,
							status: 'running',
							...(metadataModelId ? { childModelId: metadataModelId } : {}),
							timestamp: new Date().toISOString(),
						},
					});
				}
				return;
			}

			// Create the subtask card immediately and register the subtask.
			// Post the message BEFORE registerSubtask — registerSubtask with a
			// known childSessionId immediately links the child, which means child
			// events will start routing via subtaskTranscript right away.
			this.bridge.emit(parentSessionId, 'subtask', {
				subtask: {
					id: toolUseId,
					partId: toolUseId,
					...(typeof e.messageID === 'string' ? { messageID: e.messageID } : {}),
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
					...(metadataModelId ? { childModelId: metadataModelId } : {}),
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
			});

			this.subtaskManager.registerSubtask(
				toolUseId,
				parentSessionId,
				knownChildSessionId,
				typeof e.messageID === 'string' ? e.messageID : undefined,
			);

			return;
		}

		if (isChildSession) {
			// Emit tool activity to the PARENT session so the subtask card
			// can show what the child agent is doing (e.g. "Writing file: foo.ts").
			const parentSessionId = this.sessionGraph.getParent(targetSessionId);
			if (parentSessionId) {
				const canonicalName = resolveToolName(toolName) ?? toolName;
				const label = getToolActivityLabel(canonicalName);
				this.bridge.emit(parentSessionId, 'status', {
					status: 'busy',
					statusText: label,
					toolActivity: {
						toolName: canonicalName,
						label,
						toolUseId,
					},
				});
			}
		} else {
			// Emit tool-specific activity status so the UI can show granular progress
			// (e.g. "Writing file...", "Running command...") instead of generic "Working...".
			const canonicalName = resolveToolName(toolName) ?? toolName;
			const label = getToolActivityLabel(canonicalName);
			this.bridge.emit(targetSessionId, 'status', {
				status: 'busy',
				statusText: label,
				toolActivity: {
					toolName: canonicalName,
					label,
					toolUseId,
				},
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
			this.bridge.emit(targetSessionId, 'status', {
				status: 'busy',
				statusText: 'Working...',
				toolActivity: null,
			});
		} else {
			// For child sessions, clear tool activity on the parent session.
			const parentSessionId = this.sessionGraph.getParent(targetSessionId);
			if (parentSessionId) {
				this.bridge.emit(parentSessionId, 'status', {
					status: 'busy',
					statusText: 'Working...',
					toolActivity: null,
				});
			}
		}

		if (isTaskTool(toolName)) {
			const metadata =
				e.metadata && typeof e.metadata === 'object'
					? (e.metadata as Record<string, unknown>)
					: undefined;
			const taskInput =
				e.input && typeof e.input === 'object' ? (e.input as Record<string, unknown>) : undefined;
			const metadataModelId = this.getMetadataModelId(metadata);
			const content =
				typeof e.content === 'string'
					? extractCanonicalTaskResult(e.content as string)
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
			if (!parentSessionId) return;
			const resolvedParentSessionId = parentSessionId;

			this.bridge.emit(resolvedParentSessionId, 'message_part', {
				part: buildTaskMessagePart(
					e,
					resolvedParentSessionId,
					toolUseId,
					toolName,
					event.normalizedEntry,
					e.is_error ? 'error' : 'completed',
					taskInput,
					metadata,
				),
			});

			this.bridge.emit(resolvedParentSessionId, 'subtask', {
				subtask: {
					id: toolUseId,
					partId: toolUseId,
					...(typeof e.messageID === 'string' ? { messageID: e.messageID } : {}),
					agent:
						typeof taskInput?.subagent_type === 'string'
							? (taskInput.subagent_type as string)
							: 'subagent',
					prompt: typeof taskInput?.prompt === 'string' ? (taskInput.prompt as string) : '',
					description:
						typeof taskInput?.description === 'string'
							? (taskInput.description as string)
							: 'Subtask',
					status: e.is_error ? 'error' : 'completed',
					result: content,
					...(childSessionId ? { childSessionId } : {}),
					parentSessionId: resolvedParentSessionId,
					...(metadataModelId ? { childModelId: metadataModelId } : {}),
					timestamp:
						typeof e.timestamp === 'string' ? (e.timestamp as string) : new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
			});
			this.bridge.emit(resolvedParentSessionId, 'complete', {
				partId: toolUseId,
				toolUseId,
				completedAt:
					typeof e.timestamp === 'string' ? new Date(e.timestamp as string).getTime() : undefined,
			});
			this.subtaskManager.completeSubtask(toolUseId);
			return;
		}

		// Non-task tool result
		const toolInputRaw = e.input;
		if (toolInputRaw && typeof toolInputRaw === 'object') {
			const toolInput = toolInputRaw as Record<string, unknown>;
			const filePath = extractFilePath(toolInput);

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

				this.bridge.emit(targetSessionId, 'file', {
					action: 'changed',
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
						this.bridge.emit(targetSessionId, 'file', {
							action: 'changed',
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
						this.bridge.emit(targetSessionId, 'file', {
							action: 'changed',
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

		if (!isChildSession) {
			const messageId = typeof e.messageID === 'string' ? e.messageID : toolUseId;
			const partId = typeof e.partId === 'string' ? e.partId : toolUseId;
			const metadata =
				e.metadata && typeof e.metadata === 'object'
					? remapLspDiagnosticsToFilePaths(
							e.metadata as Record<string, unknown>,
							toolInputRaw && typeof toolInputRaw === 'object'
								? collectChangedFilePaths(
										toolName,
										toolInputRaw as Record<string, unknown>,
										e.metadata as Record<string, unknown>,
									)
								: [],
							this.settings.getWorkspaceRoot(),
						)
					: undefined;
			this.bridge.emit(targetSessionId, 'message_part', {
				part: {
					id: partId,
					messageId: messageId,
					sessionId: targetSessionId,
					type: 'tool',
					callId: toolUseId,
					toolName,
					state: {
						status: e.is_error ? 'error' : 'completed',
						...(typeof e.content === 'string' ? { output: e.content as string } : {}),
						...(typeof e.title === 'string' ? { title: e.title } : {}),
						...(metadata ? { metadata } : {}),
						...(e.input ? { input: e.input } : {}),
					},
					normalizedEntry: event.normalizedEntry,
				},
			});
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

	private async sendInitialState(): Promise<void> {
		// Delegate to settingsHandler so opencode.json endpoints are merged.
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

		// Logging is handled by OutboundBridge.send() — no need to duplicate here.
		this.view.webview.postMessage(msg);
	}

	// ─── Child → Parent Transcript Routing ───────────────────────────────────

	/** Safely extract a non-empty string from unknown LLM input. */
	private static safeString(val: unknown): string | undefined {
		return typeof val === 'string' && val.trim().length > 0 ? val : undefined;
	}

	private linkKnownChildSession(
		toolUseId: string,
		parentSessionId: string,
		childSessionId: string,
	): void {
		const linked = this.subtaskManager.linkChildSession(childSessionId, toolUseId, parentSessionId);
		if (!linked) return;
		this.completeActiveThinking(parentSessionId);
	}

	private updateSubtaskLifecycle(
		childSessionId: string,
		update: Partial<import('../common').SessionSubtaskPayload['subtask']> & {
			timestamp?: string;
		},
	): void {
		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) return;
		this.bridge.emit(routing.parentSessionId, 'subtask', {
			subtask: {
				id: routing.toolUseId,
				...(routing.parentMessageId ? { messageID: routing.parentMessageId } : {}),
				childSessionId,
				parentSessionId: routing.parentSessionId,
				agent: update.agent || 'subagent',
				prompt: update.prompt || '',
				description: update.description || 'Subtask',
				status: 'running',
				...update,
				timestamp: update.timestamp || new Date().toISOString(),
			},
		});
	}

	// ─── Thinking Block Lifecycle ────────────────────────────────────────────

	/** Complete (close) the active thinking block for a session, if any. */
	private completeActiveThinking(sessionId: string): void {
		const activeThinking = this.activeThinkingPartIds.get(sessionId);
		if (activeThinking) {
			const { partId } = activeThinking;
			const completedAt = Date.now();
			if (!this.sessionGraph.isChild(sessionId)) {
				this.bridge.emit(sessionId, 'complete', { partId, toolUseId: partId, completedAt });
			}
			this.activeThinkingPartIds.delete(sessionId);
		}
	}

	dispose(): void {
		this.subtaskManager.clearAll();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
