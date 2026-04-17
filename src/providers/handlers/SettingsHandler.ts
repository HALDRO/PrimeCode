import {
	isProxyEndpointProviderId,
	normalizeProxyBaseUrl,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from '../../common';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import type { PrimeCodeSettings } from '../../core/Settings';
import type { RulesService } from '../../services/RulesService';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class SettingsHandler implements WebviewMessageHandler {
	private rulesService: RulesService | null = null;

	constructor(private context: HandlerContext) {
		this.rulesService = context.services.rules;
	}

	setWorkspaceRoot(root: string) {
		this.context.services.setWorkspaceRoot(root);
		this.rulesService = this.context.services.rules;
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'getSettings':
				await this.onGetSettings();
				break;
			case 'updateSettings':
				await this.onUpdateSettings(msg);
				break;
			case 'getCommands':
				await this.onGetCommands();
				break;
			case 'getSkills':
				await this.onGetSkills();
				break;
			case 'getSubagents':
				await this.onGetSubagents();
				break;
			case 'getAgents':
				await this.onGetAgents();
				break;
			case 'getPlugins':
				await this.onGetPlugins();
				break;
			case 'getRules':
				await this.onGetRules();
				break;

			// Resource CRUD
			case 'createCommand':
				await this.onCreateResource('commands', msg);
				break;
			case 'deleteCommand':
				await this.onDeleteResource('commands', msg);
				break;
			case 'createSkill':
				await this.onCreateResource('skills', msg);
				break;
			case 'deleteSkill':
				await this.onDeleteResource('skills', msg);
				break;
			case 'createSubagent':
				await this.onCreateResource('subagents', msg);
				break;
			case 'deleteSubagent':
				await this.onDeleteResource('subagents', msg);
				break;
			case 'addPlugin':
				await this.onAddPlugin(msg);
				break;
			case 'removePlugin':
				await this.onRemovePlugin(msg);
				break;
			case 'toggleRule':
				await this.onToggleRule(msg);
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
			// Index by canonical baseUrl (normalizeProxyBaseUrl) so that
			// "http://host:8080", "http://host:8080/", "http://host:8080/v1"
			// all resolve to the same key. This is the same normalization used
			// when writing to opencode.json and when fetching proxy models.
			const existingByBaseUrl = new Map(
				existingEndpoints
					.filter(ep => ep.baseUrl?.trim())
					.map(ep => [normalizeProxyBaseUrl(ep.baseUrl), ep]),
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

				// Skip if already exists by ID or by canonical baseUrl (prevents
				// duplicates when the same endpoint is in both VS Code settings
				// and opencode.json with different IDs or slightly different URLs)
				const canonicalBaseUrl = provider.baseUrl?.trim()
					? normalizeProxyBaseUrl(provider.baseUrl)
					: '';
				if (
					existingById.has(endpointId) ||
					(canonicalBaseUrl && existingByBaseUrl.has(canonicalBaseUrl))
				) {
					continue;
				}

				const newEndpoint = {
					id: endpointId,
					name: provider.name,
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKey,
					enabledModels: provider.models.map(m => m.id),
					modelVariants: Object.fromEntries(
						provider.models.flatMap(m =>
							m.variants && m.variants.length > 0 ? [[m.id, m.variants] as const] : [],
						),
					),
				};
				mergedEndpoints.push(newEndpoint);
				if (canonicalBaseUrl) {
					existingByBaseUrl.set(canonicalBaseUrl, newEndpoint);
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

	private async onGetCommands(): Promise<void> {
		this.context.bridge.data('commandsList', { custom: [], isLoading: true });
		try {
			const [commands, cliCommands] = await Promise.all([
				this.context.services.resources.getAll('commands'),
				this.fetchCliCommands(),
			]);
			// Deduplicate: remove CLI commands that already exist in custom list
			const customNames = new Set(commands.map(c => c.name));
			const dedupedCli = cliCommands.filter(c => !customNames.has(c.name));
			this.context.bridge.data('commandsList', {
				custom: commands,
				cli: dedupedCli.map(c => ({
					name: c.name,
					description: c.description,
					source: c.source,
				})),
				isLoading: false,
			});
		} catch (error) {
			this.context.bridge.data('commandsList', {
				custom: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Fetch built-in CLI commands from the running OpenCode server.
	 * Merges server commands with PrimeCode-internal commands (e.g. compact)
	 * that are handled locally but not registered on the server.
	 * Returns empty array if server is not available.
	 */
	private async fetchCliCommands(): Promise<
		Array<{ name: string; description?: string; source?: string }>
	> {
		// Commands handled internally by PrimeCode (not registered on the server)
		const internalCommands: Array<{ name: string; description?: string; source?: string }> = [
			{ name: 'compact', description: 'Summarize and compact session context', source: 'command' },
		];

		try {
			const client = this.context.cli.getSdkClient();
			const serverInfo = this.context.cli.getOpenCodeServerInfo();
			if (!client || !serverInfo?.directory) return internalCommands;
			const { data } = await client.command.list({ directory: serverInfo.directory });
			const serverCommands = (data ?? []) as Array<{
				name: string;
				description?: string;
				source?: string;
			}>;
			// Filter out skills — they are fetched separately via GET /skill and shown
			// in the skills settings panel. The OpenCode CLI /command endpoint includes
			// skills with source: "skill" by design, but we don't want them in the
			// slash command dropdown (they'd appear as duplicate "CLI" entries).
			const filteredCommands = serverCommands.filter(c => c.source !== 'skill');
			// Merge: internal first, then server (skip duplicates)
			const names = new Set(internalCommands.map(c => c.name));
			return [...internalCommands, ...filteredCommands.filter(c => !names.has(c.name))];
		} catch (error) {
			logger.warn('[SettingsHandler] Failed to fetch CLI commands:', error);
			return internalCommands;
		}
	}

	private async onGetSkills(): Promise<void> {
		this.context.bridge.data('skillsList', { skills: [], isLoading: true });
		try {
			// Primary: fetch from CLI server (GET /skill) — includes all discovery phases
			const serverInfo = this.context.cli.getOpenCodeServerInfo();
			const cliSkills =
				serverInfo?.directory && this.context.cli.listSkills
					? await this.context.cli.listSkills(serverInfo.directory)
					: null;

			if (cliSkills && cliSkills.length > 0) {
				// Map CLI skill format to ParsedSkill-compatible shape
				const skills = cliSkills.map(s => ({
					name: s.name,
					description: s.description ?? '',
					content: s.content ?? '',
					path: s.location ?? '',
				}));
				this.context.bridge.data('skillsList', { skills, isLoading: false });
				return;
			}

			// Fallback: read local skill directories directly (.opencode + external interop dirs)
			const skills = await this.context.services.resources.getAllSkillsIncludingExternal();
			this.context.bridge.data('skillsList', { skills, isLoading: false });
		} catch (error) {
			this.context.bridge.data('skillsList', {
				skills: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onGetSubagents(): Promise<void> {
		this.context.bridge.data('subagentsList', { subagents: [], isLoading: true });
		try {
			const subagents = await this.context.services.resources.getAll('subagents');
			this.context.bridge.data('subagentsList', { subagents, isLoading: false });
		} catch (error) {
			this.context.bridge.data('subagentsList', {
				subagents: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onGetAgents(): Promise<void> {
		this.context.bridge.data('agentsList', { agents: [], isLoading: true });
		try {
			const serverInfo = this.context.cli.getOpenCodeServerInfo();
			if (!serverInfo?.directory) {
				this.context.bridge.data('agentsList', { agents: [], isLoading: false });
				return;
			}
			const data = await this.context.cli.listAgents(serverInfo.directory);
			// CLI returns Array<Agent> with `name` field — normalize to `id` for the UI
			const agents = Array.isArray(data)
				? data
						.filter((a): a is Record<string, unknown> => a != null && typeof a === 'object')
						.map(a => ({
							id: typeof a.name === 'string' ? a.name : String(a.name ?? ''),
							mode: typeof a.mode === 'string' ? a.mode : undefined,
							description: typeof a.description === 'string' ? a.description : undefined,
							model: typeof a.model === 'string' ? a.model : undefined,
							variant: typeof a.variant === 'string' ? a.variant : undefined,
							builtIn: typeof a.builtIn === 'boolean' ? a.builtIn : undefined,
							hidden: typeof a.hidden === 'boolean' ? a.hidden : undefined,
						}))
				: [];
			this.context.bridge.data('agentsList', { agents, isLoading: false });
		} catch (error) {
			this.context.bridge.data('agentsList', {
				agents: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onGetPlugins(): Promise<void> {
		this.context.bridge.data('pluginsList', { plugins: [], isLoading: true });
		try {
			const plugins = await this.context.services.mcpConfig.getPlugins();
			this.context.bridge.data('pluginsList', { plugins, isLoading: false });
		} catch (error) {
			this.context.bridge.data('pluginsList', {
				plugins: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onAddPlugin(msg: CommandOf<'addPlugin'>): Promise<void> {
		try {
			await this.context.services.mcpConfig.addPlugin(msg.plugin);
			await this.onGetPlugins();
		} catch (error) {
			logger.error('[SettingsHandler] addPlugin failed:', error);
			this.context.bridge.data('pluginsList', {
				plugins: await this.context.services.mcpConfig.getPlugins().catch(() => []),
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onRemovePlugin(msg: CommandOf<'removePlugin'>): Promise<void> {
		try {
			await this.context.services.mcpConfig.removePlugin(msg.plugin);
			await this.onGetPlugins();
		} catch (error) {
			logger.error('[SettingsHandler] removePlugin failed:', error);
			this.context.bridge.data('pluginsList', {
				plugins: await this.context.services.mcpConfig.getPlugins().catch(() => []),
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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

	private async onCreateResource(
		type: import('../../services/ResourceService').ResourceType,
		msg: WebviewCommand,
	): Promise<void> {
		const { name } = msg as {
			name: string;
		};
		if (!name) return;

		try {
			const item = this.buildResourceItem(type, msg);
			await this.context.services.resources.save(type, item);
			logger.info(`[SettingsHandler] Created ${type}: ${name}`);
			// Refresh the list
			await this.refreshResourceList(type);
		} catch (error) {
			logger.error(`[SettingsHandler] Failed to create ${type}:`, error);
			await this.refreshResourceList(type);
		}
	}

	private async onDeleteResource(
		type: import('../../services/ResourceService').ResourceType,
		msg: WebviewCommand,
	): Promise<void> {
		const { name } = msg as { name: string };
		if (!name) return;

		try {
			await this.context.services.resources.delete(type, name);
			logger.info(`[SettingsHandler] Deleted ${type}: ${name}`);
			await this.refreshResourceList(type);
		} catch (error) {
			logger.error(`[SettingsHandler] Failed to delete ${type}:`, error);
			await this.refreshResourceList(type);
		}
	}

	private buildResourceItem(
		type: import('../../services/ResourceService').ResourceType,
		msg: WebviewCommand,
	): { name: string } & Record<string, unknown> {
		const m = msg as unknown as Record<string, unknown>;
		const name = String(m.name ?? '');

		switch (type) {
			case 'commands':
				return { name, description: String(m.description ?? ''), prompt: String(m.content ?? '') };
			case 'skills':
				return {
					name,
					description: String(m.description ?? ''),
					content: String(m.content ?? ''),
					version: String(m.version ?? '0.1.0'),
				};
			case 'subagents': {
				const toNum = (v: unknown) => (typeof v === 'number' ? v : undefined);
				const toStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
				const mode = m.mode as string | undefined;
				return {
					name,
					description: String(m.description ?? ''),
					prompt: String(m.content ?? ''),
					model: toStr(m.model),
					temperature: toNum(m.temperature),
					topP: toNum(m.topP),
					mode: mode === 'subagent' || mode === 'primary' || mode === 'all' ? mode : undefined,
					color: toStr(m.color),
					steps: toNum(m.steps),
					tools:
						typeof m.tools === 'object' && m.tools !== null
							? (m.tools as Record<string, boolean>)
							: undefined,
					permission:
						typeof m.permission === 'object' && m.permission !== null
							? (m.permission as Record<string, unknown>)
							: undefined,
				};
			}
		}
	}

	private async refreshResourceList(
		type: import('../../services/ResourceService').ResourceType,
	): Promise<void> {
		switch (type) {
			case 'commands':
				await this.onGetCommands();
				break;
			case 'skills':
				await this.onGetSkills();
				break;
			case 'subagents':
				await this.onGetSubagents();
				break;
		}
	}

	private async onToggleRule(msg: WebviewCommand): Promise<void> {
		const { path: rulePath, enabled } = msg as { path: string; enabled: boolean };
		if (!this.rulesService || !rulePath) return;

		try {
			await this.rulesService.toggleRule(rulePath, enabled);
			await this.onGetRules();
		} catch (error) {
			logger.error('[SettingsHandler] toggleRule failed:', error);
			this.context.bridge.data('ruleList', {
				rules: await this.rulesService.getRules().catch(() => []),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onCreateRule(msg: WebviewCommand): Promise<void> {
		const { name, content } = msg as { name: string; content: string };
		if (!this.rulesService || !name) return;

		try {
			await this.rulesService.createRule(name, content ?? '');
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
