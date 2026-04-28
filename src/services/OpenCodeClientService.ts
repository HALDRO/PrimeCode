/**
 * @file OpenCodeClientService
 * @description Service for interacting with OpenCode REST API (providers, auth, etc.)
 * using the typed @opencode-ai/sdk client. Handles data fetching and normalization for the UI.
 */

import type { Model as ModelV2, OpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as vscode from 'vscode';
import {
	getCustomEndpointProtocolFromNpm,
	isCustomEndpointNpm,
	normalizeCustomEndpointBaseUrl,
	type ProxyEndpointProtocol,
} from '../common';
import {
	mapQuestionRuntimePayloadToRequest,
	parseSessionPermissionRequest,
	parseSessionQuestionRequest,
	parseSessionTodoItem,
} from '../common/schemas';
import {
	OpenCodeConfigService,
	parseProjectConfigText,
	resolveProjectConfigPath,
} from './opencode/OpenCodeConfigService';

interface OpenCodeModelConfig {
	name: string;
	variants?: Record<string, unknown>;
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
	model?: string;
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

export interface ProjectModelDefaults {
	model?: string;
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
	variants?: string[];
}

export interface ProjectProxyProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	protocol: ProxyEndpointProtocol;
	models: EnrichedProxyModel[];
}

export interface LspStatusItem {
	id: string;
	name: string;
	root: string;
	status: 'connected' | 'error';
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
	npm?: string;
	baseUrl?: string;
	source?: 'env' | 'api' | 'config' | 'custom';
	env?: string[];
	models: OpenCodeProviderModel[];
}

interface AvailableProvider {
	id: string;
	name: string;
	env: string[];
	models: OpenCodeProviderModel[];
}

type ProviderListModel = {
	id: string;
	name?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	variants?: Record<string, unknown>;
	reasoning?: boolean;
	capabilities?: {
		reasoning?: boolean;
	};
};

function toProviderModel(model: ProviderListModel | ModelV2): OpenCodeProviderModel {
	const modelRecord = model as Record<string, unknown>;
	const capabilitiesRecord =
		modelRecord.capabilities && typeof modelRecord.capabilities === 'object'
			? (modelRecord.capabilities as Record<string, unknown>)
			: undefined;
	const variantKeys = model.variants ? Object.keys(model.variants) : undefined;
	const topLevelReasoning = 'reasoning' in model ? model.reasoning : undefined;
	const reasoning =
		typeof capabilitiesRecord?.reasoning === 'boolean'
			? capabilitiesRecord.reasoning
			: Boolean(topLevelReasoning);
	return {
		id: model.id,
		name: model.name || model.id,
		reasoning,
		limit: model.limit ? { context: model.limit.context, output: model.limit.output } : undefined,
		variants: variantKeys && variantKeys.length > 0 ? variantKeys : undefined,
	};
}

export class OpenCodeClientService {
	private readonly projectConfig = new OpenCodeConfigService();

	private setWorkspaceRoot(workspaceRoot: string): void {
		this.projectConfig.setWorkspaceRoot(workspaceRoot);
	}

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
		const resolvedPath = await resolveProjectConfigPath(workspaceRoot);
		const configPath = vscode.Uri.file(resolvedPath);
		try {
			const raw = await vscode.workspace.fs.readFile(configPath);
			return parseProjectConfigText(
				Buffer.from(raw).toString('utf-8'),
				resolvedPath,
			) as OpenCodeJsonConfig;
		} catch {
			return {};
		}
	}

	async getProjectModelDefaults(workspaceRoot: string): Promise<ProjectModelDefaults> {
		const config = await this.readProjectConfig(workspaceRoot);
		return {
			model: typeof config.model === 'string' ? config.model : undefined,
		};
	}

	async setProjectDefaultModel(
		workspaceRoot: string,
		model: string,
	): Promise<{ contentHash: string }> {
		this.setWorkspaceRoot(workspaceRoot);
		const result = await this.projectConfig.setProjectField('model', model);
		return { contentHash: result.contentHash };
	}

	async getConnectedProviders(
		client: OpencodeClient,
		_workspaceRoot?: string,
		options?: { includeOpenAiCompatible?: boolean },
	): Promise<OpenCodeProvider[]> {
		const { data } = await client.provider.list();
		if (!data) throw new Error('OpenCode /provider returned no data');

		const connectedSet = new Set(data.connected ?? []);

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
				const rawNpm = (p as Record<string, unknown>).npm;
				const rawOptions = (p as Record<string, unknown>).options;
				const options =
					rawOptions && typeof rawOptions === 'object'
						? (rawOptions as Record<string, unknown>)
						: undefined;
				const rawBaseUrl =
					typeof options?.baseURL === 'string'
						? options.baseURL
						: typeof options?.baseUrl === 'string'
							? options.baseUrl
							: undefined;
				const source: OpenCodeProvider['source'] =
					rawSource === 'env' ||
					rawSource === 'api' ||
					rawSource === 'config' ||
					rawSource === 'custom'
						? rawSource
						: undefined;
				const npm = typeof rawNpm === 'string' ? rawNpm : undefined;
				return {
					id: p.id,
					name: p.name || p.id,
					npm,
					baseUrl:
						rawBaseUrl && npm
							? normalizeCustomEndpointBaseUrl(getCustomEndpointProtocolFromNpm(npm), rawBaseUrl)
							: rawBaseUrl,
					source,
					env: Array.isArray(p.env) ? p.env : undefined,
					models: Object.values(p.models).map(model => toProviderModel(model)),
				};
			})
			.filter(
				provider =>
					options?.includeOpenAiCompatible !== false || !isCustomEndpointNpm(provider.npm),
			)
			.filter(p => p.id.length > 0);
	}

	async getUiConnectedProviders(client: OpencodeClient): Promise<OpenCodeProvider[]> {
		return this.getConnectedProviders(client, undefined, { includeOpenAiCompatible: false });
	}

	async getSessionTodos(
		client: OpencodeClient,
		sessionId: string,
		workspaceRoot: string,
	): Promise<import('../common').SessionTodoItem[]> {
		const result = await client.session.todo({ sessionID: sessionId, directory: workspaceRoot });
		const raw = (result.data as unknown[]) || [];
		return raw.flatMap((value, index) => {
			const todo = parseSessionTodoItem(value);
			if (todo) return [todo];
			if (!value || typeof value !== 'object') return [];
			const record = value as Record<string, unknown>;
			const content = typeof record.content === 'string' ? record.content : undefined;
			if (!content) return [];
			return [
				{
					id: typeof record.id === 'string' ? record.id : `todo-${index}-${content}`,
					content,
					status:
						record.status === 'completed' ||
						record.status === 'in_progress' ||
						record.status === 'cancelled'
							? record.status
							: 'pending',
					priority: typeof record.priority === 'string' ? record.priority : 'medium',
				} satisfies import('../common').SessionTodoItem,
			];
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

	async getLspStatus(client: OpencodeClient): Promise<LspStatusItem[]> {
		const lspClient = (client as unknown as Record<string, unknown>).lsp as
			| { status?: () => Promise<{ data?: unknown }> }
			| undefined;
		if (!lspClient?.status) return [];

		const result = await lspClient.status();
		if (!Array.isArray(result.data)) return [];

		return result.data.flatMap(value => {
			if (!value || typeof value !== 'object') return [];
			const item = value as Record<string, unknown>;
			const id = typeof item.id === 'string' ? item.id : null;
			const name = typeof item.name === 'string' ? item.name : id;
			const root = typeof item.root === 'string' ? item.root : '';
			const status = item.status === 'connected' || item.status === 'error' ? item.status : null;
			if (!id || !name || !status) return [];
			return [{ id, name, root, status } satisfies LspStatusItem];
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
				models: Object.values(p.models).map(model => toProviderModel(model)),
			}))
			.filter(p => p.id.length > 0);
	}

	async getProjectProxyProvider(
		workspaceRoot: string,
		providerId: string,
	): Promise<ProjectProxyProviderConfig | undefined> {
		const config = await this.readProjectConfig(workspaceRoot);
		const provider = config.provider?.[providerId];
		if (!provider || !isCustomEndpointNpm(provider.npm)) return undefined;

		const rawBaseUrl =
			typeof provider.options?.baseURL === 'string' ? String(provider.options.baseURL) : '';
		const rawApiKey =
			typeof provider.options?.apiKey === 'string' ? String(provider.options.apiKey) : '';
		const models = Object.entries(provider.models ?? {}).map(([id, model]) => ({
			id,
			name: model.name || id,
			contextLength: model.limit?.context,
			maxCompletionTokens: model.limit?.output,
			variants: model.variants ? Object.keys(model.variants) : undefined,
			capabilities: {
				reasoning: model.reasoning,
				vision: model.modalities?.input?.includes('image'),
				tools: model.tool_call,
			},
		}));

		const protocol = getCustomEndpointProtocolFromNpm(provider.npm);
		return {
			id: providerId,
			name: provider.name || providerId,
			baseUrl: normalizeCustomEndpointBaseUrl(protocol, rawBaseUrl),
			apiKey: rawApiKey,
			protocol,
			models,
		};
	}

	/**
	 * Read ALL custom endpoint proxy providers from opencode.json.
	 * Used for reverse-syncing config file providers into the settings UI.
	 */
	async getAllProjectProxyProviders(workspaceRoot: string): Promise<ProjectProxyProviderConfig[]> {
		const config = await this.readProjectConfig(workspaceRoot);
		if (!config.provider) return [];

		const results: ProjectProxyProviderConfig[] = [];
		for (const [providerId, provider] of Object.entries(config.provider)) {
			if (!isCustomEndpointNpm(provider.npm)) continue;
			const protocol = getCustomEndpointProtocolFromNpm(provider.npm);

			const rawBaseUrl =
				typeof provider.options?.baseURL === 'string' ? String(provider.options.baseURL) : '';
			const rawApiKey =
				typeof provider.options?.apiKey === 'string' ? String(provider.options.apiKey) : '';
			const models = Object.entries(provider.models ?? {}).map(([id, model]) => ({
				id,
				name: model.name || id,
				contextLength: model.limit?.context,
				maxCompletionTokens: model.limit?.output,
				variants: model.variants ? Object.keys(model.variants) : undefined,
				capabilities: {
					reasoning: model.reasoning,
					vision: model.modalities?.input?.includes('image'),
					tools: model.tool_call,
				},
			}));

			results.push({
				id: providerId,
				name: provider.name || providerId,
				baseUrl: normalizeCustomEndpointBaseUrl(protocol, rawBaseUrl),
				apiKey: rawApiKey,
				protocol,
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

	async upsertCustomProvider(
		workspaceRoot: string,
		input: {
			providerId: string;
			name?: string;
			npm: string;
			baseUrl: string;
			apiKey?: string;
			headers?: Record<string, string>;
			models?: EnrichedProxyModel[];
		},
	): Promise<{ contentHash: string }> {
		this.setWorkspaceRoot(workspaceRoot);
		const existing = await this.readProjectConfig(workspaceRoot);
		const { providerId, name, npm, baseUrl, apiKey = '', headers, models = [] } = input;
		const protocol = getCustomEndpointProtocolFromNpm(npm);

		const modelsRecord: Record<string, OpenCodeModelConfig> = {};
		for (const m of models) {
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
			if (m.variants && m.variants.length > 0) {
				config.variants = Object.fromEntries(m.variants.map(variant => [variant, {}]));
			}
			modelsRecord[m.id] = config;
		}

		const normalizedBaseUrl = normalizeCustomEndpointBaseUrl(protocol, baseUrl);

		const providerSection = existing.provider ?? {};
		const duplicateIds = this.findProxyProviderIdsByBaseUrl(
			providerSection,
			normalizedBaseUrl,
			npm,
		);
		const canonicalProviderId = providerSection[providerId]
			? providerId
			: duplicateIds[0] || providerId;

		for (const duplicateId of duplicateIds) {
			if (duplicateId !== canonicalProviderId) {
				delete providerSection[duplicateId];
			}
		}

		providerSection[canonicalProviderId] = {
			...providerSection[canonicalProviderId],
			name: name || providerId,
			npm,
			options: {
				baseURL: normalizedBaseUrl,
				apiKey,
				...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
			},
			models: modelsRecord,
		};

		const result = await this.projectConfig.setProjectField('provider', providerSection);
		return { contentHash: result.contentHash };
	}

	async deleteCustomProvider(
		workspaceRoot: string,
		input: { providerId: string; baseUrl?: string },
	): Promise<{ contentHash?: string }> {
		this.setWorkspaceRoot(workspaceRoot);
		const existing = await this.readProjectConfig(workspaceRoot);
		if (!existing.provider) return {};
		const { providerId, baseUrl } = input;

		const idsToRemove = new Set<string>();
		if (existing.provider[providerId]) idsToRemove.add(providerId);
		if (baseUrl?.trim()) {
			const providerProtocol = getCustomEndpointProtocolFromNpm(existing.provider[providerId]?.npm);
			for (const id of this.findProxyProviderIdsByBaseUrl(
				existing.provider,
				normalizeCustomEndpointBaseUrl(providerProtocol, baseUrl),
				existing.provider[providerId]?.npm,
			)) {
				idsToRemove.add(id);
			}
		}
		if (idsToRemove.size === 0) return {};
		for (const id of idsToRemove) {
			delete existing.provider[id];
		}
		const result = await this.projectConfig.setProjectField('provider', existing.provider);
		return { contentHash: result.contentHash };
	}

	private findProxyProviderIdsByBaseUrl(
		providerSection: NonNullable<OpenCodeJsonConfig['provider']>,
		normalizedBaseUrl: string,
		targetNpm?: string,
	): string[] {
		return Object.entries(providerSection)
			.filter(([, provider]) => {
				if (!isCustomEndpointNpm(provider.npm)) return false;
				// Only match providers with the same npm/protocol
				if (targetNpm && provider.npm !== targetNpm) return false;
				const protocol = getCustomEndpointProtocolFromNpm(provider.npm);
				const rawBaseUrl =
					typeof provider.options?.baseURL === 'string'
						? String(provider.options.baseURL)
						: typeof provider.options?.baseUrl === 'string'
							? String(provider.options.baseUrl)
							: '';
				if (!rawBaseUrl) return false;
				const candidateUrl = normalizeCustomEndpointBaseUrl(protocol, rawBaseUrl);
				return candidateUrl === normalizedBaseUrl;
			})
			.map(([id]) => id);
	}
}
