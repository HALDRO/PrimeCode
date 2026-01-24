import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class ProviderHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

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
		await Promise.all([this.onLoadAvailableProviders(), this.onLoadOpenCodeProviders()]);
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

		// Best-effort: we do not probe the environment deeply here.
		this.context.view.postMessage({
			type: 'openCodeStatus',
			data: { installed: true, version: null },
		});
	}

	private async onLoadOpenCodeProviders(): Promise<void> {
		this.context.view.postMessage({
			type: 'openCodeProviders',
			data: { providers: [], config: { isLoading: true } },
		});

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

			const providers = await this.context.services.openCodeClient.getConnectedProviders(
				info.baseUrl,
				info.directory,
			);

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
			// Model is stored per-session in chatStore, not in workspace settings
			this.context.view.postMessage({ type: 'openCodeModelSet', data: { model } });
		}
	}

	private async onSelectModel(msg: WebviewMessage): Promise<void> {
		const model = typeof msg.model === 'string' ? msg.model : undefined;
		if (model) {
			// Model is stored per-session in chatStore, not in workspace settings
			this.context.view.postMessage({ type: 'modelSelected', model });
		}
	}

	private async onLoadProxyModels(msg: WebviewMessage): Promise<void> {
		const data = (msg.data ?? {}) as { baseUrl?: unknown; apiKey?: unknown };
		const baseUrlRaw =
			typeof data.baseUrl === 'string'
				? data.baseUrl
				: typeof this.context.settings.get('proxy.baseUrl') === 'string'
					? (this.context.settings.get('proxy.baseUrl') as string)
					: '';
		const apiKeyRaw =
			typeof data.apiKey === 'string'
				? data.apiKey
				: typeof this.context.settings.get('proxy.apiKey') === 'string'
					? (this.context.settings.get('proxy.apiKey') as string)
					: '';

		const baseUrl = baseUrlRaw.trim().replace(/\/+$/g, '');
		const apiKey = apiKeyRaw.trim();

		if (!baseUrl) {
			this.context.view.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], error: 'Missing proxy baseUrl' },
			});
			return;
		}

		let url: URL;
		try {
			url = new URL(`${baseUrl}/v1/models`);
		} catch {
			this.context.view.postMessage({
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

			this.context.view.postMessage({
				type: 'proxyModels',
				data: {
					enabled: models.length > 0,
					models,
					baseUrl,
				},
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.context.view.postMessage({
				type: 'proxyModels',
				data: { enabled: false, models: [], baseUrl, error: `Proxy models fetch failed: ${msg}` },
			});
		}
	}
}
