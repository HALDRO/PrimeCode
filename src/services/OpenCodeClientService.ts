/**
 * @file OpenCodeClientService
 * @description Service for interacting with OpenCode REST API (providers, auth, etc.)
 * using the typed @opencode-ai/sdk client. Handles data fetching and normalization for the UI.
 */

import type { Model as ModelV2, OpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as vscode from 'vscode';
import { normalizeProxyBaseUrl } from '../common';
import {
	mapQuestionRuntimePayloadToRequest,
	parseSessionPermissionRequest,
	parseSessionQuestionRequest,
	parseSessionTodoItem,
} from '../common/schemas';

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
	limit?: {
		context?: number;
		output?: number;
	};
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

export interface ProjectProxyProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	models: EnrichedProxyModel[];
}

interface OpenCodeProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	variants?: string[];
}

interface OpenCodeProvider {
	id: string;
	name: string;
	isCustom: boolean;
	source?: 'env' | 'api' | 'config' | 'custom';
	models: OpenCodeProviderModel[];
}

interface AvailableProvider {
	id: string;
	name: string;
	env: string[];
	models: OpenCodeProviderModel[];
}

export class OpenCodeClientService {
	private async fetchRuntimeCollection(
		baseUrl: string,
		directory: string,
		path: 'permission' | 'question',
	): Promise<unknown[]> {
		const response = await fetch(`${baseUrl}/${path}`, {
			headers: { 'x-opencode-directory': directory },
		});
		if (!response.ok) return [];
		return (await response.json()) as unknown[];
	}

	private async readProjectConfig(workspaceRoot: string): Promise<OpenCodeJsonConfig> {
		const configPath = vscode.Uri.file(`${workspaceRoot}/opencode.json`);
		try {
			const raw = await vscode.workspace.fs.readFile(configPath);
			return JSON.parse(Buffer.from(raw).toString('utf-8')) as OpenCodeJsonConfig;
		} catch {
			return {};
		}
	}

	async getConnectedProviders(
		client: OpencodeClient,
		workspaceRoot?: string,
	): Promise<OpenCodeProvider[]> {
		const { data } = await client.provider.list();
		if (!data) throw new Error('OpenCode /provider returned no data');

		const connectedSet = new Set(data.connected ?? []);

		// Read project config to identify custom OpenAI-compatible providers.
		// These should appear in CUSTOM ENDPOINTS, not in the standard PROVIDERS section.
		const customProviderIds = new Set<string>();
		if (workspaceRoot) {
			try {
				const config = await this.readProjectConfig(workspaceRoot);
				if (config.provider) {
					for (const [id, provider] of Object.entries(config.provider)) {
						if (provider.npm === '@ai-sdk/openai-compatible') {
							customProviderIds.add(id);
						}
					}
				}
			} catch {
				// Ignore config read errors — fall back to isCustom: false
			}
		}

		// Deduplicate by provider ID — CLI may return duplicate entries
		// when opencode.json and server state overlap
		const seenIds = new Set<string>();
		return data.all
			.filter(p => {
				if (!connectedSet.has(p.id)) return false;
				if (seenIds.has(p.id)) return false;
				seenIds.add(p.id);
				return true;
			})
			.map(p => {
				const rawSource = (p as Record<string, unknown>).source;
				const source: OpenCodeProvider['source'] =
					rawSource === 'env' ||
					rawSource === 'api' ||
					rawSource === 'config' ||
					rawSource === 'custom'
						? rawSource
						: undefined;
				return {
					id: p.id,
					name: p.name || p.id,
					isCustom: customProviderIds.has(p.id),
					source,
					models: Object.values(p.models).map(m => {
						// Cast to full ModelV2 type to access `variants` field.
						const model = m as unknown as ModelV2;
						const variantKeys = model.variants ? Object.keys(model.variants) : undefined;
						return {
							id: m.id,
							name: m.name || m.id,
							reasoning: m.reasoning,
							limit: m.limit ? { context: m.limit.context, output: m.limit.output } : undefined,
							variants: variantKeys && variantKeys.length > 0 ? variantKeys : undefined,
						};
					}),
				};
			})
			.filter(p => p.id.length > 0);
	}

	async getSessionTodos(
		client: OpencodeClient,
		sessionId: string,
		workspaceRoot: string,
	): Promise<import('../common').SessionTodoItem[]> {
		const result = await client.session.todo({ sessionID: sessionId, directory: workspaceRoot });
		return ((result.data as unknown[]) || []).flatMap(value => {
			const todo = parseSessionTodoItem(value);
			return todo ? [todo] : [];
		});
	}

	async getSessionPermissions(
		baseUrl: string,
		directory: string,
		sessionId: string,
	): Promise<import('../common').SessionPermissionRequest[]> {
		const result = await this.fetchRuntimeCollection(baseUrl, directory, 'permission');
		return result.flatMap(value => {
			const request = parseSessionPermissionRequest(value, sessionId);
			return request ? [request] : [];
		});
	}

	async getSessionQuestions(
		baseUrl: string,
		directory: string,
		sessionId: string,
	): Promise<import('../common').SessionQuestionRequest[]> {
		const result = await this.fetchRuntimeCollection(baseUrl, directory, 'question');
		return result.flatMap(value => {
			const request =
				parseSessionQuestionRequest(value, sessionId) ||
				mapQuestionRuntimePayloadToRequest(value, sessionId);
			return request ? [request] : [];
		});
	}

	async getAvailableProviders(client: OpencodeClient): Promise<AvailableProvider[]> {
		const { data } = await client.provider.list();
		if (!data) return [];

		const connectedSet = new Set(data.connected ?? []);

		// Deduplicate by provider ID
		const seenIds = new Set<string>();
		return data.all
			.filter(p => {
				if (connectedSet.has(p.id)) return false;
				if (seenIds.has(p.id)) return false;
				seenIds.add(p.id);
				return true;
			})
			.map(p => ({
				id: p.id,
				name: p.name || p.id,
				env: p.env ?? [],
				models: Object.values(p.models).map(m => {
					const model = m as unknown as ModelV2;
					const variantKeys = model.variants ? Object.keys(model.variants) : undefined;
					return {
						id: m.id,
						name: m.name || m.id,
						reasoning: m.reasoning,
						limit: m.limit ? { context: m.limit.context, output: m.limit.output } : undefined,
						variants: variantKeys && variantKeys.length > 0 ? variantKeys : undefined,
					};
				}),
			}))
			.filter(p => p.id.length > 0);
	}

	async getProjectProxyProvider(
		workspaceRoot: string,
		providerId: string,
	): Promise<ProjectProxyProviderConfig | undefined> {
		const config = await this.readProjectConfig(workspaceRoot);
		const provider = config.provider?.[providerId];
		if (!provider || provider.npm !== '@ai-sdk/openai-compatible') return undefined;

		const rawBaseUrl =
			typeof provider.options?.baseURL === 'string' ? String(provider.options.baseURL) : '';
		const rawApiKey =
			typeof provider.options?.apiKey === 'string' ? String(provider.options.apiKey) : '';
		const models = Object.entries(provider.models ?? {}).map(([id, model]) => ({
			id,
			name: model.name || id,
			contextLength: model.limit?.context,
			maxCompletionTokens: model.limit?.output,
			capabilities: {
				reasoning: model.reasoning,
				vision: model.modalities?.input?.includes('image'),
				tools: model.tool_call,
			},
		}));

		return {
			id: providerId,
			name: provider.name || providerId,
			baseUrl: normalizeProxyBaseUrl(rawBaseUrl),
			apiKey: rawApiKey,
			models,
		};
	}

	/**
	 * Read ALL OpenAI-compatible proxy providers from opencode.json.
	 * Used for reverse-syncing config file providers into the settings UI.
	 */
	async getAllProjectProxyProviders(workspaceRoot: string): Promise<ProjectProxyProviderConfig[]> {
		const config = await this.readProjectConfig(workspaceRoot);
		if (!config.provider) return [];

		const results: ProjectProxyProviderConfig[] = [];
		for (const [providerId, provider] of Object.entries(config.provider)) {
			if (provider.npm !== '@ai-sdk/openai-compatible') continue;

			const rawBaseUrl =
				typeof provider.options?.baseURL === 'string' ? String(provider.options.baseURL) : '';
			const rawApiKey =
				typeof provider.options?.apiKey === 'string' ? String(provider.options.apiKey) : '';
			const models = Object.entries(provider.models ?? {}).map(([id, model]) => ({
				id,
				name: model.name || id,
				contextLength: model.limit?.context,
				maxCompletionTokens: model.limit?.output,
				capabilities: {
					reasoning: model.reasoning,
					vision: model.modalities?.input?.includes('image'),
					tools: model.tool_call,
				},
			}));

			results.push({
				id: providerId,
				name: provider.name || providerId,
				baseUrl: normalizeProxyBaseUrl(rawBaseUrl),
				apiKey: rawApiKey,
				models,
			});
		}

		return results;
	}

	async setProviderAuth(client: OpencodeClient, providerId: string, apiKey: string): Promise<void> {
		const { error } = await client.auth.set({
			providerID: providerId,
			auth: { type: 'api', key: apiKey },
		});
		if (error) {
			throw new Error(`OpenCode auth set failed: ${JSON.stringify(error)}`);
		}
	}

	async disconnectProvider(client: OpencodeClient, providerId: string): Promise<void> {
		const { error } = await client.auth.remove({ providerID: providerId });
		if (error) {
			throw new Error(`OpenCode auth delete failed: ${JSON.stringify(error)}`);
		}
	}

	async syncProxyProviderToProjectConfig(
		workspaceRoot: string,
		providerId: string,
		baseUrl: string,
		apiKey: string,
		enabledModels: EnrichedProxyModel[],
		providerName?: string,
		customHeaders?: Record<string, string>,
	): Promise<void> {
		const configPath = vscode.Uri.file(`${workspaceRoot}/opencode.json`);
		const existing = await this.readProjectConfig(workspaceRoot);

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
			name: providerName || 'OpenAI Compatible',
			npm: '@ai-sdk/openai-compatible',
			options: {
				baseURL: normalizedBaseUrl,
				apiKey,
				...(customHeaders && Object.keys(customHeaders).length > 0
					? { headers: customHeaders }
					: {}),
			},
			models: modelsRecord,
		};

		existing.provider = providerSection;

		const content = Buffer.from(this.compactJsonStringify(existing), 'utf-8');
		await vscode.workspace.fs.writeFile(configPath, content);
	}

	/**
	 * JSON.stringify with indent 2, but short string arrays (e.g. modalities)
	 * are kept on a single line for readability.
	 */
	private compactJsonStringify(obj: unknown): string {
		const raw = JSON.stringify(obj, null, 2);
		// Collapse arrays that contain only short strings onto one line.
		// Matches: [\n  "text",\n  "image"\n] → ["text", "image"]
		return raw.replace(/\[(?:\s*"[^"]+"\s*,?)+\s*\]/g, match => {
			const items = Array.from(match.matchAll(/"([^"]+)"/g)).map(m => `"${m[1]}"`);
			return `[${items.join(', ')}]`;
		});
	}

	async removeProviderFromProjectConfig(workspaceRoot: string, providerId: string): Promise<void> {
		const configPath = vscode.Uri.file(`${workspaceRoot}/opencode.json`);
		const existing = await this.readProjectConfig(workspaceRoot);
		if (!existing.provider?.[providerId]) return;
		delete existing.provider[providerId];
		const content = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8');
		await vscode.workspace.fs.writeFile(configPath, content);
	}
}
