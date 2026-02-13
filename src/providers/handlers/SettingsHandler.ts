import type { CommandOf, WebviewCommand } from '../../common/webviewCommands';
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
		}
	}

	private async onGetSettings(): Promise<void> {
		this.context.view.postMessage({ type: 'settingsData', data: this.context.settings.getAll() });
	}

	private async onUpdateSettings(msg: CommandOf<'updateSettings'>): Promise<void> {
		await this.applyWebviewSettingsPatch(msg.settings);
		this.context.settings.refresh();
		this.context.view.postMessage({ type: 'settingsData', data: this.context.settings.getAll() });
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

				case 'promptImprove.timeoutMs':
					if (typeof value === 'number' && Number.isFinite(value)) {
						await this.context.settings.set('promptImprove.timeoutMs', value);
					}
					break;

				default:
					break;
			}
		}
	}

	private async onGetCommands(): Promise<void> {
		this.context.view.postMessage({ type: 'commandsList', data: { custom: [], isLoading: true } });
		try {
			const commands = await this.context.services.agentsCommands.getCommands();
			this.context.view.postMessage({
				type: 'commandsList',
				data: { custom: commands, isLoading: false },
			});
		} catch (error) {
			this.context.view.postMessage({
				type: 'commandsList',
				data: {
					custom: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetSkills(): Promise<void> {
		this.context.view.postMessage({ type: 'skillsList', data: { skills: [], isLoading: true } });
		try {
			const skills = await this.context.services.agentsSkills.getSkills();
			this.context.view.postMessage({
				type: 'skillsList',
				data: { skills, isLoading: false },
			});
		} catch (error) {
			this.context.view.postMessage({
				type: 'skillsList',
				data: {
					skills: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetHooks(): Promise<void> {
		this.context.view.postMessage({ type: 'hooksList', data: { hooks: [], isLoading: true } });
		try {
			const hooks = await this.context.services.agentsHooks.getHooks();
			this.context.view.postMessage({
				type: 'hooksList',
				data: { hooks, isLoading: false },
			});
		} catch (error) {
			this.context.view.postMessage({
				type: 'hooksList',
				data: {
					hooks: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetSubagents(): Promise<void> {
		this.context.view.postMessage({
			type: 'subagentsList',
			data: { subagents: [], isLoading: true },
		});
		try {
			const subagents = await this.context.services.agentsSubagents.getSubagents();
			this.context.view.postMessage({
				type: 'subagentsList',
				data: { subagents, isLoading: false },
			});
		} catch (error) {
			this.context.view.postMessage({
				type: 'subagentsList',
				data: {
					subagents: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private async onGetRules(): Promise<void> {
		this.context.view.postMessage({ type: 'ruleList', data: { rules: [] } });
		if (!this.rulesService) {
			this.context.view.postMessage({ type: 'ruleList', data: { rules: [] } });
			return;
		}
		try {
			const rules = await this.rulesService.getRules();
			this.context.view.postMessage({ type: 'ruleList', data: { rules } });
		} catch (error) {
			logger.error('[SettingsHandler] getRules failed:', error);
			this.context.view.postMessage({ type: 'ruleList', data: { rules: [] } });
		}
	}
}
