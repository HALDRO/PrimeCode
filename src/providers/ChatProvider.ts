/**
 * @file ChatProvider
 * @description Simplified chat provider with direct routing (no handlers).
 * Inspired by Vibe Kanban's architecture.
 */

import * as vscode from 'vscode';
import type { SessionEventMessage, SessionLifecycleMessage } from '../common';
import { type CLIEvent, CLIRunner } from '../core/CLIRunner';
import { Settings } from '../core/Settings';
// Import existing services (keep the good stuff)
import { AgentsCommandsService } from '../services/AgentsCommandsService';
import { AgentsConfigService } from '../services/AgentsConfigService';
import { AgentsHooksService } from '../services/AgentsHooksService';
import { AgentsSkillsService } from '../services/AgentsSkillsService';
import { AgentsSubagentsService } from '../services/AgentsSubagentsService';
import { AgentsSyncService } from '../services/AgentsSyncService';
import { ClipboardContextService } from '../services/ClipboardContextService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { McpMarketplaceService } from '../services/mcp/McpMarketplaceService';
import { McpMetadataService } from '../services/mcp/McpMetadataService';
import { RulesService } from '../services/RulesService';
import { logger } from '../utils/logger';
import { getHtml } from '../utils/webviewHtml';

// Service instances
const agentsCommandsService = new AgentsCommandsService();
const agentsSkillsService = new AgentsSkillsService();
const agentsHooksService = new AgentsHooksService();
const agentsSubagentsService = new AgentsSubagentsService();

// =============================================================================
// Types
// =============================================================================

interface WebviewMessage {
	type: string;
	[key: string]: unknown;
}

// =============================================================================
// ChatProvider
// =============================================================================

export class ChatProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private cli: CLIRunner;
	private settings: Settings;
	private disposables: vscode.Disposable[] = [];
	private activeSessionId: string;
	private activeAssistantPartId: string | null = null;
	private alwaysAllowByTool: Record<string, boolean> = {};
	private improvePromptController: AbortController | null = null;
	private improvePromptActiveRequestId: string | null = null;

	private readonly agentsConfigService: AgentsConfigService;
	private readonly agentsSyncService: AgentsSyncService;
	private readonly mcpConfigWatcher: McpConfigWatcherService;
	private readonly mcpMarketplaceService: McpMarketplaceService;
	private readonly mcpMetadataService: McpMetadataService;
	private readonly mcpManagementService: McpManagementService;
	private rulesService: RulesService | null = null;

	private readonly clipboardContextService = ClipboardContextService.getInstance();

	private readonly webviewHandlers: Record<string, (msg: WebviewMessage) => Promise<void>> = {
		webviewDidLaunch: msg => this.onWebviewDidLaunch(msg),
		sendMessage: msg => this.onSendMessage(msg),
		accessResponse: msg => this.onAccessResponse(msg),

		getSettings: () => this.onGetSettings(),
		updateSettings: msg => this.onUpdateSettings(msg),
		getAccess: () => this.onGetAccess(),
		getCommands: () => this.onGetCommands(),
		getSkills: () => this.onGetSkills(),
		getHooks: () => this.onGetHooks(),
		getSubagents: () => this.onGetSubagents(),
		getRules: () => this.onGetRules(),
		checkDiscoveryStatus: () => this.onCheckDiscoveryStatus(),

		// MCP
		loadMCPServers: () => this.onLoadMcpServers(),
		fetchMcpMarketplaceCatalog: msg => this.onFetchMcpMarketplaceCatalog(msg),
		installMcpFromMarketplace: msg => this.onInstallMcpFromMarketplace(msg),
		saveMCPServer: msg => this.onSaveMcpServer(msg),
		deleteMCPServer: msg => this.onDeleteMcpServer(msg),
		openAgentsMcpConfig: () => this.onOpenAgentsMcpConfig(),
		importMcpFromCLI: () => this.onImportMcpFromCli(),
		syncAgentsToClaudeProject: () => this.onSyncAgentsToProject('claude'),
		syncAgentsToOpenCodeProject: () => this.onSyncAgentsToProject('opencode'),
		startOpenCodeMcpAuth: msg => this.onStartOpenCodeMcpAuth(msg),
		loadOpenCodeMcpStatus: () => this.onLoadOpenCodeMcpStatus(),

		// Providers / Proxy
		reloadAllProviders: () => this.onReloadAllProviders(),
		checkOpenCodeStatus: () => this.onCheckOpenCodeStatus(),
		loadOpenCodeProviders: () => this.onLoadOpenCodeProviders(),
		loadAvailableProviders: () => this.onLoadAvailableProviders(),
		setOpenCodeProviderAuth: msg => this.onSetOpenCodeProviderAuth(msg),
		disconnectOpenCodeProvider: msg => this.onDisconnectOpenCodeProvider(msg),
		setOpenCodeModel: msg => this.onSetOpenCodeModel(msg),
		selectModel: msg => this.onSelectModel(msg),
		loadProxyModels: msg => this.onLoadProxyModels(msg),

		// Diagnostics / Files / Clipboard / Misc
		checkCLIDiagnostics: () => this.onCheckCliDiagnostics(),
		getPermissions: msg => this.onGetPermissions(msg),
		setPermissions: msg => this.onSetPermissions(msg),
		openFile: msg => this.onOpenFile(msg),
		openExternal: msg => this.onOpenExternal(msg),
		getImageData: msg => this.onGetImageData(msg),
		getClipboardContext: msg => this.onGetClipboardContext(msg),
		improvePromptRequest: msg => this.onImprovePromptRequest(msg),
		cancelImprovePrompt: msg => this.onCancelImprovePrompt(msg),
	};

	constructor(private context: vscode.ExtensionContext) {
		this.settings = new Settings();

		this.agentsConfigService = new AgentsConfigService();
		this.agentsSyncService = new AgentsSyncService(this.agentsConfigService);
		this.mcpConfigWatcher = new McpConfigWatcherService(
			this.agentsConfigService,
			this.agentsSyncService,
		);
		this.mcpMarketplaceService = new McpMarketplaceService(this.context);
		this.mcpMetadataService = new McpMetadataService(this.context);
		this.mcpManagementService = new McpManagementService(
			this.context,
			this.mcpMarketplaceService,
			this.mcpMetadataService,
			msg => this.postMessage(msg),
		);
		this.mcpManagementService.setOnConfigSaved(() => this.mcpConfigWatcher.notifyUiSave());

		this.alwaysAllowByTool =
			(this.context.workspaceState.get('primeCode.alwaysAllowByTool') as
				| Record<string, boolean>
				| undefined) ?? {};

		this.activeSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		this.cli = new CLIRunner(provider);

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

		// Initialize workspace-scoped services
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			agentsCommandsService.setWorkspaceRoot(workspaceRoot);
			agentsSkillsService.setWorkspaceRoot(workspaceRoot);
			agentsHooksService.setWorkspaceRoot(workspaceRoot);
			agentsSubagentsService.setWorkspaceRoot(workspaceRoot);
			this.rulesService = new RulesService(workspaceRoot);
		}

		// Start MCP watcher
		this.mcpConfigWatcher.start();
		this.disposables.push(this.mcpConfigWatcher);
		this.disposables.push(
			this.mcpConfigWatcher.onConfigChanged(e =>
				this.postMessage({
					type: 'mcpConfigReloaded',
					data: { source: e.source, timestamp: e.timestamp },
				}),
			),
		);
	}

	// =============================================================================
	// WebviewViewProvider Implementation
	// =============================================================================

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri],
		};

		// Generate HTML (simplified - just pass webview and extensionUri)
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

		// Handle messages from webview
		this.disposables.push(
			webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg)),
		);

		// Send initial state
		this.sendInitialState();
		this.postMessage({ type: 'accessData', data: [] });

		// Create + switch to initial session (unified protocol)
		this.postLifecycle('created', this.activeSessionId);
		this.postLifecycle('switched', this.activeSessionId, { isProcessing: false });
		this.postStatus(this.activeSessionId, 'idle', 'Ready');
		this.postSessionInfo();
	}

	// =============================================================================
	// Message Handling (Direct Routing - No Router!)
	// =============================================================================

	private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
		try {
			const msgType = msg.type as string;
			const handler = this.webviewHandlers[msgType];
			if (!handler) {
				logger.warn(`[ChatProvider] Unknown message type: ${msgType}`);
				return;
			}
			await handler(msg);
		} catch (error) {
			logger.error(`[ChatProvider] Error handling message:`, error);
			this.postSessionMessage({
				id: `error-${Date.now()}`,
				type: 'error',
				content: error instanceof Error ? error.message : 'Unknown error',
				isError: true,
				timestamp: new Date().toISOString(),
			});
			this.postStatus(this.activeSessionId, 'error', 'Error');
		}
	}

	// =============================================================================
	// Webview message handlers
	// =============================================================================

	private async onWebviewDidLaunch(msg: WebviewMessage): Promise<void> {
		const uiSessionId = (msg.sessionId as string | undefined) || this.activeSessionId;
		this.activeSessionId = uiSessionId;
		this.postLifecycle('created', uiSessionId);
		this.postLifecycle('switched', uiSessionId, { isProcessing: false });
		this.postStatus(uiSessionId, 'idle', 'Ready');
		this.postSessionInfo();
	}

	private async onSendMessage(msg: WebviewMessage): Promise<void> {
		const text = msg.text as string;
		const uiModel = typeof msg.model === 'string' ? (msg.model as string) : undefined;
		await this.handleSendMessage(text, msg.sessionId as string | undefined, uiModel);
	}

	private async onAccessResponse(msg: WebviewMessage): Promise<void> {
		const requestId = typeof msg.id === 'string' ? (msg.id as string) : undefined;
		const approved = Boolean(msg.approved);
		const alwaysAllow = Boolean(msg.alwaysAllow);
		const response =
			msg.response === 'once' || msg.response === 'always' || msg.response === 'reject'
				? msg.response
				: undefined;

		if (!requestId) {
			throw new Error('Missing accessResponse.id');
		}

		if (alwaysAllow) {
			const toolName = typeof msg.toolName === 'string' ? (msg.toolName as string) : undefined;
			if (toolName) {
				this.alwaysAllowByTool[toolName] = approved;
				await this.context.workspaceState.update(
					'primeCode.alwaysAllowByTool',
					this.alwaysAllowByTool,
				);
				this.postMessage({
					type: 'accessData',
					data: Object.entries(this.alwaysAllowByTool)
						.filter(([, allow]) => allow)
						.map(([t]) => ({ toolName: t, allowAll: true })),
				});
			}
		}

		await this.cli.respondToPermission({
			requestId,
			approved,
			alwaysAllow,
			response,
		});

		this.postMessage({
			type: 'session_event',
			targetId: this.activeSessionId,
			eventType: 'access',
			payload: {
				eventType: 'access',
				action: 'response',
				requestId,
				approved,
				alwaysAllow,
			},
			timestamp: Date.now(),
			sessionId: this.activeSessionId,
		} satisfies SessionEventMessage);
	}

	private async onGetSettings(): Promise<void> {
		this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
	}

	private async onUpdateSettings(msg: WebviewMessage): Promise<void> {
		const settings = (msg.settings as Record<string, unknown> | undefined) || {};
		await this.applyWebviewSettingsPatch(settings);
		this.settings.refresh();
		this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
	}

	private async onGetCommands(): Promise<void> {
		this.postMessage({ type: 'commandsList', data: { custom: [], isLoading: true } });
		try {
			const commands = await agentsCommandsService.getCommands();
			this.postMessage({
				type: 'commandsList',
				data: { custom: commands, isLoading: false },
			});
		} catch (error) {
			this.postMessage({
				type: 'commandsList',
				data: {
					custom: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetSkills(): Promise<void> {
		this.postMessage({ type: 'skillsList', data: { skills: [], isLoading: true } });
		try {
			const skills = await agentsSkillsService.getSkills();
			this.postMessage({
				type: 'skillsList',
				data: { skills, isLoading: false },
			});
		} catch (error) {
			this.postMessage({
				type: 'skillsList',
				data: {
					skills: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetHooks(): Promise<void> {
		this.postMessage({ type: 'hooksList', data: { hooks: [], isLoading: true } });
		try {
			const hooks = await agentsHooksService.getHooks();
			this.postMessage({
				type: 'hooksList',
				data: { hooks, isLoading: false },
			});
		} catch (error) {
			this.postMessage({
				type: 'hooksList',
				data: {
					hooks: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetSubagents(): Promise<void> {
		this.postMessage({ type: 'subagentsList', data: { subagents: [], isLoading: true } });
		try {
			const subagents = await agentsSubagentsService.getSubagents();
			this.postMessage({
				type: 'subagentsList',
				data: { subagents, isLoading: false },
			});
		} catch (error) {
			this.postMessage({
				type: 'subagentsList',
				data: {
					subagents: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetRules(): Promise<void> {
		this.postMessage({ type: 'ruleList', data: { rules: [] } });
		if (!this.rulesService) {
			this.postMessage({ type: 'ruleList', data: { rules: [] } });
			return;
		}
		try {
			const rules = await this.rulesService.getRules();
			this.postMessage({ type: 'ruleList', data: { rules } });
		} catch (error) {
			logger.error('[ChatProvider] getRules failed:', error);
			this.postMessage({ type: 'ruleList', data: { rules: [] } });
		}
	}

	private async onLoadMcpServers(): Promise<void> {
		await this.mcpManagementService.loadMCPServers();
		await this.mcpManagementService.pingMcpServers();
	}

	private async onFetchMcpMarketplaceCatalog(msg: WebviewMessage): Promise<void> {
		const forceRefresh = Boolean(
			(msg.data as { forceRefresh?: boolean } | undefined)?.forceRefresh,
		);
		await this.mcpManagementService.fetchMcpMarketplaceCatalog(forceRefresh);
	}

	private async onInstallMcpFromMarketplace(msg: WebviewMessage): Promise<void> {
		const mcpId = typeof msg.mcpId === 'string' ? msg.mcpId : undefined;
		if (!mcpId) throw new Error('Missing mcpId');
		await this.mcpManagementService.installMcpFromMarketplace(mcpId);
	}

	private async onSaveMcpServer(msg: WebviewMessage): Promise<void> {
		const name = typeof msg.name === 'string' ? msg.name : undefined;
		const config = msg.config as import('../common').MCPServerConfig | undefined;
		if (!name || !config) throw new Error('Missing MCP server name/config');
		await this.mcpManagementService.saveMCPServer(name, config);
	}

	private async onDeleteMcpServer(msg: WebviewMessage): Promise<void> {
		const name = typeof msg.name === 'string' ? msg.name : undefined;
		if (!name) throw new Error('Missing MCP server name');
		await this.mcpManagementService.deleteMCPServer(name);
	}

	private async onOpenAgentsMcpConfig(): Promise<void> {
		await this.mcpManagementService.openAgentsMcpConfig();
	}

	private async onImportMcpFromCli(): Promise<void> {
		await this.mcpManagementService.importFromAllSources();
	}

	private async onSyncAgentsToProject(target: 'claude' | 'opencode'): Promise<void> {
		await this.mcpManagementService.syncAgentsToProject(target);
	}

	private async onStartOpenCodeMcpAuth(_msg: WebviewMessage): Promise<void> {
		// OpenCode MCP auth flow is not implemented in CLIRunner-based architecture.
		this.postMessage({
			type: 'opencodeMcpAuthError',
			data: { name: 'opencode', error: 'OpenCode MCP auth flow is not implemented' },
		});
	}

	private async onLoadOpenCodeMcpStatus(): Promise<void> {
		this.postMessage({ type: 'opencodeMcpStatus', data: {} });
	}

	private async onGetAccess(): Promise<void> {
		this.postMessage({
			type: 'accessData',
			data: Object.entries(this.alwaysAllowByTool)
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		});
	}

	private async onCheckDiscoveryStatus(): Promise<void> {
		// Best-effort discovery based on existing files/services. The full legacy discovery pipeline was removed.
		this.postMessage({
			type: 'discoveryStatus',
			data: {
				rules: {
					hasAgentsMd: true,
					hasClaudeMd: false,
					hasClaudeShim: false,
					ruleFiles: [],
				},
				permissions: {},
				skills: [],
				hooks: [],
			},
		});
	}

	private async onReloadAllProviders(): Promise<void> {
		await Promise.all([this.onLoadAvailableProviders(), this.onLoadOpenCodeProviders()]);
	}

	private async onCheckOpenCodeStatus(): Promise<void> {
		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		if (provider !== 'opencode') {
			this.postMessage({ type: 'openCodeStatus', data: { installed: false, version: null } });
			return;
		}

		// Best-effort: we do not probe the environment deeply here.
		this.postMessage({ type: 'openCodeStatus', data: { installed: true, version: null } });
	}

	private async onLoadOpenCodeProviders(): Promise<void> {
		this.postMessage({
			type: 'openCodeProviders',
			data: { providers: [], config: { isLoading: true } },
		});

		try {
			const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
			if (provider !== 'opencode') {
				this.postMessage({
					type: 'openCodeProviders',
					data: { providers: [], config: { isLoading: false } },
				});
				return;
			}

			const info = this.cli.getOpenCodeServerInfo();
			if (!info) {
				this.postMessage({
					type: 'openCodeProviders',
					data: {
						providers: [],
						config: { isLoading: false, error: 'OpenCode server not running' },
					},
				});
				return;
			}

			const resp = await fetch(
				`${info.baseUrl}/provider?directory=${encodeURIComponent(info.directory)}`,
				{
					method: 'GET',
					headers: { ...this.buildOpenCodeHeaders(info.directory) },
				},
			);
			if (!resp.ok) {
				const text = await resp.text().catch(() => '');
				throw new Error(`OpenCode /provider failed: ${resp.status} ${resp.statusText}: ${text}`);
			}

			const json = (await resp.json()) as unknown;
			const all =
				json &&
				typeof json === 'object' &&
				'all' in json &&
				Array.isArray((json as { all?: unknown }).all)
					? ((json as { all: unknown[] }).all as unknown[])
					: [];
			const connected =
				json &&
				typeof json === 'object' &&
				'connected' in json &&
				Array.isArray((json as { connected?: unknown }).connected)
					? ((json as { connected: unknown[] }).connected as unknown[])
					: [];
			const connectedSet = new Set(connected.map(x => String(x)));

			const providers = all
				.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
				.filter(p => connectedSet.has(String(p.id ?? '')))
				.map(p => {
					const id = String(p.id ?? '');
					const name = String(p.name ?? id);
					const modelsRaw = p.models;
					const modelsObj =
						modelsRaw && typeof modelsRaw === 'object'
							? (modelsRaw as Record<string, unknown>)
							: {};
					const models = Object.values(modelsObj)
						.filter((m): m is Record<string, unknown> => m != null && typeof m === 'object')
						.map(m => ({
							id: String(m.id ?? ''),
							name: String(m.name ?? m.id ?? ''),
							reasoning: Boolean(m.reasoning),
							limit:
								m.limit && typeof m.limit === 'object'
									? {
											context:
												typeof (m.limit as { context?: unknown }).context === 'number'
													? ((m.limit as { context?: number }).context as number)
													: undefined,
											output:
												typeof (m.limit as { output?: unknown }).output === 'number'
													? ((m.limit as { output?: number }).output as number)
													: undefined,
										}
									: undefined,
						}));

					return { id, name, isCustom: p.source === 'custom', models };
				})
				.filter(p => p.id.length > 0);

			this.postMessage({
				type: 'openCodeProviders',
				data: { providers, config: { isLoading: false } },
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'openCodeProviders',
				data: { providers: [], config: { isLoading: false, error: msg } },
			});
		}
	}

	private async onLoadAvailableProviders(): Promise<void> {
		try {
			const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
			if (provider !== 'opencode') {
				this.postMessage({ type: 'availableProviders', data: { providers: [] } });
				return;
			}

			const info = this.cli.getOpenCodeServerInfo();
			if (!info) {
				this.postMessage({ type: 'availableProviders', data: { providers: [] } });
				return;
			}

			const resp = await fetch(
				`${info.baseUrl}/provider?directory=${encodeURIComponent(info.directory)}`,
				{
					method: 'GET',
					headers: { ...this.buildOpenCodeHeaders(info.directory) },
				},
			);
			if (!resp.ok) {
				this.postMessage({ type: 'availableProviders', data: { providers: [] } });
				return;
			}

			const json = (await resp.json()) as unknown;
			const all =
				json &&
				typeof json === 'object' &&
				'all' in json &&
				Array.isArray((json as { all?: unknown }).all)
					? ((json as { all: unknown[] }).all as unknown[])
					: [];
			const connected =
				json &&
				typeof json === 'object' &&
				'connected' in json &&
				Array.isArray((json as { connected?: unknown }).connected)
					? ((json as { connected: unknown[] }).connected as unknown[])
					: [];
			const connectedSet = new Set(connected.map(x => String(x)));

			const providers = all
				.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
				.filter(p => !connectedSet.has(String(p.id ?? '')))
				.map(p => ({
					id: String(p.id ?? ''),
					name: String(p.name ?? p.id ?? ''),
					env: Array.isArray(p.env) ? p.env.map(x => String(x)) : [],
				}))
				.filter(p => p.id.length > 0);

			this.postMessage({ type: 'availableProviders', data: { providers } });
		} catch {
			this.postMessage({ type: 'availableProviders', data: { providers: [] } });
		}
	}

	private buildOpenCodeHeaders(directory: string): Record<string, string> {
		return { 'x-opencode-directory': directory };
	}

	private async onSetOpenCodeProviderAuth(msg: WebviewMessage): Promise<void> {
		const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
		const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey : '';
		if (!providerId || !apiKey) {
			this.postMessage({
				type: 'openCodeAuthResult',
				data: { success: false, error: 'Missing providerId or apiKey', providerId },
			});
			return;
		}

		this.postMessage({
			type: 'openCodeAuthResult',
			data: { success: false, providerId, isLoading: true },
		});

		try {
			const info = this.cli.getOpenCodeServerInfo();
			if (!info) {
				this.postMessage({
					type: 'openCodeAuthResult',
					data: { success: false, error: 'OpenCode server not running', providerId },
				});
				return;
			}

			const resp = await fetch(
				`${info.baseUrl}/auth/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(info.directory)}`,
				{
					method: 'PUT',
					headers: {
						'Content-Type': 'application/json',
						...this.buildOpenCodeHeaders(info.directory),
					},
					body: JSON.stringify({ type: 'api', key: apiKey }),
				},
			);

			const ok = resp.ok;
			if (!ok) {
				const text = await resp.text().catch(() => '');
				throw new Error(`OpenCode auth set failed: ${resp.status} ${resp.statusText}: ${text}`);
			}

			this.postMessage({ type: 'openCodeAuthResult', data: { success: true, providerId } });
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'openCodeAuthResult',
				data: { success: false, error: err, providerId },
			});
		}
	}

	private async onDisconnectOpenCodeProvider(msg: WebviewMessage): Promise<void> {
		const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
		if (!providerId) {
			this.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: false, error: 'Missing providerId', providerId },
			});
			return;
		}

		try {
			const info = this.cli.getOpenCodeServerInfo();
			if (!info) {
				this.postMessage({
					type: 'openCodeDisconnectResult',
					data: { success: false, error: 'OpenCode server not running', providerId },
				});
				return;
			}

			const resp = await fetch(
				`${info.baseUrl}/auth/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(info.directory)}`,
				{
					method: 'DELETE',
					headers: { ...this.buildOpenCodeHeaders(info.directory) },
				},
			);

			if (!resp.ok) {
				const text = await resp.text().catch(() => '');
				throw new Error(`OpenCode auth delete failed: ${resp.status} ${resp.statusText}: ${text}`);
			}

			this.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: true, providerId },
			});

			// Let UI prune models for this provider.
			this.postMessage({ type: 'removeOpenCodeProvider', data: { providerId } });
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: false, error: err, providerId },
			});
		}
	}

	private async onSetOpenCodeModel(msg: WebviewMessage): Promise<void> {
		const model = typeof msg.model === 'string' ? msg.model : undefined;
		if (model) {
			await this.settings.set('model', model);
			this.settings.refresh();
			this.postMessage({ type: 'openCodeModelSet', data: { model } });
			this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
		}
	}

	private async onSelectModel(msg: WebviewMessage): Promise<void> {
		const model = typeof msg.model === 'string' ? msg.model : undefined;
		if (model) {
			await this.settings.set('model', model);
			this.settings.refresh();
			this.postMessage({ type: 'modelSelected', model });
			this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
		}
	}

	private async onLoadProxyModels(msg: WebviewMessage): Promise<void> {
		const data = (msg.data ?? {}) as { baseUrl?: unknown; apiKey?: unknown };
		const baseUrlRaw =
			typeof data.baseUrl === 'string'
				? data.baseUrl
				: typeof this.settings.get('proxy.baseUrl') === 'string'
					? (this.settings.get('proxy.baseUrl') as string)
					: '';
		const apiKeyRaw =
			typeof data.apiKey === 'string'
				? data.apiKey
				: typeof this.settings.get('proxy.apiKey') === 'string'
					? (this.settings.get('proxy.apiKey') as string)
					: '';

		const baseUrl = baseUrlRaw.trim().replace(/\/+$/g, '');
		const apiKey = apiKeyRaw.trim();

		if (!baseUrl) {
			this.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], error: 'Missing proxy baseUrl' },
			});
			return;
		}

		let url: URL;
		try {
			url = new URL(`${baseUrl}/v1/models`);
		} catch {
			this.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], baseUrl, error: 'Invalid proxy baseUrl' },
			});
			return;
		}

		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
			});

			if (!response.ok) {
				const bodyText = await response.text().catch(() => '');
				const detail = bodyText ? `: ${bodyText.slice(0, 400)}` : '';
				this.postMessage({
					type: 'proxyModels',
					data: {
						enabled: false,
						models: [],
						baseUrl,
						error: `Proxy models request failed (${response.status})${detail}`,
					},
				});
				return;
			}

			const json = (await response.json()) as unknown;
			const items =
				json &&
				typeof json === 'object' &&
				'data' in json &&
				Array.isArray((json as { data?: unknown }).data)
					? ((json as { data: unknown[] }).data as unknown[])
					: [];

			const models = items
				.filter(
					(item): item is { id: unknown } =>
						item != null && typeof item === 'object' && 'id' in item,
				)
				.map(item => {
					const id = String((item as { id?: unknown }).id ?? '');
					return { id, name: id };
				})
				.filter(m => m.id.length > 0);

			this.postMessage({
				type: 'proxyModels',
				data: {
					enabled: models.length > 0,
					models,
					baseUrl,
				},
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], baseUrl, error: `Proxy models fetch failed: ${msg}` },
			});
		}
	}

	private async onCheckCliDiagnostics(): Promise<void> {
		this.postMessage({ type: 'cliDiagnostics', data: null });
	}

	private async onGetPermissions(_msg: WebviewMessage): Promise<void> {
		this.postMessage({
			type: 'permissionsUpdated',
			data: { policies: { edit: 'ask', terminal: 'ask', network: 'ask' } },
		});
	}

	private async onSetPermissions(_msg: WebviewMessage): Promise<void> {
		this.postMessage({
			type: 'permissionsUpdated',
			data: { policies: { edit: 'ask', terminal: 'ask', network: 'ask' } },
		});
	}

	private async onOpenFile(msg: WebviewMessage): Promise<void> {
		const filePath = typeof msg.filePath === 'string' ? msg.filePath : undefined;
		if (!filePath) throw new Error('Missing filePath');
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	}

	private async onOpenExternal(msg: WebviewMessage): Promise<void> {
		const url = typeof msg.url === 'string' ? msg.url : undefined;
		if (!url) throw new Error('Missing url');
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	private async onGetImageData(_msg: WebviewMessage): Promise<void> {
		this.postMessage({ type: 'imageData', data: { id: '', dataUrl: '' } });
	}

	private async onGetClipboardContext(msg: WebviewMessage): Promise<void> {
		const text = typeof msg.text === 'string' ? msg.text : undefined;
		if (!text) {
			this.postMessage({ type: 'clipboardContextNotFound', data: {} });
			return;
		}
		const ctx = this.clipboardContextService.getContextForText(text);
		if (!ctx) {
			this.postMessage({ type: 'clipboardContextNotFound', data: {} });
			return;
		}
		this.postMessage({ type: 'clipboardContext', data: ctx });
	}

	private async onCancelImprovePrompt(msg: WebviewMessage): Promise<void> {
		const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
		if (requestId && this.improvePromptActiveRequestId !== requestId) {
			// Stale cancel; ignore.
			return;
		}

		this.improvePromptController?.abort();
		this.improvePromptController = null;
		this.improvePromptActiveRequestId = null;

		this.postMessage({ type: 'improvePromptCancelled', data: { requestId: requestId || '' } });
	}

	private async onImprovePromptRequest(msg: WebviewMessage): Promise<void> {
		const data = (msg.data ?? {}) as {
			text?: unknown;
			requestId?: unknown;
			model?: unknown;
			timeoutMs?: unknown;
		};

		const text = typeof data.text === 'string' ? data.text : '';
		const requestId = typeof data.requestId === 'string' ? data.requestId : '';
		const timeoutMsRaw = typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined;
		const timeoutMs =
			timeoutMsRaw && Number.isFinite(timeoutMsRaw)
				? Math.max(1000, Math.round(timeoutMsRaw))
				: 30_000;

		if (!text.trim() || !requestId) {
			this.postMessage({
				type: 'improvePromptError',
				data: { requestId: requestId || '', error: 'Missing text or requestId' },
			});
			return;
		}

		// Cancel previous request if any.
		this.improvePromptController?.abort();
		this.improvePromptController = new AbortController();
		this.improvePromptActiveRequestId = requestId;

		const timeout = setTimeout(() => this.improvePromptController?.abort(), timeoutMs);

		try {
			const modelFromSettings = this.settings.get('promptImprove.model');
			const templateFromSettings = this.settings.get('promptImprove.template');
			const model =
				typeof data.model === 'string'
					? data.model
					: typeof modelFromSettings === 'string'
						? modelFromSettings
						: undefined;

			const template = typeof templateFromSettings === 'string' ? templateFromSettings : undefined;

			const improvedText = await this.improvePromptViaOpenAICompatible({
				text,
				model,
				template,
				signal: this.improvePromptController.signal,
			});

			// Ignore if a newer request started.
			if (this.improvePromptActiveRequestId !== requestId) return;

			this.postMessage({
				type: 'improvePromptResult',
				data: { requestId, improvedText },
			});
		} catch (error) {
			if (this.improvePromptActiveRequestId !== requestId) return;

			const err = error instanceof Error ? error.message : String(error);
			const aborted = err.toLowerCase().includes('abort');
			this.postMessage({
				type: aborted ? 'improvePromptCancelled' : 'improvePromptError',
				data: aborted ? { requestId } : { requestId, error: err },
			});
		} finally {
			clearTimeout(timeout);
			if (this.improvePromptActiveRequestId === requestId) {
				this.improvePromptActiveRequestId = null;
				this.improvePromptController = null;
			}
		}
	}

	private async improvePromptViaOpenAICompatible(params: {
		text: string;
		model?: string;
		template?: string;
		signal: AbortSignal;
	}): Promise<string> {
		const baseUrlRaw = this.settings.get('proxy.baseUrl');
		const apiKeyRaw = this.settings.get('proxy.apiKey');
		const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim().replace(/\/+$/g, '') : '';
		const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';

		if (!baseUrl) {
			throw new Error('Proxy baseUrl is not configured');
		}

		const url = new URL(`${baseUrl}/v1/chat/completions`);

		const systemPrompt =
			params.template?.trim() ||
			'Rewrite the user message to be clearer, more specific, and more actionable for an AI coding agent. Preserve intent and constraints. Return only the rewritten prompt.';

		const model = params.model?.trim() || 'gpt-4o-mini';

		const resp = await fetch(url, {
			method: 'POST',
			signal: params.signal,
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: params.text },
				],
				temperature: 0.2,
			}),
		});

		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(
				`Prompt improver failed: ${resp.status} ${resp.statusText}: ${text.slice(0, 400)}`,
			);
		}

		let json: unknown;
		try {
			json = JSON.parse(text) as unknown;
		} catch {
			throw new Error('Prompt improver returned non-JSON response');
		}

		const choice0 =
			json &&
			typeof json === 'object' &&
			'choices' in json &&
			Array.isArray((json as { choices?: unknown }).choices)
				? (json as { choices: unknown[] }).choices[0]
				: undefined;

		const content =
			choice0 &&
			typeof choice0 === 'object' &&
			'message' in choice0 &&
			(choice0 as { message?: unknown }).message &&
			typeof (choice0 as { message: { content?: unknown } }).message.content === 'string'
				? ((choice0 as { message: { content: string } }).message.content as string)
				: undefined;

		const improved = (content ?? '').trim();
		if (!improved) {
			throw new Error('Prompt improver returned empty result');
		}
		return improved;
	}

	private async handleSendMessage(
		text: string,
		_uiSessionId?: string,
		uiModel?: string,
	): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error('No workspace root');
		}

		const settingsModel = this.settings.get('model');
		const model = uiModel ?? (typeof settingsModel === 'string' ? settingsModel : undefined);

		// Persist model choice when UI provides it (production-like: last used sticks).
		if (uiModel && uiModel !== settingsModel) {
			await this.settings.set('model', uiModel);
			this.settings.refresh();
			this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
		}

		const config = {
			provider: (this.settings.get('provider') || 'claude') as 'claude' | 'opencode',
			model,
			workspaceRoot,
			yoloMode: Boolean(this.settings.get('yoloMode') || false),
		};

		// Immediately mark session as busy
		this.postStatus(this.activeSessionId, 'busy', 'Working...');

		if (this.cli.getSessionId()) {
			await this.cli.spawnFollowUp(text, config);
		} else {
			await this.cli.spawn(text, config);
		}
	}

	private handleCliEvent(event: CLIEvent): void {
		const now = Date.now();

		switch (event.type) {
			case 'message': {
				const partId = this.activeAssistantPartId ?? `part-${now}`;
				this.activeAssistantPartId = partId;
				this.postSessionMessage({
					id: partId,
					type: 'assistant',
					partId,
					content: (event.data as { content?: string }).content || '',
					isStreaming: true,
					isDelta: true,
					timestamp: new Date().toISOString(),
				});
				break;
			}

			case 'thinking': {
				const thinkingId = `thinking-${now}`;
				this.postSessionMessage({
					id: thinkingId,
					type: 'thinking',
					content: (event.data as { content?: string }).content || '',
					timestamp: new Date().toISOString(),
				});
				break;
			}

			case 'tool_use': {
				const e = event.data as Record<string, unknown>;
				const toolUseId = (e.id as string) || `tool-${now}`;
				const toolName = (e.name as string) || (e.tool as string) || 'unknown';
				this.postSessionMessage({
					id: toolUseId,
					type: 'tool_use',
					partId: toolUseId,
					toolUseId,
					toolName,
					toolInput: e.input ? JSON.stringify(e.input) : '',
					rawInput: (e.input as Record<string, unknown>) || {},
					isRunning: true,
					timestamp: new Date().toISOString(),
				});
				break;
			}

			case 'tool_result': {
				const e = event.data as Record<string, unknown>;
				const toolUseId = (e.tool_use_id as string) || (e.id as string) || `tool-${now}`;
				const toolName = (e.name as string) || (e.tool as string) || 'unknown';
				const content =
					typeof e.content === 'string'
						? (e.content as string)
						: e.content
							? JSON.stringify(e.content)
							: '';
				this.postSessionMessage({
					id: `${toolUseId}-result-${now}`,
					type: 'tool_result',
					partId: toolUseId,
					toolUseId,
					toolName,
					content,
					isError: Boolean(e.is_error),
					timestamp: new Date().toISOString(),
				});
				this.postComplete(toolUseId, toolUseId);
				break;
			}

			case 'error': {
				const errorId = `error-${now}`;
				this.postSessionMessage({
					id: errorId,
					type: 'error',
					content: (event.data as { message?: string }).message || 'Unknown error',
					isError: true,
					timestamp: new Date().toISOString(),
				});
				this.postStatus(this.activeSessionId, 'error', 'Error');
				break;
			}

			case 'finished': {
				if (this.activeAssistantPartId) {
					this.postComplete(this.activeAssistantPartId, this.activeAssistantPartId);
					this.activeAssistantPartId = null;
				}
				this.postStatus(this.activeSessionId, 'idle', 'Ready');
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

				const tool =
					(typeof e.tool === 'string' ? (e.tool as string) : undefined) ??
					(typeof e.permission === 'string' ? (e.permission as string) : undefined) ??
					'tool';

				const input =
					(e.input as Record<string, unknown> | undefined) ??
					(e.toolInput as Record<string, unknown> | undefined) ??
					{};

				// Auto-approve if user previously marked this tool as always-allow.
				if (this.alwaysAllowByTool[tool]) {
					void this.cli
						.respondToPermission({ requestId, approved: true, alwaysAllow: true })
						.catch(error => logger.error('[ChatProvider] auto-approve failed:', error));
					this.postMessage({
						type: 'session_event',
						targetId: this.activeSessionId,
						eventType: 'access',
						payload: {
							eventType: 'access',
							action: 'response',
							requestId,
							approved: true,
							alwaysAllow: true,
						},
						timestamp: Date.now(),
						sessionId: this.activeSessionId,
					} satisfies SessionEventMessage);
					break;
				}

				const patterns = Array.isArray(e.patterns) ? (e.patterns as string[]) : undefined;

				this.postSessionMessage({
					id: `access-${requestId}`,
					type: 'access_request',
					requestId,
					tool,
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

	// =============================================================================
	// Settings Changes
	// =============================================================================

	private handleSettingsChange(): void {
		// Recreate CLI runner if provider changed
		this.settings.refresh();
		const provider = (this.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		this.cli = new CLIRunner(provider);
		this.cli.on('event', event => this.handleCliEvent(event));

		// Notify webview
		this.postMessage({ type: 'configChanged' });
		this.postSessionInfo();
	}

	// =============================================================================
	// Initial State
	// =============================================================================

	private sendInitialState(): void {
		this.postMessage({ type: 'settingsData', data: this.settings.getAll() });
		this.postMessage({
			type: 'accessData',
			data: Object.entries(this.alwaysAllowByTool)
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		});
	}

	// =============================================================================
	// Helpers
	// =============================================================================

	private async applyWebviewSettingsPatch(patch: Record<string, unknown>): Promise<void> {
		// Webview sends schema-style keys like 'proxy.baseUrl', 'opencode.agent', etc.
		// Apply only known keys, everything else is ignored.
		for (const [key, value] of Object.entries(patch)) {
			switch (key) {
				case 'provider':
					if (value === 'claude' || value === 'opencode') {
						await this.settings.set('provider', value);
					}
					break;

				case 'model':
					if (typeof value === 'string') {
						await this.settings.set('model', value);
					} else if (value === null || value === undefined) {
						await this.settings.set('model', undefined);
					}
					break;

				case 'autoApprove':
					if (typeof value === 'boolean') {
						await this.settings.set('autoApprove', value);
					}
					break;

				case 'yoloMode':
					if (typeof value === 'boolean') {
						await this.settings.set('yoloMode', value);
					}
					break;

				case 'mcpServers':
					if (typeof value === 'object' && value !== null) {
						await this.settings.set('mcpServers', value as Record<string, unknown>);
					}
					break;

				case 'proxy.baseUrl':
					if (typeof value === 'string') {
						await this.settings.set('proxy.baseUrl', value);
					}
					break;

				case 'proxy.apiKey':
					if (typeof value === 'string') {
						await this.settings.set('proxy.apiKey', value);
					}
					break;

				case 'proxy.enabledModels':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.settings.set('proxy.enabledModels', value);
					}
					break;

				case 'proxy.useSingleModel':
					if (typeof value === 'boolean') {
						await this.settings.set('proxy.useSingleModel', value);
					}
					break;

				case 'proxy.haikuModel':
				case 'proxy.sonnetModel':
				case 'proxy.opusModel':
				case 'proxy.subagentModel':
					if (typeof value === 'string') {
						await this.settings.set(key, value);
					} else if (value === null || value === undefined) {
						await this.settings.set(key, undefined);
					}
					break;

				case 'opencode.autoStart':
					if (typeof value === 'boolean') {
						await this.settings.set('opencode.autoStart', value);
					}
					break;

				case 'opencode.serverTimeout':
					if (typeof value === 'number' && Number.isFinite(value)) {
						await this.settings.set('opencode.serverTimeout', value);
					}
					break;

				case 'opencode.agent':
					if (typeof value === 'string') {
						await this.settings.set('opencode.agent', value);
					} else if (value === null || value === undefined) {
						await this.settings.set('opencode.agent', undefined);
					}
					break;

				case 'opencode.enabledModels':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.settings.set('opencode.enabledModels', value);
					}
					break;

				case 'providers.disabled':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.settings.set('providers.disabled', value);
					}
					break;

				case 'promptImprove.model':
				case 'promptImprove.template':
					if (typeof value === 'string') {
						await this.settings.set(key, value);
					} else if (value === null || value === undefined) {
						await this.settings.set(key, undefined);
					}
					break;

				case 'promptImprove.timeoutMs':
					if (typeof value === 'number' && Number.isFinite(value)) {
						await this.settings.set('promptImprove.timeoutMs', value);
					}
					break;

				default:
					break;
			}
		}
	}

	private postMessage(msg: unknown): void {
		this.view?.webview.postMessage(msg);
	}

	private postLifecycle(
		action: SessionLifecycleMessage['action'],
		sessionId: string,
		data?: SessionLifecycleMessage['data'],
	): void {
		this.postMessage({
			type: 'session_lifecycle',
			action,
			sessionId,
			parentId: undefined,
			data,
		} satisfies SessionLifecycleMessage);
	}

	private postSessionMessage(
		message: SessionEventMessage['payload'] extends { eventType: 'message' }
			? SessionEventMessage['payload']
			: never,
	): void;
	private postSessionMessage(message: import('../common').SessionMessageData): void;
	private postSessionMessage(message: import('../common').SessionMessageData): void {
		this.postMessage({
			type: 'session_event',
			targetId: this.activeSessionId,
			eventType: 'message',
			payload: { eventType: 'message', message },
			timestamp: Date.now(),
			sessionId: this.activeSessionId,
		} satisfies SessionEventMessage);
	}

	private postStatus(
		sessionId: string,
		status: import('../common').SessionStatus,
		statusText?: string,
	): void {
		this.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'status',
			payload: { eventType: 'status', status, statusText },
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}

	private postComplete(partId: string, toolUseId?: string): void {
		this.postMessage({
			type: 'session_event',
			targetId: this.activeSessionId,
			eventType: 'complete',
			payload: { eventType: 'complete', partId, toolUseId },
			timestamp: Date.now(),
			sessionId: this.activeSessionId,
		} satisfies SessionEventMessage);
	}

	private postSessionInfo(): void {
		this.postMessage({
			type: 'session_event',
			targetId: this.activeSessionId,
			eventType: 'session_info',
			payload: {
				eventType: 'session_info',
				data: { sessionId: this.activeSessionId, tools: [], mcpServers: [] },
			},
			timestamp: Date.now(),
			sessionId: this.activeSessionId,
		} satisfies SessionEventMessage);
	}

	// =============================================================================
	// Dispose
	// =============================================================================

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.cli.kill();
	}
}
