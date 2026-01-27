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
		const activeSessionId = this.sessionState.activeSessionId;

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
				this.sessionHandler.postSessionMessage({
					id: partId,
					type: 'assistant',
					partId,
					content: e.content || '',
					isStreaming: true,
					isDelta: e.isDelta ?? true,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				});
				break;
			}

			case 'thinking': {
				const e = event.data as { content?: string; partId?: string; isDelta?: boolean };
				const partId = e.partId || `thinking-${now}`;
				this.sessionHandler.postSessionMessage({
					id: partId,
					type: 'thinking',
					partId,
					content: e.content || '',
					isDelta: e.isDelta ?? false,
					timestamp: new Date().toISOString(),
				});
				break;
			}

			case 'tool_use': {
				const e = event.data as Record<string, unknown>;
				const toolUseId = (e.id as string) || `tool-${now}`;
				const toolName = (e.name as string) || (e.tool as string) || 'unknown';
				this.sessionHandler.postSessionMessage({
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
				});
				break;
			}

			case 'tool_result': {
				const e = event.data as Record<string, unknown>;
				const toolUseId = (e.tool_use_id as string) || (e.id as string) || `tool-${now}`;
				const toolName = (e.name as string) || (e.tool as string) || 'unknown';

				const toolInputRaw = e.input;
				let emittedFileChange = false;
				if (toolInputRaw && typeof toolInputRaw === 'object') {
					const toolInput = toolInputRaw as Record<string, unknown>;
					const filePath = typeof toolInput.filePath === 'string' ? toolInput.filePath : undefined;
					this.sessionHandler.postSessionMessage({
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
					});

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
								targetId: activeSessionId,
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
								sessionId: activeSessionId,
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
				this.sessionHandler.postSessionMessage({
					id: `${toolUseId}-result-${now}`,
					type: 'tool_result',
					partId: toolUseId,
					toolUseId,
					toolName,
					content,
					isError: Boolean(e.is_error),
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				});
				this.sessionHandler.postComplete(toolUseId, toolUseId);
				break;
			}

			case 'error': {
				const errorId = `error-${now}`;
				this.sessionHandler.postSessionMessage({
					id: errorId,
					type: 'error',
					content: (event.data as { message?: string }).message || 'Unknown error',
					isError: true,
					timestamp: new Date().toISOString(),
					normalizedEntry: event.normalizedEntry,
				});
				this.sessionHandler.postStatus(activeSessionId, 'error', 'Error');
				break;
			}

			case 'finished': {
				if (this.activeAssistantPartId) {
					this.sessionHandler.postComplete(this.activeAssistantPartId, this.activeAssistantPartId);
					this.activeAssistantPartId = null;
				}
				this.sessionHandler.postStatus(activeSessionId, 'idle', 'Ready');
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
						targetId: activeSessionId,
						eventType: 'access',
						payload: {
							eventType: 'access',
							action: 'response',
							requestId,
							approved: true,
							alwaysAllow: true,
						},
						timestamp: Date.now(),
						sessionId: activeSessionId,
					} satisfies SessionEventMessage);
					break;
				}

				const patterns = Array.isArray(e.patterns) ? (e.patterns as string[]) : undefined;

				this.sessionHandler.postSessionMessage({
					id: `access-${requestId}`,
					type: 'access_request',
					requestId,
					tool,
					toolUseId,
					input,
					pattern: patterns?.[0],
					resolved: false,
					timestamp: new Date().toISOString(),
				});
				break;
			}

			default:
				break;
		}
	}

	private handleSettingsChange(): void {
		// Recreate CLI runner if provider changed
		this.settings.refresh();
		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';

		this.cli.kill();

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

	private postMessage(msg: unknown): void {
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
		this.cli.kill();
		this.mcpHandler.dispose();
	}
}
