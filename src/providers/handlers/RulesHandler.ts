/**
 * @file Rules Handler
 * @description Handles rule management (create, toggle, delete) for the webview.
 *              Coordinates with RulesService and OpenCodeService.
 *              Rules are stored in `.agents/rules/` and synced to CLI-specific formats.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	getGlobalProvider,
	getOpenCodeService,
	getWorkspaceRoot,
} from '../../services/ProviderResolver';
import { RulesService } from '../../services/RulesService';
import type { Rule } from '../../types';
import { logger } from '../../utils/logger';

/** Directory for OpenCode memory files */
const OPENCODE_MEMORIES_DIR = '.opencode/memories';
/** Root rule file for OpenCode */
const OPENCODE_AGENTS_MD = 'AGENTS.md';

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

		// Get managed rules from .agents/rules/
		const managedRules = await service.getRules();

		// Get OpenCode derived files (AGENTS.md, .opencode/memories/*)
		const derivedRules = await this._getOpenCodeInstructionsAsRules();

		// Filter out derived rules that have the same name as managed rules
		// to avoid showing duplicates (e.g., if someone created AGENTS.md in .agents/rules/)
		const managedNames = new Set(managedRules.map(r => r.name));
		const uniqueDerivedRules = derivedRules.filter(r => !managedNames.has(r.name));

		const rules = [...managedRules, ...uniqueDerivedRules];

		this._deps.postMessage({
			type: 'ruleList',
			data: { rules },
		});
	}

	/**
	 * Fetches OpenCode rules from AGENTS.md and .opencode/memories/*.md files.
	 * These are read-only derived files - they are generated from .agents/rules/
	 * and should not be toggled directly.
	 */
	private async _getOpenCodeInstructionsAsRules(): Promise<Rule[]> {
		const rules: Rule[] = [];
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) return rules;

		try {
			// Check AGENTS.md (root rule) - read-only derived file
			const agentsMdPath = path.join(workspaceRoot, OPENCODE_AGENTS_MD);
			try {
				const stat = await fs.stat(agentsMdPath);
				if (stat.isFile()) {
					rules.push({
						name: OPENCODE_AGENTS_MD,
						path: OPENCODE_AGENTS_MD,
						isEnabled: true,
						source: 'opencode',
						isReadOnly: true,
					});
				}
			} catch {
				// AGENTS.md doesn't exist, that's fine
			}

			// Check .opencode/memories/*.md - read-only derived files
			const memoriesDir = path.join(workspaceRoot, OPENCODE_MEMORIES_DIR);
			try {
				const entries = await fs.readdir(memoriesDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isFile() && entry.name.endsWith('.md')) {
						rules.push({
							name: entry.name,
							path: `${OPENCODE_MEMORIES_DIR}/${entry.name}`,
							isEnabled: true,
							source: 'opencode',
							isReadOnly: true,
						});
					}
				}
			} catch {
				// memories dir doesn't exist, that's fine
			}
		} catch (error) {
			logger.warn('[RulesHandler] Error fetching OpenCode rules:', error);
		}

		return rules;
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

			// Refresh list
			await this.getRules();
		} catch (error) {
			logger.error('[RulesHandler] Failed to create rule:', error);
		}
	}

	/**
	 * Toggle rule enabled/disabled state.
	 * @param rulePath - Rule path
	 * @param enabled - New enabled state
	 * @param source - Rule source ('claude' | 'opencode'), passed explicitly from UI
	 */
	public async toggleRule(
		rulePath: string,
		enabled: boolean,
		source?: 'claude' | 'opencode',
	): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		// Prevent toggling read-only OpenCode derived files (AGENTS.md, .opencode/memories/*)
		// These are generated from .agents/rules/ and should not be modified directly
		if (rulePath === OPENCODE_AGENTS_MD || rulePath.startsWith(`${OPENCODE_MEMORIES_DIR}/`)) {
			logger.warn(
				`[RulesHandler] Cannot toggle read-only OpenCode rule: ${rulePath}. Toggle the source rule in .agents/rules/ instead.`,
			);
			return;
		}

		const openCodeService = await getOpenCodeService();

		try {
			// Use explicit source if provided, otherwise infer from path
			const ruleSource = source ?? (rulePath.includes('.opencode') ? 'opencode' : 'claude');

			await service.toggleRule(rulePath, enabled, ruleSource, openCodeService);

			// Refresh list
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

	public async importRulesFromClaude(): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		try {
			const result = await service.importFromClaudeToAgents();
			await this.getRules();
			this._deps.postMessage({
				type: 'ruleList',
				data: {
					rules: [...(await service.getRules()), ...(await this._getOpenCodeInstructionsAsRules())],
					meta: {
						operation: 'import',
						message:
							result.imported > 0
								? `Imported ${result.imported} rule${result.imported === 1 ? '' : 's'} (skipped ${result.skipped})`
								: 'No rules found to import',
					},
				},
			});
		} catch (error) {
			logger.error('[RulesHandler] Failed to import rules:', error);
		}
	}

	public async syncRulesToClaude(): Promise<void> {
		const service = this._getRulesService();
		if (!service) return;

		try {
			const result = await service.syncAgentsToClaude();
			this._deps.postMessage({
				type: 'ruleList',
				data: {
					rules: [...(await service.getRules()), ...(await this._getOpenCodeInstructionsAsRules())],
					meta: {
						operation: 'sync',
						message:
							result.synced > 0
								? `Synced ${result.synced} rule${result.synced === 1 ? '' : 's'} to CLI configs`
								: 'Nothing to sync',
					},
				},
			});
		} catch (error) {
			logger.error('[RulesHandler] Failed to sync rules:', error);
		}
	}
}
