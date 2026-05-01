import * as vscode from 'vscode';
import {
	buildCustomEndpointAuthHeaders,
	getCustomEndpointDefaultName,
	getCustomEndpointModelsUrl,
	getCustomEndpointNpm,
	getProxyEndpointProtocol,
	getProxyEndpointProviderId,
	normalizeCustomEndpointBaseUrl,
	type OpenCodeProviderData,
	parseModelId,
} from '../../common';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import type { EnrichedProxyModel } from '../../services/OpenCodeClientService';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class ProviderHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

	private static readonly PROXY_MODELS_CACHE_KEY = 'primecode.proxyModels.cache';

	/** Monotonic counter to discard results from stale concurrent reloads. */
	private _reloadGeneration = 0;

	private getProxyModelsCacheKey(baseUrl: string): string {
		return `${ProviderHandler.PROXY_MODELS_CACHE_KEY}:${baseUrl}`;
	}

	private async readProjectConfiguredModel(): Promise<string | undefined> {
		const workspaceRoot = this.context.settings.getWorkspaceRoot();
		if (!workspaceRoot) return undefined;
		try {
			const config =
				await this.context.services.openCodeClient.getProjectModelDefaults(workspaceRoot);
			return config.model && parseModelId(config.model) ? config.model : undefined;
		} catch {
			return undefined;
		}
	}

	private async readSelectedModel(): Promise<string | undefined> {
		return this.readProjectConfiguredModel();
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
		this.context.bridge.data('openCodeModelSet', { model: savedModel ?? null });
	}

	private async onCheckOpenCodeStatus(): Promise<void> {
		const info = this.context.cli.getAdminInfo();
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

			const workspaceRoot = this.context.settings.getWorkspaceRoot();
			void workspaceRoot;
			const providers = (await this.context.services.openCodeClient.getUiConnectedProviders(
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
			await this.context.reloadOpenCodeRuntime?.('provider:auth');

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
		if (model && parseModelId(model)) {
			const workspaceRoot = this.context.settings.getWorkspaceRoot();
			if (!workspaceRoot) return;
			const result = await this.context.services.openCodeClient.setProjectDefaultModel(
				workspaceRoot,
				model,
			);
			this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
			this.context.bridge.data('openCodeModelSet', { model });
		}
	}

	private async onSelectModel(msg: CommandOf<'selectModel'>): Promise<void> {
		const { model } = msg;
		if (model && parseModelId(model)) {
			const workspaceRoot = this.context.settings.getWorkspaceRoot();
			if (!workspaceRoot) return;
			const result = await this.context.services.openCodeClient.setProjectDefaultModel(
				workspaceRoot,
				model,
			);
			this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
			this.context.bridge.send({ type: 'modelSelected', model });
		}
	}

	private async onLoadProxyModels(msg: CommandOf<'loadProxyModels'>): Promise<void> {
		const endpointId = msg.endpointId;
		const customHeaders = msg.headers;
		const protocol = getProxyEndpointProtocol(msg.protocol);

		const baseUrlRaw = msg.baseUrl;
		const apiKeyRaw = msg.apiKey;

		const baseUrl = normalizeCustomEndpointBaseUrl(protocol, baseUrlRaw);
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
			url = new URL(getCustomEndpointModelsUrl(protocol, baseUrl));
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
					...buildCustomEndpointAuthHeaders(protocol, apiKey),
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
					const displayName = typeof item.display_name === 'string' ? item.display_name : undefined;
					return {
						id,
						name: displayName || id,
						contextLength: toPositiveInt(
							item.context_length ??
								item.context_window ??
								item.max_context_length ??
								item.max_model_len,
						),
						maxCompletionTokens: toPositiveInt(
							item.max_completion_tokens ?? item.max_output_tokens ?? item.max_tokens,
						),
						variants:
							item.variants && typeof item.variants === 'object' && !Array.isArray(item.variants)
								? Object.keys(item.variants as Record<string, unknown>)
								: undefined,
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
			protocol: rawProtocol,
		} = msg;
		if (!baseUrl?.trim()) return;

		const protocol = getProxyEndpointProtocol(rawProtocol);

		const npm = getCustomEndpointNpm(protocol);
		const defaultName = getCustomEndpointDefaultName(protocol);

		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) return;
			// Use the exact list from the UI message — never read from settings,
			// which may contain stale/merged data from OpenCode CLI global config.
			const enabledModelIds = (rawEnabledIds ?? []).filter(Boolean);

			const resolvedProviderId =
				providerId || (endpointId ? getProxyEndpointProviderId(endpointId) : '');

			if (!enabledModelIds?.length) {
				const result = await this.context.services.openCodeClient.upsertCustomProvider(
					workspaceRoot,
					{
						providerId: resolvedProviderId,
						name: providerName || defaultName,
						npm,
						baseUrl,
						apiKey,
						headers: customHeaders,
						models: [],
					},
				);
				this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
				return;
			}

			// Build enriched models from the cached proxy models (preserves /v1/models metadata),
			// falling back to models.dev for any missing fields.
			const normalizedBaseUrl = normalizeCustomEndpointBaseUrl(protocol, baseUrl) || baseUrl;
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
						if (!model.variants && devInfo.variants && devInfo.variants.length > 0) {
							model.variants = [...devInfo.variants];
						}
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

			const result = await this.context.services.openCodeClient.upsertCustomProvider(
				workspaceRoot,
				{
					providerId: resolvedProviderId,
					name: providerName || defaultName,
					npm,
					baseUrl,
					apiKey,
					headers: customHeaders,
					models: enrichedModels,
				},
			);
			this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
		} catch (syncErr) {
			console.warn('[ProviderHandler] Failed to sync proxy models to opencode.json:', syncErr);
		}
	}

	private async onRemoveProxyEndpoint(msg: CommandOf<'removeProxyEndpoint'>): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot || !msg.providerId) return;

		try {
			const result = await this.context.services.openCodeClient.deleteCustomProvider(
				workspaceRoot,
				{
					providerId: msg.providerId,
					baseUrl: msg.baseUrl,
				},
			);
			if (result.contentHash) {
				this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
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
			variants?: string[];
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
				variants: m.variants ?? dev?.variants,
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
