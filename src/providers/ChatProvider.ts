/**
 * @file ChatProvider
 * @description Simplified chat provider with direct routing (no handlers).
 * Inspired by Vibe Kanban's architecture.
 */

import * as vscode from 'vscode';
import { type CLIEvent, CLIRunner } from '../core/CLIRunner';
import { Settings } from '../core/Settings';
// Import existing services (keep the good stuff)
import { AgentsCommandsService } from '../services/AgentsCommandsService';
import { AgentsHooksService } from '../services/AgentsHooksService';
import { AgentsSkillsService } from '../services/AgentsSkillsService';
import { AgentsSubagentsService } from '../services/AgentsSubagentsService';
import type { SessionEventMessage, SessionLifecycleMessage } from '../types/extensionMessages';
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

	private readonly webviewHandlers: Record<string, (msg: WebviewMessage) => Promise<void>> = {
		webviewDidLaunch: msg => this.onWebviewDidLaunch(msg),
		sendMessage: msg => this.onSendMessage(msg),
		accessResponse: msg => this.onAccessResponse(msg),
		getCommands: () => this.onGetCommands(),
		getSkills: () => this.onGetSkills(),
		getHooks: () => this.onGetHooks(),
		getSubagents: () => this.onGetSubagents(),
		getRules: () => this.onGetRules(),
		getMcpServers: () => this.onGetMcpServers(),
		installMcpServer: msg => this.onInstallMcpServer(msg),
		loadMCPServers: () => this.onLoadMcpServers(),
		getMcpMarketplace: () => this.onGetMcpMarketplace(),
		getSettings: () => this.onGetSettings(),
		updateSettings: msg => this.onUpdateSettings(msg),
		getClipboardContext: () => this.onGetClipboardContext(),
		improvePrompt: msg => this.onImprovePrompt(msg),
	};

	constructor(private context: vscode.ExtensionContext) {
		this.settings = new Settings();

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
		}
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

	private async onGetCommands(): Promise<void> {
		this.postMessage({ type: 'commandsList', data: { custom: [], isLoading: false } });
	}

	private async onGetSkills(): Promise<void> {
		this.postMessage({ type: 'skillsList', data: { skills: [], isLoading: false } });
	}

	private async onGetHooks(): Promise<void> {
		this.postMessage({ type: 'hooksList', data: { hooks: [], isLoading: false } });
	}

	private async onGetSubagents(): Promise<void> {
		this.postMessage({ type: 'subagentsList', data: { subagents: [], isLoading: false } });
	}

	private async onGetRules(): Promise<void> {
		this.postMessage({ type: 'rulesList', data: [] });
	}

	private async onGetMcpServers(): Promise<void> {
		this.postMessage({ type: 'mcpServersList', data: [] });
	}

	private async onInstallMcpServer(msg: WebviewMessage): Promise<void> {
		this.postMessage({ type: 'mcpServerInstalled', serverId: msg.serverId });
	}

	private async onLoadMcpServers(): Promise<void> {
		this.postMessage({ type: 'mcpServersLoaded' });
	}

	private async onGetMcpMarketplace(): Promise<void> {
		this.postMessage({ type: 'mcpMarketplace', data: [] });
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

	private async onGetClipboardContext(): Promise<void> {
		this.postMessage({ type: 'clipboardContext', data: null });
	}

	private async onImprovePrompt(msg: WebviewMessage): Promise<void> {
		this.postMessage({ type: 'promptImproved', data: msg.prompt });
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
	private postSessionMessage(
		message: import('../types/extensionMessages').SessionMessageData,
	): void;
	private postSessionMessage(
		message: import('../types/extensionMessages').SessionMessageData,
	): void {
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
		status: import('../types/extensionMessages').SessionStatus,
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
