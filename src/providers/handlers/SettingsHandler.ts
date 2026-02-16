import type { CommandOf, WebviewCommand } from '../../common/protocol';
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
			case 'getHooks':
				await this.onGetHooks();
				break;
			case 'getSubagents':
				await this.onGetSubagents();
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
			case 'createHook':
				await this.onCreateResource('hooks', msg);
				break;
			case 'deleteHook':
				await this.onDeleteResource('hooks', msg);
				break;
			case 'createSubagent':
				await this.onCreateResource('subagents', msg);
				break;
			case 'deleteSubagent':
				await this.onDeleteResource('subagents', msg);
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
		this.context.bridge.data('settingsData', this.context.settings.getAll());
	}

	private async onUpdateSettings(msg: CommandOf<'updateSettings'>): Promise<void> {
		await this.applyWebviewSettingsPatch(msg.settings);
		this.context.settings.refresh();
		this.context.bridge.data('settingsData', this.context.settings.getAll());
	}

	private async applyWebviewSettingsPatch(patch: Record<string, unknown>): Promise<void> {
		// Webview sends schema-style keys like 'proxy.baseUrl', 'opencode.agent', etc.
		// Apply only known keys, everything else is ignored.
		for (const [key, value] of Object.entries(patch)) {
			switch (key) {
				case 'provider':
					if (value === 'opencode') {
						await this.context.settings.set('provider', value);
					}
					break;

				case 'model':
					// Model is stored per-session in chatStore, not in workspace settings
					break;

				case 'autoApprove':
					if (typeof value === 'boolean') {
						await this.context.settings.set('autoApprove', value);
					}
					break;

				case 'yoloMode':
					if (typeof value === 'boolean') {
						await this.context.settings.set('yoloMode', value);
					}
					break;

				case 'mcpServers':
					if (typeof value === 'object' && value !== null) {
						await this.context.settings.set('mcpServers', value as Record<string, unknown>);
					}
					break;

				case 'proxy.baseUrl':
					if (typeof value === 'string') {
						await this.context.settings.set('proxy.baseUrl', value);
					}
					break;

				case 'proxy.apiKey':
					if (typeof value === 'string') {
						await this.context.settings.set('proxy.apiKey', value);
					}
					break;

				case 'proxy.enabledModels':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.context.settings.set('proxy.enabledModels', value);
					}
					break;

				case 'proxy.useSingleModel':
					if (typeof value === 'boolean') {
						await this.context.settings.set('proxy.useSingleModel', value);
					}
					break;

				case 'proxy.haikuModel':
				case 'proxy.sonnetModel':
				case 'proxy.opusModel':
				case 'proxy.subagentModel':
					if (typeof value === 'string') {
						await this.context.settings.set(key, value);
					} else if (value === null || value === undefined) {
						await this.context.settings.set(key, undefined);
					}
					break;

				case 'opencode.autoStart':
					if (typeof value === 'boolean') {
						await this.context.settings.set('opencode.autoStart', value);
					}
					break;

				case 'opencode.serverTimeout':
					if (typeof value === 'number' && Number.isFinite(value)) {
						await this.context.settings.set('opencode.serverTimeout', value);
					}
					break;

				case 'opencode.agent':
					if (typeof value === 'string') {
						await this.context.settings.set('opencode.agent', value);
					} else if (value === null || value === undefined) {
						await this.context.settings.set('opencode.agent', undefined);
					}
					break;

				case 'opencode.enabledModels':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.context.settings.set('opencode.enabledModels', value);
					}
					break;

				case 'providers.disabled':
					if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
						await this.context.settings.set('providers.disabled', value);
					}
					break;

				case 'promptImprove.model':
				case 'promptImprove.template':
					if (typeof value === 'string') {
						await this.context.settings.set(key, value);
					} else if (value === null || value === undefined) {
						await this.context.settings.set(key, undefined);
					}
					break;

				default:
					break;
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
				cli: dedupedCli,
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
	private async fetchCliCommands(): Promise<Array<{ name: string; description?: string }>> {
		// Commands handled internally by PrimeCode (not registered on the server)
		const internalCommands: Array<{ name: string; description?: string }> = [
			{ name: 'compact', description: 'Summarize and compact session context' },
		];

		try {
			const client = this.context.cli.getSdkClient();
			const serverInfo = this.context.cli.getOpenCodeServerInfo();
			if (!client || !serverInfo?.directory) return internalCommands;
			const { data } = await client.command.list({ query: { directory: serverInfo.directory } });
			const serverCommands = (data ?? []) as Array<{ name: string; description?: string }>;
			// Merge: internal first, then server (skip duplicates)
			const names = new Set(internalCommands.map(c => c.name));
			return [...internalCommands, ...serverCommands.filter(c => !names.has(c.name))];
		} catch (error) {
			logger.warn('[SettingsHandler] Failed to fetch CLI commands:', error);
			return internalCommands;
		}
	}

	private async onGetSkills(): Promise<void> {
		this.context.bridge.data('skillsList', { skills: [], isLoading: true });
		try {
			const skills = await this.context.services.resources.getAll('skills');
			this.context.bridge.data('skillsList', { skills, isLoading: false });
		} catch (error) {
			this.context.bridge.data('skillsList', {
				skills: [],
				isLoading: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async onGetHooks(): Promise<void> {
		this.context.bridge.data('hooksList', { hooks: [], isLoading: true });
		try {
			const hooks = await this.context.services.resources.getAll('hooks');
			this.context.bridge.data('hooksList', { hooks, isLoading: false });
		} catch (error) {
			this.context.bridge.data('hooksList', {
				hooks: [],
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
			case 'hooks':
				return {
					name,
					enabled: m.enabled !== false,
					event: String(m.event ?? 'all'),
					pattern: m.pattern ? String(m.pattern) : undefined,
					action: m.action ? String(m.action) : undefined,
					content: String(m.content ?? ''),
				};
			case 'subagents':
				return {
					name,
					description: String(m.description ?? ''),
					prompt: String(m.content ?? ''),
				};
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
			case 'hooks':
				await this.onGetHooks();
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
		}
	}
}
