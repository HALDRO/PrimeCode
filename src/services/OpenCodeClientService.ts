/**
 * @file OpenCodeClientService
 * @description Service for interacting with OpenCode REST API (providers, auth, etc.).
 * Handles data fetching and normalization for the UI.
 */

export interface OpenCodeProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
}

export interface OpenCodeProvider {
	id: string;
	name: string;
	isCustom: boolean;
	models: OpenCodeProviderModel[];
}

export interface AvailableProvider {
	id: string;
	name: string;
	env: string[];
}

export class OpenCodeClientService {
	private buildHeaders(directory: string): Record<string, string> {
		return { 'x-opencode-directory': directory };
	}

	async getConnectedProviders(baseUrl: string, directory: string): Promise<OpenCodeProvider[]> {
		const resp = await fetch(`${baseUrl}/provider?directory=${encodeURIComponent(directory)}`, {
			method: 'GET',
			headers: { ...this.buildHeaders(directory) },
		});

		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`OpenCode /provider failed: ${resp.status} ${resp.statusText}: ${text}`);
		}

		const json = (await resp.json()) as unknown;
		const all =
			json &&
			typeof json === 'object' &&
			'all' in json &&
			Array.isArray((json as { all?: unknown }).all)
				? ((json as { all: unknown[] }).all as unknown[])
				: [];
		const connectedRaw =
			json &&
			typeof json === 'object' &&
			'connected' in json &&
			Array.isArray((json as { connected?: unknown }).connected)
				? ((json as { connected: unknown[] }).connected as unknown[])
				: [];

		const connectedIds = this.normalizeConnectedProviderIds(connectedRaw);
		const connectedSet = new Set(connectedIds);

		return all
			.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
			.filter(p => connectedSet.has(String(p.id ?? '')))
			.map(p => {
				const id = String(p.id ?? '');
				const name = String(p.name ?? id);
				const modelsRaw = p.models;
				const modelsObj =
					modelsRaw && typeof modelsRaw === 'object' ? (modelsRaw as Record<string, unknown>) : {};
				const models = Object.values(modelsObj)
					.filter((m): m is Record<string, unknown> => m != null && typeof m === 'object')
					.map(m => ({
						id: String(m.id ?? ''),
						name: String(m.name ?? m.id ?? ''),
						reasoning: Boolean(m.reasoning),
						limit:
							m.limit && typeof m.limit === 'object'
								? {
										context:
											typeof (m.limit as { context?: unknown }).context === 'number'
												? ((m.limit as { context?: number }).context as number)
												: undefined,
										output:
											typeof (m.limit as { output?: unknown }).output === 'number'
												? ((m.limit as { output?: number }).output as number)
												: undefined,
									}
								: undefined,
					}));

				return { id, name, isCustom: p.source === 'custom', models };
			})
			.filter(p => p.id.length > 0);
	}

	async getAvailableProviders(baseUrl: string, directory: string): Promise<AvailableProvider[]> {
		const resp = await fetch(`${baseUrl}/provider?directory=${encodeURIComponent(directory)}`, {
			method: 'GET',
			headers: { ...this.buildHeaders(directory) },
		});
		if (!resp.ok) {
			return [];
		}

		const json = (await resp.json()) as unknown;
		const all =
			json &&
			typeof json === 'object' &&
			'all' in json &&
			Array.isArray((json as { all?: unknown }).all)
				? ((json as { all: unknown[] }).all as unknown[])
				: [];
		const connectedRaw =
			json &&
			typeof json === 'object' &&
			'connected' in json &&
			Array.isArray((json as { connected?: unknown }).connected)
				? ((json as { connected: unknown[] }).connected as unknown[])
				: [];

		const connectedIds = this.normalizeConnectedProviderIds(connectedRaw);
		const connectedSet = new Set(connectedIds);

		return all
			.filter((p): p is Record<string, unknown> => p != null && typeof p === 'object')
			.filter(p => !connectedSet.has(String(p.id ?? '')))
			.map(p => ({
				id: String(p.id ?? ''),
				name: String(p.name ?? p.id ?? ''),
				env: Array.isArray(p.env) ? p.env.map(x => String(x)) : [],
			}))
			.filter(p => p.id.length > 0);
	}

	async setProviderAuth(
		baseUrl: string,
		directory: string,
		providerId: string,
		apiKey: string,
	): Promise<void> {
		const resp = await fetch(
			`${baseUrl}/auth/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(directory)}`,
			{
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					...this.buildHeaders(directory),
				},
				body: JSON.stringify({ type: 'api', key: apiKey }),
			},
		);

		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`OpenCode auth set failed: ${resp.status} ${resp.statusText}: ${text}`);
		}
	}

	async disconnectProvider(baseUrl: string, directory: string, providerId: string): Promise<void> {
		const resp = await fetch(
			`${baseUrl}/auth/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(directory)}`,
			{
				method: 'DELETE',
				headers: { ...this.buildHeaders(directory) },
			},
		);

		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`OpenCode auth delete failed: ${resp.status} ${resp.statusText}: ${text}`);
		}
	}

	/**
	 * Normalize OpenCode provider connection response to extract provider IDs.
	 * Handles multiple response formats from OpenCode server.
	 */
	private normalizeConnectedProviderIds(connectedRaw: unknown[]): string[] {
		return connectedRaw
			.map(item => {
				if (typeof item === 'string') return item;
				if (!item || typeof item !== 'object') return '';
				if ('id' in item && typeof (item as { id?: unknown }).id === 'string') {
					return (item as { id: string }).id;
				}
				if (
					'provider' in item &&
					(item as { provider?: unknown }).provider &&
					typeof (item as { provider: { id?: unknown } }).provider === 'object' &&
					typeof (item as { provider: { id?: unknown } }).provider.id === 'string'
				) {
					return (item as { provider: { id: string } }).provider.id;
				}
				return '';
			})
			.filter(Boolean);
	}
}
