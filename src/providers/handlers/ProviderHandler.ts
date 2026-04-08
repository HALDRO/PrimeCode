import * as vscode from 'vscode';
import {
	getProxyEndpointProviderId,
	normalizeProxyBaseUrl,
	type OpenCodeProviderData,
} from '../../common';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../../common/constants';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import type { EnrichedProxyModel } from '../../services/OpenCodeClientService';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class ProviderHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

	private static readonly LEGACY_SELECTED_MODEL_KEY = 'primecode.selectedModel';
	private static readonly PROXY_MODELS_CACHE_KEY = 'primecode.proxyModels.cache';

	/** Monotonic counter to discard results from stale concurrent reloads. */
	private _reloadGeneration = 0;

	private getProxyModelsCacheKey(baseUrl: string): string {
		return `${ProviderHandler.PROXY_MODELS_CACHE_KEY}:${baseUrl}`;
	}

	private getSelectedModelKey(): string {
		return 'primecode.selectedModel.opencode';
	}

	private async readSelectedModel(): Promise<string | undefined> {
		const key = this.getSelectedModelKey();
		const fromWorkspace = this.context.extensionContext.workspaceState.get<string>(key);
		if (fromWorkspace) return fromWorkspace;

		// Migration: copy from globalState → workspaceState (one-time per workspace)
		const fromGlobal = this.context.extensionContext.globalState.get<string>(key);
		if (fromGlobal) {
			await this.context.extensionContext.workspaceState.update(key, fromGlobal);
			return fromGlobal;
		}

		// Backward-compat: attempt to migrate from the legacy globalState key.
		const legacy = this.context.extensionContext.globalState.get<string>(
			ProviderHandler.LEGACY_SELECTED_MODEL_KEY,
		);
		if (!legacy) return undefined;

		// OpenCode models are composite IDs: "provider/model".
		if (!legacy.includes('/')) return undefined;

		await this.context.extensionContext.workspaceState.update(key, legacy);
		return legacy;
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'reloadAllProviders':
				await this.onReloadAllProviders();
				break;
			case 'checkOpenCodeStatus':
				await this.onCheckOpenCodeStatus();
				break;
			case 'loadOpenCodeProviders':
				await this.onLoadOpenCodeProviders();
				break;
			case 'loadAvailableProviders':
				await this.onLoadAvailableProviders();
				break;
			case 'setOpenCodeProviderAuth':
				await this.onSetOpenCodeProviderAuth(msg);
				break;
			case 'disconnectOpenCodeProvider':
				await this.onDisconnectOpenCodeProvider(msg);
				break;
			case 'setOpenCodeModel':
				await this.onSetOpenCodeModel(msg);
				break;
			case 'selectModel':
				await this.onSelectModel(msg);
				break;
			case 'loadProxyModels':
				await this.onLoadProxyModels(msg);
				break;
			case 'syncProxyModels':
				await this.onSyncProxyModels(msg);
				break;
			case 'removeProxyEndpoint':
				await this.onRemoveProxyEndpoint(msg);
				break;
		}
	}

	private async onReloadAllProviders(): Promise<void> {
		const gen = ++this._reloadGeneration;
		const results = await Promise.all([
			this.onCheckOpenCodeStatus(),
			this.onLoadAvailableProviders(),
			this.onLoadOpenCodeProviders(),
			this.restoreSelectedModel(),
		]);
		// If another reload was triggered while we were awaiting, discard these results
		// by not sending any additional messages — the newer reload will handle it.
		if (gen !== this._reloadGeneration) return;
		void results; // results are sent inline by each sub-method
	}

	private async restoreSelectedModel(): Promise<void> {
		const savedModel = await this.readSelectedModel();
		if (!savedModel) return;
		this.context.bridge.data('openCodeModelSet', { model: savedModel });
	}

	private async onCheckOpenCodeStatus(): Promise<void> {
		const info = this.context.cli.getOpenCodeServerInfo();
		if (!info) {
			this.context.bridge.data('openCodeStatus', {
				installed: false,
				version: null,
				error: 'OpenCode server not running',
			});
			return;
		}

		// Version detection is intentionally omitted (depends on CLI/server implementation).
		this.context.bridge.data('openCodeStatus', { installed: true, version: null });
	}

	private async onLoadOpenCodeProviders(): Promise<void> {
		try {
			const sdkClient = this.context.cli.getSdkClient();
			if (!sdkClient) {
				this.context.bridge.data('openCodeProviders', {
					providers: [],
					config: { isLoading: false, error: 'OpenCode server not running' },
				});
				return;
			}

			const providers = (await this.context.services.openCodeClient.getConnectedProviders(
				sdkClient,
			)) as OpenCodeProviderData[];

			this.context.bridge.data('openCodeProviders', { providers, config: { isLoading: false } });
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.context.bridge.data('openCodeProviders', {
				providers: [],
				config: { isLoading: false, error: msg },
			});
		}
	}

	private async onLoadAvailableProviders(): Promise<void> {
		try {
			const sdkClient = this.context.cli.getSdkClient();
			if (!sdkClient) {
				this.context.bridge.data('availableProviders', { providers: [] });
				return;
			}

			const providers = await this.context.services.openCodeClient.getAvailableProviders(sdkClient);

			this.context.bridge.data('availableProviders', { providers });
		} catch {
			this.context.bridge.data('availableProviders', { providers: [] });
		}
	}

	private async onSetOpenCodeProviderAuth(
		msg: CommandOf<'setOpenCodeProviderAuth'>,
	): Promise<void> {
		const { providerId, apiKey } = msg;
		if (!providerId || !apiKey) {
			this.context.bridge.data('openCodeAuthResult', {
				success: false,
				error: 'Missing providerId or apiKey',
				providerId,
			});
			return;
		}

		this.context.bridge.data('openCodeAuthResult', { success: false, providerId, isLoading: true });

		try {
			const sdkClient = this.context.cli.getSdkClient();
			if (!sdkClient) {
				this.context.bridge.data('openCodeAuthResult', {
					success: false,
					error: 'OpenCode server not running',
					providerId,
				});
				return;
			}

			await this.context.services.openCodeClient.setProviderAuth(sdkClient, providerId, apiKey);

			this.context.bridge.data('openCodeAuthResult', { success: true, providerId });
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.context.bridge.data('openCodeAuthResult', { success: false, error: err, providerId });
		}
	}

	private async onDisconnectOpenCodeProvider(
		msg: CommandOf<'disconnectOpenCodeProvider'>,
	): Promise<void> {
		const { providerId } = msg;
		if (!providerId) {
			this.context.bridge.data('openCodeDisconnectResult', {
				success: false,
				error: 'Missing providerId',
				providerId,
			});
			return;
		}

		try {
			const client = this.context.cli.getSdkClient();
			if (!client) {
				this.context.bridge.data('openCodeDisconnectResult', {
					success: false,
					error: 'OpenCode server not running',
					providerId,
				});
				return;
			}

			await this.context.services.openCodeClient.disconnectProvider(client, providerId);

			this.context.bridge.data('openCodeDisconnectResult', { success: true, providerId });

			// Let UI prune models for this provider.
			this.context.bridge.data('removeOpenCodeProvider', { providerId });
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.context.bridge.data('openCodeDisconnectResult', {
				success: false,
				error: err,
				providerId,
			});
		}
	}

	private async onSetOpenCodeModel(msg: CommandOf<'setOpenCodeModel'>): Promise<void> {
		const { model } = msg;
		if (model) {
			await this.context.extensionContext.workspaceState.update(this.getSelectedModelKey(), model);
			this.context.bridge.data('openCodeModelSet', { model });
		}
	}

	private async onSelectModel(msg: CommandOf<'selectModel'>): Promise<void> {
		const { model } = msg;
		if (model) {
			await this.context.extensionContext.workspaceState.update(this.getSelectedModelKey(), model);
			this.context.bridge.send({ type: 'modelSelected', model });
		}
	}

	private async onLoadProxyModels(msg: CommandOf<'loadProxyModels'>): Promise<void> {
		const endpointId = msg.endpointId;
		const customHeaders = msg.headers;

		let baseUrlRaw = msg.baseUrl;
		if (!baseUrlRaw.trim()) {
			const setting = this.context.settings.get('proxy.baseUrl');
			if (typeof setting === 'string') baseUrlRaw = setting;
		}

		let apiKeyRaw = msg.apiKey;
		if (!apiKeyRaw.trim()) {
			const setting = this.context.settings.get('proxy.apiKey');
			if (typeof setting === 'string') apiKeyRaw = setting;
		}

		const baseUrl = normalizeProxyBaseUrl(baseUrlRaw);
		const apiKey = apiKeyRaw.trim();

		if (!baseUrl || baseUrl === '/v1') {
			this.context.bridge.data('proxyModels', {
				enabled: false,
				models: [],
				error: 'Missing proxy baseUrl',
				endpointId,
			});
			return;
		}

		// Immediately send cached models so the UI is populated before fetch completes.
		const cacheKey = this.getProxyModelsCacheKey(baseUrl);
		const cached = this.context.extensionContext.globalState.get<EnrichedProxyModel[]>(cacheKey);
		if (cached?.length) {
			this.context.bridge.data('proxyModels', {
				enabled: true,
				models: cached,
				baseUrl,
				endpointId,
			});
		}

		let url: URL;
		try {
			url = new URL(`${baseUrl}/models`);
		} catch {
			this.context.bridge.data('proxyModels', {
				enabled: Boolean(cached?.length),
				models: cached ?? [],
				baseUrl,
				error: 'Invalid proxy baseUrl',
				endpointId,
			});
			return;
		}

		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
					...(customHeaders ?? {}),
				},
			});

			if (!response.ok) {
				const bodyText = await response.text().catch(() => '');
				const detail = bodyText ? `: ${bodyText.slice(0, 400)}` : '';
				this.context.bridge.data('proxyModels', {
					enabled: Boolean(cached?.length),
					models: cached ?? [],
					baseUrl,
					error: `Proxy models request failed (${response.status})${detail}`,
					endpointId,
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

			// Parse models with extended metadata from /v1/models response.
			const rawModels = items
				.filter(
					(item): item is Record<string, unknown> =>
						item != null && typeof item === 'object' && 'id' in item,
				)
				.map(item => {
					const id = String(item.id ?? '');
					return {
						id,
						name: id,
						contextLength: toPositiveInt(
							item.context_length ??
								item.context_window ??
								item.max_context_length ??
								item.max_model_len,
						),
						maxCompletionTokens: toPositiveInt(
							item.max_completion_tokens ?? item.max_output_tokens ?? item.max_tokens,
						),
					};
				})
				.filter(m => m.id.length > 0);

			if (rawModels.length === 0) {
				this.context.bridge.data('proxyModels', {
					enabled: Boolean(cached?.length),
					models: cached ?? [],
					baseUrl,
					error: 'No models returned by proxy',
					endpointId,
				});
				return;
			}

			const enriched = await this.enrichWithModelsDev(rawModels);

			// Persist to cache for next startup
			void this.context.extensionContext.globalState.update(cacheKey, enriched);

			this.context.bridge.data('proxyModels', {
				enabled: true,
				models: enriched,
				baseUrl,
				endpointId,
			});
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			this.context.bridge.data('proxyModels', {
				enabled: Boolean(cached?.length),
				models: cached ?? [],
				baseUrl,
				error: `Proxy models fetch failed: ${errMsg}`,
				endpointId,
			});
		}
	}

	/**
	 * Sync only user-enabled proxy models to opencode.json.
	 * Triggered when the user toggles models in the ProviderManager UI.
	 */
	private async onSyncProxyModels(msg: CommandOf<'syncProxyModels'>): Promise<void> {
		const {
			baseUrl,
			apiKey,
			endpointId,
			providerId,
			providerName,
			headers: customHeaders,
			enabledModelIds: rawEnabledIds,
		} = msg;
		if (!baseUrl?.trim()) return;

		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) return;
			// Use the exact list from the UI message — never read from settings,
			// which may contain stale/merged data from OpenCode CLI global config.
			const enabledModelIds = (rawEnabledIds ?? []).filter(Boolean);

			const resolvedProviderId =
				providerId ||
				(endpointId ? getProxyEndpointProviderId(endpointId) : OPENAI_COMPATIBLE_PROVIDER_ID);

			if (!enabledModelIds?.length) {
				await this.context.services.openCodeClient.syncProxyProviderToProjectConfig(
					workspaceRoot,
					resolvedProviderId,
					baseUrl,
					apiKey,
					[],
					providerName,
					customHeaders,
				);
				const sdkClient = this.context.cli.getSdkClient();
				if (sdkClient) {
					await sdkClient.instance.dispose().catch((err: unknown) => {
						console.warn('[ProviderHandler] instance.dispose() after sync failed:', err);
					});
				}
				return;
			}

			// Build enriched models from the cached proxy models (preserves /v1/models metadata),
			// falling back to models.dev for any missing fields.
			const normalizedBaseUrl = normalizeProxyBaseUrl(baseUrl) || baseUrl;
			const cached = this.context.extensionContext.globalState.get<EnrichedProxyModel[]>(
				this.getProxyModelsCacheKey(normalizedBaseUrl),
			);
			const cachedById = new Map((cached ?? []).map(m => [m.id, m]));

			const enrichedModels: EnrichedProxyModel[] = enabledModelIds.map(id => {
				const fromCache = cachedById.get(id);
				return fromCache ? { ...fromCache } : { id, name: id };
			});

			// Enrich any models still missing metadata via models.dev
			const idsNeedingEnrichment = enrichedModels
				.filter(m => !m.contextLength && !m.capabilities)
				.map(m => m.id);
			if (idsNeedingEnrichment.length > 0) {
				const modelsDevLookup =
					await this.context.services.modelsDev.lookupModels(idsNeedingEnrichment);
				for (const model of enrichedModels) {
					const devInfo = modelsDevLookup.get(model.id);
					if (devInfo) {
						if (!model.contextLength && devInfo.context) model.contextLength = devInfo.context;
						if (!model.maxCompletionTokens && devInfo.output)
							model.maxCompletionTokens = devInfo.output;
						if (!model.capabilities) {
							model.capabilities = {
								reasoning: devInfo.reasoning,
								vision: devInfo.modalities?.input?.includes('image'),
								tools: devInfo.tool_call,
							};
						}
					}
				}
			}

			await this.context.services.openCodeClient.syncProxyProviderToProjectConfig(
				workspaceRoot,
				resolvedProviderId,
				baseUrl,
				apiKey,
				enrichedModels,
				providerName,
				customHeaders,
			);

			// Trigger OpenCode config reload
			const sdkClient = this.context.cli.getSdkClient();
			if (sdkClient) {
				await sdkClient.instance.dispose().catch((err: unknown) => {
					console.warn('[ProviderHandler] instance.dispose() after sync failed:', err);
				});
			}
		} catch (syncErr) {
			console.warn('[ProviderHandler] Failed to sync proxy models to opencode.json:', syncErr);
		}
	}

	private async onRemoveProxyEndpoint(msg: CommandOf<'removeProxyEndpoint'>): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot || !msg.providerId) return;

		try {
			await this.context.services.openCodeClient.removeProviderFromProjectConfig(
				workspaceRoot,
				msg.providerId,
			);
			const sdkClient = this.context.cli.getSdkClient();
			if (sdkClient) {
				await sdkClient.instance.dispose().catch((err: unknown) => {
					console.warn('[ProviderHandler] instance.dispose() after remove failed:', err);
				});
			}
		} catch (error) {
			console.warn('[ProviderHandler] Failed to remove proxy endpoint:', error);
		}
	}

	/**
	 * Enrich proxy models with metadata from models.dev.
	 * For each model missing contextLength, look it up in the centralized database.
	 */
	private async enrichWithModelsDev(
		models: Array<{
			id: string;
			name: string;
			contextLength?: number;
			maxCompletionTokens?: number;
		}>,
	): Promise<EnrichedProxyModel[]> {
		const idsToLookup = models.map(m => m.id);
		const devData = await this.context.services.modelsDev.lookupModels(idsToLookup);

		return models.map(m => {
			const dev = devData.get(m.id);
			const enriched: EnrichedProxyModel = {
				// Always preserve original id and name from the proxy — never
				// replace them with models.dev values, as the proxy may use
				// custom prefixes/suffixes that must be sent back verbatim.
				id: m.id,
				name: m.name,
				contextLength: m.contextLength ?? dev?.context,
				maxCompletionTokens: m.maxCompletionTokens ?? dev?.output,
			};
			if (dev) {
				enriched.capabilities = {
					reasoning: dev.reasoning,
					vision: dev.modalities?.input?.includes('image'),
					tools: dev.tool_call,
				};
			} else {
				// No models.dev data — assume broadest defaults so the UI
				// doesn't hide capabilities that likely exist.
				enriched.capabilities = {
					reasoning: true,
					vision: true,
					tools: true,
				};
			}
			return enriched;
		});
	}
}

/** Safely coerce a value to a positive integer, or undefined. */
function toPositiveInt(val: unknown): number | undefined {
	if (val == null) return undefined;
	const n = typeof val === 'number' ? val : Number(val);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
