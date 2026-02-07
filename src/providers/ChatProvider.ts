import * as vscode from 'vscode';
import type { SessionEventMessage } from '../common';
import { computeDiffStats } from '../common/diffStats';
import { type CLIEvent, CLIRunner } from '../core/CLIRunner';
import type { ServiceRegistry } from '../core/ServiceRegistry';
import { SessionState } from '../core/SessionState';
import { Settings } from '../core/Settings';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';

import { FileHandler } from './handlers/FileHandler';
import { McpHandler } from './handlers/McpHandler';
import { ProviderHandler } from './handlers/ProviderHandler';
import { SessionHandler } from './handlers/SessionHandler';
import { SettingsHandler } from './handlers/SettingsHandler';
import { SseHandler } from './handlers/SseHandler';
import { ToolHandler } from './handlers/ToolHandler';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './handlers/types';

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private cli: CLIRunner;
	private settings: Settings;
	private sessionState: SessionState;
	private disposables: vscode.Disposable[] = [];

	private activeAssistantPartId: string | null = null;
	private subSessionParentMap = new Map<string, string>();
	private openCodeInitTimer: ReturnType<typeof setInterval> | null = null;

	// Handlers
	private sessionHandler: SessionHandler;
	private settingsHandler: SettingsHandler;
	private mcpHandler: McpHandler;
	private providerHandler: ProviderHandler;
	private toolHandler: ToolHandler;
	private fileHandler: FileHandler;
	private sseHandler: SseHandler;

	private handlers: Record<string, WebviewMessageHandler> = {};

	constructor(
		private context: vscode.ExtensionContext,
		private services: ServiceRegistry,
	) {
		this.settings = new Settings();
		this.sessionState = new SessionState();
		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		this.cli = new CLIRunner(provider);

		// Initialize Handlers
		const handlerContext: HandlerContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			view: { postMessage: msg => this.postMessage(msg) },
			sessionState: this.sessionState,
			services: this.services,
		};

		this.sessionHandler = new SessionHandler(handlerContext);
		this.settingsHandler = new SettingsHandler(handlerContext);
		this.mcpHandler = new McpHandler(handlerContext);
		this.providerHandler = new ProviderHandler(handlerContext);
		this.toolHandler = new ToolHandler(handlerContext);
		this.fileHandler = new FileHandler(handlerContext);
		this.sseHandler = new SseHandler(handlerContext);

		// Proxy Fetch Handler
		const proxyFetchHandler = {
			handleMessage: async (msg: WebviewMessage) => {
				if (msg.type === 'proxyFetch') {
					try {
						const { id, url, init } = msg as unknown as {
							id: string;
							url: string;
							init?: {
								method?: string;
								headers?: Record<string, string>;
								body?: string;
							};
						};

						// Use global fetch in extension host
						const response = await fetch(url, {
							method: init?.method,
							headers: init?.headers,
							body: init?.body,
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
							id: msg.id,
							ok: false,
							error: String(error),
						});
					}
				}
			},
		};

		this.handlers.proxyFetch = proxyFetchHandler;
		this.handlers.proxyFetchAbort = {
			handleMessage: async () => {
				// Abort not fully implemented on extension side yet as fetch is promise-based
				// But we acknowledge the message to prevent errors
			},
		};

		// Single-point OpenCode initialization with retry polling
		this.scheduleOpenCodeInit();

		this.registerHandlers();

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
		} catch (error) {
			logger.warn('[ChatProvider] Failed to start OpenCode:', error);
		}
	}

	private registerHandlers() {
		// Map message types to handlers
		const sessionTypes = [
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
		];
		sessionTypes.forEach(t => {
			this.handlers[t] = this.sessionHandler;
		});

		const settingsTypes = [
			'getSettings',
			'updateSettings',
			'getCommands',
			'getSkills',
			'getHooks',
			'getSubagents',
			'getRules',
		];
		settingsTypes.forEach(t => {
			this.handlers[t] = this.settingsHandler;
		});

		const mcpTypes = [
			'loadMCPServers',
			'fetchMcpMarketplaceCatalog',
			'installMcpFromMarketplace',
			'saveMCPServer',
			'deleteMCPServer',
			'openAgentsMcpConfig',
			'importMcpFromCLI',
			'syncAgentsToClaudeProject',
			'syncAgentsToOpenCodeProject',
		];
		mcpTypes.forEach(t => {
			this.handlers[t] = this.mcpHandler;
		});

		const providerTypes = [
			'reloadAllProviders',
			'checkOpenCodeStatus',
			'loadOpenCodeProviders',
			'loadAvailableProviders',
			'setOpenCodeProviderAuth',
			'disconnectOpenCodeProvider',
			'setOpenCodeModel',
			'selectModel',
			'loadProxyModels',
		];
		providerTypes.forEach(t => {
			this.handlers[t] = this.providerHandler;
		});

		const toolTypes = [
			'accessResponse',
			'getPermissions',
			'setPermissions',
			'checkDiscoveryStatus',
			'getAccess',
			'checkCLIDiagnostics',
		];
		toolTypes.forEach(t => {
			this.handlers[t] = this.toolHandler;
		});

		const fileTypes = [
			'openFile',
			'openFileDiff',
			'openExternal',
			'getImageData',
			'getClipboardContext',
		];
		fileTypes.forEach(t => {
			this.handlers[t] = this.fileHandler;
		});

		const sseTypes = ['sseSubscribe', 'sseClose'];
		sseTypes.forEach(t => {
			this.handlers[t] = this.sseHandler;
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
	}

	private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
		try {
			const msgType = msg.type;
			const handler = this.handlers[msgType];
			if (!handler) {
				logger.warn(`[ChatProvider] Unknown message type: ${msgType}`);
				return;
			}
			await handler.handleMessage(msg);
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
		logger.debug(`[ChatProvider] handleCliEvent: ${event.type}`, event.data);

		if (event.type === 'session_updated') {
			this.sessionHandler.handleSessionUpdatedEvent(event.data, event.sessionId);
			return;
		}

		let targetSessionId = event.sessionId || this.sessionState.activeSessionId;

		// Check if this session is a sub-session mapped to a parent
		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			targetSessionId = this.subSessionParentMap.get(event.sessionId) ?? targetSessionId;
		}

		if (!targetSessionId) {
			logger.warn(`[ChatProvider] Dropping event ${event.type}: no active session`);
			return;
		}

		switch (event.type) {
			case 'normalized_log': {
				// Pure data event for history/logs, no direct UI message by default
				// but can be attached to other messages or used for auditing
				// We don't need to post it as a separate session message unless requested
				break;
			}

			case 'finished': {
				if (this.activeAssistantPartId) {
					this.sessionHandler.postComplete(
						this.activeAssistantPartId,
						this.activeAssistantPartId,
						targetSessionId,
					);
					this.activeAssistantPartId = null;
				}
				this.sessionHandler.postStatus(targetSessionId, 'idle', 'Ready');
				break;
			}

			case 'message': {
				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId = e.partId || this.activeAssistantPartId || `part-${now}`;
				this.activeAssistantPartId = partId;

				// Determine context: prefer event.sessionId mapping
				let contextId: string | undefined;
				const messageTargetSessionId = targetSessionId;

				if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
					// Message from a known sub-session
					contextId = event.sessionId;
				}

				// Ensure unique ID for assistant message distinct from thinking block with same partId
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
						contextId,
					},
					messageTargetSessionId,
				);
				break;
			}

			case 'thinking': {
				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId = e.partId || `thinking-${now}`;

				// Determine context: prefer event.sessionId mapping
				let contextId: string | undefined;
				const thinkingTargetSessionId = targetSessionId;

				if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
					contextId = event.sessionId;
				}

				// Ensure unique ID for thinking block distinct from assistant message with same partId
				const thinkingId = partId.startsWith('thinking-') ? partId : `thinking-${partId}`;

				this.sessionHandler.postSessionMessage(
					{
						id: thinkingId,
						type: 'thinking',
						partId,
						content: e.content || '',
						isDelta: e.isDelta ?? false,
						timestamp: new Date().toISOString(),
						contextId,
					},
					thinkingTargetSessionId,
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
				const contextId =
					event.sessionId && this.subSessionParentMap.has(event.sessionId)
						? event.sessionId
						: undefined;

				this.sessionHandler.postSessionMessage(
					{
						id: errorId,
						type: 'error',
						content: (event.data as { message?: string }).message || 'Unknown error',
						isError: true,
						timestamp: new Date().toISOString(),
						normalizedEntry: event.normalizedEntry,
						contextId,
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

				const toolUseId = typeof e.toolUseId === 'string' ? (e.toolUseId as string) : undefined;

				const tool =
					(typeof e.tool === 'string' ? (e.tool as string) : undefined) ??
					(typeof e.permission === 'string' ? (e.permission as string) : undefined) ??
					'tool';

				const input =
					(e.input as Record<string, unknown> | undefined) ??
					(e.toolInput as Record<string, unknown> | undefined) ??
					{};

				const alwaysAllowByTool = this.toolHandler.getAlwaysAllowByTool();

				// Auto-approve if user previously marked this tool as always-allow.
				if (alwaysAllowByTool[tool]) {
					void this.cli
						.respondToPermission({ requestId, approved: true, alwaysAllow: true })
						.catch(error => logger.error('[ChatProvider] auto-approve failed:', error));
					this.postMessage({
						type: 'session_event',
						targetId: targetSessionId,
						eventType: 'access',
						payload: {
							eventType: 'access',
							action: 'response',
							requestId,
							approved: true,
							alwaysAllow: true,
						},
						timestamp: Date.now(),
						sessionId: targetSessionId,
					} satisfies SessionEventMessage);
					break;
				}

				const patterns = Array.isArray(e.patterns) ? (e.patterns as string[]) : undefined;

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
			// Register this sub-session to the current active session (Parent)
			const parentSessionId = this.sessionState.activeSessionId;
			// The event.sessionId here is likely the *Sub-Session* ID (allocated by OpenCode executor)
			if (parentSessionId && event.sessionId && event.sessionId !== parentSessionId) {
				this.subSessionParentMap.set(event.sessionId, parentSessionId);
			}

			const input = (e.input as Record<string, unknown>) || {};
			const childSessionId = event.sessionId;

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
					// Backend-first: contextId points to the REAL child session
					contextId: childSessionId,
					metadata: childSessionId ? { childSessionId } : undefined,
				},
				parentSessionId,
			);
			return;
		}

		// Check if this tool use belongs to a known sub-session
		let contextId: string | undefined;
		const toolUseTargetSessionId = targetSessionId;

		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			contextId = event.sessionId;
		}

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
				contextId,
			},
			toolUseTargetSessionId,
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

			const childSessionId = event.sessionId ?? extractedChildSessionId;

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
				// Card lives in parent
				this.sessionState.activeSessionId,
			);
			this.sessionHandler.postComplete(toolUseId, toolUseId, this.sessionState.activeSessionId);
			return;
		}

		// Determine context for subagent tool results
		let contextId: string | undefined;
		const toolResultTargetSessionId = targetSessionId;

		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			contextId = event.sessionId;
		}

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
					contextId,
				},
				toolResultTargetSessionId,
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

					const stats = computeDiffStats(oldContent, newContent);

					this.postMessage({
						type: 'session_event',
						targetId: toolResultTargetSessionId,
						eventType: 'file',
						payload: {
							eventType: 'file',
							action: 'changed',
							filePath,
							fileName: filePath.split(/[/\\]/).pop() || filePath,
							linesAdded: stats.added,
							linesRemoved: stats.removed,
							toolUseId,
						},
						timestamp: Date.now(),
						sessionId: toolResultTargetSessionId,
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
				timestamp: new Date().toISOString(),
				normalizedEntry: event.normalizedEntry,
				contextId,
			},
			toolResultTargetSessionId,
		);
		this.sessionHandler.postComplete(toolUseId, toolUseId, toolResultTargetSessionId);
	}

	private handleSettingsChange(): void {
		// Recreate CLI runner if provider changed
		this.settings.refresh();
		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';

		if (this.cli.getProvider() === provider) {
			logger.info('[ChatProvider] Provider unchanged, skipping CLI restart');
			this.postMessage({ type: 'configChanged' });
			return;
		}

		this.cli.dispose();

		this.cli = new CLIRunner(provider);
		this.cli.on('event', event => this.handleCliEvent(event));

		const handlerContext: HandlerContext = {
			extensionContext: this.context,
			settings: this.settings,
			cli: this.cli,
			view: { postMessage: msg => this.postMessage(msg) },
			sessionState: this.sessionState,
			services: this.services,
		};

		// Re-instantiate handlers with new CLI
		this.sessionHandler = new SessionHandler(handlerContext);
		this.settingsHandler = new SettingsHandler(handlerContext);
		this.mcpHandler = new McpHandler(handlerContext);
		this.providerHandler = new ProviderHandler(handlerContext);
		this.toolHandler = new ToolHandler(handlerContext);
		this.fileHandler = new FileHandler(handlerContext);

		// Restore workspace root for settings handler
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			this.settingsHandler.setWorkspaceRoot(workspaceRoot);
		}

		this.registerHandlers();

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
		} else {
			logger.debug('[ChatProvider] postMessage', {
				type: msgType,
				targetId: (msg as { targetId?: string })?.targetId,
			});
		}

		this.view.webview.postMessage(msg);
	}

	dispose(): void {
		this.clearOpenCodeInitTimer();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
		this.sseHandler.dispose();
	}
}
