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
	/**
	 * Tracks the currently active subtask (task tool) execution.
	 * When set, all incoming messages are routed to this context bucket
	 * until the corresponding tool_result is received.
	 */
	private activeSubtaskContext: {
		toolUseId: string;
		contextId: string;
		parentSessionId: string;
	} | null = null;

	// Handlers
	private sessionHandler: SessionHandler;
	private settingsHandler: SettingsHandler;
	private mcpHandler: McpHandler;
	private providerHandler: ProviderHandler;
	private toolHandler: ToolHandler;
	private fileHandler: FileHandler;

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

		// Proactive start for OpenCode if configured
		this.maybeStartOpenCode();

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
	}

	private async maybeStartOpenCode() {
		const provider = this.cli.getProvider();
		if (provider !== 'opencode') return;

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return;

		// Check if auto-start is disabled (default true)
		const autoStart = this.settings.get('opencode.autoStart') !== false;
		if (!autoStart) return;

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
			logger.info('[ChatProvider] Proactively starting OpenCode server...');
			await this.cli.start(config);
		} catch (error) {
			logger.warn('[ChatProvider] Failed to proactively start OpenCode:', error);
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

		webviewView.webview.html = getHtml(
			scriptUri,
			styleUri,
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
		let targetSessionId = event.sessionId || this.sessionState.activeSessionId;

		// Check if this session is a sub-session mapped to a parent
		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			targetSessionId = this.subSessionParentMap.get(event.sessionId) ?? targetSessionId;
		}

		logger.debug(`[ChatProvider] handleCliEvent: ${event.type}`, event.data);

		if (event.type === 'session_updated') {
			this.sessionHandler.handleSessionUpdatedEvent(event.data);
			return;
		}

		switch (event.type) {
			case 'normalized_log': {
				// Pure data event for history/logs, no direct UI message by default
				// but can be attached to other messages or used for auditing
				// We don't need to post it as a separate session message unless requested
				break;
			}

			case 'message': {
				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId = e.partId || this.activeAssistantPartId || `part-${now}`;
				this.activeAssistantPartId = partId;

				// Determine context: prefer event.sessionId mapping, fallback to activeSubtaskContext
				let contextId: string | undefined;
				let messageTargetSessionId = targetSessionId;

				if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
					// Message from a known sub-session
					contextId = event.sessionId;
				} else if (this.activeSubtaskContext) {
					// Message during active subtask - route to subtask context bucket
					contextId = this.activeSubtaskContext.contextId;
					// Keep target as parent session but messages will be stored in context bucket
					messageTargetSessionId = this.activeSubtaskContext.parentSessionId;
				}

				this.sessionHandler.postSessionMessage(
					{
						id: partId,
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

				// Determine context: prefer event.sessionId mapping, fallback to activeSubtaskContext
				let contextId: string | undefined;
				let thinkingTargetSessionId = targetSessionId;

				if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
					contextId = event.sessionId;
				} else if (this.activeSubtaskContext) {
					contextId = this.activeSubtaskContext.contextId;
					thinkingTargetSessionId = this.activeSubtaskContext.parentSessionId;
				}

				this.sessionHandler.postSessionMessage(
					{
						id: partId,
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
			// Verify if event.sessionId is different from activeSessionId to confirm it's a sub-session
			if (event.sessionId && event.sessionId !== parentSessionId) {
				this.subSessionParentMap.set(event.sessionId, parentSessionId);
			}

			// Use toolUseId as the contextId for this subtask's message bucket.
			// This ensures all subagent messages are routed to this bucket.
			const subtaskContextId = toolUseId;
			this.activeSubtaskContext = {
				toolUseId,
				contextId: subtaskContextId,
				parentSessionId,
			};

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
					// Link this card to the context bucket (using toolUseId)
					contextId: subtaskContextId,
				},
				parentSessionId,
			);
			return;
		}

		// Check if this tool use belongs to a known sub-session or active subtask
		let contextId: string | undefined;
		let toolUseTargetSessionId = targetSessionId;

		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			contextId = event.sessionId;
		} else if (this.activeSubtaskContext) {
			// Tool use during active subtask - route to subtask context bucket
			contextId = this.activeSubtaskContext.contextId;
			toolUseTargetSessionId = this.activeSubtaskContext.parentSessionId;
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
			const extractedContextId = sessionIdMatch ? sessionIdMatch[1].trim() : undefined;

			// Use the contextId from activeSubtaskContext (consistent with setup)
			const subtaskContextId = this.activeSubtaskContext?.contextId ?? extractedContextId;

			this.sessionHandler.postSessionMessage(
				{
					id: toolUseId,
					type: 'subtask',
					partId: toolUseId,
					status: 'completed',
					result: content,
					contextId: subtaskContextId,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				},
				// Always route task FULL completion to the ACTIVE session (Parent) where the card lives
				this.sessionState.activeSessionId,
			);
			this.sessionHandler.postComplete(toolUseId, toolUseId, this.sessionState.activeSessionId);

			// Clear activeSubtaskContext now that the subtask is complete
			this.activeSubtaskContext = null;
			return;
		}

		// Determine context for subagent tool results
		let contextId: string | undefined;
		let toolResultTargetSessionId = targetSessionId;

		if (event.sessionId && this.subSessionParentMap.has(event.sessionId)) {
			contextId = event.sessionId;
		} else if (this.activeSubtaskContext) {
			contextId = this.activeSubtaskContext.contextId;
			toolResultTargetSessionId = this.activeSubtaskContext.parentSessionId;
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
		this.sessionHandler.postSessionInfo();
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

		logger.debug('[ChatProvider] postMessage', {
			type: (msg as { type?: string })?.type,
			targetId: (msg as { targetId?: string })?.targetId,
		});

		this.view.webview.postMessage(msg);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.dispose();
		this.mcpHandler.dispose();
	}
}
