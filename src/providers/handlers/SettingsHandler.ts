/**
 * @file SettingsHandler
 * @description Manages application settings, access, MCP servers, and custom snippets.
 *              Handles proxy model fetching with timeout support, settings persistence,
 *              and synchronization between VS Code configuration and webview state.
 *              For OpenCode CLI, proxy settings are saved to opencode.json via SDK.
 *              For Claude CLI, proxy settings are passed via environment variables.
 *              After updateSettings, automatically sends updated settings back to webview.
 *              Supports .agents/mcp.json as the single source of truth for MCP configs.
 */

import * as vscode from 'vscode';
import type { AccessService } from '../../services/AccessService';
import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import { ClipboardContextService } from '../../services/ClipboardContextService';
import { ErrorCode, errorService, NetworkError } from '../../services/ErrorService';
import type { FileService } from '../../services/FileService';
import { McpManagementService } from '../../services/mcp/McpManagementService';
import { getGlobalProvider, isOpenCode } from '../../services/ProviderResolver';
import type { SessionManager } from '../../services/SessionManager';
import type { SettingsService } from '../../services/SettingsService';
import { OPENAI_COMPATIBLE_PROVIDER_ID, TIMEOUTS } from '../../shared';
import type { AgentsMcpServer, MCPServerConfig } from '../../types';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface SettingsHandlerDeps {
	postMessage: (msg: unknown) => void;
	getCLISessionId: () => string | undefined;
	getSessionManager: () => SessionManager;
	onMcpConfigSaved?: () => void;
}

interface ProxyModel {
	id: string;
	name: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	capabilities?: {
		reasoning?: boolean;
		vision?: boolean;
		tools?: boolean;
	};
}

interface TextSearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
}

// =============================================================================
// SettingsHandler Class
// =============================================================================

export class SettingsHandler {
	private readonly _anthropicApiKeySecretKey = 'anthropic.apiKey';
	private _proxyModels: ProxyModel[] = [];
	private readonly _mcp: McpManagementService;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _settingsService: SettingsService,
		private readonly _accessService: AccessService,
		private readonly _fileService: FileService,
		private readonly _deps: SettingsHandlerDeps,
		private readonly _mcpMarketplace: import('../../services/mcp/McpMarketplaceService.js').McpMarketplaceService,
		private readonly _mcpMetadata: import('../../services/mcp/McpMetadataService.js').McpMetadataService,
	) {
		this._mcp = new McpManagementService(
			this._context,
			this._mcpMarketplace,
			this._mcpMetadata,
			(msg: unknown) => this._deps.postMessage(msg),
		);

		// Wire up MCP config save notification
		if (this._deps.onMcpConfigSaved) {
			this._mcp.setOnConfigSaved(this._deps.onMcpConfigSaved);
		}
	}

	public sendCurrentSettings(): void {
		this._deps.postMessage({
			type: 'settingsData',
			data: this._settingsService.getCurrentSettings(),
		});
	}

	public async updateSettings(settings: Record<string, unknown>): Promise<void> {
		const previousProvider = this._settingsService.getCurrentSettings().provider;
		await this._settingsService.updateSettings(settings);
		// Send updated settings back to webview for state sync
		this.sendCurrentSettings();

		// If provider changed, notify webview to reload provider-specific data
		const newProvider = settings.provider as string | undefined;
		if (newProvider && newProvider !== previousProvider) {
			logger.info(`[SettingsHandler] Provider changed: ${previousProvider} -> ${newProvider}`);

			// Reset model to default when switching providers to avoid incompatible model formats
			// Claude uses model IDs like "claude-sonnet-4" or "[Proxy] model"
			// OpenCode uses "providerId/modelId" format like "anthropic/claude-sonnet-4" or "oai/[Proxy] model"
			const currentModel = this._settingsService.selectedModel;
			if (currentModel && currentModel !== 'default') {
				logger.info(
					`[SettingsHandler] Resetting model from "${currentModel}" to "default" due to provider change`,
				);
				this._settingsService.setSelectedModel('default');
				this._deps.postMessage({ type: 'modelSelected', model: 'default' });
			}

			// Trigger reload of OpenCode providers when switching to opencode
			// or clear them when switching away
			this._deps.postMessage({ type: 'reloadOpenCodeProviders' });
		}
	}

	public async getClipboardText(): Promise<void> {
		const text = await this._fileService.getClipboardText();
		this._deps.postMessage({ type: 'clipboardText', data: text });
	}

	public async getClipboardContext(pastedText: string): Promise<void> {
		try {
			logger.debug('[SettingsHandler] getClipboardContext called, text length:', pastedText.length);

			// First, try to get context from ClipboardContextService (captured during copy)
			const clipboardService = ClipboardContextService.getInstance();
			const capturedContext = clipboardService.getContextForText(pastedText);

			if (capturedContext) {
				logger.debug(
					'[SettingsHandler] Found captured context:',
					capturedContext.filePath,
					`lines ${capturedContext.startLine}-${capturedContext.endLine}`,
				);
				this._deps.postMessage({
					type: 'clipboardContext',
					filePath: capturedContext.filePath,
					startLine: capturedContext.startLine,
					endLine: capturedContext.endLine,
					content: pastedText,
				});
				return;
			}

			logger.debug('[SettingsHandler] No captured context, falling back to document search');

			// Fallback: search in open documents
			const result = await this._findTextInDocuments(pastedText);
			if (result) {
				logger.debug('[SettingsHandler] Found text in document:', result.filePath);
				this._deps.postMessage({
					type: 'clipboardContext',
					filePath: result.filePath,
					startLine: result.startLine,
					endLine: result.endLine,
					content: pastedText,
				});
			} else {
				logger.debug('[SettingsHandler] Text not found in any open document');
				// Notify webview that context was not found so it can fallback to plain text
				this._deps.postMessage({
					type: 'clipboardContextNotFound',
					text: pastedText,
				});
			}
		} catch (error) {
			logger.error('[SettingsHandler] getClipboardContext error:', error);
			// On error, also notify webview to fallback
			this._deps.postMessage({
				type: 'clipboardContextNotFound',
				text: pastedText,
			});
		}
	}

	public setSelectedModel(model: string): void {
		this._settingsService.setSelectedModel(model);
		this._deps.postMessage({ type: 'modelSelected', model });
	}

	public async loadProxyModels(providedBaseUrl?: string, providedApiKey?: string): Promise<void> {
		const config = vscode.workspace.getConfiguration('primeCode');

		// Check if proxy provider is disabled
		// Note: We check 'providers.disabled' setting, but also respect 'visibility' logic.
		// If the user explicitly asks to fetch (providedBaseUrl set), we proceed.
		// If it's an auto-load (startup), we skip if disabled.
		if (!providedBaseUrl) {
			const disabledProviders = config.get<string[]>('providers.disabled', []);
			if (disabledProviders.includes(OPENAI_COMPATIBLE_PROVIDER_ID)) {
				logger.debug('[SettingsHandler] Skipping proxy model fetch - provider disabled');
				this._deps.postMessage({ type: 'proxyModels', data: { models: [], enabled: true } });
				return;
			}
		}

		const baseUrl =
			providedBaseUrl || config.get<string>('proxy.baseUrl', 'http://localhost:11434');
		const apiKey = providedApiKey ?? config.get<string>('proxy.apiKey', '');

		// Always try to load models - visibility is controlled by disabledProviders in UI
		if (!baseUrl) {
			this._deps.postMessage({ type: 'proxyModels', data: { models: [], enabled: true } });
			return;
		}

		try {
			const models = await this._fetchProxyModels(baseUrl, apiKey);
			this._proxyModels = models;
			this._deps.postMessage({
				type: 'proxyModels',
				data: { models: this._proxyModels, baseUrl, enabled: true },
			});

			// For OpenCode CLI: save proxy provider to opencode.json after successful fetch
			// Only do this if models were explicitly requested (providedBaseUrl is set)
			// to avoid restart loops on initialization
			if (providedBaseUrl && models.length > 0) {
				if (isOpenCode()) {
					// Fire and forget - don't await to avoid blocking UI
					this.saveProxyProviderForOpenCode(baseUrl, apiKey, models).catch(err => {
						logger.warn('[SettingsHandler] Failed to save proxy provider:', err);
					});
				}
			}
		} catch (error) {
			const networkError =
				error instanceof NetworkError
					? error
					: NetworkError.fromFetchError(error as Error, baseUrl);
			errorService.handle(networkError, 'SettingsHandler.loadProxyModels');
			this._deps.postMessage({
				type: 'proxyModels',
				data: { models: [], enabled: true, error: networkError.userMessage },
			});
		}
	}

	/**
	 * Save proxy provider configuration to OpenCode's opencode.json via SDK.
	 * This ensures OpenCode CLI can use the proxy provider for model switching.
	 * For Claude CLI, proxy settings are passed via environment variables at runtime.
	 * Provider ID is 'oai' (OpenAI-compatible) for consistency.
	 */
	public async saveProxyProviderForOpenCode(
		baseUrl: string,
		apiKey: string,
		models: Array<{ id: string; name: string }>,
	): Promise<void> {
		const provider = getGlobalProvider();

		// Only save to opencode.json if using OpenCode CLI
		if (provider !== 'opencode') {
			logger.debug('[SettingsHandler] Skipping OpenCode save - using Claude CLI');
			this._deps.postMessage({
				type: 'proxyProviderSaved',
				data: { success: true, provider: 'claude' },
			});
			return;
		}

		this._deps.postMessage({
			type: 'proxyProviderSaving',
			data: { isLoading: true },
		});

		try {
			// Get OpenCode service
			let service = this._deps.getSessionManager().getActiveSession()?.cliService;
			if (!service) {
				service = await CLIServiceFactory.getService('opencode');
			}

			if (!service.addCustomProvider) {
				throw new Error('Custom provider not supported by current CLI service');
			}

			// Save proxy provider to opencode.json with canonical OpenAI-compatible provider ID
			const result = await service.addCustomProvider({
				id: OPENAI_COMPATIBLE_PROVIDER_ID,
				name: 'OpenAI Compatible',
				baseURL: baseUrl,
				apiKey: apiKey,
				models: models,
			});

			if (!result.success) {
				throw new Error(result.error || 'Failed to save proxy provider');
			}

			logger.info('[SettingsHandler] OpenAI-compatible provider saved to opencode.json');

			this._deps.postMessage({
				type: 'proxyProviderSaved',
				data: { success: true, provider: 'opencode' },
			});

			// Reload providers to reflect changes
			this._deps.postMessage({ type: 'reloadOpenCodeProviders' });
		} catch (error) {
			logger.error('[SettingsHandler] Failed to save proxy provider:', error);
			this._deps.postMessage({
				type: 'proxyProviderSaved',
				data: {
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}

	public openModelTerminal(): void {
		this._settingsService.openModelTerminal(this._deps.getCLISessionId());
		this._deps.postMessage({
			type: 'terminalOpened',
			data: 'Check terminal to update model configuration.',
		});
	}

	public executeSlashCommand(command: string): void {
		this._settingsService.executeSlashCommand(command, this._deps.getCLISessionId());
		this._deps.postMessage({
			type: 'terminalOpened',
			data: `Executing /${command}. Check terminal.`,
		});
	}

	public async sendAccess(): Promise<void> {
		const access = await this._accessService.getAccess();
		this._deps.postMessage({ type: 'accessData', data: access });
	}

	public async removeAccess(toolName: string, command: string | null): Promise<void> {
		await this._accessService.removeAccess(toolName, command);
		await this.sendAccess();
	}

	public async addAccess(toolName: string, command: string | null): Promise<void> {
		await this._accessService.addAccess(toolName, command);
		await this.sendAccess();
	}

	public async loadMCPServers(): Promise<void> {
		await this._mcp.loadMCPServers();
	}

	public async pingMcpServers(): Promise<void> {
		await this._mcp.pingMcpServers();
	}

	public async saveMCPServer(name: string, config: MCPServerConfig): Promise<void> {
		await this._mcp.saveMCPServer(name, config);
	}

	public async deleteMCPServer(name: string): Promise<void> {
		await this._mcp.deleteMCPServer(name);
	}

	public async fetchMcpMarketplaceCatalog(forceRefresh = false): Promise<void> {
		await this._mcp.fetchMcpMarketplaceCatalog(forceRefresh);
	}

	public async installMcpFromMarketplace(mcpId: string): Promise<void> {
		await this._mcp.installMcpFromMarketplace(mcpId);
	}

	public async checkAgentsConfig(): Promise<void> {
		await this._mcp.checkAgentsConfig();
	}

	public async openAgentsMcpConfig(): Promise<void> {
		await this._mcp.openAgentsMcpConfig();
	}

	public async saveMCPServerToAgents(name: string, server: AgentsMcpServer): Promise<void> {
		await this._mcp.saveMCPServerToAgents(name, server);
	}

	public async deleteMCPServerFromAgents(name: string): Promise<void> {
		await this._mcp.deleteMCPServer(name);
	}

	public async syncAgentsToProject(target: 'claude' | 'opencode'): Promise<void> {
		await this._mcp.syncAgentsToProject(target);
	}

	/**
	 * Import MCP configs from all CLI sources into .agents/mcp.json
	 */
	public async importMcpFromCLI(): Promise<void> {
		await this._mcp.importFromAllSources();
	}

	/**
	 * Refresh MCP servers list in webview.
	 * Called by McpConfigWatcherService when .agents/mcp.json changes.
	 */
	public async refreshMcpServers(): Promise<void> {
		logger.info('[SettingsHandler] Refreshing MCP servers after config change');
		await this._mcp.loadMCPServers();
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private async _findTextInDocuments(searchText: string): Promise<TextSearchResult | null> {
		const activeEditor = vscode.window.activeTextEditor;

		// Check active editor first
		if (activeEditor) {
			const result = this._findTextInDocument(activeEditor.document, searchText);
			if (result) return result;
		}

		// Check visible editors
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor === activeEditor) continue;
			const result = this._findTextInDocument(editor.document, searchText);
			if (result) return result;
		}

		// Check all open documents
		for (const document of vscode.workspace.textDocuments) {
			if (activeEditor && document === activeEditor.document) continue;
			if (vscode.window.visibleTextEditors.some(e => e.document === document)) continue;
			if (document.uri.scheme !== 'file') continue;

			const result = this._findTextInDocument(document, searchText);
			if (result) return result;
		}

		return null;
	}

	private _findTextInDocument(
		document: vscode.TextDocument,
		searchText: string,
	): TextSearchResult | null {
		const text = document.getText();
		const index = text.indexOf(searchText);
		if (index === -1) return null;

		const startPos = document.positionAt(index);
		const endPos = document.positionAt(index + searchText.length);

		return {
			filePath: vscode.workspace.asRelativePath(document.uri, false),
			startLine: startPos.line + 1,
			endLine: endPos.line + 1,
		};
	}

	public async loadAnthropicModels(anthropicApiKey?: string): Promise<void> {
		const apiKey =
			anthropicApiKey || (await this._context.secrets.get(this._anthropicApiKeySecretKey));
		const keyPresent = Boolean(apiKey && apiKey.trim().length > 0);
		if (!keyPresent) {
			this._deps.postMessage({
				type: 'anthropicModels',
				data: { enabled: true, models: [], error: 'Anthropic API key is not set', keyPresent },
			});
			return;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.PROXY_MODELS_FETCH);

		try {
			const response = await fetch('https://api.anthropic.com/v1/models', {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					...(apiKey ? { 'X-Api-Key': apiKey } : {}),
				},
				signal: controller.signal,
			});

			if (!response.ok) {
				throw NetworkError.fromHttpStatus(response.status, response.statusText, 'anthropic');
			}

			const data = (await response.json()) as {
				data?: Array<{ id: string; display_name?: string }>;
			};

			const models = (data.data || []).map(m => ({
				id: m.id,
				name: m.display_name || m.id,
			}));

			this._deps.postMessage({
				type: 'anthropicModels',
				data: { enabled: true, models, keyPresent: true },
			});
		} catch (error) {
			const err =
				error instanceof NetworkError
					? error
					: NetworkError.fromFetchError(error as Error, 'https://api.anthropic.com/v1/models');
			errorService.handle(err, 'SettingsHandler.loadAnthropicModels');
			this._deps.postMessage({
				type: 'anthropicModels',
				data: { enabled: true, models: [], error: err.userMessage },
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}

	public async setAnthropicApiKey(apiKey: string): Promise<void> {
		try {
			await this._context.secrets.store(this._anthropicApiKeySecretKey, apiKey);
			this._deps.postMessage({ type: 'anthropicKeySaved', data: { success: true } });
			this._deps.postMessage({ type: 'anthropicKeyStatus', data: { hasKey: true } });
			await this.loadAnthropicModels(apiKey);
		} catch (error) {
			this._deps.postMessage({
				type: 'anthropicKeySaved',
				data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
			});
		}
	}

	public async clearAnthropicApiKey(): Promise<void> {
		try {
			await this._context.secrets.delete(this._anthropicApiKeySecretKey);
			this._deps.postMessage({ type: 'anthropicKeyCleared', data: { success: true } });
			this._deps.postMessage({ type: 'anthropicKeyStatus', data: { hasKey: false } });
			this._deps.postMessage({
				type: 'anthropicModels',
				data: { enabled: true, models: [], keyPresent: false },
			});
		} catch (error) {
			this._deps.postMessage({
				type: 'anthropicKeyCleared',
				data: { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
			});
		}
	}

	public async getAnthropicKeyStatus(): Promise<void> {
		try {
			const key = await this._context.secrets.get(this._anthropicApiKeySecretKey);
			this._deps.postMessage({
				type: 'anthropicKeyStatus',
				data: { hasKey: Boolean(key && key.trim().length > 0) },
			});
		} catch (error) {
			this._deps.postMessage({
				type: 'anthropicKeyStatus',
				data: {
					hasKey: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}

	private async _fetchProxyModels(baseUrl: string, apiKey: string): Promise<ProxyModel[]> {
		const normalizedUrl = baseUrl.replace(/\/+$/, '');
		const modelsUrl = normalizedUrl.endsWith('/v1')
			? `${normalizedUrl}/models`
			: `${normalizedUrl}/v1/models`;

		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}

		// Create AbortController for timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.PROXY_MODELS_FETCH);

		try {
			const response = await fetch(modelsUrl, {
				method: 'GET',
				headers,
				signal: controller.signal,
			});

			if (!response.ok) {
				throw NetworkError.fromHttpStatus(response.status, response.statusText, baseUrl);
			}

			const normalizeModelCapabilities = (m: {
				capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
				reasoning?: boolean;
				vision?: boolean;
				tools?: boolean;
				thinking?: unknown;
			}): ProxyModel['capabilities'] | undefined => {
				const reasoning =
					m.capabilities?.reasoning ?? m.reasoning ?? (m.thinking != null ? true : undefined);
				const vision = m.capabilities?.vision ?? m.vision;
				const tools = m.capabilities?.tools ?? m.tools;

				if (reasoning === undefined && vision === undefined && tools === undefined)
					return undefined;
				return { reasoning, vision, tools };
			};

			const data = (await response.json()) as {
				data?: Array<{
					id: string;
					name?: string;
					display_name?: string;
					description?: string;
					context_length?: number;
					max_completion_tokens?: number;
					capabilities?: {
						reasoning?: boolean;
						vision?: boolean;
						tools?: boolean;
						[key: string]: unknown;
					};
					// Some servers may surface capability flags at top-level
					reasoning?: boolean;
					vision?: boolean;
					tools?: boolean;
					// Some OpenAI-compatible servers provide "thinking" metadata instead
					thinking?: unknown;
				}>;
			};

			return (data.data || []).map(m => {
				const capabilities = normalizeModelCapabilities(m);
				return {
					id: m.id,
					name: m.id, // User requested to see IDs instead of display names
					contextLength: m.context_length,
					maxCompletionTokens: m.max_completion_tokens,
					capabilities,
				};
			});
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new NetworkError(
					`Request timed out after ${TIMEOUTS.PROXY_MODELS_FETCH / 1000} seconds`,
					ErrorCode.NETWORK_TIMEOUT,
					{ url: baseUrl },
				);
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
