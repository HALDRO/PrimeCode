/**
 * @file OpenCode Provider Operations
 * @description Handles provider management, authentication, MCP operations, and config.
 * Extends BaseOpenCodeOps for unified error handling and reduced boilerplate.
 * Uses Context Accessor pattern for safe state access.
 * Updated for SDK v2 flat parameter style.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../../../utils/logger';
import type { CLIConfig, CLIModelInfo, CLIProvidersResponse } from '../../ICLIService';
import { BaseOpenCodeOps } from './BaseOpenCodeOps.js';
import type { CustomProviderConfig } from './types.js';

/** MCP server configuration for local servers */
export interface McpLocalConfig {
	type: 'local';
	command: string[];
	environment?: Record<string, string>;
	enabled?: boolean;
}

/** MCP server configuration for remote servers */
export interface McpRemoteConfig {
	type: 'remote';
	url: string;
	enabled?: boolean;
	headers?: Record<string, string>;
}

/** Provider auth method */
export interface ProviderAuthMethod {
	type: 'oauth' | 'api';
	label: string;
}

/** Pending permission entry (mapped from SDK PermissionRequest) */
export interface PendingPermission {
	id: string;
	type: string;
	sessionID: string;
	messageID: string;
	title: string;
	metadata: Record<string, unknown>;
}

/** Tool definition */
export interface ToolDefinition {
	id: string;
	description: string;
	parameters: unknown;
}

/** Available provider info */
export interface AvailableProvider {
	id: string;
	name: string;
	env: string[];
}

/** Raw provider data from SDK */
interface RawProviderData {
	all?: Array<{
		id: string;
		name?: string;
		source?: string;
		env?: string[];
		options?: Record<string, unknown>;
		models?: Record<string, unknown>;
	}>;
	default?: Record<string, string>;
	connected?: string[];
}

/** Raw model data from SDK */
interface RawModelData {
	id?: string;
	name?: string;
	reasoning?: boolean;
	temperature?: boolean;
	tool_call?: boolean;
	limit?: { context?: number; output?: number };
}

export class OpenCodeProviderOps extends BaseOpenCodeOps {
	// =========================================================================
	// Health & Logging
	// =========================================================================

	/**
	 * Get global health status with version info
	 */
	public async getGlobalHealth(): Promise<{ healthy: boolean; version?: string }> {
		const client = this._client;
		if (!client) {
			return { healthy: false };
		}

		try {
			const res = await client.global.health();
			if (res.error || !res.data) {
				return { healthy: false };
			}
			return { healthy: res.data.healthy, version: res.data.version };
		} catch {
			return { healthy: false };
		}
	}

	/**
	 * Write a log entry to the OpenCode server
	 */
	public async writeLog(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		extra?: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteResult('Write log', client =>
			client.app.log({
				directory: this._workspaceDir,
				service: 'vscode-extension',
				level,
				message,
				extra,
			}),
		);
		return { success: result.success, error: result.error };
	}

	// =========================================================================
	// Provider Management
	// =========================================================================

	/**
	 * Get configured providers and their models
	 */
	public async getProviders(): Promise<CLIProvidersResponse | null> {
		return this.safeExecute<RawProviderData, CLIProvidersResponse>(
			'Get providers',
			client => client.provider.list({ directory: this._workspaceDir }),
			rawData => {
				const providersArray = rawData?.all || [];
				const connectedProviders = new Set(rawData?.connected || []);
				const result: CLIProvidersResponse = {};

				for (const provider of providersArray) {
					if (!provider.id) continue;
					if (!connectedProviders.has(provider.id)) continue;

					const models: Record<string, CLIModelInfo> = {};
					if (provider.models) {
						for (const [modelId, modelData] of Object.entries(provider.models)) {
							const m = modelData as RawModelData;
							models[modelId] = {
								id: m.id || modelId,
								name: m.name || modelId,
								reasoning: m.reasoning === true,
								temperature: m.temperature === true,
								tool_call: m.tool_call === true,
								limit: m.limit ? { context: m.limit.context, output: m.limit.output } : undefined,
							};
						}
					}

					result[provider.id] = {
						id: provider.id,
						name: provider.name || provider.id,
						npm: provider.source === 'config' ? '@ai-sdk/openai-compatible' : undefined,
						hasKey: true,
						models,
					};
				}

				return result;
			},
		);
	}

	/**
	 * Get available (not connected) providers
	 */
	public async getAvailableProviders(): Promise<AvailableProvider[] | null> {
		return this.safeExecute<RawProviderData, AvailableProvider[]>(
			'Get available providers',
			client => client.provider.list({ directory: this._workspaceDir }),
			rawData => {
				const providersArray = rawData?.all || [];
				const connectedSet = new Set(rawData?.connected || []);

				return providersArray
					.filter(p => p.id && !connectedSet.has(p.id))
					.map(p => ({
						id: p.id,
						name: p.name || p.id,
						env: p.env || [],
					}));
			},
		);
	}

	/**
	 * Get provider authentication methods
	 */
	public async getProviderAuthMethods(): Promise<Record<string, ProviderAuthMethod[]> | null> {
		return this.safeExecute<Record<string, ProviderAuthMethod[]>>(
			'Get provider auth methods',
			client =>
				client.provider.auth({
					directory: this._workspaceDir,
				}),
		);
	}

	/**
	 * Set provider API key authentication
	 */
	public async setProviderAuth(
		providerId: string,
		apiKey: string,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Setting auth for provider: ${providerId}`,
			client =>
				client.auth.set({
					providerID: providerId,
					directory: this._workspaceDir,
					auth: { type: 'api', key: apiKey },
				}),
		);

		if (result.success) {
			// Clear cached provider state
			await this._disposeInstance();
		}

		return { success: result.success, error: result.error };
	}

	/**
	 * Disconnect a provider by removing its auth
	 */
	public async disconnectProvider(
		providerId: string,
	): Promise<{ success: boolean; error?: string }> {
		const client = this._client;
		if (!client) {
			return { success: false, error: 'OpenCode not initialized' };
		}

		try {
			logger.info(`[OpenCodeProviderOps] Disconnecting provider: ${providerId}`);

			// Get data directory
			const dataDir = await this._getDataDir();
			const authFilePath = path.join(dataDir, 'auth.json');

			try {
				const authContent = await fs.promises.readFile(authFilePath, 'utf-8');
				const authData = JSON.parse(authContent) as Record<string, unknown>;

				if (providerId in authData) {
					delete authData[providerId];
					await fs.promises.writeFile(authFilePath, JSON.stringify(authData, null, 2), 'utf-8');
					logger.info(`[OpenCodeProviderOps] Removed ${providerId} from auth.json`);
				}
			} catch {
				// Fallback: set empty key via API
				await client.auth.set({
					providerID: providerId,
					directory: this._workspaceDir,
					auth: { type: 'api', key: '' },
				});
			}

			await this._disposeInstance();
			return { success: true };
		} catch (error) {
			logger.error('[OpenCodeProviderOps] Error disconnecting provider:', error);
			return {
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	/**
	 * Start OAuth flow for a provider
	 */
	public async startProviderOAuth(
		providerId: string,
		methodIndex = 0,
	): Promise<{
		success: boolean;
		url?: string;
		method?: string;
		instructions?: string;
		error?: string;
	}> {
		const result = await this.safeExecuteWithLog(
			`Starting OAuth for provider ${providerId}`,
			client =>
				client.provider.oauth.authorize({
					providerID: providerId,
					directory: this._workspaceDir,
					method: methodIndex,
				}),
			(data: { url?: string; method?: string; instructions?: string }) => ({
				url: data?.url,
				method: data?.method,
				instructions: data?.instructions,
			}),
		);

		return {
			success: result.success,
			url: result.data?.url,
			method: result.data?.method,
			instructions: result.data?.instructions,
			error: result.error,
		};
	}

	/**
	 * Complete OAuth flow for a provider
	 */
	public async completeProviderOAuth(
		providerId: string,
		code: string,
		methodIndex = 0,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Completing OAuth for provider ${providerId}`,
			client =>
				client.provider.oauth.callback({
					providerID: providerId,
					directory: this._workspaceDir,
					method: methodIndex,
					code,
				}),
		);
		return { success: result.success, error: result.error };
	}

	/**
	 * Add a custom OpenAI-compatible provider
	 */
	public async addCustomProvider(
		config: CustomProviderConfig,
	): Promise<{ success: boolean; restartRequired: boolean; error?: string }> {
		const client = this._client;
		if (!client) {
			return { success: false, restartRequired: false, error: 'OpenCode not initialized' };
		}

		try {
			logger.info(`[OpenCodeProviderOps] Adding custom provider: ${config.id}`);

			const pathRes = await client.path.get({ directory: this._workspaceDir });
			if (pathRes.error || !pathRes.data?.config) {
				return {
					success: false,
					restartRequired: false,
					error: 'Failed to get global config path',
				};
			}

			const globalConfigDir = pathRes.data.config;
			const globalConfigPath = `${globalConfigDir}/opencode.json`;

			// Load or create config
			let existingConfig: Record<string, unknown> = {};
			try {
				const content = await fs.promises.readFile(globalConfigPath, 'utf-8');
				existingConfig = JSON.parse(content);
			} catch {
				existingConfig = { $schema: 'https://opencode.ai/config.json' };
			}

			// Normalize base URL
			let normalizedBaseURL = config.baseURL.replace(/\/+$/, '');
			if (!normalizedBaseURL.endsWith('/v1')) {
				normalizedBaseURL = `${normalizedBaseURL}/v1`;
			}

			// Build provider config
			const providerConfig: Record<string, unknown> = {
				name: config.name,
				npm: '@ai-sdk/openai-compatible',
				options: { baseURL: normalizedBaseURL, apiKey: config.apiKey },
			};

			if (config.models?.length) {
				const modelsConfig: Record<string, { name: string }> = {};
				for (const model of config.models) {
					modelsConfig[model.id] = { name: model.name };
				}
				providerConfig.models = modelsConfig;
			}

			// Update config
			const providers = (existingConfig.provider as Record<string, unknown>) || {};
			providers[config.id] = providerConfig;
			existingConfig.provider = providers;

			await fs.promises.mkdir(globalConfigDir, { recursive: true });
			await fs.promises.writeFile(globalConfigPath, JSON.stringify(existingConfig, null, 2));

			return { success: true, restartRequired: true };
		} catch (error) {
			logger.error('[OpenCodeProviderOps] Error adding custom provider:', error);
			return {
				success: false,
				restartRequired: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			};
		}
	}

	// =========================================================================
	// Config Management
	// =========================================================================

	public async getConfig(): Promise<CLIConfig | null> {
		return this.safeExecute<CLIConfig>('Get config', client =>
			client.config.get({ directory: this._workspaceDir }),
		);
	}

	public async updateConfig(
		configUpdate: Partial<CLIConfig> & Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog('Updating config', client =>
			client.config.update({
				directory: this._workspaceDir,
				config: configUpdate as Record<string, unknown>,
			}),
		);
		return { success: result.success, error: result.error };
	}

	public async setActiveModel(model: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Setting active model: ${model}`, client =>
			client.config.update({
				directory: this._workspaceDir,
				config: { model },
			}),
		);
		return { success: result.success, error: result.error };
	}

	// =========================================================================
	// MCP Server Management
	// =========================================================================

	/**
	 * Get MCP servers status
	 */
	public async getMcpStatus(): Promise<Record<string, { status: string; error?: string }> | null> {
		return this.safeExecute<Record<string, { status: string; error?: string }>>(
			'Get MCP status',
			client => client.mcp.status({ directory: this._workspaceDir }),
		);
	}

	/**
	 * Reload MCP configuration by disposing instance
	 */
	public async forceReloadInstance(): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog('Reloading instance', client =>
			client.instance.dispose({ directory: this._workspaceDir }),
		);
		return { success: result.success, error: result.error };
	}

	/**
	 * Authenticate MCP server
	 */
	public async authenticateMcp(name: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteResult(`Authenticate MCP: ${name}`, client =>
			client.mcp.auth.authenticate({
				name,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	/**
	 * Start MCP OAuth flow
	 */
	public async startMcpAuth(
		name: string,
	): Promise<{ success: boolean; authorizationUrl?: string; error?: string }> {
		const result = await this.safeExecuteResult(
			`Start MCP auth: ${name}`,
			client =>
				client.mcp.auth.start({
					name,
					directory: this._workspaceDir,
				}),
			(data: { authorizationUrl?: string } | undefined) => {
				if (!data?.authorizationUrl) {
					throw new Error('Missing authorizationUrl');
				}
				return { authorizationUrl: data.authorizationUrl };
			},
		);

		return {
			success: result.success,
			authorizationUrl: result.data?.authorizationUrl,
			error: result.error,
		};
	}

	/**
	 * Add MCP server
	 */
	public async addMcpServer(
		name: string,
		config: McpLocalConfig | McpRemoteConfig,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Adding MCP server: ${name}`, client =>
			client.mcp.add({
				directory: this._workspaceDir,
				name,
				config,
			}),
		);
		return { success: result.success, error: result.error };
	}

	/**
	 * Connect MCP server
	 */
	public async connectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Connecting MCP server: ${name}`, client =>
			client.mcp.connect({
				name,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	/**
	 * Disconnect MCP server
	 */
	public async disconnectMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Disconnecting MCP server: ${name}`, client =>
			client.mcp.disconnect({
				name,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	// =========================================================================
	// Permissions & Tools
	// =========================================================================

	/**
	 * List pending permissions
	 */
	public async listPendingPermissions(): Promise<PendingPermission[] | null> {
		// SDK returns PermissionRequest[], we transform to PendingPermission[]
		interface SdkPermissionRequest {
			id: string;
			sessionID: string;
			permission: string;
			patterns: string[];
			metadata: Record<string, unknown>;
			tool?: { messageID: string; callID: string };
		}

		return this.safeExecute<SdkPermissionRequest[], PendingPermission[]>(
			'List permissions',
			client => client.permission.list({ directory: this._workspaceDir }),
			data =>
				(data || []).map(p => ({
					id: p.id,
					type: p.permission,
					sessionID: p.sessionID,
					messageID: p.tool?.messageID || '',
					title: p.permission,
					metadata: p.metadata,
				})),
		);
	}

	/**
	 * Get tool IDs
	 */
	public async getToolIds(): Promise<string[] | null> {
		return this.safeExecute<string[]>('Get tool IDs', client =>
			client.tool.ids({
				directory: this._workspaceDir,
			}),
		);
	}

	/**
	 * Get tools for a provider/model
	 */
	public async getTools(provider: string, model: string): Promise<ToolDefinition[] | null> {
		return this.safeExecute<ToolDefinition[]>(`Get tools for ${provider}/${model}`, client =>
			client.tool.list({
				directory: this._workspaceDir,
				provider,
				model,
			}),
		);
	}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	/**
	 * Dispose instance to clear cached state
	 */
	private async _disposeInstance(): Promise<void> {
		const client = this._client;
		if (!client) return;

		try {
			await client.instance.dispose({ directory: this._workspaceDir });
		} catch (error) {
			logger.warn('[OpenCodeProviderOps] Failed to dispose instance:', error);
		}
	}

	/**
	 * Get OpenCode data directory
	 */
	private async _getDataDir(): Promise<string> {
		const client = this._client;
		if (client) {
			try {
				const pathRes = await client.path.get({ directory: this._workspaceDir });
				// pathRes.data is of type Path which has: home, state, config, worktree, directory
				if (!pathRes.error && pathRes.data?.state) {
					return pathRes.data.state;
				}
			} catch {
				logger.debug(
					'[OpenCodeProviderOps] Failed to get path from server, falling back to local calculation',
				);
			}
		}

		// Fallback to local calculation
		const home = process.env.HOME || process.env.USERPROFILE || '';
		if (process.env.XDG_DATA_HOME) {
			return path.join(process.env.XDG_DATA_HOME, 'opencode');
		}
		return path.join(home, '.local', 'share', 'opencode');
	}
}
