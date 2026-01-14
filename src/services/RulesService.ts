/**
 * @file Rules Service
 * @description Manages rule files with automatic sync to CLI formats.
 *              Single source of truth: `.agents/rules/` (active) and `.agents/rules/disabled/` (inactive)
 *              Auto-syncs to `.claude/rules/` and generates `AGENTS.md` + `.opencode/memories/`
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PATHS } from '../shared/constants';
import { logger } from '../utils/logger';
import { normalizeToPosixPath } from '../utils/path';
import type { OpenCodeService } from './cli/opencode/OpenCodeService';

const OPENCODE_MEMORIES_DIR = '.opencode/memories';
const OPENCODE_AGENTS_MD = 'AGENTS.md';

export interface Rule {
	name: string;
	path: string;
	isEnabled: boolean;
	source: 'claude' | 'opencode';
	content?: string;
}

export class RulesService {
	constructor(private _workspaceRoot: string) {}

	/**
	 * Get all rules from `.agents/rules/` (active and disabled)
	 */
	public async getRules(): Promise<Rule[]> {
		const rules: Rule[] = [];
		const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const disabledDir = path.join(rulesDir, 'disabled');

		try {
			// Active rules
			if (await this._dirExists(rulesDir)) {
				const files = await this._findMdFiles(rulesDir, false);
				for (const file of files) {
					rules.push({
						name: file,
						path: normalizeToPosixPath(path.join(PATHS.AGENTS_RULES_DIR, file)),
						isEnabled: true,
						source: 'claude',
					});
				}
			}

			// Disabled rules
			if (await this._dirExists(disabledDir)) {
				const files = await this._findMdFiles(disabledDir, false);
				for (const file of files) {
					rules.push({
						name: file,
						path: normalizeToPosixPath(path.join(PATHS.AGENTS_RULES_DIR, 'disabled', file)),
						isEnabled: false,
						source: 'claude',
					});
				}
			}
		} catch (error) {
			logger.warn('[RulesService] Error scanning rules:', error);
		}

		return rules.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Create a new rule and auto-sync to CLI formats
	 */
	public async createRule(
		name: string,
		content: string,
		_provider: 'claude' | 'opencode',
		openCodeService?: OpenCodeService,
	): Promise<Rule> {
		const safeName = name.endsWith('.md') ? name : `${name}.md`;
		const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		await fs.mkdir(rulesDir, { recursive: true });

		const filePath = path.join(rulesDir, safeName);
		await fs.writeFile(filePath, content, 'utf8');

		// Auto-sync to CLI formats
		await this._autoSync(openCodeService);

		return {
			name: safeName,
			path: normalizeToPosixPath(path.relative(this._workspaceRoot, filePath)),
			isEnabled: true,
			source: 'claude',
		};
	}

	/**
	 * Toggle rule enabled/disabled and auto-sync
	 */
	public async toggleRule(
		rulePath: string,
		enabled: boolean,
		_source: 'claude' | 'opencode',
		openCodeService?: OpenCodeService,
	): Promise<void> {
		const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const disabledDir = path.join(rulesDir, 'disabled');
		const fullPath = path.join(this._workspaceRoot, rulePath);
		const fileName = path.basename(rulePath);

		await fs.mkdir(rulesDir, { recursive: true });
		await fs.mkdir(disabledDir, { recursive: true });

		const targetDir = enabled ? rulesDir : disabledDir;
		const targetPath = path.join(targetDir, fileName);

		try {
			await fs.rename(fullPath, targetPath);
			await this._autoSync(openCodeService);
		} catch (error) {
			logger.error(`[RulesService] Failed to toggle rule ${rulePath}:`, error);
			throw error;
		}
	}

	/**
	 * Delete rule and auto-sync
	 */
	public async deleteRule(rulePath: string, openCodeService?: OpenCodeService): Promise<void> {
		const fullPath = path.join(this._workspaceRoot, rulePath);
		try {
			await fs.unlink(fullPath);
			await this._autoSync(openCodeService);
		} catch (error) {
			logger.error(`[RulesService] Failed to delete rule ${rulePath}:`, error);
		}
	}

	/**
	 * Auto-sync: `.agents/rules/` → `.claude/rules/` + `AGENTS.md` + `.opencode/memories/`
	 */
	private async _autoSync(openCodeService?: OpenCodeService): Promise<void> {
		await Promise.all([this._syncToClaude(), this._syncToOpenCode(openCodeService)]);
	}

	/**
	 * Sync `.agents/rules/` → `.claude/rules/` (mirror structure)
	 */
	private async _syncToClaude(): Promise<void> {
		const fromDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const toDir = path.join(this._workspaceRoot, PATHS.CLAUDE_RULES_DIR);

		try {
			// Clear target directory
			await fs.rm(toDir, { recursive: true, force: true });
			await fs.mkdir(toDir, { recursive: true });

			// Copy all files (including disabled/)
			const files = await this._findMdFiles(fromDir, true);
			for (const rel of files) {
				const src = path.join(fromDir, rel);
				const dst = path.join(toDir, rel);
				await fs.mkdir(path.dirname(dst), { recursive: true });
				await fs.copyFile(src, dst);
			}

			logger.debug(`[RulesService] Synced ${files.length} rules to .claude/rules/`);
		} catch (error) {
			logger.warn('[RulesService] Failed to sync to Claude:', error);
		}
	}

	/**
	 * Generate `AGENTS.md` (first enabled rule) + `.opencode/memories/` (rest)
	 */
	private async _syncToOpenCode(_openCodeService?: OpenCodeService): Promise<void> {
		const fromDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const memoriesDir = path.join(this._workspaceRoot, OPENCODE_MEMORIES_DIR);
		const agentsMdPath = path.join(this._workspaceRoot, OPENCODE_AGENTS_MD);

		try {
			// Get active rules sorted alphabetically
			const activeRules = (await this._findMdFiles(fromDir, false)).sort((a, b) =>
				a.localeCompare(b),
			);

			await fs.mkdir(memoriesDir, { recursive: true });

			if (activeRules.length === 0) {
				// No active rules: remove derived files
				await fs.rm(agentsMdPath, { force: true });
				await fs.rm(memoriesDir, { recursive: true, force: true });
				logger.debug('[RulesService] No active rules, cleared OpenCode files');
				return;
			}

			// First rule → AGENTS.md
			const rootRuleName = activeRules[0];
			const rootRulePath = path.join(fromDir, rootRuleName);
			const rootContent = await fs.readFile(rootRulePath, 'utf8');
			await fs.writeFile(agentsMdPath, rootContent, 'utf8');

			// Rest → .opencode/memories/
			const nonRootRules = activeRules.slice(1);
			await fs.rm(memoriesDir, { recursive: true, force: true });
			await fs.mkdir(memoriesDir, { recursive: true });

			for (const ruleName of nonRootRules) {
				const srcPath = path.join(fromDir, ruleName);
				const dstPath = path.join(memoriesDir, ruleName);
				const content = await fs.readFile(srcPath, 'utf8');
				await fs.writeFile(dstPath, content, 'utf8');
			}

			logger.debug(
				`[RulesService] Synced to OpenCode: AGENTS.md + ${nonRootRules.length} memories`,
			);
		} catch (error) {
			logger.warn('[RulesService] Failed to sync to OpenCode:', error);
		}
	}

	// =========================================================================
	// Helper Methods
	// =========================================================================

	private async _dirExists(dirPath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(dirPath);
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	private async _findMdFiles(dir: string, recursive: boolean): Promise<string[]> {
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			const files: string[] = [];

			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.md')) {
					files.push(entry.name);
				} else if (recursive && entry.isDirectory()) {
					const subFiles = await this._findMdFiles(path.join(dir, entry.name), true);
					files.push(...subFiles.map(f => path.join(entry.name, f)));
				}
			}
			return files;
		} catch {
			return [];
		}
	}
}
