import * as vscode from 'vscode';
import { PERMISSION_CATEGORIES, type PermissionCategory } from '../common/permissions';
import type { WebviewCommand } from '../common/protocol';
import { computeDiffLineStats, isFileEditTool, isTaskTool } from '../common/toolRegistry';
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

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private cli: OpenCodeExecutor;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];
	private sessionGraph = new SessionGraph();
	private openCodeInitTimer: ReturnType<typeof setInterval> | null = null;

	// Session / subtask tracking (delegated to SubtaskManager)
	private readonly subtaskManager: SubtaskManager;
	private readonly activeThinkingPartIds = new Map<string, string>();
	private readonly activeAssistantPartIds = new Map<string, string>();

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
		this.subtaskManager = new SubtaskManager(this.sessionGraph, this.sessionState, {
			onTimeout: toolUseId => this.onSubtaskTimeout(toolUseId),
		});

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
			registerCheckpoint: (commitId, record) =>
				this.restoreHandler.registerCheckpoint(commitId, record),
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
			this.services.mcpConfigWatcher.onConfigChanged(e =>
				this.bridge.data('mcpConfigReloaded', { source: e.source, timestamp: e.timestamp }),
			),
		);

		// Wire up ResourceWatcher — auto-refresh UI when .opencode/ resource files change
		this.disposables.push(
			this.services.resourceWatcher.onResourceChanged(async e => {
				logger.info(`[ChatProvider] Resource changed: ${e.resourceType}, refreshing UI`);
				try {
					const items = await this.services.resources.getAll(e.resourceType);
					const dataKeyMap = {
						commands: 'commandsList',
						skills: 'skillsList',
						hooks: 'hooksList',
						subagents: 'subagentsList',
					} as const;
					const key = dataKeyMap[e.resourceType];
					const payloadKeyMap = {
						commands: 'custom',
						skills: 'skills',
						hooks: 'hooks',
						subagents: 'subagents',
					} as const;
					this.bridge.data(key, { [payloadKeyMap[e.resourceType]]: items, isLoading: false });
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
	 * Polls for workspace root availability because VS Code may not populate
	 * `workspaceFolders` synchronously at extension activation time.
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

		// Workspace not ready yet — poll every 1s for up to 15s
		logger.info('[ChatProvider] Workspace root not available, polling until ready...');
		let attempts = 0;
		const MAX_ATTEMPTS = 15;
		const INTERVAL_MS = 1000;

		this.openCodeInitTimer = setInterval(() => {
			attempts++;
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

			if (workspaceRoot) {
				this.clearOpenCodeInitTimer();
				logger.info(`[ChatProvider] Workspace root appeared after ${attempts}s, starting OpenCode`);
				void this.doStartOpenCode(workspaceRoot);
				return;
			}

			if (attempts >= MAX_ATTEMPTS) {
				this.clearOpenCodeInitTimer();
				logger.warn(
					`[ChatProvider] Workspace root not available after ${MAX_ATTEMPTS}s, OpenCode not started`,
				);
			}
		}, INTERVAL_MS);
	}

	private clearOpenCodeInitTimer(): void {
		if (this.openCodeInitTimer) {
			clearInterval(this.openCodeInitTimer);
			this.openCodeInitTimer = null;
		}
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
				'checkDiscoveryStatus',
				'getAccess',
				'checkCLIDiagnostics',
			],
			'tool',
		);

		// File
		r.register(
			this.fileHandler,
			['openFile', 'openFileDiff', 'openExternal', 'getImageData', 'getClipboardContext'],
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

		// Utility (proxy fetch, resource files, git stage, workspace files)
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
		// Prevent duplicate syncAll during startup (opencode-start vs webview-syncAll race)
		if (this.hasSynced) {
			logger.info('[ChatProvider] syncAll skipped: already synced', { source });
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
		const requests: Promise<unknown>[] = [
			this.settingsHandler.handleMessage({ type: 'getSettings' }),
			this.toolHandler.handleMessage({ type: 'getPermissions' }),
			this.toolHandler.handleMessage({ type: 'getAccess' }),
			this.settingsHandler.handleMessage({ type: 'getCommands' }),
			this.settingsHandler.handleMessage({ type: 'getSkills' }),
			this.settingsHandler.handleMessage({ type: 'getSubagents' }),
			this.mcpHandler.handleMessage({ type: 'loadMCPServers' }),
			this.providerHandler.handleMessage({
				type: 'loadProxyModels',
				baseUrl: '',
				apiKey: '',
			}),
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
			.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.js'))
			.toString();
		const styleUri = webviewView.webview
			.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview.css'))
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

		// If OpenCode started before the webview mounted, run the deferred sync now.
		if (this.pendingSyncAll) {
			void this.syncAllOrDefer('deferred-after-view-ready');
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
			const silentCommands = new Set(['openFile', 'openFileDiff', 'openExternal', 'getImageData']);
			if (silentCommands.has(msg.type)) return;

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
		// Skip verbose per-token logging for high-frequency delta events
		if (event.type !== 'thinking' && event.type !== 'message') {
			logger.debug(`[ChatProvider] handleCliEvent: ${event.type}`, event.data);
		}

		if (event.type === 'session_updated') {
			// CRITICAL: Before routing session_updated to the handler (which adds sessionId
			// to startedSessions), check if this is a child session that needs deferred linking.
			const updatedSessionId = event.sessionId;
			if (updatedSessionId) {
				this.subtaskManager.tryLinkChildSession(updatedSessionId);
			}

			// Also reset inactivity timer for known child sessions on session_updated
			if (updatedSessionId && this.sessionGraph.isChild(updatedSessionId)) {
				this.subtaskManager.resetTimerByChild(updatedSessionId);

				const record = event.data as Record<string, unknown> | undefined;

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

		// Resolve target session: events always go to their own session bucket.
		// EXCEPT child session events — those are aggregated into the parent subtask's transcript.
		// STRICT: never fallback to activeSessionId — if event has no sessionId, drop it.
		const targetSessionId = event.sessionId;

		if (!targetSessionId) {
			logger.warn(`[ChatProvider] Dropping event ${event.type}: no sessionId in event payload`);
			return;
		}

		// Determine if this event belongs to a known child session
		let isChildSession = this.sessionGraph.isChild(targetSessionId);

		// Reset subtask inactivity timer on any event from a known child session
		if (isChildSession) {
			this.subtaskManager.resetTimerByChild(targetSessionId);
		}

		// Deferred child→parent linking: if this event's session is unknown to the graph
		// but we have pending subtask tool IDs, this is the first event from a new child session.
		if (!isChildSession && this.subtaskManager.tryLinkChildSession(targetSessionId)) {
			isChildSession = true;
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
						// For child sessions, post a complete marker into the parent transcript
						this.routeToParentTranscript(targetSessionId, {
							id: `complete-${finishedPartId}`,
							type: 'assistant',
							partId: finishedPartId,
							content: '',
							isStreaming: false,
							timestamp: new Date().toISOString(),
						});
					} else {
						this.sessionHandler.postComplete(finishedPartId, finishedPartId, targetSessionId);
					}
					this.activeAssistantPartIds.delete(targetSessionId);
				}
				break;
			}

			case 'message': {
				this.completeActiveThinking(targetSessionId);

				const e = event.data;
				const partId =
					e.partId || this.activeAssistantPartIds.get(targetSessionId) || `part-${now}`;
				this.activeAssistantPartIds.set(targetSessionId, partId);
				const messageId = partId.startsWith('msg-') ? partId : `msg-${partId}`;

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

				const prevThinkingPartId = this.activeThinkingPartIds.get(targetSessionId);
				if (prevThinkingPartId && prevThinkingPartId !== partId) {
					if (isChildSession) {
						this.routeToParentTranscript(targetSessionId, {
							id: `thinking-${prevThinkingPartId}`,
							type: 'thinking',
							partId: prevThinkingPartId,
							isStreaming: false,
							timestamp: new Date().toISOString(),
						});
					} else {
						this.sessionHandler.postComplete(
							prevThinkingPartId,
							prevThinkingPartId,
							targetSessionId,
						);
					}
				}
				this.activeThinkingPartIds.set(targetSessionId, partId);

				const thinkingId = partId.startsWith('thinking-') ? partId : `thinking-${partId}`;
				const isFirstChunk = !prevThinkingPartId || prevThinkingPartId !== partId;

				const thinkingData: import('../common').SessionMessageData = {
					id: thinkingId,
					type: 'thinking',
					partId,
					content: e.content || '',
					isDelta: e.isDelta ?? false,
					isStreaming: true,
					...(isFirstChunk ? { startTime: String(Date.now()) } : {}),
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
				this.handleToolUse(event, targetSessionId, isChildSession);
				break;
			}

			case 'tool_result': {
				this.handleToolResult(event, targetSessionId, isChildSession);
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
					this.routeToParentTranscript(targetSessionId, errorData);
				} else {
					this.sessionHandler.postSessionMessage(errorData, targetSessionId);
					this.sessionHandler.postStatus(targetSessionId, 'error', 'Error');
				}
				break;
			}
			case 'permission': {
				const e = event.data as Record<string, unknown>;
				const requestId =
					(typeof e.id === 'string' ? (e.id as string) : undefined) ??
					(typeof e.requestId === 'string' ? (e.requestId as string) : undefined);
				if (!requestId) {
					break;
				}

				// If this permission comes from a child session, route it to the parent
				// so the user actually sees the dialog (child session UI is not visible).
				// CRITICAL: Do NOT fall back to activeSessionId — it changes on tab switch.
				// If graph has no parent, fall back to targetSessionId itself (the child).
				const isChildPermission = this.sessionGraph.isChild(targetSessionId);
				const permissionTargetSessionId = isChildPermission
					? (this.sessionGraph.getParent(targetSessionId) ?? targetSessionId)
					: targetSessionId;

				const toolUseId =
					(typeof e.toolUseId === 'string' ? (e.toolUseId as string) : undefined) ??
					(typeof e.toolCallId === 'string' ? (e.toolCallId as string) : undefined);

				const tool =
					(typeof e.tool === 'string' ? (e.tool as string) : undefined) ??
					(typeof e.permission === 'string' ? (e.permission as string) : undefined) ??
					'tool';

				const input =
					(e.input as Record<string, unknown> | undefined) ??
					(e.toolInput as Record<string, unknown> | undefined) ??
					{};

				const patterns = Array.isArray(e.patterns) ? (e.patterns as string[]) : undefined;
				const metadata = e.metadata as Record<string, unknown> | undefined;

				// Helper: post a resolved access_request so ToolCard can show the diff,
				// then send the access response event to the webview.
				const autoRespond = (approved: boolean, alwaysAllow?: boolean) => {
					// Always create the access_request message (with metadata/diff)
					// so ToolCard.resolveDiffData() can find it via useAccessRequestByToolUseId.
					this.sessionHandler.postSessionMessage(
						{
							id: `access-${requestId}`,
							type: 'access_request',
							requestId,
							tool,
							toolUseId,
							input,
							pattern: patterns?.[0],
							resolved: true,
							approved,
							timestamp: new Date().toISOString(),
							metadata,
							...(isChildPermission ? { childSessionId: targetSessionId } : {}),
						},
						permissionTargetSessionId,
					);
					void this.cli
						.respondToPermission({ requestId, approved, alwaysAllow })
						.catch(error => logger.error('[ChatProvider] auto-response failed:', error));
					this.bridge.session.accessResponse(permissionTargetSessionId, {
						requestId,
						approved,
						...(alwaysAllow ? { alwaysAllow } : {}),
					});
				};

				// Auto-approve everything if yoloMode or autoApprove is enabled in settings.
				const isYolo = Boolean(this.settings.get('access.yoloMode'));
				const isAutoApprove = Boolean(this.settings.get('access.autoApprove'));
				logger.debug('[ChatProvider] Permission check', {
					tool,
					requestId,
					isYolo,
					isAutoApprove,
					isChildPermission,
				});
				if (isYolo || isAutoApprove) {
					logger.debug('[ChatProvider] Auto-approve via yolo/autoApprove');
					autoRespond(true);
					break;
				}

				const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();

				// Auto-approve if user previously marked this tool as always-allow.
				if (alwaysAllowByTool[tool]) {
					logger.debug('[ChatProvider] Auto-approve via alwaysAllowByTool', { tool });
					autoRespond(true, true);
					break;
				}

				// Auto-approve/deny based on permission policies.
				// OpenCode sends the category name directly in the `permission` field
				// (e.g. "edit", "bash", "webfetch") — no mapping needed.
				const policies = this.toolHandler.getPermissionPolicies();
				const policyCategory = PERMISSION_CATEGORIES.includes(tool as PermissionCategory)
					? (tool as PermissionCategory)
					: undefined;
				const policyValue = policyCategory ? policies[policyCategory] : undefined;
				logger.debug('[ChatProvider] Policy resolution', {
					tool,
					policyCategory,
					policyValue,
				});

				if (policyValue === 'allow' || policyValue === 'deny') {
					logger.debug('[ChatProvider] Auto-respond via policy', { policyValue });
					autoRespond(policyValue === 'allow');
					break;
				}

				// Fall through: show the permission dialog in the webview.
				// Use permissionTargetSessionId so child session permissions
				// are shown in the parent session (which the user is viewing).
				this.sessionHandler.postSessionMessage(
					{
						id: `access-${requestId}`,
						type: 'access_request',
						requestId,
						tool,
						toolUseId,
						input,
						pattern: patterns?.[0],
						resolved: false,
						timestamp: new Date().toISOString(),
						metadata,
						...(isChildPermission ? { childSessionId: targetSessionId } : {}),
					},
					permissionTargetSessionId,
				);
				break;
			}

			case 'question': {
				// event.data is already typed as QuestionEventData via discriminated CLIEvent union.
				const q = event.data;
				this.sessionHandler.postSessionMessage(
					{
						id: `question-${q.requestId}`,
						type: 'question',
						requestId: q.requestId,
						questions: q.questions,
						tool: q.tool,
						resolved: false,
						timestamp: new Date().toISOString(),
					},
					targetSessionId,
				);
				break;
			}

			default:
				break;
		}
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

			// Child session ID is unknown — deferred linking will resolve it later.
			this.subtaskManager.registerSubtask(toolUseId, parentSessionId);

			const input = (e.input as Record<string, unknown>) || {};

			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					toolUseId,
					toolName,
					agent: (input.subagent_type as string) || 'subagent',
					prompt: (input.prompt as string) || '',
					description: (input.description as string) || 'Running subtask...',
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
		} else {
			this.sessionHandler.postSessionMessage(toolData, targetSessionId);
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

		if (isTaskTool(toolName)) {
			const content =
				typeof e.content === 'string'
					? (e.content as string)
					: e.content
						? JSON.stringify(e.content)
						: '';
			const sessionIdMatch = content.match(
				/<task_metadata>\s*session_id:\s*(.*?)\s*<\/task_metadata>/s,
			);
			const extractedChildSessionId = sessionIdMatch ? sessionIdMatch[1].trim() : undefined;

			// Clean up pending tracking and inactivity timer for this tool
			this.subtaskManager.completeSubtask(toolUseId);

			const graphChildId = this.sessionGraph.getChildByTaskId(toolUseId);
			// Determine child session ID: use event.sessionId or extracted ID, but only if
			// it's not a known top-level session (tab). Previously compared against activeSessionId,
			// which breaks after tab switch — activeSessionId becomes a third unrelated session.
			const storedParent = this.subtaskManager.getParentSession(toolUseId);
			const fallbackChildId =
				event.sessionId &&
				!this.sessionState.startedSessions.has(event.sessionId) &&
				event.sessionId !== storedParent
					? event.sessionId
					: extractedChildSessionId &&
							!this.sessionState.startedSessions.has(extractedChildSessionId) &&
							extractedChildSessionId !== storedParent
						? extractedChildSessionId
						: undefined;
			const childSessionId = graphChildId ?? fallbackChildId;

			// Resolve parent from graph first, then stored parent, then event.sessionId.
			// CRITICAL: Do NOT fall back to activeSessionId — it changes on tab switch.
			const parentSessionId =
				(childSessionId && this.sessionGraph.getParent(childSessionId)) ||
				this.subtaskManager.getParentSession(toolUseId) ||
				event.sessionId;
			if (childSessionId && parentSessionId && !this.sessionGraph.isChild(childSessionId)) {
				this.sessionGraph.registerChild(childSessionId, parentSessionId, toolUseId);
			}

			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					status: 'completed',
					result: content,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
				parentSessionId,
			);
			this.sessionHandler.postComplete(toolUseId, toolUseId, parentSessionId);
			return;
		}

		// Non-task tool result
		const toolInputRaw = e.input;
		let emittedFileChange = false;
		if (toolInputRaw && typeof toolInputRaw === 'object') {
			const toolInput = toolInputRaw as Record<string, unknown>;
			const filePath = typeof toolInput.filePath === 'string' ? toolInput.filePath : undefined;
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

			if (filePath && !emittedFileChange) {
				if (isFileEditTool(toolName)) {
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
					emittedFileChange = true;
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
	}

	private handleSettingsChange(): void {
		this.settings.refresh();
		this.bridge.send({ type: 'configChanged' });
	}

	private sendInitialState(): void {
		this.bridge.data('settingsData', this.settings.getAll());
		this.bridge.data(
			'accessData',
			Object.entries(this.toolHandler.getAlwaysAllowByTool())
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		);
	}

	public postMessage(msg: unknown): void {
		if (!this.view) {
			logger.error('[ChatProvider] postMessage called but view is not initialized!', {
				messageType: (msg as { type?: string })?.type,
			});
			return;
		}

		const msgType = (msg as { type?: string })?.type;

		// Extra diagnostics for conversation list
		if (msgType === 'conversationList') {
			const data = (msg as { data?: unknown })?.data;
			logger.info('[ChatProvider] postMessage conversationList', {
				isArray: Array.isArray(data),
				count: Array.isArray(data) ? data.length : 'N/A',
			});
		} else if (msgType !== 'session_event') {
			logger.debug('[ChatProvider] postMessage', {
				type: msgType,
				targetId: (msg as { targetId?: string })?.targetId,
			});
		}

		this.view.webview.postMessage(msg);
	}

	// ─── Child → Parent Transcript Routing ───────────────────────────────────

	/**
	 * Route a child session message into the parent subtask's transcript.
	 * Returns true if the message was routed, false if no parent/subtask found.
	 */
	private routeToParentTranscript(
		childSessionId: string,
		childMessage: import('../common').SessionMessageData,
	): boolean {
		const routing = this.subtaskManager.resolveRouting(childSessionId);
		if (!routing) return false;
		this.bridge.session.subtaskTranscript(routing.parentSessionId, routing.toolUseId, childMessage);
		return true;
	}

	// ─── Thinking Block Lifecycle ────────────────────────────────────────────

	/** Complete (close) the active thinking block for a session, if any. */
	private completeActiveThinking(sessionId: string): void {
		const thinkingPartId = this.activeThinkingPartIds.get(sessionId);
		if (thinkingPartId) {
			this.sessionHandler.postComplete(thinkingPartId, thinkingPartId, sessionId);
			this.activeThinkingPartIds.delete(sessionId);
		}
	}

	// ─── Subtask Timeout Handler ─────────────────────────────────────────────

	/** Fired when a subtask has been inactive for too long (callback from SubtaskManager). */
	private onSubtaskTimeout(toolUseId: string): void {
		const routing = this.subtaskManager.resolveRouting(
			// Find child session ID from the graph by task tool call ID
			this.sessionGraph.getChildByTaskId(toolUseId) ?? '',
		);
		const parentSessionId =
			routing?.parentSessionId ?? this.subtaskManager.getParentSession(toolUseId);
		const childSessionId = this.sessionGraph.getChildByTaskId(toolUseId);

		logger.warn('[ChatProvider] Subtask inactivity timeout', {
			toolUseId,
			parentSessionId,
			childSessionId,
		});

		// Clean up all subtask state
		this.subtaskManager.completeSubtask(toolUseId);

		// Synthesize an error subtask result so the parent continues
		if (parentSessionId) {
			// Abort the child session on the backend so it doesn't hang forever
			if (childSessionId && this.cli.abortSession) {
				void this.cli
					.abortSession(childSessionId)
					.catch(error =>
						logger.warn('[ChatProvider] Failed to abort timed-out child session:', error),
					);
			}

			const now = Date.now();
			const errorContent = 'Subtask timed out — no activity for 30 seconds';

			// 1. Update the subtask card to show error state
			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					toolUseId,
					toolName: 'task',
					status: 'error',
					content: errorContent,
					isError: true,
					isRunning: false,
					timestamp: new Date().toISOString(),
				},
				parentSessionId,
			);

			// 2. Synthesize a tool_result so the webview marks this tool as completed.
			this.sessionHandler.postSessionMessage(
				{
					id: `${toolUseId}-result-${now}`,
					type: 'tool_result',
					partId: toolUseId,
					toolUseId,
					toolName: 'task',
					content: errorContent,
					isError: true,
					timestamp: new Date().toISOString(),
				},
				parentSessionId,
			);

			this.sessionHandler.postComplete(toolUseId, toolUseId, parentSessionId);

			// 3. If no more subtasks are pending/running, transition parent to idle.
			if (!this.subtaskManager.hasActiveSubtasks()) {
				logger.debug('[ChatProvider] All subtasks resolved after timeout, sending idle', {
					parentSessionId,
				});
				this.sessionHandler.postStatus(parentSessionId, 'idle', 'Ready');
			}
		}
	}

	dispose(): void {
		this.clearOpenCodeInitTimer();
		this.subtaskManager.clearAll();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
