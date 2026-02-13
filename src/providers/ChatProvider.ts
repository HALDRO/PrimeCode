import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionEventMessage } from '../common';

import type { WebviewCommand } from '../common/webviewCommands';
import { type CLIEvent, CLIRunner } from '../core/CLIRunner';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { SessionGraph, SessionState } from '../core/SessionManager';
import { Settings } from '../core/Settings';
import { getWorkspacePath, searchWorkspaceFiles } from '../services/fileSearch';
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
import type { HandlerContext, WebviewMessageHandler } from './handlers/types';

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
	private cli: CLIRunner;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];

	/** Per-session active assistant part IDs — avoids cross-contamination between concurrent subagents. */
	private activeAssistantPartIds = new Map<string, string>();
	private sessionGraph = new SessionGraph();
	private openCodeInitTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Tracks pending subtask tool_use IDs that haven't been linked to a child session yet.
	 * When a `task` tool_use arrives, the child session ID is unknown (event.sessionId is the parent).
	 * We store the toolUseId here and link it when the first child event arrives.
	 */
	private pendingSubtaskToolIds = new Set<string>();

	// Handlers
	private sessionHandler: SessionHandler;
	private settingsHandler: SettingsHandler;
	private mcpHandler: McpHandler;
	private providerHandler: ProviderHandler;
	private toolHandler: ToolHandler;
	private fileHandler: FileHandler;
	private sseHandler: SseHandler;
	private restoreHandler: RestoreHandler;

	private pendingSyncAll = false;

	constructor(
		private context: vscode.ExtensionContext,
		private services: ServiceRegistry,
	) {
		this.settings = new Settings();
		this.sessionState = new SessionState();
		this.cli = new CLIRunner();

		// Initialize Handlers
		// RestoreHandler is created first so its registerCheckpoint can be wired into the context
		this.restoreHandler = new RestoreHandler({
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			view: { postMessage: msg => this.postMessage(msg) },
			sessionState: this.sessionState,
			services: this.services,
			sessionGraph: this.sessionGraph,
		});

		const handlerContext: HandlerContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			view: { postMessage: msg => this.postMessage(msg) },
			sessionState: this.sessionState,
			services: this.services,
			sessionGraph: this.sessionGraph,
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

		// Proxy Fetch Handler
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
				this.postMessage(msg);
			}),
		);

		// Wire up McpConfigWatcher config change events
		this.disposables.push(
			this.services.mcpConfigWatcher.onConfigChanged(e =>
				this.postMessage({
					type: 'mcpConfigReloaded',
					data: { source: e.source, timestamp: e.timestamp },
				}),
			),
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
	 * Maps a webview command to its handler via exhaustive switch.
	 * Returns null for unimplemented types (logged as TODO).
	 */
	private resolveHandler(msg: WebviewCommand): WebviewMessageHandler | null {
		switch (msg.type) {
			// Session
			case 'webviewDidLaunch':
			case 'createSession':
			case 'switchSession':
			case 'closeSession':
			case 'sendMessage':
			case 'stopRequest':
			case 'improvePromptRequest':
			case 'cancelImprovePrompt':
			case 'getConversationList':
			case 'loadConversation':
			case 'deleteConversation':
			case 'renameConversation':
				return this.sessionHandler;

			// Settings
			case 'getSettings':
			case 'updateSettings':
			case 'getCommands':
			case 'getSkills':
			case 'getHooks':
			case 'getSubagents':
			case 'getRules':
				return this.settingsHandler;

			// MCP
			case 'loadMCPServers':
			case 'fetchMcpMarketplaceCatalog':
			case 'installMcpFromMarketplace':
			case 'saveMCPServer':
			case 'deleteMCPServer':
			case 'openAgentsMcpConfig':
			case 'importMcpFromCLI':
			case 'syncAgentsToOpenCodeProject':
				return this.mcpHandler;

			// Provider
			case 'reloadAllProviders':
			case 'checkOpenCodeStatus':
			case 'loadOpenCodeProviders':
			case 'loadAvailableProviders':
			case 'setOpenCodeProviderAuth':
			case 'disconnectOpenCodeProvider':
			case 'setOpenCodeModel':
			case 'selectModel':
			case 'loadProxyModels':
				return this.providerHandler;

			// Tool / Access
			case 'accessResponse':
			case 'getPermissions':
			case 'setPermissions':
			case 'checkDiscoveryStatus':
			case 'getAccess':
			case 'checkCLIDiagnostics':
				return this.toolHandler;

			// File
			case 'openFile':
			case 'openFileDiff':
			case 'openExternal':
			case 'getImageData':
			case 'getClipboardContext':
				return this.fileHandler;

			// SSE
			case 'sseSubscribe':
			case 'sseClose':
				return this.sseHandler;

			// Restore
			case 'restoreCommit':
			case 'unrevert':
				return this.restoreHandler;

			// Orchestration
			case 'syncAll':
				return {
					handleMessage: async () => {
						await this.syncAllOrDefer('webview-syncAll');
					},
				};

			// Proxy
			case 'proxyFetch':
				return {
					handleMessage: async (m: WebviewCommand) => {
						if (m.type !== 'proxyFetch') return;
						try {
							const { id, url, options } = m;
							const response = await fetch(url, {
								method: options?.method,
								headers: options?.headers,
								body: options?.body,
							});
							const bodyText = await response.text();
							const headers: Record<string, string> = {};
							response.headers.forEach((value, key) => {
								headers[key] = value;
							});
							this.postMessage({
								type: 'proxyFetchResult',
								id,
								ok: response.ok,
								status: response.status,
								statusText: response.statusText,
								headers,
								bodyText,
							});
						} catch (error) {
							logger.error('[ChatProvider] proxyFetch failed:', error);
							this.postMessage({
								type: 'proxyFetchResult',
								id: m.id,
								ok: false,
								error: String(error),
							});
						}
					},
				};
			case 'proxyFetchAbort':
				// Abort not fully implemented — fetch is promise-based
				return { handleMessage: async () => {} };

			case 'openCommandFile':
			case 'openSkillFile':
			case 'openHookFile':
			case 'openSubagentFile': {
				const services = this.services;
				const name = (msg as { name: string }).name;
				return {
					async handleMessage() {
						const root = vscode.workspace.workspaceFolders?.[0]?.uri;
						if (!root || !name) return;
						let relativePath: string | undefined;
						switch (msg.type) {
							case 'openCommandFile': {
								const items = await services.agentsCommands.getAll();
								relativePath = items.find(c => c.name === name)?.path;
								break;
							}
							case 'openSkillFile': {
								const items = await services.agentsSkills.getAll();
								relativePath = items.find(s => s.name === name)?.path;
								break;
							}
							case 'openHookFile': {
								const items = await services.agentsHooks.getAll();
								relativePath = items.find(h => h.name === name)?.path;
								break;
							}
							case 'openSubagentFile': {
								const items = await services.agentsSubagents.getAll();
								relativePath = items.find(s => s.name === name)?.path;
								break;
							}
						}
						if (!relativePath) {
							logger.warn(`[ChatProvider] Resource not found: ${msg.type} name=${name}`);
							return;
						}
						const fileUri = vscode.Uri.joinPath(root, relativePath);
						await vscode.window.showTextDocument(fileUri);
					},
				};
			}

			// TODO: Agents CRUD — not yet implemented
			case 'createSkill':
			case 'deleteSkill':
			case 'importSkillsFromCLI':
			case 'syncSkillsToCLI':
			case 'createHook':
			case 'deleteHook':
			case 'importHooksFromCLI':
			case 'syncHooksToCLI':
			case 'createCommand':
			case 'deleteCommand':
			case 'importCommandsFromCLI':
			case 'syncCommandsToCLI':
			case 'createSubagent':
			case 'deleteSubagent':
			case 'importSubagentsFromCLI':
			case 'syncSubagentsToCLI':
			case 'toggleRule':
			// File actions: accept (git stage)
			case 'acceptFile': {
				const filePath = (msg as { filePath: string }).filePath;
				return {
					async handleMessage() {
						try {
							const uri = vscode.Uri.file(filePath);
							await vscode.commands.executeCommand('git.stage', uri);
							logger.info('[ChatProvider] Staged file', { filePath });
						} catch (err) {
							logger.error('[ChatProvider] Failed to stage file', { filePath, err });
						}
					},
				};
			}
			case 'acceptAllFiles': {
				const filePaths = (msg as { filePaths: string[] }).filePaths;
				return {
					async handleMessage() {
						for (const fp of filePaths) {
							try {
								const uri = vscode.Uri.file(fp);
								await vscode.commands.executeCommand('git.stage', uri);
							} catch (err) {
								logger.error('[ChatProvider] Failed to stage file', { filePath: fp, err });
							}
						}
						logger.info('[ChatProvider] Staged all files', { count: filePaths.length });
					},
				};
			}
			// TODO: File actions — not yet implemented
			case 'undoFileChanges':
			case 'undoAllChanges':
			case 'copyLastResponse':
			case 'copyAllMessages':
			case 'copyLastDiffs':
			case 'copyAllDiffs':
			case 'getWorkspaceFiles': {
				const self = this;
				return {
					async handleMessage() {
						const wsPath = getWorkspacePath();
						if (!wsPath) return;
						const searchTerm = (msg as { searchTerm?: string }).searchTerm ?? '';
						const results = await searchWorkspaceFiles(searchTerm, wsPath, 50);
						const files = results.map(r => ({
							name: r.label,
							path: r.path,
							fsPath: path.join(wsPath, r.path),
						}));
						self.postMessage({ type: 'workspaceFiles', data: files });
					},
				};
			}
			// TODO: Missing handlers
			case 'clearAllConversations':
				logger.warn(`[ChatProvider] Unimplemented message type: ${msg.type}`);
				return null;
		}
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
		this.postMessage({ type: 'accessData', data: [] });

		// If OpenCode started before the webview mounted, run the deferred sync now.
		if (this.pendingSyncAll) {
			void this.syncAllOrDefer('deferred-after-view-ready');
		}
	}

	private async handleWebviewMessage(msg: WebviewCommand): Promise<void> {
		try {
			const handler = this.resolveHandler(msg);
			if (handler) {
				await handler.handleMessage(msg);
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

			case 'finished': {
				const finishedPartId = this.activeAssistantPartIds.get(targetSessionId);
				if (finishedPartId) {
					this.sessionHandler.postComplete(finishedPartId, finishedPartId, targetSessionId);
					this.activeAssistantPartIds.delete(targetSessionId);
				}
				if (!this.sessionState.isStopGuarded()) {
					this.sessionHandler.postStatus(targetSessionId, 'idle', 'Ready');
				}
				break;
			}

			case 'message': {
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

				const thinkingId = partId.startsWith('thinking-') ? partId : `thinking-${partId}`;

				this.sessionHandler.postSessionMessage(
					{
						id: thinkingId,
						type: 'thinking',
						partId,
						content: e.content || '',
						isDelta: e.isDelta ?? false,
						timestamp: new Date().toISOString(),
						contextId: isChildSession ? targetSessionId : undefined,
					},
					targetSessionId,
				);
				break;
			}

			case 'tool_use': {
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
					this.postMessage({
						type: 'session_event',
						targetId: targetSessionId,
						eventType: 'access',
						payload: {
							eventType: 'access',
							action: 'response',
							requestId,
							approved,
							...(alwaysAllow ? { alwaysAllow } : {}),
						},
						timestamp: Date.now(),
						sessionId: targetSessionId,
					} satisfies SessionEventMessage);
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

			// Clean up pending tracking for this tool
			this.pendingSubtaskToolIds.delete(toolUseId);

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

					this.postMessage({
						type: 'session_event',
						targetId: targetSessionId,
						eventType: 'file',
						payload: {
							eventType: 'file',
							action: 'changed',
							filePath,
							fileName: filePath.split(/[/\\]/).pop() || filePath,
							linesAdded: Math.max(0, newLineCount - oldLineCount),
							linesRemoved: Math.max(0, oldLineCount - newLineCount),
							toolUseId,
						},
						timestamp: Date.now(),
						sessionId: targetSessionId,
					} satisfies SessionEventMessage);
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
		this.postMessage({ type: 'configChanged' });
	}

	private sendInitialState(): void {
		this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
		this.postMessage({
			type: 'accessData',
			data: Object.entries(this.toolHandler.getAlwaysAllowByTool())
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		});
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

	dispose(): void {
		this.clearOpenCodeInitTimer();
		this.pendingSubtaskToolIds.clear();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
