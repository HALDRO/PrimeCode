import * as vscode from 'vscode';
import { normalizeProxyBaseUrl, type OpenCodeProviderData } from '../../common';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '../../common/constants';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class ProviderHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

	private static readonly LEGACY_SELECTED_MODEL_KEY = 'primecode.selectedModel';

	private getSelectedModelKey(): string {
		return 'primecode.selectedModel.opencode';
	}

	private async readSelectedModel(): Promise<string | undefined> {
		const key = this.getSelectedModelKey();
		const fromNew = this.context.extensionContext.globalState.get<string>(key);
		if (fromNew) return fromNew;

		// Backward-compat: attempt to migrate from the legacy key.
		const legacy = this.context.extensionContext.globalState.get<string>(
			ProviderHandler.LEGACY_SELECTED_MODEL_KEY,
		);
		if (!legacy) return undefined;

		// OpenCode models are composite IDs: "provider/model".
		if (!legacy.includes('/')) return undefined;

		await this.context.extensionContext.globalState.update(key, legacy);
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
		}
	}

	private async onReloadAllProviders(): Promise<void> {
		await Promise.all([
			this.onCheckOpenCodeStatus(),
			this.onLoadAvailableProviders(),
			this.onLoadOpenCodeProviders(),
			this.restoreSelectedModel(),
		]);
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
			const info = this.context.cli.getOpenCodeServerInfo();
			if (!info) {
				this.context.bridge.data('openCodeDisconnectResult', {
					success: false,
					error: 'OpenCode server not running',
					providerId,
				});
				return;
			}

			await this.context.services.openCodeClient.disconnectProvider(
				info.baseUrl,
				info.directory,
				providerId,
			);
			// Note: disconnectProvider still uses fetch (no SDK method for DELETE /auth/{id})

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
			await this.context.extensionContext.globalState.update(this.getSelectedModelKey(), model);
			this.context.bridge.data('openCodeModelSet', { model });
		}
	}

	private async onSelectModel(msg: CommandOf<'selectModel'>): Promise<void> {
		const { model } = msg;
		if (model) {
			await this.context.extensionContext.globalState.update(this.getSelectedModelKey(), model);
			this.context.bridge.send({ type: 'modelSelected', model });
		}
	}

	private async onLoadProxyModels(msg: CommandOf<'loadProxyModels'>): Promise<void> {
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
			});
			return;
		}

		// Live fetch (no caching)

		let url: URL;
		try {
			url = new URL(`${baseUrl}/models`);
		} catch {
			this.context.bridge.data('proxyModels', {
				enabled: false,
				models: [],
				baseUrl,
				error: 'Invalid proxy baseUrl',
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
				this.context.bridge.data('proxyModels', {
					enabled: false,
					models: [],
					baseUrl,
					error: `Proxy models request failed (${response.status})${detail}`,
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

			if (models.length === 0) {
				this.context.bridge.data('proxyModels', {
					enabled: false,
					models: [],
					baseUrl,
					error: 'No models returned by proxy',
				});
				return;
			}

			this.context.bridge.data('proxyModels', {
				enabled: true,
				models,
				baseUrl,
			});

			// Sync oai provider config to project-level opencode.json
			// so the OpenCode server picks up the proxy models.
			try {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceRoot) {
					await this.context.services.openCodeClient.syncProxyProviderToProjectConfig(
						workspaceRoot,
						OPENAI_COMPATIBLE_PROVIDER_ID,
						baseUrl,
						apiKey,
						models,
					);

					// OpenCode caches config as a lazy singleton — it won't re-read
					// opencode.json until the instance is disposed. Trigger dispose so
					// the next request bootstraps fresh state with updated providers.
					const sdkClient = this.context.cli.getSdkClient();
					if (sdkClient) {
						await sdkClient.instance.dispose().catch((err: unknown) => {
							console.warn('[ProviderHandler] instance.dispose() after config sync failed:', err);
						});
					}
				}
			} catch (syncErr) {
				// Non-fatal — proxy models are loaded in UI, config sync is best-effort
				console.warn('[ProviderHandler] Failed to sync proxy provider to opencode.json:', syncErr);
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.context.bridge.data('proxyModels', {
				enabled: false,
				models: [],
				baseUrl,
				error: `Proxy models fetch failed: ${msg}`,
			});
		}
	}
}
