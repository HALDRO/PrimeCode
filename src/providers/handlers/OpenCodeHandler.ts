/**
 * @file OpenCodeHandler
 * @description Manages OpenCode-specific provider operations: loading providers, setting models,
 *              authentication, custom provider configuration, and provider disconnection.
 *              Provides abstraction layer between ChatProvider and OpenCode CLI service.
 *              Uses centralized _getReadyService() helper for consistent service initialization
 *              with timeout and retry logic.
 */

import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import type { ICLIService } from '../../services/ICLIService';
import type { SessionManager } from '../../services/SessionManager';
import type { SettingsService } from '../../services/SettingsService';
import { logger } from '../../utils/logger';

/** Default timeout for service operations in milliseconds */
const DEFAULT_TIMEOUT_MS = 15000;
/** Extended timeout for initial service initialization (server startup takes ~3-5s) */
const INIT_TIMEOUT_MS = 25000;
/** Default number of retries for provider loading operations */
const DEFAULT_RETRIES = 2;
/** Delay multiplier for retry backoff (ms * attempt) */
const RETRY_DELAY_MS = 3000;

export class OpenCodeHandler {
	constructor(
		private readonly _settingsService: SettingsService,
		private readonly _sessionManager: SessionManager,
	) {}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	/**
	 * Creates a timeout promise that rejects after specified milliseconds.
	 */
	private _timeout<T>(ms: number, message: string): Promise<T> {
		return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
	}

	/**
	 * Executes an async function with retry logic and exponential backoff.
	 */
	private async _withRetry<T>(
		fn: () => Promise<T>,
		retries = DEFAULT_RETRIES,
		context = 'operation',
	): Promise<T> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				return await fn();
			} catch (error) {
				if (attempt === retries) throw error;
				const delay = RETRY_DELAY_MS * (attempt + 1);
				logger.warn(
					`[OpenCodeHandler] ${context} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`,
				);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
		throw new Error('Unreachable');
	}

	/**
	 * Gets a ready OpenCode service instance with initialization and timeout handling.
	 * Always uses 'opencode' provider explicitly to avoid getting wrong service.
	 * Uses extended timeout for initial server startup which can take 3-5 seconds.
	 */
	private async _getReadyService(timeoutMs = INIT_TIMEOUT_MS): Promise<ICLIService> {
		let service = this._sessionManager.getActiveSession()?.cliService;

		// If active session service is not OpenCode (e.g. Claude), get unified OpenCode instance
		if (service?.getProviderType() !== 'opencode') {
			service = await CLIServiceFactory.getService('opencode');
		}

		if (!service.isReady()) {
			logger.debug('[OpenCodeHandler] Service not ready, waiting for initialization...');
			await Promise.race([
				service.initialize(),
				this._timeout<never>(timeoutMs, 'OpenCode initialization timed out'),
			]);
			logger.debug('[OpenCodeHandler] Service initialization complete');
		}

		return service;
	}

	// =========================================================================
	// Public Methods - Provider Loading
	// =========================================================================

	public async loadOpenCodeProviders(
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		if (providerConfig !== 'opencode') {
			postMessage({
				type: 'openCodeProviders',
				data: { providers: [], config: { isLoading: false } },
			});
			return;
		}

		postMessage({
			type: 'openCodeProviders',
			data: { providers: [], config: { isLoading: true } },
		});

		try {
			const service = await this._withRetry(
				() => this._getReadyService(),
				DEFAULT_RETRIES,
				'loadOpenCodeProviders',
			);

			if (!service.getProviders || !service.getConfig) {
				throw new Error('OpenCode service missing provider methods');
			}

			const [providersData, configData] = await Promise.race([
				Promise.all([service.getProviders(), service.getConfig()]),
				this._timeout<never>(DEFAULT_TIMEOUT_MS, 'OpenCode providers request timed out'),
			]);

			if (!providersData) throw new Error('Failed to fetch providers');

			// Debug: Log raw provider data to troubleshoot model ID issues
			logger.debug(
				`[OpenCodeHandler] Raw providersData keys: ${Object.keys(providersData).join(', ')}`,
			);
			for (const [pid, pinfo] of Object.entries(providersData)) {
				const p = pinfo as { name?: string; models?: Record<string, unknown> };
				const modelKeys = p.models ? Object.keys(p.models) : [];
				logger.debug(
					`[OpenCodeHandler] Provider "${pid}" (name: "${p.name}") models: ${modelKeys.join(', ')}`,
				);
			}

			const providers: Array<{
				id: string;
				name: string;
				api?: string;
				isCustom?: boolean;
				hasKey?: boolean;
				models: Array<{
					id: string;
					name: string;
					providerId: string;
					providerName: string;
					reasoning?: boolean;
					limit?: { context?: number; output?: number };
				}>;
			}> = [];

			for (const [providerId, providerInfo] of Object.entries(providersData)) {
				const typedProvider = providerInfo as {
					name?: string;
					api?: string;
					npm?: string;
					hasKey?: boolean;
					models?: Record<
						string,
						{
							name?: string;
							reasoning?: boolean;
							limit?: { context?: number; output?: number };
						}
					>;
				};

				const modelsObj = typedProvider.models;
				if (!modelsObj) continue;

				const models = Object.entries(modelsObj).map(([modelId, modelInfo]) => ({
					id: modelId,
					name: modelInfo.name || modelId,
					providerId,
					providerName: typedProvider.name || providerId,
					reasoning: modelInfo.reasoning,
					limit: modelInfo.limit,
				}));

				if (models.length > 0) {
					// npm field is only set for providers added via config (source === 'config')
					// Built-in providers like OpenRouter don't have npm field
					const isCustomProvider = typedProvider.npm != null;

					providers.push({
						id: providerId,
						name: typedProvider.name || providerId,
						api: typedProvider.api,
						isCustom: isCustomProvider,
						hasKey: typedProvider.hasKey,
						models,
					});
				}
			}

			// Use saved model from SettingsService, fallback to OpenCode config model
			const savedModel = this._settingsService.selectedModel;
			const currentModel = savedModel && savedModel !== 'default' ? savedModel : configData?.model;

			postMessage({
				type: 'openCodeProviders',
				data: {
					providers,
					config: {
						currentModel,
						isLoading: false,
					},
				},
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			logger.error(
				`[OpenCodeHandler] Failed to load OpenCode providers: ${errorMessage}`,
				errorStack ? { stack: errorStack } : undefined,
			);
			postMessage({
				type: 'openCodeProviders',
				data: {
					providers: [],
					config: {
						isLoading: false,
						error: errorMessage || 'Failed to load providers',
					},
				},
			});
		}
	}

	public setOpenCodeModel(model: string, postMessage: (msg: unknown) => void): void {
		logger.info(`[OpenCodeHandler] setOpenCodeModel called with: "${model}"`);
		this._settingsService.setSelectedModel(model);
		postMessage({
			type: 'openCodeModelSet',
			data: { model },
		});
		void this._updateOpenCodeActiveModel(model);
	}

	public async setOpenCodeProviderAuth(
		providerId: string,
		apiKey: string,
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		postMessage({
			type: 'openCodeAuthResult',
			data: { providerId, isLoading: true },
		});

		try {
			const service = await this._getReadyService();

			if (!service.setProviderAuth) {
				throw new Error('Provider auth not supported by current CLI service');
			}

			const result = await service.setProviderAuth(providerId, apiKey);

			postMessage({
				type: 'openCodeAuthResult',
				data: {
					providerId,
					isLoading: false,
					success: result.success,
					error: result.error,
				},
			});

			if (result.success) {
				void this.loadOpenCodeProviders(postMessage, providerConfig);
			}
		} catch (error) {
			logger.error('[OpenCodeHandler] Error setting provider auth:', error);
			postMessage({
				type: 'openCodeAuthResult',
				data: {
					providerId,
					isLoading: false,
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}

	public async disconnectOpenCodeProvider(
		providerId: string,
		postMessage: (msg: unknown) => void,
		_providerConfig: string,
	): Promise<void> {
		try {
			const service = await this._getReadyService();

			if (!service.disconnectProvider) {
				throw new Error('Provider disconnect not supported by current CLI service');
			}

			const result = await service.disconnectProvider(providerId);

			if (result.success) {
				postMessage({
					type: 'openCodeDisconnectResult',
					data: { providerId, success: true },
				});
				// Send message to remove provider from UI immediately
				// Don't reload from server - it may have stale cached data
				postMessage({
					type: 'removeOpenCodeProvider',
					data: { providerId },
				});
			} else {
				logger.warn(`[OpenCodeHandler] Failed to disconnect provider: ${result.error}`);
				postMessage({
					type: 'openCodeDisconnectResult',
					data: { providerId, success: false, error: result.error },
				});
			}
		} catch (error) {
			logger.error('[OpenCodeHandler] Error disconnecting provider:', error);
			postMessage({
				type: 'openCodeDisconnectResult',
				data: {
					providerId,
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}

	public async addOpenCodeCustomProvider(
		config: {
			id: string;
			name: string;
			baseURL: string;
			apiKey: string;
			models?: Array<{ id: string; name: string }>;
		},
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		postMessage({
			type: 'openCodeCustomProviderResult',
			data: { providerId: config.id, isLoading: true },
		});

		try {
			const service = await this._getReadyService();

			if (!service.addCustomProvider) {
				throw new Error('Custom provider not supported by current CLI service');
			}

			const result = await service.addCustomProvider(config);

			postMessage({
				type: 'openCodeCustomProviderResult',
				data: {
					providerId: config.id,
					isLoading: false,
					success: result.success,
					error: result.error,
				},
			});

			if (result.success) {
				void this.loadOpenCodeProviders(postMessage, providerConfig);
			}
		} catch (error) {
			logger.error('[OpenCodeHandler] Error adding custom provider:', error);
			postMessage({
				type: 'openCodeCustomProviderResult',
				data: {
					providerId: config.id,
					isLoading: false,
					success: false,
					error: error instanceof Error ? error.message : 'Unknown error',
				},
			});
		}
	}

	public async loadAvailableProviders(
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		// Only load available providers for OpenCode CLI
		if (providerConfig !== 'opencode') {
			postMessage({
				type: 'availableProviders',
				data: { providers: [] },
			});
			return;
		}

		try {
			const service = await this._withRetry(
				() => this._getReadyService(),
				DEFAULT_RETRIES,
				'loadAvailableProviders',
			);

			if (!service.getAvailableProviders) {
				postMessage({
					type: 'availableProviders',
					data: { providers: [] },
				});
				return;
			}

			const providers = await Promise.race([
				service.getAvailableProviders(),
				this._timeout<null>(DEFAULT_TIMEOUT_MS, 'Available providers request timed out'),
			]);

			logger.info(
				`[OpenCodeHandler] loadAvailableProviders: got ${providers?.length ?? 0} providers`,
			);

			postMessage({
				type: 'availableProviders',
				data: { providers: providers || [] },
			});
		} catch (error) {
			logger.error('[OpenCodeHandler] Error loading available providers:', error);
			postMessage({
				type: 'availableProviders',
				data: { providers: [], error: error instanceof Error ? error.message : 'Unknown error' },
			});
		}
	}

	public async loadOpenCodeMcpStatus(
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		if (providerConfig !== 'opencode') {
			postMessage({ type: 'opencodeMcpStatus', data: {} });
			return;
		}

		try {
			const service = await this._getReadyService();

			// Use raw SDK client MCP status endpoint (GET /mcp)
			const opencodeService = service as unknown as {
				getMcpStatus?: () => Promise<Record<string, { status: string; error?: string }> | null>;
			};

			if (!opencodeService.getMcpStatus) {
				postMessage({ type: 'opencodeMcpStatus', data: {} });
				return;
			}

			const status = await opencodeService.getMcpStatus();
			postMessage({ type: 'opencodeMcpStatus', data: status || {} });
		} catch (error) {
			logger.warn('[OpenCodeHandler] Failed to load OpenCode MCP status:', error);
			postMessage({ type: 'opencodeMcpStatus', data: {} });
		}
	}

	public async startMcpAuth(
		name: string,
		postMessage: (msg: unknown) => void,
		providerConfig: string,
	): Promise<void> {
		if (providerConfig !== 'opencode') return;

		try {
			const service = await this._getReadyService();

			if (!service.startMcpAuth) {
				postMessage({
					type: 'opencodeMcpAuthError',
					data: { name, error: 'MCP auth not supported by current OpenCode service' },
				});
				return;
			}

			const result = await service.startMcpAuth(name);
			if (!result.success || !result.authorizationUrl) {
				postMessage({
					type: 'opencodeMcpAuthError',
					data: { name, error: result.error || 'Failed to start OAuth' },
				});
				return;
			}

			postMessage({
				type: 'opencodeMcpAuthStarted',
				data: { name, authorizationUrl: result.authorizationUrl },
			});
		} catch (error) {
			postMessage({
				type: 'opencodeMcpAuthError',
				data: { name, error: error instanceof Error ? error.message : 'Unknown error' },
			});
		}
	}

	private async _updateOpenCodeActiveModel(model: string): Promise<void> {
		try {
			const service = await this._getReadyService();
			if (service.setActiveModel) {
				await service.setActiveModel(model);
			}
		} catch (error) {
			logger.error('[OpenCodeHandler] Error updating OpenCode active model:', error);
		}
	}
}
