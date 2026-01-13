/**
 * @file ChatProvider - VS Code chat/webview provider
 * @description Owns the webview panel lifecycle, routes webview messages to handlers,
 *              and bridges SessionManager events (CLI stream) to typed extension messages.
 *              Persists conversation history via SessionContext and supports multi-session routing.
 *              Also coordinates MCP config hot-reload and per-session services.
 */

import { randomUUID } from 'node:crypto';
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
import type { CommitInfo, ConversationMessage, WebviewMessage } from '../types';
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

		// Initialize handlers
		this._gitHandler = this._createGitHandler();
		this._imageHandler = this._createImageHandler();
		this._diagnosticsHandler = this._createDiagnosticsHandler();
		this._openCodeHandler = new OpenCodeHandler(this._settingsService, this._sessionManager);
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
		const deps: GitHandlerDeps = { postMessage: msg => this._postMessage(msg) };
		return new GitHandler(this._fileService, deps);
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
			postMessage: msg => this._postMessage(msg),
			sendReadyMessage: () => this._sendReadyMessage(),
			handleSwitchSession: sid => this._handleSwitchSession(sid),
		};
		return new HistoryHandler(this._globalConversationService, this._sessionManager, deps);
	}

	private _createSessionHandler(): SessionHandler {
		const deps: SessionHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
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
			postMessage: msg => this._postMessage(msg),
			sendAndSaveMessage: (msg, sid) => this._sendAndSaveMessage(msg, sid),
		};
		return new RestoreHandler(this._sessionManager, deps);
	}

	private _createAccessHandler(): AccessHandler {
		const deps: AccessHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
			sendAndSaveMessage: (msg, sid) => this._sendAndSaveMessage(msg, sid),
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
		return new PromptImproverHandler();
	}

	private _createStreamHandler(): StreamHandler {
		const deps: StreamHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
			sendAndSaveMessage: (msg, sid) => this._sendAndSaveMessage(msg, sid),
			createBackup: (msg, mid, sid) => this._messageHandler.createBackup(msg, mid, sid),
			handleOpenCodeAccess: data => this._accessHandler.handleOpenCodeAccess(data),
			handleLoginRequired: sid => this._handleLoginRequired(sid),
			// Coordinate with AccessHandler to prevent duplicate tool_use messages
			hasToolUseBeenCreated: toolUseId => this._accessHandler.hasToolUseBeenCreated(toolUseId),
			markToolUseCreated: toolUseId => this._accessHandler.markToolUseCreated(toolUseId),
		};
		return new StreamHandler(this._sessionManager, deps);
	}

	private _createMessageHandler(): MessageHandler {
		const deps: MessageHandlerDeps = {
			postMessage: msg => this._postMessage(msg),
			sendAndSaveMessage: (msg, sid) => this._sendAndSaveMessage(msg, sid),
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
			postMessage: msg => this._postMessage(msg),
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
		this._postMessage({ type: 'sessionCreated', data: { sessionId } });
	}

	private _onSessionClosed(sessionId: string): void {
		logger.info(`[ChatProvider] Session closed: ${sessionId}`);
		this._postMessage({ type: 'sessionClosed', data: { sessionId } });
	}

	private _onSessionData(sessionId: string, data: CLIStreamData): void {
		this._streamHandler.processStreamData(data, sessionId);
	}

	private _onSessionClose(sessionId: string, code: number | null, errorOutput: string): void {
		logger.info(`[ChatProvider] Session ${sessionId} process closed with code: ${code}`);

		const session = this._sessionManager.getSession(sessionId);
		if (session) {
			this._postMessage({
				type: 'sessionProcessingComplete',
				data: { sessionId, code, stats: session.getStats() },
			});
		}

		if (errorOutput && code !== 0) {
			this._postMessage({ type: 'error', data: { content: errorOutput }, sessionId });
		}

		this._postMessage({ type: 'setProcessing', data: { isProcessing: false, sessionId } });
	}

	private _onSessionError(sessionId: string, error: Error): void {
		logger.error(`[ChatProvider] Session ${sessionId} error:`, error);
		this._postMessage({ type: 'error', data: { content: error.message }, sessionId });
		this._postMessage({ type: 'setProcessing', data: { isProcessing: false, sessionId } });
	}

	private _onCommitCreated(sessionId: string, commit: CommitInfo): void {
		logger.info(`[ChatProvider] Commit created for session ${sessionId}: ${commit.sha}`);
		this._postMessage({ type: 'showRestoreOption', data: commit, sessionId });
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
		this._postMessage({ type: 'sessionCreated', data: { sessionId } });

		// Explicitly switch to this session to ensure UI is in sync
		this._postMessage({
			type: 'sessionSwitched',
			data: {
				sessionId,
				isProcessing,
				totalStats: {
					totalCost: session.totalCost,
					totalTokensInput: session.totalTokensInput,
					totalTokensOutput: session.totalTokensOutput,
					totalDuration: session.totalDuration,
					requestCount: session.requestCount,
				},
			},
		});

		// Replay local conversation history (authoritative source after persistence improvements)
		if (session.conversationMessages.length > 0) {
			logger.info(
				`[ChatProvider] Sending ${session.conversationMessages.length} messages from local history`,
			);

			// Deduplicate messages before sending to UI to prevent React key conflicts
			const uniqueMessages = session.conversationMessages.filter(
				(msg, index, self) =>
					index ===
					self.findIndex(m => {
						// Use specific type guard logic or cast to avoid TS errors with 'content' property on disjoint union
						const isSameId = m.id === msg.id && m.type === msg.type;

						// For types with content, compare content. For others, assume ID/type is enough.
						if ('content' in m && 'content' in msg) {
							return isSameId && m.content === msg.content;
						}

						return isSameId;
					}),
			);

			this._postMessage({
				type: 'messagesReloaded',
				data: { messages: uniqueMessages },
				sessionId,
			});
		}

		// Send stats
		this._postMessage({
			type: 'updateTotals',
			data: {
				totalCost: session.totalCost,
				totalTokensInput: session.totalTokensInput,
				totalTokensOutput: session.totalTokensOutput,
				totalReasoningTokens: session.totalReasoningTokens,
				totalDuration: session.totalDuration,
				requestCount: session.requestCount,
			},
			sessionId,
		});

		// Restore commits/checkpoints for restore functionality
		if (session.commits.length > 0) {
			for (const commit of session.commits) {
				this._postMessage({ type: 'showRestoreOption', data: commit, sessionId });
			}
		}

		// Restore changed files for the floating panel
		if (session.changedFiles.length > 0) {
			for (const file of session.changedFiles) {
				this._postMessage({ type: 'fileChanged', data: file, sessionId });
			}
		}

		this._postMessage({
			type: 'ready',
			data: isProcessing
				? `${providerName} is working...`
				: `Ready to chat with ${providerName}! Type your message below.`,
		});

		if (workspaceName) {
			this._postMessage({ type: 'workspaceInfo', data: { name: workspaceName } });
		}

		this._postMessage({ type: 'modelSelected', model: this._settingsService.selectedModel });
		this._postMessage({ type: 'platformInfo', data: this._settingsService.getPlatformInfo() });
		this._postMessage({ type: 'settingsData', data: this._settingsService.getCurrentSettings() });
		this._settingsHandler.loadProxyModels();

		if (session.draftMessage) {
			this._postMessage({ type: 'restoreInputText', data: session.draftMessage });
		}
	}

	private _sendAndSaveMessage(
		message: { type: string; [key: string]: unknown },
		sessionId?: string,
	): void {
		const targetSessionId = sessionId || this._sessionManager.activeSessionId;
		if (!targetSessionId) {
			this._postMessage(message);
			return;
		}

		// Normalize message shape on extension side.
		const normalizedMessage = this._normalizeMessage(message);

		// Persist/merge into authoritative session history first.
		const conversationMessageTypes = new Set([
			'user',
			'assistant',
			'thinking',
			'tool_use',
			'tool_result',
			'error',
			'interrupted',
			'access_request',
			'subtask',
			'system_notice',
		]);

		const session = this._sessionManager.getSession(targetSessionId);
		if (session && conversationMessageTypes.has(normalizedMessage.type)) {
			session.addConversationMessage(
				normalizedMessage as Partial<ConversationMessage> & { type: string },
			);
		}

		// Emit clean, session-normalized message.
		this._postMessage({ ...normalizedMessage, sessionId: targetSessionId });
	}

	private _normalizeMessage(message: { type: string; [key: string]: unknown }): {
		type: string;
		[key: string]: unknown;
	} {
		// Normalize streaming identity for assistant/thinking: use partId as stable id.
		// This prevents UI from appending a new message for every incremental update.
		if (message.type === 'assistant' || message.type === 'thinking') {
			const partId = (message as { partId?: unknown }).partId;
			if (typeof partId !== 'string' || partId.length === 0) {
				// Without partId we cannot merge streaming updates, but we also must not crash.
				return message;
			}

			const existingId = (message as { id?: unknown }).id;
			if (existingId === undefined) {
				return { ...message, id: partId };
			}
			if (existingId !== partId) {
				logger.warn(
					`[ChatProvider] Streaming message id mismatch type=${message.type}; expected id=partId=${partId}`,
				);
				return { ...message, id: partId };
			}
			return message;
		}

		// Ensure error/interrupted/system_notice messages have a stable id for dismiss/clear semantics.
		if (
			message.type === 'error' ||
			message.type === 'interrupted' ||
			message.type === 'system_notice'
		) {
			const existingId = (message as { id?: unknown }).id;
			if (typeof existingId !== 'string' || existingId.length === 0) {
				return { ...message, id: randomUUID() };
			}
		}

		return message;
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

		this._postMessage({ type: 'setProcessing', data: { isProcessing: false, sessionId } });
		this._postMessage({ type: 'loginRequired', sessionId });

		const terminal = vscode.window.createTerminal('Claude Login');
		terminal.sendText('claude');
		terminal.show();
		// Login message sent to chat via postMessage, no toast needed
		this._postMessage({
			type: 'terminalOpened',
			data: 'Please login to Claude in the terminal.',
			sessionId,
		});
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
