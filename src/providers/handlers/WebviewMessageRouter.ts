/**
 * @file WebviewMessageRouter
 * @description Routes incoming webview messages to appropriate handlers. Centralizes message
 * dispatching logic, reducing ChatProvider complexity and improving maintainability.
 * Includes runtime validation of incoming messages using TypeBox schemas.
 */

import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import { getGlobalProvider } from '../../services/ProviderResolver';
import type { WebviewMessage } from '../../types';
import { WebviewMessageSchema } from '../../types';
import { logger } from '../../utils/logger';
import type { AccessHandler } from './AccessHandler';
import type { CommandsHandler } from './CommandsHandler';
import type { DiagnosticsHandler } from './DiagnosticsHandler';
import type { DiscoveryHandler } from './DiscoveryHandler';
import type { GitHandler } from './GitHandler';
import type { HistoryHandler } from './HistoryHandler';
import type { HooksHandler } from './HooksHandler';
import type { ImageHandler } from './ImageHandler';
import type { MessageHandler } from './MessageHandler';
import type { OpenCodeHandler } from './OpenCodeHandler';
import type { PermissionsHandler } from './PermissionsHandler';
import type { PromptImproverHandler } from './PromptImproverHandler';
import type { RestoreHandler } from './RestoreHandler';
import type { RulesHandler } from './RulesHandler';
import type { SessionHandler } from './SessionHandler';
import type { SettingsHandler } from './SettingsHandler';
import type { SkillsHandler } from './SkillsHandler';

// =============================================================================
// Types
// =============================================================================

export interface WebviewMessageRouterDeps {
	postMessage: (msg: unknown) => void;
	sendReadyMessage: () => Promise<void>;
	handleSwitchSession: (sessionId: string) => Promise<void>;
	sendWorkspaceFiles: (searchTerm?: string) => Promise<void>;
	openFileInEditor: (filePath: string, startLine?: number, endLine?: number) => Promise<void>;
	saveInputText: (text: string) => void;
	getActiveSessionId: () => string | undefined;
}

export interface WebviewMessageRouterHandlers {
	messageHandler: MessageHandler;
	sessionHandler: SessionHandler;
	historyHandler: HistoryHandler;
	settingsHandler: SettingsHandler;
	imageHandler: ImageHandler;
	gitHandler: GitHandler;
	diagnosticsHandler: DiagnosticsHandler;
	openCodeHandler: OpenCodeHandler;
	restoreHandler: RestoreHandler;
	rulesHandler: RulesHandler;
	permissionsHandler: PermissionsHandler;
	accessHandler: AccessHandler;
	discoveryHandler: DiscoveryHandler;
	commandsHandler: CommandsHandler;
	skillsHandler: SkillsHandler;
	hooksHandler: HooksHandler;
	promptImproverHandler: PromptImproverHandler;
}

interface MessageContext {
	message: WebviewMessage;
	handlers: WebviewMessageRouterHandlers;
	deps: WebviewMessageRouterDeps;
	postMessage: (msg: unknown) => void;
}

// =============================================================================
// WebviewMessageRouter Class
// =============================================================================

export class WebviewMessageRouter {
	constructor(
		private readonly _handlers: WebviewMessageRouterHandlers,
		private readonly _deps: WebviewMessageRouterDeps,
	) {}

	public route(message: WebviewMessage): void {
		// Runtime validation of incoming message
		// Cast to unknown to prevent TypeScript narrowing to 'never' after failed check
		const rawMessage = message as unknown;
		if (!Value.Check(WebviewMessageSchema, rawMessage)) {
			const errors = [...Value.Errors(WebviewMessageSchema, rawMessage)];
			const msgType = (rawMessage as { type?: string })?.type ?? 'unknown';
			logger.warn(
				`[WebviewMessageRouter] Invalid message rejected: type=${msgType}, errors=${errors.length}`,
			);
			return;
		}

		const handler = this._getHandler(message);
		if (handler) {
			void handler();
		}
	}

	private _getHandler(message: WebviewMessage): (() => void | Promise<void>) | undefined {
		const context: MessageContext = {
			message,
			handlers: this._handlers,
			deps: this._deps,
			postMessage: this._deps.postMessage,
		};

		// Map message types to handler categories
		const routeMap: Record<string, (ctx: MessageContext) => void | Promise<void>> = {
			...this._getLifecycleRoutes(),
			...this._getMessageRoutes(),
			...this._getSessionRoutes(),
			...this._getRestoreRoutes(),
			...this._getHistoryRoutes(),
			...this._getWorkspaceRoutes(),
			...this._getImageRoutes(),
			...this._getSettingsRoutes(),
			...this._getFileRoutes(),
			...this._getAccessRoutes(),
			...this._getMCPServerRoutes(),
			...this._getGitRoutes(),
			...this._getDiagnosticsRoutes(),
			...this._getOpenCodeRoutes(),
			...this._getOpenCodeMcpRoutes(),
			...this._getRulesRoutes(),
			...this._getDiscoveryRoutes(),
			...this._getPermissionsRoutes(),
			...this._getCommandsRoutes(),
			...this._getSkillsRoutes(),
			...this._getHooksRoutes(),
			...this._getPromptImproverRoutes(),
		};

		const handler = routeMap[message.type];
		return handler ? () => handler(context) : undefined;
	}

	// =========================================================================
	// Route Definitions
	// =========================================================================

	private _getLifecycleRoutes() {
		return {
			webviewDidLaunch: async ({ handlers }: MessageContext) => {
				// Initialize session on webview launch
				// This replaces the proactive initialization in ChatProvider
				await handlers.sessionHandler.initializeSession();
			},
		};
	}

	private _getMessageRoutes() {
		return {
			// IMPORTANT: Never rely on "active session" for message routing.
			// Webview always sends an explicit sessionId and we must route purely by it,
			// otherwise multi-session concurrency will mix messages under race conditions.
			sendMessage: ({ message, handlers }: MessageContext) => {
				const hasContent =
					message.text ||
					message.attachments?.files?.length ||
					message.attachments?.codeSnippets?.length ||
					message.attachments?.images?.length;
				if (hasContent) {
					const uiSessionId = message.sessionId;
					if (!uiSessionId) {
						this._deps.postMessage({
							type: 'error',
							data: { content: 'Missing sessionId for sendMessage. Please reload the webview.' },
						});
						return;
					}
					void handlers.messageHandler.sendMessageToSession(
						uiSessionId,
						message.text || '',
						message.planMode,
						message.attachments,
					);
				}
			},
			stopRequest: ({ message, handlers }: MessageContext) =>
				handlers.messageHandler.stopProcess(message.sessionId),
			resumeAfterError: ({ message, handlers }: MessageContext) => {
				const uiSessionId = message.sessionId;
				if (uiSessionId) {
					void handlers.messageHandler.resumeAfterError(uiSessionId);
				}
			},
			dismissError: ({ message, postMessage }: MessageContext) => {
				const { messageId, sessionId } = message;
				if (messageId && sessionId) {
					// Remove from backend session history
					this._handlers.messageHandler.dismissErrorMessage(sessionId, messageId);

					// Send message to webview to remove the error from UI
					postMessage({
						type: 'messagePartRemoved',
						data: { messageId, partId: messageId },
						sessionId,
					});
				}
			},
		};
	}

	private _getSessionRoutes() {
		return {
			newSession: ({ handlers, postMessage }: MessageContext) =>
				handlers.sessionHandler.newSession(postMessage),
			createSession: ({ handlers }: MessageContext) =>
				handlers.sessionHandler.handleCreateSession(),
			switchSession: ({ message, handlers }: MessageContext) => {
				if (message.sessionId) handlers.sessionHandler.handleSwitchSession(message.sessionId);
			},
			closeSession: ({ message, handlers }: MessageContext) => {
				if (message.sessionId) handlers.sessionHandler.handleCloseSession(message.sessionId);
			},
		};
	}

	private _getRestoreRoutes() {
		return {
			restoreCommit: ({ message, handlers }: MessageContext) => {
				if (message.data) {
					const data = message.data as
						| string
						| {
								messageId: string;
								sessionId: string;
								cliSessionId?: string;
								associatedMessageId?: string;
						  };
					if (typeof data === 'object' && 'messageId' in data && 'sessionId' in data) {
						void handlers.restoreHandler.revertToMessage(
							data.sessionId,
							data.messageId,
							data.cliSessionId,
							data.associatedMessageId,
						);
					} else if (typeof data === 'string') {
						void handlers.restoreHandler.restoreToCommit(data);
					}
				}
			},
			unrevert: ({ message, handlers }: MessageContext) => {
				const data = message.data as { sessionId: string; cliSessionId?: string } | undefined;
				if (data?.sessionId) {
					void handlers.restoreHandler.unrevert(data.sessionId, data.cliSessionId);
				}
			},
		};
	}

	private _getHistoryRoutes() {
		return {
			getConversationList: ({ handlers }: MessageContext) =>
				handlers.historyHandler.sendConversationList(),
			loadConversation: ({ message, handlers }: MessageContext) => {
				if (message.filename)
					void handlers.historyHandler.loadConversationHistory(message.filename);
			},
			renameConversation: ({ message, handlers }: MessageContext) => {
				if (message.filename && message.newTitle) {
					void handlers.historyHandler.renameConversation(message.filename, message.newTitle);
				}
			},
			deleteConversation: ({ message, handlers }: MessageContext) => {
				if (message.filename) void handlers.historyHandler.deleteConversation(message.filename);
			},
			clearAllConversations: ({ handlers }: MessageContext) =>
				void handlers.historyHandler.clearAllConversations(),
		};
	}

	private _getWorkspaceRoutes() {
		return {
			getWorkspaceFiles: ({ message, deps }: MessageContext) =>
				void deps.sendWorkspaceFiles(message.searchTerm),
		};
	}

	private _getImageRoutes() {
		return {
			selectImageFile: ({ handlers }: MessageContext) =>
				void handlers.imageHandler.selectImageFile(),
			getImageData: ({ message, handlers }: MessageContext) => {
				if (message.path) {
					void handlers.imageHandler.getImageData(message.path, message.id, message.name);
				}
			},
			createImageFile: ({ message, handlers }: MessageContext) => {
				if (message.imageData && message.imageType) {
					void handlers.imageHandler.createImageFile(message.imageData, message.imageType);
				}
			},
		};
	}

	private _getSettingsRoutes() {
		return {
			getSettings: ({ handlers }: MessageContext) => handlers.settingsHandler.sendCurrentSettings(),
			updateSettings: ({ message, handlers }: MessageContext) => {
				if (message.settings) void handlers.settingsHandler.updateSettings(message.settings);
			},
			getClipboardText: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.getClipboardText(),
			getClipboardContext: ({ message, handlers }: MessageContext) => {
				if (message.text) void handlers.settingsHandler.getClipboardContext(message.text);
			},
			selectModel: ({ message, handlers }: MessageContext) => {
				if (message.model) handlers.settingsHandler.setSelectedModel(message.model);
			},
			loadProxyModels: ({ message, handlers }: MessageContext) => {
				void handlers.settingsHandler.loadProxyModels(
					message.baseUrl as string,
					message.apiKey as string,
				);
			},
			loadAnthropicModels: ({ message, handlers }: MessageContext) => {
				void handlers.settingsHandler.loadAnthropicModels(message.anthropicApiKey as string);
			},
			setAnthropicApiKey: ({ message, handlers }: MessageContext) => {
				if (message.anthropicApiKey) {
					void handlers.settingsHandler.setAnthropicApiKey(message.anthropicApiKey as string);
				}
			},
			clearAnthropicApiKey: ({ handlers }: MessageContext) => {
				void handlers.settingsHandler.clearAnthropicApiKey();
			},
			getAnthropicKeyStatus: ({ handlers }: MessageContext) => {
				void handlers.settingsHandler.getAnthropicKeyStatus();
			},
			saveProxyProvider: ({ message, handlers }: MessageContext) => {
				const { baseUrl, apiKey, models } = message as {
					baseUrl?: string;
					apiKey?: string;
					models?: Array<{ id: string; name: string }>;
				};
				if (baseUrl && models) {
					void handlers.settingsHandler.saveProxyProviderForOpenCode(baseUrl, apiKey || '', models);
				}
			},
			openModelTerminal: ({ handlers }: MessageContext) =>
				handlers.settingsHandler.openModelTerminal(),
			executeSlashCommand: ({ message, handlers }: MessageContext) => {
				if (message.command) handlers.settingsHandler.executeSlashCommand(message.command);
			},
			saveInputText: ({ message, deps }: MessageContext) => {
				if (message.text !== undefined) deps.saveInputText(message.text);
			},
		};
	}

	private _getFileRoutes() {
		return {
			openFile: ({ message, deps }: MessageContext) => {
				if (message.filePath) {
					void deps.openFileInEditor(
						message.filePath,
						message.startLine as number | undefined,
						message.endLine as number | undefined,
					);
				}
			},
			openExternal: ({ message }: MessageContext) => {
				if (message.url) void vscode.env.openExternal(vscode.Uri.parse(message.url));
			},
		};
	}

	private _getAccessRoutes() {
		return {
			accessResponse: ({ message, handlers }: MessageContext) => {
				if (message.id !== undefined && message.approved !== undefined) {
					handlers.accessHandler.handleAccessResponse(
						message.id,
						message.approved,
						message.alwaysAllow,
						message.response as 'once' | 'always' | 'reject',
					);
				}
			},
			getAccess: ({ handlers }: MessageContext) => void handlers.settingsHandler.sendAccess(),
			removeAccess: ({ message, handlers }: MessageContext) => {
				if (message.toolName) {
					void handlers.settingsHandler.removeAccess(message.toolName, message.command || null);
				}
			},
			addAccess: ({ message, handlers }: MessageContext) => {
				if (message.toolName) {
					void handlers.settingsHandler.addAccess(message.toolName, message.command || null);
				}
			},
		};
	}

	private _getMCPServerRoutes() {
		return {
			loadMCPServers: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.loadMCPServers(),
			pingMcpServers: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.pingMcpServers(),
			fetchMcpMarketplaceCatalog: ({ handlers, message }: MessageContext) => {
				const forceRefresh = Boolean(
					(message.data as { forceRefresh?: boolean } | undefined)?.forceRefresh,
				);
				void handlers.settingsHandler.fetchMcpMarketplaceCatalog(forceRefresh);
			},
			installMcpFromMarketplace: ({ message, handlers }: MessageContext) => {
				const mcpId = message.mcpId as string | undefined;
				if (mcpId) void handlers.settingsHandler.installMcpFromMarketplace(mcpId);
			},
			saveMCPServer: ({ message, handlers }: MessageContext) => {
				if (message.name && message.config) {
					void handlers.settingsHandler.saveMCPServer(message.name, message.config);
				}
			},
			deleteMCPServer: ({ message, handlers }: MessageContext) => {
				if (message.name) void handlers.settingsHandler.deleteMCPServer(message.name);
			},
			// Agents config routes
			checkAgentsConfig: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.checkAgentsConfig(),
			openAgentsMcpConfig: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.openAgentsMcpConfig(),
			syncAgentsToClaudeProject: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.syncAgentsToProject('claude'),
			syncAgentsToOpenCodeProject: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.syncAgentsToProject('opencode'),
			importMcpFromCLI: ({ handlers }: MessageContext) =>
				void handlers.settingsHandler.importMcpFromCLI(),
		};
	}

	private _getGitRoutes() {
		return {
			openFileDiff: ({ message, handlers }: MessageContext) => {
				if (message.filePath) {
					void handlers.gitHandler.openFileDiff(
						message.filePath,
						message.oldContent as string | undefined,
						message.newContent as string | undefined,
					);
				}
			},
			undoFileChanges: ({ message, handlers }: MessageContext) => {
				if (message.filePath) void handlers.gitHandler.undoFileChanges(message.filePath);
			},
			undoAllChanges: ({ handlers }: MessageContext) => void handlers.gitHandler.undoAllChanges(),
			copyDiffs: ({ message, handlers }: MessageContext) => {
				if (Array.isArray(message.filePaths)) {
					void handlers.gitHandler.copyDiffs(message.filePaths as string[]);
				}
			},
			copyAllDiffs: ({ handlers }: MessageContext) => void handlers.gitHandler.copyAllDiffs(),
		};
	}

	private _getDiagnosticsRoutes() {
		return {
			checkCLIDiagnostics: ({ handlers }: MessageContext) =>
				void handlers.diagnosticsHandler.checkCLIDiagnostics(),
			checkOpenCodeStatus: ({ handlers }: MessageContext) =>
				void handlers.diagnosticsHandler.checkOpenCodeStatus(),
		};
	}

	private _getOpenCodeRoutes() {
		return {
			loadOpenCodeProviders: ({ handlers, postMessage }: MessageContext) => {
				void handlers.openCodeHandler.loadOpenCodeProviders(postMessage, getGlobalProvider());
			},
			loadAvailableProviders: ({ handlers, postMessage }: MessageContext) => {
				void handlers.openCodeHandler.loadAvailableProviders(postMessage, getGlobalProvider());
			},
			reloadAllProviders: ({ handlers, postMessage }: MessageContext) => {
				const provider = getGlobalProvider();
				void handlers.openCodeHandler.loadOpenCodeProviders(postMessage, provider);
				void handlers.openCodeHandler.loadAvailableProviders(postMessage, provider);
			},
			setOpenCodeModel: ({ message, handlers, postMessage }: MessageContext) => {
				if (message.model) {
					handlers.openCodeHandler.setOpenCodeModel(message.model as string, postMessage);
				}
			},
			setOpenCodeProviderAuth: ({ message, handlers, postMessage }: MessageContext) => {
				const { providerId, apiKey } = message as { providerId?: string; apiKey?: string };
				if (providerId && apiKey) {
					void handlers.openCodeHandler.setOpenCodeProviderAuth(
						providerId,
						apiKey,
						postMessage,
						getGlobalProvider(),
					);
				}
			},
			addOpenCodeCustomProvider: ({ message, handlers, postMessage }: MessageContext) => {
				const config = message.config as {
					id: string;
					name: string;
					baseURL: string;
					apiKey: string;
					models?: Array<{ id: string; name: string }>;
				};
				if (config) {
					void handlers.openCodeHandler.addOpenCodeCustomProvider(
						config,
						postMessage,
						getGlobalProvider(),
					);
				}
			},
			disconnectOpenCodeProvider: ({ message, handlers, postMessage }: MessageContext) => {
				const { providerId } = message as { providerId?: string };
				if (providerId) {
					void handlers.openCodeHandler.disconnectOpenCodeProvider(
						providerId,
						postMessage,
						getGlobalProvider(),
					);
				}
			},
		};
	}

	private _getOpenCodeMcpRoutes() {
		return {
			loadOpenCodeMcpStatus: ({ handlers, postMessage }: MessageContext) => {
				void handlers.openCodeHandler.loadOpenCodeMcpStatus(postMessage, getGlobalProvider());
			},
			startOpenCodeMcpAuth: ({ message, handlers, postMessage }: MessageContext) => {
				const name = (message.data as { name?: string } | undefined)?.name;
				if (!name) return;
				void handlers.openCodeHandler.startMcpAuth(name, postMessage, getGlobalProvider());
			},
		};
	}

	private _getDiscoveryRoutes() {
		return {
			checkDiscoveryStatus: ({ handlers }: MessageContext) =>
				void handlers.discoveryHandler.checkDiscoveryStatus(),
			createClaudeShim: ({ handlers }: MessageContext) =>
				void handlers.discoveryHandler.createClaudeShim(),
		};
	}

	private _getPermissionsRoutes() {
		return {
			getPermissions: ({ handlers }: MessageContext) =>
				void handlers.permissionsHandler.getPermissions(),
			setPermissions: ({ message, handlers }: MessageContext) => {
				const msg = message as WebviewMessage & {
					policies?: {
						edit: 'ask' | 'allow' | 'deny';
						terminal: 'ask' | 'allow' | 'deny';
						network: 'ask' | 'allow' | 'deny';
					};
					provider?: 'claude' | 'opencode';
				};
				if (msg.policies && msg.provider) {
					void handlers.permissionsHandler.setPermissions(msg.policies, msg.provider);
				}
			},
		};
	}

	private _getRulesRoutes() {
		return {
			getRules: ({ handlers }: MessageContext) => void handlers.rulesHandler.getRules(),
			importRulesFromClaude: ({ handlers }: MessageContext) =>
				void handlers.rulesHandler.importRulesFromClaude(),
			syncRulesToClaude: ({ handlers }: MessageContext) =>
				void handlers.rulesHandler.syncRulesToClaude(),
			createRule: ({ message, handlers }: MessageContext) => {
				const msg = message as WebviewMessage & { name?: string; content?: string };
				if (msg.name && msg.content) void handlers.rulesHandler.createRule(msg.name, msg.content);
			},
			toggleRule: ({ message, handlers }: MessageContext) => {
				const msg = message as WebviewMessage & {
					path?: string;
					enabled?: boolean;
					source?: 'claude' | 'opencode';
				};
				if (msg.path && msg.enabled !== undefined)
					void handlers.rulesHandler.toggleRule(msg.path, msg.enabled, msg.source);
			},
			deleteRule: ({ message, handlers }: MessageContext) => {
				const msg = message as WebviewMessage & { path?: string };
				if (msg.path) void handlers.rulesHandler.deleteRule(msg.path);
			},
		};
	}

	private _getCommandsRoutes() {
		return {
			getCommands: ({ handlers }: MessageContext) => void handlers.commandsHandler.getCommands(),
			createCommand: ({ message, handlers }: MessageContext) =>
				void handlers.commandsHandler.createCommand(message),
			deleteCommand: ({ message, handlers }: MessageContext) =>
				void handlers.commandsHandler.deleteCommand(message),
			openCommandFile: ({ message, handlers }: MessageContext) =>
				void handlers.commandsHandler.openCommandFile(message),
			syncCommandsToCLI: ({ handlers }: MessageContext) =>
				void handlers.commandsHandler.syncCommands(),
			importCommandsFromClaude: ({ handlers }: MessageContext) =>
				void handlers.commandsHandler.importCommands(),
		};
	}

	private _getSkillsRoutes() {
		return {
			getSkills: ({ handlers }: MessageContext) => void handlers.skillsHandler.getSkills(),
			createSkill: ({ message, handlers }: MessageContext) =>
				void handlers.skillsHandler.createSkill(message),
			deleteSkill: ({ message, handlers }: MessageContext) =>
				void handlers.skillsHandler.deleteSkill(message),
			openSkillFile: ({ message, handlers }: MessageContext) =>
				void handlers.skillsHandler.openSkillFile(message),
			importSkillsFromCLI: ({ handlers }: MessageContext) =>
				void handlers.skillsHandler.importSkills(),
			syncSkillsToCLI: ({ handlers }: MessageContext) => void handlers.skillsHandler.syncSkills(),
		};
	}

	private _getHooksRoutes() {
		return {
			getHooks: ({ handlers }: MessageContext) => void handlers.hooksHandler.getHooks(),
			createHook: ({ message, handlers }: MessageContext) =>
				void handlers.hooksHandler.createHook(message),
			deleteHook: ({ message, handlers }: MessageContext) =>
				void handlers.hooksHandler.deleteHook(message),
			openHookFile: ({ message, handlers }: MessageContext) =>
				void handlers.hooksHandler.openHookFile(message),
			importHooksFromClaude: ({ handlers }: MessageContext) =>
				void handlers.hooksHandler.importHooksFromClaude(),
			syncHooksToClaude: ({ handlers }: MessageContext) =>
				void handlers.hooksHandler.syncHooksToClaude(),
		};
	}

	private _getPromptImproverRoutes() {
		return {
			improvePromptRequest: ({ message, handlers, postMessage }: MessageContext) =>
				void handlers.promptImproverHandler.improvePrompt(message, postMessage),
			cancelImprovePrompt: ({ message, handlers, postMessage }: MessageContext) =>
				void handlers.promptImproverHandler.cancelImprovement(message, postMessage),
		};
	}
}
