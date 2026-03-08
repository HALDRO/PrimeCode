/**
 * @file OpenCodeClientService
 * @description Service for interacting with OpenCode REST API (providers, auth, etc.)
 * using the typed @opencode-ai/sdk client. Handles data fetching and normalization for the UI.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import * as vscode from 'vscode';
import { normalizeProxyBaseUrl } from '../common';

interface OpenCodeModelConfig {
	name: string;
	modalities?: {
		input: string[];
		output: string[];
	};
	reasoning?: boolean;
	temperature?: boolean;
	attachment?: boolean;
	tool_call?: boolean;
}

interface OpenCodeJsonConfig {
	$schema?: string;
	provider?: Record<
		string,
		{
			name?: string;
			npm?: string;
			options?: Record<string, unknown>;
			models?: Record<string, OpenCodeModelConfig>;
		}
	>;
	[key: string]: unknown;
}

/**
 * Default capabilities for proxy models.
 * Proxy /v1/models doesn't return capabilities, so we assume the broadest
 * reasonable defaults. If a model doesn't actually support something,
 * the LLM itself will return an error — better than silently stripping
 * content on our side.
 */
const DEFAULT_PROXY_MODEL_CAPABILITIES: Omit<OpenCodeModelConfig, 'name'> = {
	modalities: {
		input: ['text', 'image'],
		output: ['text'],
	},
	reasoning: true,
	temperature: true,
	attachment: true,
	tool_call: true,
};

/** Enriched proxy model with metadata from /v1/models response and/or models.dev */
export interface EnrichedProxyModel {
	id: string;
	name: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
}

interface OpenCodeProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
}

interface OpenCodeProvider {
	id: string;
	name: string;
	isCustom: boolean;
	models: OpenCodeProviderModel[];
}

interface AvailableProvider {
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

	/**
	 * Write ONLY the enabled proxy models into the project-level opencode.json
	 * so the OpenCode server picks them up on next config reload.
	 * Merges non-destructively with existing content.
	 *
	 * @param enabledModels - Only models the user explicitly enabled in the UI.
	 *   Enriched with metadata from /v1/models response and models.dev lookup.
	 */
	async syncProxyProviderToProjectConfig(
		workspaceRoot: string,
		providerId: string,
		baseUrl: string,
		apiKey: string,
		enabledModels: EnrichedProxyModel[],
	): Promise<void> {
		const configPath = vscode.Uri.file(`${workspaceRoot}/opencode.json`);

		let existing: OpenCodeJsonConfig = {};
		try {
			const raw = await vscode.workspace.fs.readFile(configPath);
			existing = JSON.parse(Buffer.from(raw).toString('utf-8')) as OpenCodeJsonConfig;
		} catch {
			// file doesn't exist yet — start fresh
		}

		const modelsRecord: Record<string, OpenCodeModelConfig> = {};
		for (const m of enabledModels) {
			const config: OpenCodeModelConfig = {
				name: m.name,
				...DEFAULT_PROXY_MODEL_CAPABILITIES,
			};
			// Override with real metadata when available
			if (m.contextLength || m.maxCompletionTokens) {
				(config as OpenCodeModelConfig & { limit: Record<string, number> }).limit = {
					...(m.contextLength ? { context: m.contextLength } : {}),
					...(m.maxCompletionTokens ? { output: m.maxCompletionTokens } : {}),
				};
			}
			if (m.capabilities?.reasoning !== undefined) {
				config.reasoning = m.capabilities.reasoning;
			}
			if (m.capabilities?.vision !== undefined) {
				config.modalities = {
					input: m.capabilities.vision ? ['text', 'image'] : ['text'],
					output: ['text'],
				};
			}
			if (m.capabilities?.tools !== undefined) {
				config.tool_call = m.capabilities.tools;
			}
			modelsRecord[m.id] = config;
		}

		const normalizedBaseUrl = normalizeProxyBaseUrl(baseUrl);

		const providerSection = existing.provider ?? {};
		providerSection[providerId] = {
			...providerSection[providerId],
			name: 'OpenAI Compatible',
			npm: '@ai-sdk/openai-compatible',
			options: { baseURL: normalizedBaseUrl, apiKey },
			models: modelsRecord,
		};

		existing.provider = providerSection;

		const content = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8');
		await vscode.workspace.fs.writeFile(configPath, content);
	}
}
