import * as vscode from 'vscode';

import { OpenCodeExecutor } from '../core/executor/OpenCode';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { SessionGraph, SessionState } from '../core/SessionManager';
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

/**
 * Maps a tool name to its permission policy category (edit/terminal/network).
 * Returns undefined for unrecognized tools (falls through to 'ask' UI prompt).
 *
 * Uses exact-match Sets first, then word-boundary regex as fallback
 * to avoid false positives (e.g. "read_file_without_editing" matching "edit").
 */
function resolveToolPolicyCategory(tool: string): 'edit' | 'terminal' | 'network' | undefined {
	const normalized = tool.toLowerCase();

	// Exact known tool names (highest priority, no ambiguity).
	const exactEdit = new Set([
		'write',
		'edit',
		'multiedit',
		'multi_edit',
		'patch',
		'create',
		'writefile',
		'editfile',
		'write_file',
		'edit_file',
		'create_file',
		'apply_diff',
		'insert_code',
	]);
	const exactTerminal = new Set([
		'bash',
		'terminal',
		'shell',
		'command',
		'exec',
		'run',
		'execute',
		'run_command',
		'run_terminal_cmd',
	]);
	const exactNetwork = new Set([
		'fetch',
		'http',
		'curl',
		'request',
		'download',
		'mcp',
		'web_search',
		'http_request',
	]);

	if (exactEdit.has(normalized)) return 'edit';
	if (exactTerminal.has(normalized)) return 'terminal';
	if (exactNetwork.has(normalized)) return 'network';

	// Word-boundary regex fallback for dynamic/unknown tool names.
	const editPattern = /\b(write|edit|patch|create|overwrite|insert|replace|append|delete_file)\b/;
	const terminalPattern = /\b(bash|terminal|shell|command|exec|run)\b/;
	const networkPattern = /\b(fetch|http|curl|request|download|mcp|web_search)\b/;

	if (editPattern.test(normalized)) return 'edit';
	if (terminalPattern.test(normalized)) return 'terminal';
	if (networkPattern.test(normalized)) return 'network';

	return undefined;
}

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private cli: OpenCodeExecutor;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];
	private sessionGraph = new SessionGraph();
	private openCodeInitTimer: ReturnType<typeof setInterval> | null = null;

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
	private readonly bridge = new OutboundBridge();
	private readonly router = new CommandRouter();

	constructor(
		private context: vscode.ExtensionContext,
		private services: ServiceRegistry,
	) {
		this.settings = new Settings();
		this.sessionState = new SessionState();
		this.cli = new OpenCodeExecutor();

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

		const config = {
			provider: 'opencode' as const,
			workspaceRoot,
			agent: typeof opencodeAgent === 'string' ? opencodeAgent : undefined,
			autoApprove: Boolean(this.settings.get('autoApprove') || false),
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
				'getHooks',
				'getSubagents',
				'getRules',
				// Resource CRUD
				'createCommand',
				'deleteCommand',
				'createSkill',
				'deleteSkill',
				'createHook',
				'deleteHook',
				'createSubagent',
				'deleteSubagent',
				'toggleRule',
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
				'fetchMcpMarketplaceCatalog',
				'installMcpFromMarketplace',
				'saveMCPServer',
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
			],
			'provider',
		);

		// Tool / Access
		r.register(
			this.toolHandler,
			[
				'accessResponse',
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
				'openHookFile',
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
			this.toolHandler.handleMessage({ type: 'getAccess' }),
			this.settingsHandler.handleMessage({ type: 'getCommands' }),
			this.settingsHandler.handleMessage({ type: 'getSkills' }),
			this.settingsHandler.handleMessage({ type: 'getHooks' }),
			this.settingsHandler.handleMessage({ type: 'getSubagents' }),
			this.mcpHandler.handleMessage({ type: 'loadMCPServers' }),
			this.mcpHandler.handleMessage({
				type: 'fetchMcpMarketplaceCatalog',
				forceRefresh: false,
			}),
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
			this.sessionHandler.postSessionMessage({
				id: `error-${Date.now()}`,
				type: 'error',
				content: error instanceof Error ? error.message : 'Unknown error',
				isError: true,
				timestamp: new Date().toISOString(),
			});
			this.sessionHandler.postStatus(this.sessionState.activeSessionId, 'error', 'Error');
		}
	}

	private handleCliEvent(event: CLIEvent): void {
		const now = Date.now();
		// Skip verbose per-token logging for high-frequency delta events
		if (event.type !== 'thinking' && event.type !== 'message') {
			logger.debug(`[ChatProvider] handleCliEvent: ${event.type}`, event.data);
		}

		if (event.type === 'session_updated') {
			this.sessionHandler.handleSessionUpdatedEvent(event.data, event.sessionId);
			return;
		}

		// Resolve target session: events always go to their own session bucket.
		// Child session events stay in the child bucket — the parent only holds the subtask card.
		const targetSessionId = event.sessionId || this.sessionState.activeSessionId;

		if (!targetSessionId) {
			logger.warn(`[ChatProvider] Dropping event ${event.type}: no active session`);
			return;
		}

		// Determine if this event belongs to a known child session
		const isChildSession = this.sessionGraph.isChild(targetSessionId);

		// Reset subtask inactivity timer on any event from a known child session
		if (isChildSession) {
			this.resetSubtaskTimerByChild(targetSessionId);
		}

		// Deferred child→parent linking: if this event's session is unknown to the graph
		// but we have pending subtask tool IDs, this is the first event from a new child session.
		if (
			!isChildSession &&
			targetSessionId !== this.sessionState.activeSessionId &&
			this.pendingSubtaskToolIds.size > 0
		) {
			const parentSessionId = this.sessionState.activeSessionId;
			if (parentSessionId) {
				// Link the first pending subtask to this child session
				const pendingToolId = this.pendingSubtaskToolIds.values().next().value;
				if (pendingToolId) {
					this.pendingSubtaskToolIds.delete(pendingToolId);
					this.sessionGraph.registerChild(targetSessionId, parentSessionId, pendingToolId);

					// Now that we know the child session ID, wire it into the inactivity timer
					this.childSessionToToolUseId.set(targetSessionId, pendingToolId);
					this.resetSubtaskTimer(pendingToolId);

					logger.debug('[ChatProvider] Deferred child session linked', {
						childSessionId: targetSessionId,
						parentSessionId,
						toolUseId: pendingToolId,
					});

					// Update the subtask card's contextId in the parent session
					this.sessionHandler.postSessionMessage(
						{
							id: pendingToolId,
							type: 'subtask',
							contextId: targetSessionId,
							metadata: { childSessionId: targetSessionId },
							timestamp: new Date().toISOString(),
						},
						parentSessionId,
					);
				}
			}
		}

		switch (event.type) {
			case 'normalized_log': {
				break;
			}

			case 'turn_tokens': {
				this.sessionHandler.postTurnTokens(
					event.data as {
						inputTokens: number;
						outputTokens: number;
						totalTokens: number;
						cacheReadTokens: number;
						durationMs?: number;
						userMessageId?: string;
					},
					targetSessionId,
				);
				break;
			}

			case 'finished': {
				// Complete thinking block first (so durationMs is computed)
				this.completeActiveThinking(targetSessionId);
				const finishedPartId = this.activeAssistantPartIds.get(targetSessionId);
				if (finishedPartId) {
					this.sessionHandler.postComplete(finishedPartId, finishedPartId, targetSessionId);
					this.activeAssistantPartIds.delete(targetSessionId);
				}
				// NOTE: Do NOT send postStatus('idle') here.
				// The 'finished' event fires after each individual assistant message completes
				// (reason: message_completed), but in agentic chains the session is still busy —
				// the model will immediately make the next tool call. Sending 'idle' here causes
				// the UI to prematurely flip the Stop button to Send while the agent is still working.
				// The authoritative idle/busy status comes from the SDK's session_updated events,
				// which flow through handleSessionUpdatedEvent → postStatus. That is the single
				// source of truth for session processing state.
				break;
			}

			case 'message': {
				// Complete any active thinking block when assistant message starts
				this.completeActiveThinking(targetSessionId);

				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId =
					e.partId || this.activeAssistantPartIds.get(targetSessionId) || `part-${now}`;
				this.activeAssistantPartIds.set(targetSessionId, partId);

				const messageId = partId.startsWith('msg-') ? partId : `msg-${partId}`;

				this.sessionHandler.postSessionMessage(
					{
						id: messageId,
						type: 'assistant',
						partId,
						content: e.content || '',
						isStreaming: true,
						isDelta: e.isDelta ?? true,
						timestamp: new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
						contextId: isChildSession ? targetSessionId : undefined,
					},
					targetSessionId,
				);
				break;
			}

			case 'thinking': {
				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId = e.partId || `thinking-${now}`;

				// Complete previous thinking block if a new one starts
				const prevThinkingPartId = this.activeThinkingPartIds.get(targetSessionId);
				if (prevThinkingPartId && prevThinkingPartId !== partId) {
					this.sessionHandler.postComplete(prevThinkingPartId, prevThinkingPartId, targetSessionId);
				}
				this.activeThinkingPartIds.set(targetSessionId, partId);

				const thinkingId = partId.startsWith('thinking-') ? partId : `thinking-${partId}`;

				// Only send startTime on the first chunk (when no previous partId or different partId)
				const isFirstChunk = !prevThinkingPartId || prevThinkingPartId !== partId;

				this.sessionHandler.postSessionMessage(
					{
						id: thinkingId,
						type: 'thinking',
						partId,
						content: e.content || '',
						isDelta: e.isDelta ?? false,
						isStreaming: true,
						...(isFirstChunk ? { startTime: Date.now() } : {}),
						timestamp: new Date().toISOString(),
						contextId: isChildSession ? targetSessionId : undefined,
					},
					targetSessionId,
				);
				break;
			}

			case 'tool_use': {
				// Complete any active thinking block when tool_use starts
				this.completeActiveThinking(targetSessionId);
				this.handleToolUse(event, targetSessionId);
				break;
			}

			case 'tool_result': {
				this.handleToolResult(event, targetSessionId);
				break;
			}

			case 'error': {
				const errorId = `error-${now}`;
				this.sessionHandler.postSessionMessage(
					{
						id: errorId,
						type: 'error',
						content: (event.data as { message?: string }).message || 'Unknown error',
						isError: true,
						timestamp: new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
						contextId: isChildSession ? targetSessionId : undefined,
					},
					targetSessionId,
				);
				this.sessionHandler.postStatus(targetSessionId, 'error', 'Error');
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
						},
						targetSessionId,
					);
					void this.cli
						.respondToPermission({ requestId, approved, alwaysAllow })
						.catch(error => logger.error('[ChatProvider] auto-response failed:', error));
					this.bridge.session.accessResponse(targetSessionId, {
						requestId,
						approved,
						...(alwaysAllow ? { alwaysAllow } : {}),
					});
				};

				// Auto-approve everything if yoloMode or autoApprove is enabled in settings.
				const isYolo = Boolean(this.settings.get('access.yoloMode'));
				const isAutoApprove = Boolean(this.settings.get('access.autoApprove'));
				if (isYolo || isAutoApprove) {
					autoRespond(true);
					break;
				}

				const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();

				// Auto-approve if user previously marked this tool as always-allow.
				if (alwaysAllowByTool[tool]) {
					autoRespond(true, true);
					break;
				}

				// Auto-approve/deny based on permission policies (edit/terminal/network).
				const policies = this.toolHandler.getPermissionPolicies();
				const policyCategory = resolveToolPolicyCategory(tool);
				const policyValue = policyCategory ? policies[policyCategory] : undefined;

				if (policyValue === 'allow' || policyValue === 'deny') {
					autoRespond(policyValue === 'allow');
					break;
				}

				// Fall through: show the permission dialog in the webview.
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
					},
					targetSessionId,
				);
				break;
			}

			default:
				break;
		}
	}

	private handleToolUse(event: CLIEvent, targetSessionId: string): void {
		const now = Date.now();
		const e = event.data as Record<string, unknown>;
		const toolUseId = (e.id as string) || `tool-${now}`;
		const toolName = (e.name as string) || (e.tool as string) || 'unknown';

		if (toolName === 'task') {
			const eventSessionId = event.sessionId;
			// The task tool_use event comes from the PARENT's SSE stream,
			// so event.sessionId is the parent — NOT the child.
			// The real child session ID only becomes known when child events arrive later.
			const parentSessionId = this.sessionState.activeSessionId;

			// Only treat eventSessionId as child if it's genuinely different from parent
			const childSessionId =
				eventSessionId && eventSessionId !== parentSessionId ? eventSessionId : undefined;

			// Register in the session graph if we already know the child
			if (parentSessionId && childSessionId) {
				this.sessionGraph.registerChild(childSessionId, parentSessionId, toolUseId);
			} else {
				// Child session unknown — mark as pending for deferred linking
				this.pendingSubtaskToolIds.add(toolUseId);
			}

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
					// Only set contextId if we know the real child session
					contextId: childSessionId,
					metadata: childSessionId ? { childSessionId } : undefined,
				},
				parentSessionId,
			);

			// Start inactivity timer — if no child events arrive within the timeout,
			// we abort the child and synthesize an error so the parent continues.
			this.startSubtaskTimer(toolUseId, parentSessionId, childSessionId);
			return;
		}

		// Non-task tool: route to the event's own session bucket
		this.sessionHandler.postSessionMessage(
			{
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
				contextId: this.sessionGraph.isChild(targetSessionId) ? targetSessionId : undefined,
			},
			targetSessionId,
		);
	}

	private handleToolResult(event: CLIEvent, targetSessionId: string): void {
		const now = Date.now();
		const e = event.data as Record<string, unknown>;
		const toolUseId = (e.tool_use_id as string) || (e.id as string) || `tool-${now}`;
		const toolName = (e.name as string) || (e.tool as string) || 'unknown';

		if (toolName === 'task') {
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
			this.pendingSubtaskToolIds.delete(toolUseId);
			this.clearSubtaskTimer(toolUseId);

			const graphChildId = this.sessionGraph.getChildByTaskId(toolUseId);
			// Only use event.sessionId / extractedChildSessionId if they differ from the active (parent) session
			const fallbackChildId =
				event.sessionId && event.sessionId !== this.sessionState.activeSessionId
					? event.sessionId
					: extractedChildSessionId && extractedChildSessionId !== this.sessionState.activeSessionId
						? extractedChildSessionId
						: undefined;
			const childSessionId = graphChildId ?? fallbackChildId;

			// Resolve parent from graph first, fall back to active session
			const parentSessionId =
				(childSessionId && this.sessionGraph.getParent(childSessionId)) ||
				this.sessionState.activeSessionId;
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
					contextId: childSessionId,
					metadata: childSessionId ? { childSessionId } : undefined,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
				parentSessionId,
			);
			this.sessionHandler.postComplete(toolUseId, toolUseId, parentSessionId);
			return;
		}

		// Non-task tool result: route to the event's own session bucket
		const isChildSession = this.sessionGraph.isChild(targetSessionId);

		const toolInputRaw = e.input;
		let emittedFileChange = false;
		if (toolInputRaw && typeof toolInputRaw === 'object') {
			const toolInput = toolInputRaw as Record<string, unknown>;
			const filePath = typeof toolInput.filePath === 'string' ? toolInput.filePath : undefined;
			this.sessionHandler.postSessionMessage(
				{
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
					contextId: isChildSession ? targetSessionId : undefined,
				},
				targetSessionId,
			);

			if (filePath && !emittedFileChange) {
				const normalizedTool = toolName.toLowerCase();
				const isFileTool = ['write', 'edit', 'multiedit', 'patch'].includes(normalizedTool);
				if (isFileTool) {
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

					const oldLineCount = oldContent ? oldContent.split('\n').length : 0;
					const newLineCount = newContent ? newContent.split('\n').length : 0;

					this.bridge.session.fileChanged(targetSessionId, {
						filePath,
						fileName: filePath.split(/[/\\]/).pop() || filePath,
						linesAdded: Math.max(0, newLineCount - oldLineCount),
						linesRemoved: Math.max(0, oldLineCount - newLineCount),
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
		this.sessionHandler.postSessionMessage(
			{
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
				contextId: isChildSession ? targetSessionId : undefined,
			},
			targetSessionId,
		);
		this.sessionHandler.postComplete(toolUseId, toolUseId, targetSessionId);
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

	// ─── Subtask Inactivity Timeout ──────────────────────────────────────────

	/**
	 * Start an inactivity timer for a subtask. If no SSE event arrives from the
	 * child session within SUBTASK_INACTIVITY_TIMEOUT_MS, we abort the child
	 * and synthesize an error tool_result so the parent session continues.
	 */
	private startSubtaskTimer(
		toolUseId: string,
		parentSessionId?: string,
		childSessionId?: string,
	): void {
		this.clearSubtaskTimer(toolUseId);
		if (parentSessionId) {
			this.subtaskParentSessionByToolUseId.set(toolUseId, parentSessionId);
		}
		if (childSessionId) {
			this.childSessionToToolUseId.set(childSessionId, toolUseId);
		}
		const timer = setTimeout(() => {
			this.onSubtaskTimeout(toolUseId);
		}, ChatProvider.SUBTASK_INACTIVITY_TIMEOUT_MS);
		this.subtaskTimers.set(toolUseId, timer);
	}

	/** Reset the inactivity timer for a subtask (called on every child event). */
	private resetSubtaskTimer(toolUseId: string): void {
		const existing = this.subtaskTimers.get(toolUseId);
		if (!existing) return;
		clearTimeout(existing);
		const timer = setTimeout(() => {
			this.onSubtaskTimeout(toolUseId);
		}, ChatProvider.SUBTASK_INACTIVITY_TIMEOUT_MS);
		this.subtaskTimers.set(toolUseId, timer);
	}

	/** Reset timer by child session ID (convenience for handleCliEvent). */
	private resetSubtaskTimerByChild(childSessionId: string): void {
		const toolUseId = this.childSessionToToolUseId.get(childSessionId);
		if (toolUseId) this.resetSubtaskTimer(toolUseId);
	}

	private clearChildSessionLinkByToolUseId(toolUseId: string): void {
		for (const [childSessionId, mappedToolUseId] of this.childSessionToToolUseId.entries()) {
			if (mappedToolUseId === toolUseId) {
				this.childSessionToToolUseId.delete(childSessionId);
			}
		}
	}

	private clearSubtaskTimer(toolUseId: string): void {
		const timer = this.subtaskTimers.get(toolUseId);
		if (timer) {
			clearTimeout(timer);
			this.subtaskTimers.delete(toolUseId);
		}
		this.subtaskParentSessionByToolUseId.delete(toolUseId);
		this.clearChildSessionLinkByToolUseId(toolUseId);
	}

	private clearAllSubtaskTimers(): void {
		for (const timer of this.subtaskTimers.values()) clearTimeout(timer);
		this.subtaskTimers.clear();
		this.subtaskParentSessionByToolUseId.clear();
		this.childSessionToToolUseId.clear();
	}

	/** Fired when a subtask has been inactive for too long. */
	private onSubtaskTimeout(toolUseId: string): void {
		const parentSessionId =
			this.subtaskParentSessionByToolUseId.get(toolUseId) || this.sessionState.activeSessionId;
		this.subtaskTimers.delete(toolUseId);
		this.subtaskParentSessionByToolUseId.delete(toolUseId);

		// Find the child session associated with this tool
		const childSessionId = [...this.childSessionToToolUseId.entries()].find(
			([, tid]) => tid === toolUseId,
		)?.[0];

		logger.warn('[ChatProvider] Subtask inactivity timeout', {
			toolUseId,
			parentSessionId,
			childSessionId,
		});

		if (childSessionId) {
			this.childSessionToToolUseId.delete(childSessionId);
		}

		// Clean up pending tracking
		this.pendingSubtaskToolIds.delete(toolUseId);

		// Synthesize an error subtask result so the parent continues
		if (parentSessionId) {
			const now = Date.now();
			const errorContent = 'Subtask timed out — no activity for 60 seconds';

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
			//    Without this, the UI keeps waiting for a tool_result that never arrives.
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
			//    The OpenCode backend won't send idle because it doesn't know about
			//    the timeout — the parent would stay in "Working" state forever.
			if (this.subtaskTimers.size === 0 && this.pendingSubtaskToolIds.size === 0) {
				logger.debug('[ChatProvider] All subtasks resolved after timeout, sending idle', {
					parentSessionId,
				});
				this.sessionHandler.postStatus(parentSessionId, 'idle', 'Ready');
			}
		}
	}

	dispose(): void {
		this.clearOpenCodeInitTimer();
		this.clearAllSubtaskTimers();
		this.pendingSubtaskToolIds.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
