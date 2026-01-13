/**
 * @file OpenCode CLI Service Implementation (Refactored)
 * @description Facade class for OpenCode AI coding assistant.
 * Delegates operations to specialized modules (Ops classes) for clean separation of concerns.
 *
 * Architecture:
 * - OpenCodeService (Facade & State)
 *   - OpenCodeServerManager (Server Lifecycle - owns process)
 *   - OpenCodeEventParser (Stream Transformation - module with named exports)
 *   - OpenCodeSessionOps (Session Logic - extends BaseOpenCodeOps)
 *   - OpenCodeProviderOps (Provider/Config Logic - extends BaseOpenCodeOps)
 *   - OpenCodeFindOps (Search Logic - extends BaseOpenCodeOps)
 *   - OpenCodeProjectOps (Project & Part Logic - extends BaseOpenCodeOps)
 */

import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { CLIProviderType } from '../../../shared/constants';
import { logger } from '../../../utils/logger';
import { AgentsConfigService } from '../../AgentsConfigService.js';
import { AgentsSyncService } from '../../AgentsSyncService.js';
import { ErrorCode, NetworkError } from '../../ErrorService.js';
import type {
	CLIAgent,
	CLIProcessOptions,
	CLISession,
	CLIStreamData,
	ICLIService,
	PermissionResponse,
} from '../../ICLIService.js';
import { retryService } from '../../RetryService.js';

import * as OpenCodeEventParser from './OpenCodeEventParser.js';
import { OpenCodeFindOps } from './OpenCodeFindOps.js';
import { OpenCodeProjectOps } from './OpenCodeProjectOps.js';
import { OpenCodeProviderOps } from './OpenCodeProviderOps.js';
import { OpenCodeServerManager } from './OpenCodeServerManager.js';
import { OpenCodeSessionOps } from './OpenCodeSessionOps.js';
import type { CustomProviderConfig, OpenCodeEvent, OpencodeInstance } from './types.js';

export class OpenCodeService implements ICLIService {
	// State
	private _opencode: OpencodeInstance | null = null;
	private _isInitializing = false;
	private _restartPromise: Promise<void> | null = null;
	private _currentSessionId: string | null = null;
	private _currentSessionTitle = 'New Session';
	private _workspaceDir: string | undefined;

	// Process Control
	private _processing = new Set<string>();
	private _abortControllers = new Map<string, AbortController>();

	// Modules
	private readonly _agentsConfigService: AgentsConfigService;
	private readonly _agentsSyncService: AgentsSyncService;
	private readonly _serverManager: OpenCodeServerManager;
	private readonly _sessionOps: OpenCodeSessionOps;
	private readonly _providerOps: OpenCodeProviderOps;
	private readonly _findOps: OpenCodeFindOps;
	private readonly _projectOps: OpenCodeProjectOps;

	constructor() {
		this._agentsConfigService = new AgentsConfigService();
		this._agentsSyncService = new AgentsSyncService(this._agentsConfigService);
		this._serverManager = new OpenCodeServerManager();

		// Context Bridge for Ops classes
		const context = {
			getClient: () => this._opencode?.client,
			getWorkspaceDir: () => this._workspaceDir,
			getLogger: () => logger,
		};

		this._sessionOps = new OpenCodeSessionOps(context);
		this._providerOps = new OpenCodeProviderOps(context);
		this._findOps = new OpenCodeFindOps(context);
		this._projectOps = new OpenCodeProjectOps(context);
	}

	public getProviderType(): CLIProviderType {
		return 'opencode';
	}

	public getWorkspaceRoot(): string | undefined {
		return this._workspaceDir;
	}

	public isReady(): boolean {
		return this._opencode !== null && !this._isInitializing;
	}

	public async initialize(workspaceRoot?: string): Promise<void> {
		if (this._opencode || this._isInitializing) return;

		this._isInitializing = true;

		if (workspaceRoot && fs.existsSync(workspaceRoot)) {
			this._workspaceDir = workspaceRoot;
		}

		const cwd = this._workspaceDir || process.cwd();

		try {
			// Sync MCP servers from .agents/mcp.json to opencode.json
			await this._syncMcpConfig();

			logger.info('[OpenCodeService] Starting OpenCode server...');

			// Use ServerManager to start server (it owns the process now)
			const { url } = await this._serverManager.startServer(cwd);

			const { createOpencodeClient } = await import('@opencode-ai/sdk/v2/client');
			const client = createOpencodeClient({
				baseUrl: url,
				throwOnError: false,
			});

			this._opencode = {
				client,
				server: {
					url,
					close: () => this._serverManager.stopServer(),
				},
			};

			logger.info('[OpenCodeService] Initialization complete');
		} catch (error) {
			// ServerManager handles its own cleanup on failure
			this._serverManager.stopServer();

			logger.error('[OpenCodeService] Initialization failed:', error);
			const message = error instanceof Error ? error.message : String(error);
			let userMessage = `Failed to start OpenCode: ${message}`;

			if (message.includes('ENOENT') || message.includes('spawn opencode')) {
				userMessage =
					'OpenCode CLI not found. Please install it:\n• Windows: choco install opencode\n• Other: npm install -g @opencode-ai/cli';
			}

			vscode.window.showErrorMessage(userMessage);
			throw error;
		} finally {
			this._isInitializing = false;
		}
	}

	public async dispose(): Promise<void> {
		// ServerManager owns the process, delegate cleanup
		this._serverManager.dispose();
		this._opencode = null;
		this._currentSessionId = null;
	}

	public async restart(): Promise<void> {
		if (this._restartPromise) {
			return this._restartPromise;
		}

		this._restartPromise = (async () => {
			logger.info('[OpenCodeService] Restarting server to reload config...');
			await this.dispose();
			await this.initialize(this._workspaceDir);
			logger.info('[OpenCodeService] Server restarted successfully');
		})();

		try {
			await this._restartPromise;
		} finally {
			this._restartPromise = null;
		}
	}

	// =========================================================================
	// Process & Streaming Logic
	// =========================================================================

	public async startProcess(
		options: CLIProcessOptions,
		onData: (data: CLIStreamData) => void,
		onClose: (code: number | null, errorOutput: string) => void,
		onError: (error: Error) => void,
	): Promise<void> {
		if (!this._opencode) throw new Error('OpenCode not initialized');

		const sid = options.sessionId || this._currentSessionId;
		if (!sid) throw new Error('No active session');

		this.stopProcess(sid);
		this._processing.add(sid);
		const abortController = new AbortController();
		this._abortControllers.set(sid, abortController);

		try {
			const config = await this._providerOps.getConfig();
			const model = options.selectedModel || config?.model || 'anthropic/claude-sonnet-4-5';

			logger.debug(
				`[OpenCodeService] Raw selectedModel from options: "${options.selectedModel}", from config: "${config?.model}"`,
			);

			const slashIndex = model.indexOf('/');
			const providerID = slashIndex > 0 ? model.substring(0, slashIndex) : model;
			const modelID = slashIndex > 0 ? model.substring(slashIndex + 1) : model;

			const directory = this._workspaceDir || process.cwd();

			logger.info(`[OpenCodeService] Starting prompt for session ${sid}`);

			if (!options.message || typeof options.message !== 'string') {
				throw new Error(`Invalid message: expected string, got ${typeof options.message}`);
			}

			// Use retry logic for SSE subscription
			const sseResult = await retryService.executeWithReconnect(
				async () => {
					// biome-ignore lint/style/noNonNullAssertion: Checked at start
					const sse = await this._opencode!.client.event.subscribe({
						directory,
					});
					return sse;
				},
				{
					maxRetries: 3,
					initialDelayMs: 1000,
					signal: abortController.signal,
					onReconnecting: attempt => {
						logger.info(`[OpenCodeService] SSE reconnecting (attempt ${attempt})...`);
						onData({
							type: 'system',
							sessionId: sid,
							message: {
								content: [{ type: 'text', text: `Reconnecting... (attempt ${attempt})` }],
							},
						});
					},
					onReconnected: () => {
						logger.info('[OpenCodeService] SSE reconnected successfully');
					},
				},
			);

			if (!sseResult.success || !sseResult.data) {
				throw (
					sseResult.error ||
					new NetworkError('Failed to establish SSE connection', ErrorCode.NETWORK_UNREACHABLE)
				);
			}

			const sse = sseResult.data;
			logger.info('[OpenCodeService] SSE subscription established, sending prompt...');

			if (options.command) {
				const normalizedCommand = options.command.trim().replace(/^\//, '');
				const isCompact = normalizedCommand === 'compact';

				if (isCompact) {
					// OpenCode has a dedicated summarize endpoint for session compaction.
					// Using session.command('compact') can crash inside opencode (command agent resolution bug).
					// Start stream FIRST, then send summarize to not miss any events
					const streamTask = this._processStreamWithRetry(
						sse,
						sid,
						onData,
						directory,
						abortController,
					);

					try {
						const summarizePromise = this._opencode?.client.session.summarize({
							sessionID: sid,
							directory,
							providerID,
							modelID,
							auto: false,
						});
						const result = await summarizePromise;
						if (result.error) {
							logger.error('[OpenCodeService] Summarize failed:', result.error);
							throw new Error(`Summarize failed: ${JSON.stringify(result.error)}`);
						}
					} finally {
						abortController.abort();
						await streamTask;
					}
				} else {
					// Execute command
					// Start stream FIRST, then send command to not miss any events
					const streamTask = this._processStreamWithRetry(
						sse,
						sid,
						onData,
						directory,
						abortController,
					);

					// biome-ignore lint/style/noNonNullAssertion: Checked at start
					const commandPromise = this._opencode!.client.session.command({
						sessionID: sid,
						directory,
						command: normalizedCommand,
						arguments: options.commandArgs || '',
						agent: options.agent || 'build',
						model: `${providerID}/${modelID}`,
					});

					try {
						const result = await commandPromise;
						if (result.error) {
							logger.error('[OpenCodeService] Command failed:', result.error);
							throw new Error(`Command failed: ${JSON.stringify(result.error)}`);
						}
					} finally {
						// Some commands may not emit session.idle reliably.
						// Abort the SSE stream after the command finishes so the request can complete.
						abortController.abort();
						await streamTask;
					}
				}
			} else {
				// Regular prompt
				// biome-ignore lint/style/noNonNullAssertion: Checked at start
				const promptPromise = this._opencode!.client.session.prompt({
					sessionID: sid,
					directory,
					model: { providerID, modelID },
					parts: [{ type: 'text' as const, text: options.message }],
					agent: options.agent || undefined,
					tools: options.tools,
					system: options.systemPrompt,
					noReply: options.noReply,
				});

				await this._processStreamWithRetry(sse, sid, onData, directory, abortController);

				const result = await promptPromise;
				if (result.error) {
					logger.error('[OpenCodeService] Prompt failed:', result.error);
					throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
				}
			}
			onClose(0, '');
		} catch (error) {
			logger.error('[OpenCodeService] startProcess error:', error);
			onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this._processing.delete(sid);
			this._abortControllers.delete(sid);
		}
	}

	public stopProcess(sessionId?: string): boolean {
		const sid = sessionId || this._currentSessionId;
		if (!sid) return false;

		const controller = this._abortControllers.get(sid);
		if (controller) {
			controller.abort();
			this._processing.delete(sid);
			this._abortControllers.delete(sid);

			// Also abort the session on the server to stop generation
			this.abortSession(sid).catch(error => {
				logger.warn('[OpenCodeService] Failed to abort session on server:', error);
			});

			return true;
		}
		return false;
	}

	public isProcessRunning(sessionId?: string): boolean {
		const sid = sessionId || this._currentSessionId;
		if (!sid) return false;
		return this._processing.has(sid);
	}

	// =========================================================================
	// Delegated Operations
	// =========================================================================

	public getCurrentSessionId(): string | null {
		return this._currentSessionId;
	}

	public getCurrentSessionTitle(): string {
		return this._currentSessionTitle;
	}

	// Session Ops delegation
	public async createSession(): Promise<string> {
		const id = await this._sessionOps.createSession();
		this._currentSessionId = id;
		this._currentSessionTitle = 'New Session';
		return id;
	}

	public async listSessions() {
		return this._sessionOps.listSessions();
	}

	public async switchSession(sessionId: string): Promise<CLISession> {
		const session = await this._sessionOps.switchSession(sessionId);
		this._currentSessionId = session.id;
		this._currentSessionTitle = session.title;
		return session;
	}

	public async getMessages(sessionId: string) {
		return this._sessionOps.getMessages(sessionId);
	}
	public async getSessionTodos(sessionId: string) {
		return this._sessionOps.getSessionTodos(sessionId);
	}
	public async initSession(sessionId: string, options?: Record<string, unknown>) {
		return this._sessionOps.initSession(sessionId, options);
	}
	public async executeCommand(
		sessionId: string,
		command: string,
		args?: string,
		options?: Record<string, unknown>,
	) {
		return this._sessionOps.executeCommand(sessionId, command, args, options);
	}
	public async executeShell(sessionId: string, command: string, options?: Record<string, unknown>) {
		return this._sessionOps.executeShell(sessionId, command, options);
	}
	public async summarizeSession(sessionId: string, options?: Record<string, unknown>) {
		return this._sessionOps.summarizeSession(sessionId, options);
	}
	public async shareSession(sessionId: string) {
		return this._sessionOps.shareSession(sessionId);
	}
	public async unshareSession(sessionId: string) {
		return this._sessionOps.unshareSession(sessionId);
	}
	public async getSessionChildren(sessionId: string) {
		return this._sessionOps.getSessionChildren(sessionId);
	}

	public async deleteSession(sessionId: string) {
		const result = await this._sessionOps.deleteSession(sessionId);
		if (result.success && this._currentSessionId === sessionId) {
			this._currentSessionId = null;
			this._currentSessionTitle = 'New Session';
		}
		return result;
	}

	public async updateSession(sessionId: string, updates: Record<string, unknown>) {
		const result = await this._sessionOps.updateSession(sessionId, updates);
		if (
			result.success &&
			this._currentSessionId === sessionId &&
			typeof updates.title === 'string'
		) {
			this._currentSessionTitle = updates.title;
		}
		return result;
	}

	public async getSessionDiff(sessionId: string, messageId?: string) {
		return this._sessionOps.getSessionDiff(sessionId, messageId);
	}
	public async abortSession(sessionId: string) {
		return this._sessionOps.abortSession(sessionId);
	}
	public async revertToMessage(sessionId: string, messageId: string) {
		return this._sessionOps.revertToMessage(sessionId, messageId);
	}
	public async unrevertSession(sessionId: string) {
		return this._sessionOps.unrevertSession(sessionId);
	}
	public async forkSession(sessionId: string, messageId: string) {
		return this._sessionOps.forkSession(sessionId, messageId);
	}
	public async getSessionStatus() {
		return this._sessionOps.getSessionStatus();
	}

	// Provider Ops delegation
	public async getGlobalHealth() {
		return this._providerOps.getGlobalHealth();
	}
	public async writeLog(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		extra?: unknown,
	) {
		return this._providerOps.writeLog(level, message, extra as Record<string, unknown> | undefined);
	}
	public async getProviders() {
		return this._providerOps.getProviders();
	}
	public async getConfig() {
		return this._providerOps.getConfig();
	}
	public async updateConfig(config: Record<string, unknown>) {
		return this._providerOps.updateConfig(config);
	}
	public async setActiveModel(model: string) {
		return this._providerOps.setActiveModel(model);
	}
	public async setProviderAuth(providerId: string, apiKey: string) {
		return this._providerOps.setProviderAuth(providerId, apiKey);
	}
	public async disconnectProvider(providerId: string) {
		return this._providerOps.disconnectProvider(providerId);
	}

	public async addCustomProvider(config: CustomProviderConfig) {
		const result = await this._providerOps.addCustomProvider(config);
		if (result.success && result.restartRequired) {
			await this.restart();
		}
		return { success: result.success, error: result.error };
	}

	public async getMcpStatus() {
		return this._providerOps.getMcpStatus();
	}
	public async reloadMcpConfig() {
		await this._syncMcpConfig();
		return this._providerOps.forceReloadInstance();
	}
	public async authenticateMcp(name: string) {
		return this._providerOps.authenticateMcp(name);
	}
	public async startMcpAuth(name: string) {
		return this._providerOps.startMcpAuth(name);
	}
	// biome-ignore lint/suspicious/noExplicitAny: Config matches complex union type in ICLIService
	public async addMcpServer(name: string, config: any) {
		return this._providerOps.addMcpServer(name, config);
	}
	public async connectMcpServer(name: string) {
		return this._providerOps.connectMcpServer(name);
	}
	public async disconnectMcpServer(name: string) {
		return this._providerOps.disconnectMcpServer(name);
	}
	public async getProviderAuthMethods() {
		return this._providerOps.getProviderAuthMethods();
	}
	public async startProviderOAuth(providerId: string, methodIndex?: number) {
		return this._providerOps.startProviderOAuth(providerId, methodIndex);
	}
	public async completeProviderOAuth(providerId: string, code: string, methodIndex?: number) {
		return this._providerOps.completeProviderOAuth(providerId, code, methodIndex);
	}
	public async listPendingPermissions() {
		return this._providerOps.listPendingPermissions();
	}
	public async getToolIds() {
		return this._providerOps.getToolIds();
	}
	public async getTools(provider: string, model: string) {
		return this._providerOps.getTools(provider, model);
	}
	public async getAvailableProviders() {
		return this._providerOps.getAvailableProviders();
	}

	// Find Ops delegation
	public async findText(pattern: string) {
		return this._findOps.findText(pattern);
	}
	public async findFiles(query: string, includeDirs?: boolean) {
		return this._findOps.findFiles(query, includeDirs);
	}
	public async findSymbols(query: string) {
		return this._findOps.findSymbols(query);
	}
	public async listFiles(filePath: string) {
		return this._findOps.listFiles(filePath);
	}
	public async readFile(filePath: string) {
		return this._findOps.readFile(filePath);
	}
	public async getCommands() {
		return this._findOps.getCommands();
	}
	public async getLspStatus() {
		return this._findOps.getLspStatus();
	}
	public async getFormatterStatus() {
		return this._findOps.getFormatterStatus();
	}
	public async getVcsInfo() {
		return this._findOps.getVcsInfo();
	}
	public async getFileStatus() {
		return this._findOps.getFileStatus();
	}

	// Project Ops delegation
	public async listProjects() {
		return this._projectOps.listProjects();
	}
	public async getCurrentProject() {
		return this._projectOps.getCurrentProject();
	}
	public async updateProject(
		projectId: string,
		updates: { name?: string; icon?: { url?: string; color?: string } },
	) {
		return this._projectOps.updateProject(projectId, updates);
	}

	// Part Ops delegation
	public async deletePart(sessionId: string, messageId: string, partId: string) {
		return this._projectOps.deletePart(sessionId, messageId, partId);
	}
	public async updatePart(
		sessionId: string,
		messageId: string,
		partId: string,
		partData: Record<string, unknown>,
	) {
		return this._projectOps.updatePart(sessionId, messageId, partId, partData);
	}

	// Direct client methods (not delegated to Ops)
	public async getAgents(): Promise<CLIAgent[]> {
		if (!this._opencode) throw new Error('OpenCode not initialized');
		const res = await this._opencode.client.app.agents({
			directory: this._workspaceDir,
		});
		if (res.error) throw new Error(`Get agents failed: ${JSON.stringify(res.error)}`);

		// SDK returns Agent[] which may not have builtIn field, handle gracefully
		const agents = (res.data || []) as Array<{
			name: string;
			description?: string;
			mode: 'subagent' | 'primary' | 'all';
			builtIn?: boolean;
			options?: Record<string, unknown>;
		}>;

		return agents
			.filter(a => a.mode === 'primary' || a.mode === 'all')
			.map(a => ({
				name: a.name,
				description: a.description,
				mode: a.mode,
				builtIn: a.builtIn ?? false,
				options: a.options,
			}));
	}

	/**
	 * Respond to a permission request from the AI assistant.
	 * SDK v2 API: permission.reply (replaces deprecated permission.respond)
	 * @param permissionId - The unique permission request ID (requestID in SDK v2)
	 * @param response - The response: 'once' (allow this time), 'always' (allow permanently), 'reject' (deny)
	 * @param message - Optional message explaining the response (useful for reject explanations)
	 */
	public async respondToPermission(
		permissionId: string,
		response: PermissionResponse,
		message?: string,
	) {
		if (!this._opencode) throw new Error('OpenCode not initialized');
		const res = await this._opencode.client.permission.reply({
			requestID: permissionId,
			directory: this._workspaceDir,
			reply: response,
			message,
		});
		if (res.error) {
			throw new Error(`Permission reply failed: ${JSON.stringify(res.error)}`);
		}
	}

	public async checkHealth(): Promise<{ healthy: boolean; version?: string }> {
		return this._providerOps.getGlobalHealth();
	}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	private async _syncMcpConfig(): Promise<void> {
		try {
			const hasConfig = await this._agentsConfigService.hasProjectConfig();
			if (hasConfig) {
				await this._agentsSyncService.syncToOpenCodeProject();
				logger.info('[OpenCodeService] Synced MCP config to opencode.json');
			}
		} catch (error) {
			logger.warn('[OpenCodeService] Failed to sync MCP config:', error);
		}
	}

	private async _processStreamWithRetry(
		sse: unknown,
		sessionId: string,
		onData: (data: CLIStreamData) => void,
		directory: string,
		abortController: AbortController,
	): Promise<void> {
		let currentSse = sse as { stream: AsyncIterable<unknown>; close?: () => void };
		let reconnectAttempts = 0;
		const maxReconnectAttempts = 3;

		// Track child sessions (subtasks/subagents) to allow their events through
		const childSessionIds = new Set<string>();

		while (reconnectAttempts <= maxReconnectAttempts) {
			try {
				let eventCount = 0;
				let lastEventType = '';

				try {
					for await (const event of currentSse.stream) {
						if (abortController.signal.aborted) {
							logger.info('[OpenCodeService] Stream aborted');
							break;
						}

						eventCount++;
						const typedEvent = event as OpenCodeEvent;
						lastEventType = typedEvent.type || 'unknown';
						const props = typedEvent.properties ?? {};

						// Extract session ID from various event structures
						const info = props.info as Record<string, unknown> | undefined;
						const part = props.part as Record<string, unknown> | undefined;
						const evSessionID =
							(props.sessionID as string | undefined) ??
							(props.sessionId as string | undefined) ??
							(info?.sessionID as string | undefined) ??
							(info?.sessionId as string | undefined) ??
							(part?.sessionID as string | undefined) ??
							(part?.sessionId as string | undefined);

						// For session.created events, check if it's a child session of our parent
						// If so, track it and allow its events through
						if (typedEvent.type === 'session.created' && info) {
							const parentID = info.parentID as string | undefined;
							const newSessionId = (info.id as string) || (info.sessionID as string);
							if (parentID === sessionId && newSessionId) {
								logger.info(
									`[OpenCodeService] Child session created: ${newSessionId} (parent: ${sessionId})`,
								);
								childSessionIds.add(newSessionId);
								// Don't filter this event - let it through
							}
						}

						// Filter events: allow if matches parent session OR is from a tracked child session
						const isParentSession = !evSessionID || evSessionID === sessionId;
						const isChildSession = evSessionID ? childSessionIds.has(evSessionID) : false;

						if (!isParentSession && !isChildSession) {
							continue;
						}

						// Use EventParser module
						// Pass the actual event's sessionId for proper context, but use parent sessionId for UI routing
						const streamData = OpenCodeEventParser.transformEvent(typedEvent, sessionId);
						if (streamData) {
							// For child session events, mark them so UI knows they belong to a subtask
							if (isChildSession && evSessionID) {
								streamData.childSessionId = evSessionID;
							}
							onData(streamData);
						}

						// Only break on parent session idle, not child session idle
						if (typedEvent.type === 'session.idle' && evSessionID === sessionId) {
							logger.info(`[OpenCodeService] Session idle after ${eventCount} events`);
							break;
						}
					}

					// Log if stream ended without session.idle
					if (!abortController.signal.aborted && lastEventType !== 'session.idle') {
						logger.warn(
							`[OpenCodeService] Stream ended without session.idle. Last event: ${lastEventType}, total events: ${eventCount}`,
						);
					}

					return; // Success
				} finally {
					try {
						currentSse.close?.();
					} catch {
						// Ignore close errors
					}
				}
			} catch (error) {
				const isNetworkErr = retryService.isNetworkError(error);
				const isAborted = abortController.signal.aborted;

				// Enhanced error logging
				const errorInfo = {
					type: error?.constructor?.name,
					message: error instanceof Error ? error.message : String(error),
					code: (error as { code?: string })?.code,
					cause: (error as { cause?: unknown })?.cause,
					isNetworkError: isNetworkErr,
					isAborted,
					reconnectAttempts,
				};
				logger.debug('[OpenCodeService] Stream error details:', errorInfo);

				if (isAborted) return;

				if (!isNetworkErr || reconnectAttempts >= maxReconnectAttempts) {
					logger.error(
						`[OpenCodeService] Stream failed after ${reconnectAttempts} attempts:`,
						error,
					);
					throw error;
				}

				reconnectAttempts++;
				logger.warn(`[OpenCodeService] Stream disconnected, retry ${reconnectAttempts}...`);

				onData({
					type: 'system',
					sessionId,
					message: {
						content: [
							{
								type: 'text',
								text: `Connection lost. Reconnecting... (attempt ${reconnectAttempts})`,
							},
						],
					},
				});

				const delayMs = Math.min(1000 * 2 ** (reconnectAttempts - 1), 10000);
				await new Promise(resolve => setTimeout(resolve, delayMs));
				// biome-ignore lint/style/noNonNullAssertion: Checked
				currentSse = await this._opencode!.client.event.subscribe({ directory });
				logger.info('[OpenCodeService] SSE reconnected successfully');
				onData({
					type: 'system',
					sessionId,
					message: { content: [{ type: 'text', text: 'Reconnected successfully' }] },
				});
			}
		}
	}

	/**
	 * Run a simple prompt and get a text response (no streaming, no session).
	 * Used for utility tasks like Prompt Improver.
	 */
	public async runSimplePrompt(
		prompt: string,
		options?: {
			model?: string;
			timeoutMs?: number;
			proxyConfig?: {
				enabled: boolean;
				baseUrl: string;
				apiKey?: string;
				useSingleModel?: boolean;
				haikuModel?: string;
				sonnetModel?: string;
				opusModel?: string;
				subagentModel?: string;
			};
		},
	): Promise<string> {
		const timeout = options?.timeoutMs || 60000;

		// Ensure OpenCode is initialized
		if (!this._opencode) {
			await this.initialize(this._workspaceDir);
		}

		if (!this._opencode) {
			throw new Error('OpenCode service not initialized');
		}

		const directory = this._workspaceDir || process.cwd();

		// Create a temporary session for this request
		const sessionRes = await this._opencode.client.session.create({ directory });
		if (sessionRes.error) {
			throw new Error(`Create session failed: ${JSON.stringify(sessionRes.error)}`);
		}
		const sessionId = (sessionRes.data as { id: string }).id;
		logger.debug(`[OpenCodeService] runSimplePrompt: created session ${sessionId}`);

		try {
			// Build model options - model already comes with correct format from UI (e.g., "oai/[Kiro] model")
			const effectiveModel = options?.model;
			let modelOptions: { providerID: string; modelID: string } | undefined;
			if (effectiveModel && effectiveModel !== 'default') {
				modelOptions = effectiveModel.includes('/')
					? {
							providerID: effectiveModel.split('/')[0],
							modelID: effectiveModel.split('/').slice(1).join('/'),
						}
					: { providerID: 'anthropic', modelID: effectiveModel };
			}

			logger.debug(
				`[OpenCodeService] runSimplePrompt: model=${effectiveModel}, providerID=${modelOptions?.providerID}, modelID=${modelOptions?.modelID}`,
			);

			// Subscribe to events BEFORE sending prompt (to not miss any events)
			const sse = (await this._opencode.client.event.subscribe({
				directory,
			})) as { stream: AsyncIterable<unknown>; close?: () => void };

			// Send the message using session.prompt (don't await - process events in parallel)
			const promptPromise = this._opencode.client.session.prompt({
				sessionID: sessionId,
				directory,
				model: modelOptions || { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
				parts: [{ type: 'text' as const, text: prompt }],
			});

			// Collect response with timeout
			const startTime = Date.now();
			let resultText = '';
			let isComplete = false;

			try {
				for await (const event of sse.stream) {
					if (Date.now() - startTime > timeout) {
						throw new Error('Timeout waiting for response');
					}

					const typedEvent = event as OpenCodeEvent;

					// Filter events for our session
					const eventSessionId =
						(typedEvent.properties?.sessionID as string) ||
						(typedEvent.properties?.sessionId as string);
					if (eventSessionId && eventSessionId !== sessionId) {
						continue;
					}

					if (typedEvent.type === 'part.text.delta' && typedEvent.properties?.content) {
						resultText += typedEvent.properties.content;
					}

					// Also handle message.part.updated for text content
					if (typedEvent.type === 'message.part.updated') {
						const part = typedEvent.properties?.part as Record<string, unknown> | undefined;
						if (part?.type === 'text' && typeof part?.text === 'string') {
							// This is a full replacement, not delta
							resultText = part.text;
						}
					}

					if (typedEvent.type === 'session.idle') {
						isComplete = true;
						break;
					}

					if (typedEvent.type === 'session.error') {
						const errorMsg =
							(typedEvent.properties?.error as string) || JSON.stringify(typedEvent.properties);
						throw new Error(`Session error: ${errorMsg}`);
					}
				}
			} finally {
				try {
					sse.close?.();
				} catch {
					// Ignore close errors
				}
			}

			// Check prompt result
			const promptRes = await promptPromise;
			if (promptRes.error) {
				throw new Error(`Prompt failed: ${JSON.stringify(promptRes.error)}`);
			}

			if (!isComplete && !resultText) {
				throw new Error('OpenCode returned no response');
			}

			logger.debug(
				`[OpenCodeService] runSimplePrompt: success, response length=${resultText.length}`,
			);
			return resultText.trim();
		} finally {
			// Clean up the temporary session
			try {
				await this._opencode.client.session.abort({ sessionID: sessionId });
			} catch {
				// Ignore cleanup errors
			}
		}
	}
}
