import {
	getCustomEndpointDedupeKey,
	getProxyEndpointProtocol,
	isProxyEndpointProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from '../../common';
import type {
	CommandListItem,
	CommandOf,
	ManagedResource,
	PluginListItem,
	ResourceKind,
	SkillListItem,
	WebviewCommand,
} from '../../common/protocol';
import type { ParsedCommand, ParsedSkill } from '../../common/schemas';
import type { PrimeCodeSettings } from '../../core/Settings';
import type { RulesService } from '../../services/RulesService';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

type ResourceAdapter = {
	list: () => Promise<{ resources: ManagedResource[]; revision: number }>;
	create?: (name: string, payload: Record<string, unknown>) => Promise<void>;
	delete?: (name: string) => Promise<void>;
	refresh?: () => void;
};

export class SettingsHandler implements WebviewMessageHandler {
	private rulesService: RulesService | null = null;
	private resourceRevision: Record<ResourceKind, number> = {
		agent: 0,
		command: 0,
		skill: 0,
		plugin: 0,
	};
	private readonly resourceAdapters: Record<ResourceKind, ResourceAdapter>;

	constructor(private context: HandlerContext) {
		this.rulesService = context.services.rules;
		this.resourceAdapters = this.createResourceAdapters();
	}

	setWorkspaceRoot(root: string) {
		this.context.services.setWorkspaceRoot(root);
		this.rulesService = this.context.services.rules;
	}

	private createResourceAdapters(): Record<ResourceKind, ResourceAdapter> {
		return {
			agent: {
				list: () => this.context.services.agentResources.listAgents(this.context.cli),
				create: (name, payload) =>
					this.context.services.resources.save('subagents', {
						name,
						description: getPayloadString(payload, 'description'),
						prompt: getPayloadString(payload, 'content'),
						model: getOptionalPayloadString(payload, 'model'),
						temperature: getOptionalPayloadNumber(payload, 'temperature'),
						topP: getOptionalPayloadNumber(payload, 'topP'),
						mode: getAgentMode(payload.mode),
						color: getOptionalPayloadString(payload, 'color'),
						steps: getOptionalPayloadNumber(payload, 'steps'),
						tools: getRecordPayload<boolean>(payload.tools, value => typeof value === 'boolean'),
						permission: getRecordPayload(payload.permission),
					}),
				delete: name => this.context.services.resources.delete('subagents', name),
				refresh: () => this.context.cli.clearAgentsCache?.(),
			},
			command: {
				list: async () => ({
					resources: await this.listCommands(),
					revision: this.nextResourceRevision('command'),
				}),
				create: (name, payload) =>
					this.context.services.resources.save('commands', {
						name,
						description: getPayloadString(payload, 'description'),
						template: getPayloadString(payload, 'content'),
					}),
				delete: name => this.context.services.resources.delete('commands', name),
				refresh: () => this.context.cli.clearCommandsCache?.(),
			},
			skill: {
				list: async () => ({
					resources: await this.listSkills(),
					revision: this.nextResourceRevision('skill'),
				}),
				create: (name, payload) =>
					this.context.services.resources.save('skills', {
						name,
						description: getPayloadString(payload, 'description'),
						content: getPayloadString(payload, 'content'),
						version: '0.1.0',
					}),
				delete: name => this.context.services.resources.delete('skills', name),
				refresh: () => this.context.cli.clearSkillsCache?.(),
			},
			plugin: {
				list: async () => ({
					resources: await this.listPlugins(),
					revision: this.nextResourceRevision('plugin'),
				}),
				create: async name => {
					await this.context.services.openCodeConfig.addProjectPlugin(name);
					this.context.services.mcpConfigWatcher.notifyUiSave();
				},
				delete: async name => {
					await this.context.services.openCodeConfig.removeProjectPlugin(name);
					this.context.services.mcpConfigWatcher.notifyUiSave();
				},
			},
		};
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'getSettings':
				await this.onGetSettings();
				break;
			case 'updateSettings':
				await this.onUpdateSettings(msg);
				break;
			case 'getRules':
				await this.onGetRules();
				break;
			case 'getResources':
				await this.onGetResources(msg);
				break;
			case 'mutateResource':
				await this.onMutateResource(msg);
				break;
			case 'applyResourceAction':
				await this.onApplyResourceAction(msg);
				break;
			case 'deleteSubagent':
				await this.onMutateResource({
					type: 'mutateResource',
					kind: 'agent',
					action: 'delete',
					name: msg.name,
				});
				break;
			case 'createRule':
				await this.onCreateRule(msg);
				break;
			case 'deleteRule':
				await this.onDeleteRule(msg);
				break;
		}
	}

	private async onGetSettings(): Promise<void> {
		const settings = this.context.settings.getAll();
		const merged = await this.mergeOpenCodeJsonEndpoints(settings);
		this.context.bridge.data('settingsData', merged);
	}

	/**
	 * Returns the merged list of custom proxy endpoints from VS Code settings
	 * and opencode.json. Used by ChatProvider to auto-fetch models on startup
	 * without re-reading opencode.json separately.
	 */
	async getResolvedEndpoints(): Promise<
		Array<{
			id: string;
			baseUrl: string;
			apiKey: string;
			headers?: Record<string, string>;
			modelVariants?: Record<string, string[]>;
		}>
	> {
		const settings = this.context.settings.getAll();
		const merged = await this.mergeOpenCodeJsonEndpoints(settings);
		return (merged['proxy.endpoints'] ?? []).map(ep => ({
			id: ep.id,
			baseUrl: ep.baseUrl,
			apiKey: ep.apiKey,
			headers: ep.headers,
			modelVariants: ep.modelVariants,
		}));
	}

	/**
	 * Reverse-sync: read proxy providers from opencode.json and merge them
	 * into the `proxy.endpoints` settings sent to the webview.
	 * This ensures that providers configured directly in opencode.json
	 * (e.g. by hand or by another tool) appear in the Settings UI.
	 */
	private async mergeOpenCodeJsonEndpoints(
		settings: PrimeCodeSettings,
	): Promise<PrimeCodeSettings> {
		try {
			const workspaceRoot = this.context.settings.getWorkspaceRoot();
			if (!workspaceRoot) return settings;

			const configProviders =
				await this.context.services.openCodeClient.getAllProjectProxyProviders(workspaceRoot);
			if (configProviders.length === 0) return settings;

			const existingEndpoints = settings['proxy.endpoints'] ?? [];
			const existingById = new Map(existingEndpoints.map(ep => [ep.id, ep]));
			// Index by canonical (baseUrl + protocol) key so that
			// "http://host:8080", "http://host:8080/", "http://host:8080/v1"
			// all resolve to the same key within the same protocol.
			// Two endpoints with the same URL but different protocols are distinct.
			const existingByBaseUrlKey = new Map<string, (typeof existingEndpoints)[number]>(
				existingEndpoints
					.filter(ep => ep.baseUrl?.trim())
					.map(ep => {
						const protocol = getProxyEndpointProtocol((ep as Record<string, unknown>).protocol);
						return [getCustomEndpointDedupeKey(protocol, ep.baseUrl), ep];
					}),
			);
			const mergedSettings = { ...settings };

			// Merge all OpenAI-compatible providers from opencode.json into proxy.endpoints.
			// Provider IDs in opencode.json use the "oai-{endpointId}" format;
			// strip the prefix to get the endpoint ID used by the UI.
			const mergedEndpoints = [...existingEndpoints];

			for (const provider of configProviders) {
				const endpointId = isProxyEndpointProviderId(provider.id)
					? provider.id.replace(`${OPENAI_COMPATIBLE_PROVIDER_ID}-`, '')
					: provider.id;

				// Skip if already exists by ID or by canonical (baseUrl + protocol) key
				// (prevents duplicates when the same endpoint is in both VS Code settings
				// and opencode.json with different IDs or slightly different URLs).
				// Two endpoints with the same URL but different protocols are distinct.
				const protocol = getProxyEndpointProtocol(provider.protocol);
				const baseUrlKey = provider.baseUrl?.trim()
					? getCustomEndpointDedupeKey(protocol, provider.baseUrl)
					: '';
				if (existingById.has(endpointId) || (baseUrlKey && existingByBaseUrlKey.has(baseUrlKey))) {
					continue;
				}

				const newEndpoint = {
					id: endpointId,
					name: provider.name,
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKey,
					protocol,
					enabledModels: provider.models.map(m => m.id),
					modelVariants: Object.fromEntries(
						provider.models.flatMap(m =>
							m.variants && m.variants.length > 0 ? [[m.id, m.variants] as const] : [],
						),
					),
				};
				mergedEndpoints.push(newEndpoint);
				if (baseUrlKey) {
					existingByBaseUrlKey.set(baseUrlKey, newEndpoint);
				}
			}

			mergedSettings['proxy.endpoints'] = mergedEndpoints;
			return mergedSettings;
		} catch (error) {
			logger.warn('[SettingsHandler] Failed to merge opencode.json endpoints:', error);
			return settings;
		}
	}

	private async onUpdateSettings(msg: CommandOf<'updateSettings'>): Promise<void> {
		await this.applyWebviewSettingsPatch(msg.settings);
		this.context.settings.refresh();
		const settings = this.context.settings.getAll();
		const merged = await this.mergeOpenCodeJsonEndpoints(settings);
		this.context.bridge.data('settingsData', merged);
	}

	private async applyWebviewSettingsPatch(patch: Record<string, unknown>): Promise<void> {
		const booleanKeys = new Set<keyof PrimeCodeSettings>([
			'access.autoApprove',
			'proxy.useSingleModel',
			'opencode.autoStart',
		]);
		const nullableStringKeys = new Set<keyof PrimeCodeSettings>([
			'proxy.haikuModel',
			'proxy.sonnetModel',
			'proxy.opusModel',
			'proxy.subagentModel',
			'opencode.agent',
			'promptImprove.model',
			'promptImprove.template',
		]);
		const stringArrayKeys = new Set<keyof PrimeCodeSettings>([
			'opencode.enabledModels',
			'providers.disabled',
		]);

		const isValidProxyEndpointList = (
			input: unknown,
		): input is NonNullable<PrimeCodeSettings['proxy.endpoints']> =>
			Array.isArray(input) &&
			input.every(entry => {
				if (!entry || typeof entry !== 'object') return false;
				const record = entry as Record<string, unknown>;
				return (
					typeof record.id === 'string' &&
					typeof record.name === 'string' &&
					typeof record.baseUrl === 'string' &&
					typeof record.apiKey === 'string' &&
					Array.isArray(record.enabledModels) &&
					(record.modelVariants === undefined ||
						(typeof record.modelVariants === 'object' && !Array.isArray(record.modelVariants))) &&
					(record.headers === undefined ||
						(typeof record.headers === 'object' && !Array.isArray(record.headers)))
				);
			});

		for (const [rawKey, value] of Object.entries(patch)) {
			if (rawKey === 'model') continue;

			if (rawKey === 'provider') {
				if (value === 'opencode') {
					await this.context.settings.set('provider', value);
				}
				continue;
			}

			if (rawKey === 'mcpServers') {
				if (typeof value === 'object' && value !== null) {
					await this.context.settings.set('mcpServers', value as Record<string, unknown>);
				}
				continue;
			}

			if (rawKey === 'proxy.endpoints') {
				if (isValidProxyEndpointList(value)) {
					await this.context.settings.set('proxy.endpoints', value);
				}
				continue;
			}

			if (rawKey === 'opencode.serverTimeout') {
				if (typeof value === 'number' && Number.isFinite(value)) {
					await this.context.settings.set('opencode.serverTimeout', value);
				}
				continue;
			}

			const key = rawKey as keyof PrimeCodeSettings;

			if (booleanKeys.has(key)) {
				if (typeof value === 'boolean') {
					await this.context.settings.set(key, value);
				}
				continue;
			}

			if (nullableStringKeys.has(key)) {
				if (typeof value === 'string') {
					await this.context.settings.set(key, value);
				} else if (value === null || value === undefined) {
					await this.context.settings.set(key, undefined);
				}
				continue;
			}

			if (stringArrayKeys.has(key)) {
				if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
					await this.context.settings.set(key, value);
				}
			}
		}
	}

	private async onGetResources(msg: CommandOf<'getResources'>): Promise<void> {
		const kinds: ResourceKind[] = msg.kind ? [msg.kind] : ['agent', 'command', 'skill', 'plugin'];
		await Promise.all(kinds.map(kind => this.sendResourceList(kind, msg.requestId)));
	}

	private async onApplyResourceAction(msg: CommandOf<'applyResourceAction'>): Promise<void> {
		this.context.bridge.data('resourceOperation', {
			operationId: msg.operationId,
			resourceId: msg.resourceId,
			action: msg.action,
			status: 'started',
		});

		try {
			if (msg.action !== 'setDisabled' || typeof msg.value !== 'boolean') {
				throw new Error('Unsupported resource action payload');
			}
			const resources = await this.context.services.agentResources.buildAgentResources(
				this.context.cli,
			);
			const resource = resources.find(item => item.id === msg.resourceId);
			if (!resource) throw new Error('Resource not found');

			const result = await this.context.services.openCodeApply.setAgentDisabled(
				this.context.cli,
				resource,
				msg.value,
				this.context.reloadOpenCodeRuntime,
			);
			this.context.bridge.data('resourceOperation', {
				operationId: msg.operationId,
				resourceId: msg.resourceId,
				action: msg.action,
				status: 'completed',
				result: result.result,
				message: result.message,
				revision: result.revision,
			});
			this.sendResources('agent', result.resources, result.revision, undefined, msg.operationId);
		} catch (error) {
			const { resources, revision } = await this.context.services.agentResources.listAgents(
				this.context.cli,
			);
			this.context.bridge.data('resourceOperation', {
				operationId: msg.operationId,
				resourceId: msg.resourceId,
				action: msg.action,
				status: 'completed',
				result: 'error',
				message: error instanceof Error ? error.message : String(error),
				revision,
			});
			this.sendResources('agent', resources, revision, undefined, msg.operationId);
		}
	}

	private sendResources(
		kind: ResourceKind,
		resources: ManagedResource[],
		revision: number,
		requestId?: string,
		operationId?: string,
	): void {
		this.context.bridge.data('resourcesList', {
			kind,
			resources,
			revision,
			requestId,
			operationId,
		});
	}

	private nextResourceRevision(kind: ResourceKind): number {
		this.resourceRevision[kind] += 1;
		return this.resourceRevision[kind];
	}

	private async sendResourceList(kind: ResourceKind, requestId?: string): Promise<void> {
		try {
			const { resources, revision } = await this.resourceAdapters[kind].list();
			this.context.bridge.data('resourcesList', { kind, resources, revision, requestId });
		} catch (error) {
			this.context.bridge.data('resourcesList', {
				kind,
				resources: [],
				revision: this.nextResourceRevision(kind),
				requestId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async listCommands(): Promise<Array<CommandListItem & { kind: 'command'; id: string }>> {
		try {
			const [project, global] = await Promise.all([
				this.context.services.resources.getAll('commands') as Promise<ParsedCommand[]>,
				this.context.services.resources.getGlobalCommands(),
			]);
			return this.mergeByPath<CommandListItem>([
				...project.map(command => ({
					...command,
					source: 'project' as const,
					locationScope: 'project' as const,
				})),
				...global.map(command => ({
					...command,
					source: 'global' as const,
					locationScope: 'global' as const,
				})),
			]).map(command => ({ ...command, kind: 'command' as const, id: command.path }));
		} catch {
			return [];
		}
	}

	private async listSkills(): Promise<Array<SkillListItem & { kind: 'skill'; id: string }>> {
		try {
			const [projectAndExternal, global] = await Promise.all([
				this.context.services.resources.getAll('skills') as Promise<ParsedSkill[]>,
				this.context.services.resources.getGlobalSkillsIncludingExternal(),
			]);
			return this.mergeByPath<SkillListItem>([
				...projectAndExternal.map(skill => this.skillItem(skill, 'project')),
				...global.map(skill => this.skillItem(skill, 'global')),
			]).map(skill => ({ ...skill, kind: 'skill' as const, id: skill.path }));
		} catch {
			return [];
		}
	}

	private skillItem(skill: ParsedSkill, locationScope: 'project' | 'global'): SkillListItem {
		const format = getSkillFormat(skill.path);
		return {
			...skill,
			source: format === 'opencode' ? locationScope : ('external' as const),
			locationScope,
			format,
		};
	}

	private async listPlugins(): Promise<Array<PluginListItem & { kind: 'plugin' }>> {
		try {
			const [projectFiles, globalFiles, projectConfig, globalConfig] = await Promise.all([
				this.context.services.resources.getProjectPluginFiles(),
				this.context.services.resources.getGlobalPluginFiles(),
				this.context.services.openCodeConfig.getProjectPlugins(),
				this.context.services.openCodeConfig.getGlobalPlugins(),
			]);
			return this.mergePlugins([
				...projectFiles.map(file => this.pluginFileItem(file, 'project' as const)),
				...globalFiles.map(file => this.pluginFileItem(file, 'global' as const)),
				...projectConfig.map(name => this.pluginConfigItem(name, 'project' as const)),
				...globalConfig.map(name => this.pluginConfigItem(name, 'global' as const)),
			]).map(plugin => ({ ...plugin, kind: 'plugin' as const }));
		} catch {
			return [];
		}
	}

	private mergeByPath<T extends { path: string; name: string }>(items: T[]): T[] {
		const byPath = new Map<string, T>();
		for (const item of items) {
			byPath.set(item.path, item);
		}
		return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	private pluginFileItem(path: string, source: 'project' | 'global'): PluginListItem {
		const name =
			path
				.split(/[\\/]/)
				.pop()
				?.replace(/\.(mjs|js|ts)$/u, '') || path;
		return {
			id: `${source}:file:${path}`,
			name,
			path,
			source,
			locationScope: source,
			origin: 'file',
		};
	}

	private pluginConfigItem(name: string, source: 'project' | 'global'): PluginListItem {
		return {
			id: `${source}:config:${name}`,
			name,
			source: source === 'project' ? 'config' : source,
			locationScope: source,
			origin: 'config',
		};
	}

	private mergePlugins(items: PluginListItem[]): PluginListItem[] {
		const byId = new Map<string, PluginListItem>();
		for (const item of items) {
			byId.set(item.id, item);
		}
		return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	private async onGetRules(): Promise<void> {
		this.context.bridge.data('ruleList', { rules: [] });
		if (!this.rulesService) {
			this.context.bridge.data('ruleList', { rules: [] });
			return;
		}
		try {
			const rules = await this.rulesService.getRules();
			this.context.bridge.data('ruleList', { rules });
		} catch (error) {
			logger.error('[SettingsHandler] getRules failed:', error);
			this.context.bridge.data('ruleList', { rules: [] });
		}
	}

	// =========================================================================
	// Resource CRUD
	// =========================================================================

	private async onMutateResource(msg: CommandOf<'mutateResource'>): Promise<void> {
		const { name, kind, action, payload } = msg;
		if (!name) return;
		const adapter = this.resourceAdapters[kind];

		try {
			if (action === 'delete') await adapter.delete?.(name);
			else await adapter.create?.(name, payload ?? {});
			logger.info(`[SettingsHandler] ${action} ${kind}: ${name}`);
			adapter.refresh?.();
			await this.context.reloadOpenCodeRuntime?.(`settings:${kind}:${action}`);
			await this.sendResourceList(kind);
		} catch (error) {
			logger.error(`[SettingsHandler] Failed to ${action} ${kind}:`, error);
			await this.sendResourceList(kind);
		}
	}

	private async onCreateRule(msg: WebviewCommand): Promise<void> {
		const { name, content } = msg as { name: string; content: string };
		if (!this.rulesService || !name) return;

		try {
			await this.rulesService.createRule(name, content ?? '');
			await this.context.reloadOpenCodeRuntime?.('settings:rules:create');
			await this.onGetRules();
		} catch (error) {
			logger.error('[SettingsHandler] createRule failed:', error);
			this.context.bridge.data('ruleList', {
				rules: await this.rulesService.getRules().catch(() => []),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onDeleteRule(msg: WebviewCommand): Promise<void> {
		const { path: rulePath } = msg as { path: string };
		if (!this.rulesService || !rulePath) return;

		try {
			await this.rulesService.deleteRule(rulePath);
			await this.context.reloadOpenCodeRuntime?.('settings:rules:delete');
			await this.onGetRules();
		} catch (error) {
			logger.error('[SettingsHandler] deleteRule failed:', error);
			this.context.bridge.data('ruleList', {
				rules: await this.rulesService.getRules().catch(() => []),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function getPayloadString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	return typeof value === 'string' ? value : '';
}

function getOptionalPayloadString(
	payload: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = payload[key];
	return typeof value === 'string' && value ? value : undefined;
}

function getOptionalPayloadNumber(
	payload: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = payload[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRecordPayload<T = unknown>(
	value: unknown,
	isValue?: (value: unknown) => value is T,
): Record<string, T> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const entries = Object.entries(value as Record<string, unknown>).filter(
		(entry): entry is [string, T] => !isValue || isValue(entry[1]),
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getAgentMode(input: unknown): 'primary' | 'subagent' | 'all' | undefined {
	return input === 'primary' || input === 'subagent' || input === 'all' ? input : undefined;
}

function getSkillFormat(path: string): SkillListItem['format'] {
	const normalized = path.replace(/\\/g, '/');
	if (normalized.startsWith('.agents/') || normalized.includes('/.agents/')) {
		return 'agent-compatible';
	}
	if (normalized.startsWith('.claude/') || normalized.includes('/.claude/')) {
		return 'claude-compatible';
	}
	return 'opencode';
}
