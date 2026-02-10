import type { OpenCodeProviderData } from '../../common';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class ProviderHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

	private static readonly LEGACY_SELECTED_MODEL_KEY = 'primecode.selectedModel';

	private getSelectedModelKey(provider: 'claude' | 'opencode'): string {
		return provider === 'opencode'
			? 'primecode.selectedModel.opencode'
			: 'primecode.selectedModel.claude';
	}

	private async readSelectedModel(provider: 'claude' | 'opencode'): Promise<string | undefined> {
		const key = this.getSelectedModelKey(provider);
		const fromNew = this.context.extensionContext.globalState.get<string>(key);
		if (fromNew) return fromNew;

		// Backward-compat: attempt to migrate from the legacy key.
		const legacy = this.context.extensionContext.globalState.get<string>(
			ProviderHandler.LEGACY_SELECTED_MODEL_KEY,
		);
		if (!legacy) return undefined;

		// Guard against cross-provider contamination.
		// OpenCode models are composite IDs: "provider/model".
		if (provider === 'opencode' && !legacy.includes('/')) return undefined;
		// Claude models are simple IDs without '/'.
		if (provider === 'claude' && legacy.includes('/')) return undefined;

		await this.context.extensionContext.globalState.update(key, legacy);
		return legacy;
	}

	async handleMessage(msg: WebviewMessage): Promise<void> {
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
		const provider = (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		const savedModel = await this.readSelectedModel(provider);
		if (!savedModel) return;

		if (provider === 'opencode') {
			this.context.view.postMessage({ type: 'openCodeModelSet', data: { model: savedModel } });
		} else {
			this.context.view.postMessage({ type: 'modelSelected', model: savedModel });
		}
	}

	private async onCheckOpenCodeStatus(): Promise<void> {
		const provider = (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode';
		if (provider !== 'opencode') {
			this.context.view.postMessage({
				type: 'openCodeStatus',
				data: { installed: false, version: null },
			});
			return;
		}

		const info = this.context.cli.getOpenCodeServerInfo();
		if (!info) {
			this.context.view.postMessage({
				type: 'openCodeStatus',
				data: { installed: false, version: null, error: 'OpenCode server not running' },
			});
			return;
		}

		// Version detection is intentionally omitted (depends on CLI/server implementation).
		this.context.view.postMessage({
			type: 'openCodeStatus',
			data: { installed: true, version: null },
		});
	}

	private async onLoadOpenCodeProviders(): Promise<void> {
		try {
			const provider = (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode';
			if (provider !== 'opencode') {
				this.context.view.postMessage({
					type: 'openCodeProviders',
					data: { providers: [], config: { isLoading: false } },
				});
				return;
			}

			const info = this.context.cli.getOpenCodeServerInfo();
			if (!info) {
				this.context.view.postMessage({
					type: 'openCodeProviders',
					data: {
						providers: [],
						config: { isLoading: false, error: 'OpenCode server not running' },
					},
				});
				return;
			}

			const providers = (await this.context.services.openCodeClient.getConnectedProviders(
				info.baseUrl,
				info.directory,
			)) as OpenCodeProviderData[];

			this.context.view.postMessage({
				type: 'openCodeProviders',
				data: { providers, config: { isLoading: false } },
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.context.view.postMessage({
				type: 'openCodeProviders',
				data: { providers: [], config: { isLoading: false, error: msg } },
			});
		}
	}

	private async onLoadAvailableProviders(): Promise<void> {
		try {
			const provider = (this.context.settings.get('provider') || 'claude') as 'claude' | 'opencode';
			if (provider !== 'opencode') {
				this.context.view.postMessage({ type: 'availableProviders', data: { providers: [] } });
				return;
			}

			const info = this.context.cli.getOpenCodeServerInfo();
			if (!info) {
				this.context.view.postMessage({ type: 'availableProviders', data: { providers: [] } });
				return;
			}

			const providers = await this.context.services.openCodeClient.getAvailableProviders(
				info.baseUrl,
				info.directory,
			);

			this.context.view.postMessage({ type: 'availableProviders', data: { providers } });
		} catch {
			this.context.view.postMessage({ type: 'availableProviders', data: { providers: [] } });
		}
	}

	private async onSetOpenCodeProviderAuth(msg: WebviewMessage): Promise<void> {
		const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
		const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey : '';
		if (!providerId || !apiKey) {
			this.context.view.postMessage({
				type: 'openCodeAuthResult',
				data: { success: false, error: 'Missing providerId or apiKey', providerId },
			});
			return;
		}

		this.context.view.postMessage({
			type: 'openCodeAuthResult',
			data: { success: false, providerId, isLoading: true },
		});

		try {
			const info = this.context.cli.getOpenCodeServerInfo();
			if (!info) {
				this.context.view.postMessage({
					type: 'openCodeAuthResult',
					data: { success: false, error: 'OpenCode server not running', providerId },
				});
				return;
			}

			await this.context.services.openCodeClient.setProviderAuth(
				info.baseUrl,
				info.directory,
				providerId,
				apiKey,
			);

			this.context.view.postMessage({
				type: 'openCodeAuthResult',
				data: { success: true, providerId },
			});
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.context.view.postMessage({
				type: 'openCodeAuthResult',
				data: { success: false, error: err, providerId },
			});
		}
	}

	private async onDisconnectOpenCodeProvider(msg: WebviewMessage): Promise<void> {
		const providerId = typeof msg.providerId === 'string' ? msg.providerId : '';
		if (!providerId) {
			this.context.view.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: false, error: 'Missing providerId', providerId },
			});
			return;
		}

		try {
			const info = this.context.cli.getOpenCodeServerInfo();
			if (!info) {
				this.context.view.postMessage({
					type: 'openCodeDisconnectResult',
					data: { success: false, error: 'OpenCode server not running', providerId },
				});
				return;
			}

			await this.context.services.openCodeClient.disconnectProvider(
				info.baseUrl,
				info.directory,
				providerId,
			);

			this.context.view.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: true, providerId },
			});

			// Let UI prune models for this provider.
			this.context.view.postMessage({ type: 'removeOpenCodeProvider', data: { providerId } });
			await this.onReloadAllProviders();
		} catch (error) {
			const err = error instanceof Error ? error.message : String(error);
			this.context.view.postMessage({
				type: 'openCodeDisconnectResult',
				data: { success: false, error: err, providerId },
			});
		}
	}

	private async onSetOpenCodeModel(msg: WebviewMessage): Promise<void> {
		const model = typeof msg.model === 'string' ? msg.model : undefined;
		if (model) {
			await this.context.extensionContext.globalState.update(
				this.getSelectedModelKey('opencode'),
				model,
			);
			this.context.view.postMessage({ type: 'openCodeModelSet', data: { model } });
		}
	}

	private async onSelectModel(msg: WebviewMessage): Promise<void> {
		const model = typeof msg.model === 'string' ? msg.model : undefined;
		if (model) {
			await this.context.extensionContext.globalState.update(
				this.getSelectedModelKey('claude'),
				model,
			);
			this.context.view.postMessage({ type: 'modelSelected', model });
		}
	}

	private async onLoadProxyModels(msg: WebviewMessage): Promise<void> {
		const data = (msg.data ?? {}) as { baseUrl?: unknown; apiKey?: unknown };

		let baseUrlRaw = typeof data.baseUrl === 'string' ? data.baseUrl : '';
		if (!baseUrlRaw.trim()) {
			const setting = this.context.settings.get('proxy.baseUrl');
			if (typeof setting === 'string') baseUrlRaw = setting;
		}

		let apiKeyRaw = typeof data.apiKey === 'string' ? data.apiKey : '';
		if (!apiKeyRaw.trim()) {
			const setting = this.context.settings.get('proxy.apiKey');
			if (typeof setting === 'string') apiKeyRaw = setting;
		}

		const baseUrl = baseUrlRaw.trim().replace(/\/+$/g, '');
		const apiKey = apiKeyRaw.trim();

		if (!baseUrl) {
			this.context.view.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], error: 'Missing proxy baseUrl' },
			});
			return;
		}

		// Live fetch (no caching)

		let url: URL;
		try {
			url = new URL(`${baseUrl}/v1/models`);
		} catch {
			this.context.view.postMessage({
				type: 'proxyModels',
				data: {
					enabled: false,
					models: [],
					baseUrl,
					error: 'Invalid proxy baseUrl',
				},
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
				this.context.view.postMessage({
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

			if (models.length === 0) {
				this.context.view.postMessage({
					type: 'proxyModels',
					data: {
						enabled: false,
						models: [],
						baseUrl,
						error: 'No models returned by proxy',
					},
				});
				return;
			}

			this.context.view.postMessage({
				type: 'proxyModels',
				data: {
					enabled: true,
					models,
					baseUrl,
				},
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.context.view.postMessage({
				type: 'proxyModels',
				data: {
					enabled: false,
					models: [],
					baseUrl,
					error: `Proxy models fetch failed: ${msg}`,
				},
			});
		}
	}
}
