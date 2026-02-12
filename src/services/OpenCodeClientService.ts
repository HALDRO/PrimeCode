/**
 * @file OpenCodeClientService
 * @description Service for interacting with OpenCode REST API (providers, auth, etc.)
 * using the typed @opencode-ai/sdk client. Handles data fetching and normalization for the UI.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';

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
	async getConnectedProviders(client: OpencodeClient): Promise<OpenCodeProvider[]> {
		const { data } = await client.provider.list();
		if (!data) throw new Error('OpenCode /provider returned no data');

		const connectedSet = new Set(data.connected ?? []);

		return data.all
			.filter(p => connectedSet.has(p.id))
			.map(p => ({
				id: p.id,
				name: p.name || p.id,
				isCustom: false,
				models: Object.values(p.models).map(m => ({
					id: m.id,
					name: m.name || m.id,
					reasoning: m.reasoning,
					limit: m.limit ? { context: m.limit.context, output: m.limit.output } : undefined,
				})),
			}))
			.filter(p => p.id.length > 0);
	}

	async getAvailableProviders(client: OpencodeClient): Promise<AvailableProvider[]> {
		const { data } = await client.provider.list();
		if (!data) return [];

		const connectedSet = new Set(data.connected ?? []);

		return data.all
			.filter(p => !connectedSet.has(p.id))
			.map(p => ({
				id: p.id,
				name: p.name || p.id,
				env: p.env ?? [],
			}))
			.filter(p => p.id.length > 0);
	}

	async setProviderAuth(client: OpencodeClient, providerId: string, apiKey: string): Promise<void> {
		const { error } = await client.auth.set({
			path: { id: providerId },
			body: { type: 'api', key: apiKey },
		});
		if (error) {
			throw new Error(`OpenCode auth set failed: ${JSON.stringify(error)}`);
		}
	}

	async disconnectProvider(baseUrl: string, directory: string, providerId: string): Promise<void> {
		// SDK has no DELETE /auth/{id} method — use direct fetch
		const url = `${baseUrl}/auth/${encodeURIComponent(providerId)}?directory=${encodeURIComponent(directory)}`;
		const resp = await fetch(url, {
			method: 'DELETE',
			headers: { 'x-opencode-directory': directory },
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`OpenCode auth delete failed: ${resp.status} ${resp.statusText}: ${text}`);
		}
	}
}
