/**
 * @file Rules Handler
 * @description Handles rule management (create, toggle, delete) for the webview.
 *              Simplified: no manual import/sync, everything auto-syncs.
 */

import {
	getGlobalProvider,
	getOpenCodeService,
	getWorkspaceRoot,
} from '../../services/ProviderResolver';
import { RulesService } from '../../services/RulesService';
import { logger } from '../../utils/logger';

export interface RulesHandlerDeps {
	postMessage: (msg: unknown) => void;
}

export class RulesHandler {
	private _rulesService: RulesService | undefined;

	constructor(private readonly _deps: RulesHandlerDeps) {}

	private _getRulesService(): RulesService | undefined {
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) return undefined;

		if (!this._rulesService) {
			this._rulesService = new RulesService(workspaceRoot);
		}
		return this._rulesService;
	}

	public async getRules(): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		const rules = await service.getRules();

		this._deps.postMessage({
			type: 'ruleList',
			data: { rules },
		});
	}

	public async createRule(name: string, content: string): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		const provider = getGlobalProvider();
		const openCodeService = await getOpenCodeService();

		try {
			const rule = await service.createRule(name, content, provider, openCodeService);

			this._deps.postMessage({
				type: 'ruleUpdated',
				data: { rule },
			});

			await this.getRules();
		} catch (error) {
			logger.error('[RulesHandler] Failed to create rule:', error);
		}
	}

	public async toggleRule(
		rulePath: string,
		enabled: boolean,
		source?: 'claude' | 'opencode',
	): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		const openCodeService = await getOpenCodeService();

		try {
			const ruleSource = source ?? 'claude';
			await service.toggleRule(rulePath, enabled, ruleSource, openCodeService);
			await this.getRules();
		} catch (error) {
			logger.error('[RulesHandler] Failed to toggle rule:', error);
		}
	}

	public async deleteRule(path: string): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		const openCodeService = await getOpenCodeService();

		try {
			await service.deleteRule(path, openCodeService);
			await this.getRules();
		} catch (error) {
			logger.error('[RulesHandler] Failed to delete rule:', error);
		}
	}
}
