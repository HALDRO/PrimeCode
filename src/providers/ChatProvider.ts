/**
 * @file ChatProvider - VS Code chat/webview provider
 * @description Owns the webview panel lifecycle, routes webview messages to handlers,
 *              and bridges SessionManager events (CLI stream) to typed extension messages.
 *              Persists conversation history via SessionContext and supports multi-session routing.
 *              Also coordinates MCP config hot-reload and per-session services.
 */

import * as vscode from 'vscode';
import { AccessService } from '../services/AccessService';
import { CLIServiceFactory } from '../services/CLIServiceFactory';
import { ConversationService } from '../services/ConversationService';
import { errorService, FileSystemError } from '../services/ErrorService';
import { FileService } from '../services/FileService';
import { getWorkspacePath, searchWorkspaceFiles } from '../services/fileSearch';
import type { CLIStreamData } from '../services/ICLIService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { McpMarketplaceService } from '../services/mcp/McpMarketplaceService';
import { McpMetadataService } from '../services/mcp/McpMetadataService';
import { SessionManager, type SessionManagerEvents } from '../services/SessionManager';
import { SettingsService } from '../services/SettingsService';
import type { CommitInfo, WebviewMessage } from '../types';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';
import {
	AccessHandler,
	type AccessHandlerDeps,
	CommandsHandler,
	DiagnosticsHandler,
	type DiagnosticsHandlerDeps,
	DiscoveryHandler,
	type DiscoveryHandlerDeps,
	GitHandler,
	type GitHandlerDeps,
	HistoryHandler,
	type HistoryHandlerDeps,
	HooksHandler,
	ImageHandler,
	type ImageHandlerDeps,
	MessageHandler,
	type MessageHandlerDeps,
	OpenCodeHandler,
	PermissionsHandler,
	type PermissionsHandlerDeps,
	PromptImproverHandler,
	RestoreHandler,
	type RestoreHandlerDeps,
	RulesHandler,
	type RulesHandlerDeps,
	SessionHandler,
	type SessionHandlerDeps,
	SessionRouter,
	type SessionRouterDeps,
	SettingsHandler,
	type SettingsHandlerDeps,
	SkillsHandler,
	StreamHandler,
	type StreamHandlerDeps,
	SubagentsHandler,
	WebviewMessageRouter,
	type WebviewMessageRouterDeps,
	type WebviewMessageRouterHandlers,
} from './handlers';

// =============================================================================
// ChatProvider Class
// =============================================================================

export class ChatProvider {
	// Panel & Webview
	private _panel: vscode.WebviewPanel | undefined;
	private _webview: vscode.Webview | undefined;
	private _webviewView: vscode.WebviewView | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _messageHandlerDisposable: vscode.Disposable | undefined;
	private _isDisposed = false;

	// Session Management
	private readonly _sessionManager: SessionManager;

	// Services
	private readonly _accessService: AccessService;
	private readonly _settingsService: SettingsService;
	private readonly _fileService: FileService;
	private readonly _globalConversationService: ConversationService;
	private readonly _mcpConfigWatcher: McpConfigWatcherService;

	// Handlers
	private readonly _gitHandler: GitHandler;
	private readonly _imageHandler: ImageHandler;
	private readonly _diagnosticsHandler: DiagnosticsHandler;
	private readonly _openCodeHandler: OpenCodeHandler;
	private readonly _streamHandler: StreamHandler;
	private readonly _historyHandler: HistoryHandler;
	private readonly _sessionHandler: SessionHandler;
	private readonly _settingsHandler: SettingsHandler;
	private readonly _messageHandler: MessageHandler;
	private readonly _restoreHandler: RestoreHandler;
	private readonly _accessHandler: AccessHandler;
	private readonly _rulesHandler: RulesHandler;
	private readonly _commandsHandler: CommandsHandler;
	private readonly _skillsHandler: SkillsHandler;
	private readonly _hooksHandler: HooksHandler;
	private readonly _subagentsHandler: SubagentsHandler;
	private readonly _permissionsHandler: PermissionsHandler;
	private readonly _discoveryHandler: DiscoveryHandler;

	private readonly _promptImproverHandler: PromptImproverHandler;
	private readonly _messageRouter: WebviewMessageRouter;

	// Unified Session Router
	private readonly _sessionRouter: SessionRouter;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		readonly _context: vscode.ExtensionContext,
	) {
		// Initialize services
		this._accessService = new AccessService(_context);
		CLIServiceFactory.setAccessService(this._accessService);
		this._settingsService = new SettingsService(_context);
		this._fileService = new FileService();
		this._globalConversationService = new ConversationService(_context);

		// Initialize MCP config watcher for hot-reload
		const agentsConfigService = new (
			require('../services/AgentsConfigService') as typeof import('../services/AgentsConfigService')
		).AgentsConfigService();
		const agentsSyncService = new (
			require('../services/AgentsSyncService') as typeof import('../services/AgentsSyncService')
		).AgentsSyncService(agentsConfigService);
		this._mcpConfigWatcher = new McpConfigWatcherService(agentsConfigService, agentsSyncService);

		// Initialize AgentsCommandsService
		const { agentsCommandsService } =
			require('../services/AgentsCommandsService') as typeof import('../services/AgentsCommandsService');
		if (vscode.workspace.workspaceFolders?.[0]) {
			agentsCommandsService.setWorkspaceRoot(vscode.workspace.workspaceFolders[0].uri.fsPath);
		}

		// Initialize SessionManager
		this._sessionManager = this._createSessionManager(_context);

		// Initialize SessionRouter (unified event routing)
		this._sessionRouter = this._createSessionRouter();

		// Initialize handlers
		this._gitHandler = this._createGitHandler();
		this._imageHandler = this._createImageHandler();
		this._diagnosticsHandler = this._createDiagnosticsHandler();
		this._openCodeHandler = this._createOpenCodeHandler();
		this._historyHandler = this._createHistoryHandler();
		this._sessionHandler = this._createSessionHandler();
		this._settingsHandler = this._createSettingsHandler();
		this._restoreHandler = this._createRestoreHandler();
		this._accessHandler = this._createAccessHandler();
		this._discoveryHandler = this._createDiscoveryHandler();
		this._permissionsHandler = this._createPermissionsHandler();
		this._promptImproverHandler = this._createPromptImproverHandler();
		this._rulesHandler = this._createRulesHandler();
		this._commandsHandler = this._createCommandsHandler();
		this._skillsHandler = this._createSkillsHandler();
		this._hooksHandler = this._createHooksHandler();
		this._subagentsHandler = this._createSubagentsHandler();
		this._streamHandler = this._createStreamHandler();
		this._messageHandler = this._createMessageHandler();
		this._messageRouter = this._createMessageRouter();

		this._initialize();
	}

	// =========================================================================
	// Public API
	// =========================================================================

	public get panel(): vscode.WebviewPanel | undefined {
		return this._panel;
	}

	/**
	 * Sets the disposed state of the provider.
	 * Used by ChatWebviewProvider to mark provider as disposed when sidebar is hidden.
	 */
	public setDisposed(disposed: boolean): void {
		this._isDisposed = disposed;
	}

	public show(column: vscode.ViewColumn | vscode.Uri = vscode.ViewColumn.Two): void {
		const actualColumn = column instanceof vscode.Uri ? vscode.ViewColumn.Two : column;
		this._closeSidebar();

		if (this._panel) {
			this._panel.reveal(actualColumn);
			return;
		}

		// Reset disposed flag when creating new panel
		this._isDisposed = false;

		const title = 'PrimeCode';
		this._panel = vscode.window.createWebviewPanel('primeCode', title, actualColumn, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				this._extensionUri,
				vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
			],
		});

		this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.png');
		this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
		this._panel.onDidDispose(
			() => {
				this._isDisposed = true;
				this._panel = undefined;
				// Don't call full dispose() here - ChatProvider is a singleton
				// and services should remain alive for sidebar/reopening
			},
			null,
			this._disposables,
		);

		this._setupWebviewMessageHandler(this._panel.webview);

		// Removed proactive initialization to avoid race conditions with webviewDidLaunch
		// The webview will request initialization via webviewDidLaunch event
	}

	public showInWebview(webview: vscode.Webview, webviewView?: vscode.WebviewView): void {
		if (this._panel) {
			this._panel.dispose();
			this._panel = undefined;
		}

		// Reset disposed flag when showing in webview
		this._isDisposed = false;

		this._webview = webview;
		this._webviewView = webviewView;
		this._webview.html = this._getHtmlForWebview(this._webview);

		this._setupWebviewMessageHandler(this._webview);
		// Removed proactive initialization to avoid race conditions with webviewDidLaunch
	}

	public reinitializeWebview(): void {
		if (this._webview) {
			void this._initializeSession();
			this._setupWebviewMessageHandler(this._webview);
		}
	}

	public async loadConversation(filename: string): Promise<void> {
		await this._historyHandler.loadConversationHistory(filename);
	}

	public dispose(): void {
		this._isDisposed = true;
		this._panel?.dispose();
		this._messageHandlerDisposable?.dispose();
		this._accessService.dispose();
		this._mcpConfigWatcher.dispose();
		void CLIServiceFactory.dispose();
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
	}

	// =========================================================================
	// Factory Methods for Handlers
	// =========================================================================

	private _createSessionManager(context: vscode.ExtensionContext): SessionManager {
		const events: SessionManagerEvents = {
			onSessionCreated: sessionId => this._onSessionCreated(sessionId),
			onSessionClosed: sessionId => this._onSessionClosed(sessionId),
			onSessionData: (sessionId, data) => this._onSessionData(sessionId, data),
			onSessionClose: (sessionId, code, error) => this._onSessionClose(sessionId, code, error),
			onSessionError: (sessionId, error) => this._onSessionError(sessionId, error),
			onCommitCreated: (sessionId, commit) => this._onCommitCreated(sessionId, commit),
		};
		return new SessionManager(context, events, {
			maxSessions: 10,
			persistSessions: true,
		});
	}

	private _createGitHandler(): GitHandler {
		const deps: GitHandlerDeps = { router: this._sessionRouter };
		return new GitHandler(this._fileService, this._sessionManager, deps);
	}

	private _createImageHandler(): ImageHandler {
		const deps: ImageHandlerDeps = { postMessage: msg => this._postMessage(msg) };
		return new ImageHandler(this._fileService, deps);
	}

	private _createDiagnosticsHandler(): DiagnosticsHandler {
		const deps: DiagnosticsHandlerDeps = { postMessage: msg => this._postMessage(msg) };
		return new DiagnosticsHandler(this._sessionManager, deps);
	}

	private _createHistoryHandler(): HistoryHandler {
		const deps: HistoryHandlerDeps = {
			router: this._sessionRouter,
			postMessage: msg => this._postMessage(msg),
			sendReadyMessage: () => this._sendReadyMessage(),
		};
		return new HistoryHandler(this._globalConversationService, this._sessionManager, deps);
	}

	private _createSessionHandler(): SessionHandler {
		const deps: SessionHandlerDeps = {
			router: this._sessionRouter,
			sendReadyMessage: () => this._sendReadyMessage(),
			loadConversationHistory: filename => this._historyHandler.loadConversationHistory(filename),
			getLatestConversation: async () => {
				await this._globalConversationService.waitForInitialization();
				return this._globalConversationService.getLatestConversation();
			},
		};
		return new SessionHandler(this._sessionManager, deps);
	}

	private _createSettingsHandler(): SettingsHandler {
		const deps: SettingsHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
			getCLISessionId: () => this._sessionManager.getActiveSession()?.cliSessionId,
			getSessionManager: () => this._sessionManager,
			onMcpConfigSaved: () => this._mcpConfigWatcher.notifyUiSave(),
		};
		return new SettingsHandler(
			this._context,
			this._settingsService,
			this._accessService,
			this._fileService,
			deps,
			new McpMarketplaceService(this._context),
			new McpMetadataService(this._context),
		);
	}

	private _createRestoreHandler(): RestoreHandler {
		const deps: RestoreHandlerDeps = {
			router: this._sessionRouter,
		};
		return new RestoreHandler(this._sessionManager, deps);
	}

	private _createAccessHandler(): AccessHandler {
		const deps: AccessHandlerDeps = {
			router: this._sessionRouter,
		};
		return new AccessHandler(this._sessionManager, this._accessService, deps);
	}

	private _createDiscoveryHandler(): DiscoveryHandler {
		const deps: DiscoveryHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
		};
		return new DiscoveryHandler(deps);
	}

	private _createRulesHandler(): RulesHandler {
		const deps: RulesHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
		};
		return new RulesHandler(deps);
	}

	private _createCommandsHandler(): CommandsHandler {
		return new CommandsHandler(msg => this._postMessage(msg), this._context);
	}

	private _createSkillsHandler(): SkillsHandler {
		return new SkillsHandler(msg => this._postMessage(msg));
	}

	private _createHooksHandler(): HooksHandler {
		return new HooksHandler(msg => this._postMessage(msg));
	}

	private _createSubagentsHandler(): SubagentsHandler {
		return new SubagentsHandler(msg => this._postMessage(msg));
	}

	private _createPermissionsHandler(): PermissionsHandler {
		const deps: PermissionsHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
		};
		return new PermissionsHandler(deps);
	}

	private _createPromptImproverHandler(): PromptImproverHandler {
		return new PromptImproverHandler({ postMessage: msg => this._postMessage(msg) });
	}

	private _createOpenCodeHandler(): OpenCodeHandler {
		return new OpenCodeHandler(this._settingsService, this._sessionManager, {
			postMessage: msg => this._postMessage(msg),
		});
	}

	private _createSessionRouter(): SessionRouter {
		const deps: SessionRouterDeps = {
			postMessage: msg => this._postMessage(msg),
		};
		return new SessionRouter(this._sessionManager, deps);
	}

	private _createStreamHandler(): StreamHandler {
		const deps: StreamHandlerDeps = {
			router: this._sessionRouter,
			createBackup: (msg, mid, sid) => this._messageHandler.createBackup(msg, mid, sid),
			handleOpenCodeAccess: data => this._accessHandler.handleOpenCodeAccess(data),
			handleLoginRequired: sid => this._handleLoginRequired(sid),
			hasToolUseBeenCreated: toolUseId => this._accessHandler.hasToolUseBeenCreated(toolUseId),
			markToolUseCreated: toolUseId => this._accessHandler.markToolUseCreated(toolUseId),
		};
		return new StreamHandler(this._sessionManager, deps);
	}

	private _createMessageHandler(): MessageHandler {
		const deps: MessageHandlerDeps = {
			router: this._sessionRouter,
		};
		return new MessageHandler(
			this._sessionManager,
			this._settingsService,
			this._accessService,
			this._imageHandler,
			this._streamHandler,
			deps,
		);
	}

	private _createMessageRouter(): WebviewMessageRouter {
		const handlers: WebviewMessageRouterHandlers = {
			messageHandler: this._messageHandler,
			sessionHandler: this._sessionHandler,
			historyHandler: this._historyHandler,
			settingsHandler: this._settingsHandler,
			imageHandler: this._imageHandler,
			gitHandler: this._gitHandler,
			diagnosticsHandler: this._diagnosticsHandler,
			openCodeHandler: this._openCodeHandler,
			restoreHandler: this._restoreHandler,
			accessHandler: this._accessHandler,
			discoveryHandler: this._discoveryHandler,
			rulesHandler: this._rulesHandler,
			permissionsHandler: this._permissionsHandler,
			commandsHandler: this._commandsHandler,
			skillsHandler: this._skillsHandler,
			hooksHandler: this._hooksHandler,
			subagentsHandler: this._subagentsHandler,
			promptImproverHandler: this._promptImproverHandler,
		};
		const deps: WebviewMessageRouterDeps = {
			router: this._sessionRouter,
			sendReadyMessage: () => this._sendReadyMessage(),
			handleSwitchSession: sid => this._handleSwitchSession(sid),
			sendWorkspaceFiles: term => this._sendWorkspaceFilesRipgrep(term),
			openFileInEditor: (path, startLine, endLine) =>
				this._openFileInEditor(path, startLine, endLine),
			saveInputText: text => this._saveInputText(text),
			getActiveSessionId: () => this._sessionManager.activeSessionId,
		};
		return new WebviewMessageRouter(handlers, deps);
	}

	// =========================================================================
	// Session Event Handlers
	// =========================================================================

	private _onSessionCreated(sessionId: string): void {
		logger.info(`[ChatProvider] Session created: ${sessionId}`);
		this._sessionRouter.emitSessionCreated(sessionId);
	}

	private _onSessionClosed(sessionId: string): void {
		logger.info(`[ChatProvider] Session closed: ${sessionId}`);
		this._sessionRouter.emitSessionClosed(sessionId);
	}

	private _onSessionData(sessionId: string, data: CLIStreamData): void {
		this._streamHandler.processStreamData(data, sessionId);
	}

	private _onSessionClose(sessionId: string, code: number | null, errorOutput: string): void {
		logger.info(`[ChatProvider] Session ${sessionId} process closed with code: ${code}`);

		const session = this._sessionManager.getSession(sessionId);
		if (session) {
			this._sessionRouter.emitTotalStats(sessionId, session.getStats());
		}

		if (errorOutput && code !== 0) {
			this._sessionRouter.emitError(sessionId, errorOutput);
		}

		this._sessionRouter.emitStatus(sessionId, 'idle');
	}

	private _onSessionError(sessionId: string, error: Error): void {
		logger.error(`[ChatProvider] Session ${sessionId} error:`, error);
		this._sessionRouter.emitError(sessionId, error.message);
		this._sessionRouter.emitStatus(sessionId, 'idle');
	}

	private _onCommitCreated(sessionId: string, commit: CommitInfo): void {
		logger.info(`[ChatProvider] Commit created for session ${sessionId}: ${commit.sha}`);
		this._sessionRouter.emitRestoreOption(sessionId, commit);
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _initialize(): void {
		// this._accessService.initializeMCPConfig();
		this._accessService.setAccessRequestCallback(req =>
			this._accessHandler.handleAccessRequest(req),
		);

		// Start MCP config watcher for hot-reload
		this._mcpConfigWatcher.start();

		// Register reload callbacks for different CLI providers
		this._mcpConfigWatcher.setClaudeReloadCallback(async () => {
			const cliService = await CLIServiceFactory.getService('claude');
			if ('reloadMcpConfig' in cliService) {
				await (cliService as { reloadMcpConfig: () => Promise<unknown> }).reloadMcpConfig();
			}
		});

		this._mcpConfigWatcher.setOpenCodeReloadCallback(async () => {
			const cliService = await CLIServiceFactory.getService();
			if (CLIServiceFactory.isOpenCode() && 'reloadMcpConfig' in cliService) {
				await (cliService as { reloadMcpConfig: () => Promise<unknown> }).reloadMcpConfig();
			}
		});

		// Notify webview when MCP config changes
		this._mcpConfigWatcher.onConfigChanged(event => {
			logger.info(`[ChatProvider] MCP config changed (source: ${event.source})`);
			this._postMessage({
				type: 'mcpConfigReloaded',
				data: { source: event.source, timestamp: event.timestamp },
			});
			// Also refresh settings to update MCP servers list in UI
			this._settingsHandler.refreshMcpServers();
		});
	}

	private async _initializeSession(): Promise<void> {
		await this._sessionHandler.initializeSession();
	}

	private _postMessage(message: unknown): void {
		if (this._isDisposed) {
			return;
		}
		const target = this._panel?.webview || this._webview;
		target?.postMessage(message);
	}

	private _closeSidebar(): void {
		if (this._webviewView) {
			vscode.commands.executeCommand('workbench.view.explorer');
		}
	}

	private _setupWebviewMessageHandler(webview: vscode.Webview): void {
		this._messageHandlerDisposable?.dispose();
		this._messageHandlerDisposable = webview.onDidReceiveMessage(
			(msg: WebviewMessage) => this._messageRouter.route(msg),
			null,
			this._disposables,
		);
	}

	private async _sendReadyMessage(): Promise<void> {
		const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
		const providerName = CLIServiceFactory.isOpenCode() ? 'OpenCode' : 'Claude Code';

		// Use ensureActiveSession to safely get/create session without race conditions
		const session = await this._sessionManager.ensureActiveSession();
		const sessionId = session.uiSessionId;

		const isProcessing = session.isProcessing;

		// Notify UI about session creation (idempotent on UI side)
		this._sessionRouter.emitSessionCreated(sessionId);

		// Switch to this session to ensure UI is in sync
		this._sessionRouter.emitSessionSwitched(sessionId, {
			isProcessing,
			totalStats: session.getStats(),
			messages: session.conversationMessages.length > 0 ? session.conversationMessages : undefined,
		});

		// Restore commits/checkpoints for restore functionality
		if (session.commits.length > 0) {
			this._sessionRouter.emitRestoreCommits(sessionId, session.commits);
		}

		// Restore changed files for the floating panel
		if (session.changedFiles.length > 0) {
			for (const file of session.changedFiles) {
				this._sessionRouter.emitFileChanged(sessionId, {
					filePath: file.filePath,
					fileName: file.fileName,
					linesAdded: file.linesAdded,
					linesRemoved: file.linesRemoved,
					toolUseId: file.toolUseId,
				});
			}
		}

		// Ready/initial status is now delivered via session_event status.
		this._sessionRouter.emitStatus(
			sessionId,
			isProcessing ? 'busy' : 'idle',
			undefined,
			undefined,
			'Ready',
			isProcessing
				? `${providerName} is working...`
				: `Ready to chat with ${providerName}! Type your message below.`,
		);

		if (workspaceName) {
			this._postMessage({ type: 'workspaceInfo', data: { name: workspaceName } });
		}

		this._postMessage({ type: 'modelSelected', model: this._settingsService.selectedModel });
		this._postMessage({ type: 'platformInfo', data: this._settingsService.getPlatformInfo() });
		this._postMessage({ type: 'settingsData', data: this._settingsService.getCurrentSettings() });
		this._settingsHandler.loadProxyModels();

		if (session.draftMessage) {
			this._sessionRouter.emitRestoreInput(sessionId, session.draftMessage);
		}
	}

	private async _handleSwitchSession(uiSessionId: string): Promise<void> {
		await this._sessionHandler.handleSwitchSession(uiSessionId);
	}

	private async _sendWorkspaceFilesRipgrep(searchTerm?: string): Promise<void> {
		const workspacePath = getWorkspacePath();
		if (!workspacePath) {
			this._postMessage({ type: 'workspaceFiles', data: [] });
			return;
		}

		try {
			const results = await searchWorkspaceFiles(searchTerm || '', workspacePath, 50);
			const files = results.map(r => ({
				name: r.label,
				path: r.path,
				fsPath: `${workspacePath}/${r.path}`,
			}));
			this._postMessage({ type: 'workspaceFiles', data: files });
		} catch (error) {
			const fsError = FileSystemError.fromNodeError(error as NodeJS.ErrnoException, workspacePath);
			errorService.handle(fsError, 'ClaudeChatProvider._sendWorkspaceFilesRipgrep');
			this._postMessage({ type: 'workspaceFiles', data: [] });
		}
	}

	private async _openFileInEditor(
		filePath: string,
		startLine?: number,
		endLine?: number,
	): Promise<void> {
		const absolutePath = this._fileService.resolveFilePath(filePath);
		await this._fileService.openFileInEditor(absolutePath, startLine, endLine);
	}

	private _saveInputText(text: string): void {
		const session = this._sessionManager.getActiveSession();
		if (session) {
			session.setDraftMessage(text || '');
		}
	}

	private _handleLoginRequired(sessionId?: string): void {
		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		if (session) {
			session.setProcessing(false);
		}

		this._sessionRouter.emitStatus(sessionId || '', 'idle');

		if (sessionId) {
			this._sessionRouter.emitAuthRequired(sessionId);
		}

		const terminal = vscode.window.createTerminal('Claude Login');
		terminal.sendText('claude');
		terminal.show();

		if (sessionId) {
			this._sessionRouter.emitTerminalOpened(sessionId, 'Please login to Claude in the terminal.');
		}
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		logger.info('_getHtmlForWebview called');

		const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview.js');
		const stylePath = vscode.Uri.joinPath(this._extensionUri, 'out', 'webview.css');

		logger.info('Script path:', scriptPath.fsPath);
		logger.info('Style path:', stylePath.fsPath);

		const scriptUri = webview.asWebviewUri(scriptPath);
		const styleUri = webview.asWebviewUri(stylePath);

		logger.info('Script URI:', scriptUri.toString());
		logger.info('Style URI:', styleUri.toString());

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		const normalizedWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');

		logger.info('Workspace root:', normalizedWorkspaceRoot);
		logger.info('Telemetry enabled:', vscode.env?.isTelemetryEnabled);

		const html = getHtml(
			scriptUri.toString(),
			styleUri.toString(),
			vscode.env?.isTelemetryEnabled || false,
			normalizedWorkspaceRoot,
		);

		logger.debug('Generated HTML length:', html.length);

		return html;
	}
}
