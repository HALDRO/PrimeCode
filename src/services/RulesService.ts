/**
 * @file Rules Service
 * @description Manages rule files and configurations for Claude and OpenCode.
 *              Implements the "Stack" concept:
 *              - File-based rules: primary `.agents/rules/` (active) vs `.agents/rules/disabled/` (inactive)
 *                with fallback to legacy `.claude/rules/` if `.agents/rules/` is empty.
 *              - OpenCode: file-based rules using `AGENTS.md` (root) and `.opencode/memories/*.md`.
 *
 *              The service intentionally separates persistence (`.agents/`) from compatibility sync
 *              (copy to/from `.claude/` and `.opencode/`) so the UI can operate on a single canonical location.
 *
 *              Cursor is READ-ONLY: we only import/parse from `.cursor/rules/`, never write to it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PATHS } from '../shared/constants';
import { logger } from '../utils/logger';
import { normalizeToPosixPath } from '../utils/path';
import type { OpenCodeService } from './cli/opencode/OpenCodeService';

/** Directory for OpenCode memory files (non-root rules) */
const OPENCODE_MEMORIES_DIR = '.opencode/memories';
/** Root rule file for OpenCode (like CLAUDE.md for Claude) */
const OPENCODE_AGENTS_MD = 'AGENTS.md';

export interface Rule {
	name: string;
	path: string;
	isEnabled: boolean;
	source: 'claude' | 'opencode';
	content?: string;
}

type RuleBaseDir = 'agents' | 'claude';

export class RulesService {
	constructor(private _workspaceRoot: string) {}

	public async getRules(): Promise<Rule[]> {
		// Prefer `.agents/rules/` if it exists and contains any `.md` files.
		const agentsRulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const hasAgentsRules = await this._hasAnyMdFiles(agentsRulesDir);

		if (hasAgentsRules) {
			return this._getFileRulesFromBaseDir('agents');
		}

		// Fallback: legacy `.claude/rules/`.
		return this._getFileRulesFromBaseDir('claude');
	}

	public async importFromClaudeToAgents(): Promise<{ imported: number; skipped: number }> {
		const toDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		let totalImported = 0;
		let totalSkipped = 0;

		// Import from Claude (.claude/rules/)
		const claudeDir = path.join(this._workspaceRoot, PATHS.CLAUDE_RULES_DIR);
		const claudeResult = await this._importRulesDirectory(claudeDir, toDir);
		totalImported += claudeResult.imported;
		totalSkipped += claudeResult.skipped;

		// Import from Cursor (.cursor/rules/)
		const cursorDir = path.join(this._workspaceRoot, PATHS.CURSOR_RULES_DIR);
		const cursorResult = await this._importRulesDirectory(cursorDir, toDir);
		totalImported += cursorResult.imported;
		totalSkipped += cursorResult.skipped;

		// Import from legacy OpenCode (.opencode/rules/)
		const legacyOpenCodeDir = path.join(this._workspaceRoot, '.opencode', 'rules');
		const legacyResult = await this._importRulesDirectory(legacyOpenCodeDir, toDir);
		totalImported += legacyResult.imported;
		totalSkipped += legacyResult.skipped;

		// Import from OpenCode memories (.opencode/memories/)
		const memoriesDir = path.join(this._workspaceRoot, OPENCODE_MEMORIES_DIR);
		const memoriesResult = await this._importRulesDirectory(memoriesDir, toDir);
		totalImported += memoriesResult.imported;
		totalSkipped += memoriesResult.skipped;

		// Import from AGENTS.md (root OpenCode rule)
		const agentsMdPath = path.join(this._workspaceRoot, OPENCODE_AGENTS_MD);
		const agentsMdResult = await this._importSingleFile(agentsMdPath, toDir, 'agents-root.md');
		totalImported += agentsMdResult.imported;
		totalSkipped += agentsMdResult.skipped;

		return { imported: totalImported, skipped: totalSkipped };
	}

	/**
	 * Import a single file to target directory with optional rename.
	 */
	private async _importSingleFile(
		sourcePath: string,
		targetDir: string,
		targetName?: string,
	): Promise<{ imported: number; skipped: number }> {
		try {
			if (!(await this._fileExists(sourcePath))) return { imported: 0, skipped: 0 };

			await fs.mkdir(targetDir, { recursive: true });
			const fileName = targetName || path.basename(sourcePath);
			const targetPath = path.join(targetDir, fileName);

			if (await this._fileExists(targetPath)) {
				return { imported: 0, skipped: 1 };
			}

			await fs.copyFile(sourcePath, targetPath);
			logger.info(`[RulesService] Imported ${sourcePath} → ${targetPath}`);
			return { imported: 1, skipped: 0 };
		} catch (error) {
			logger.warn(`[RulesService] Failed to import ${sourcePath}:`, error);
			return { imported: 0, skipped: 0 };
		}
	}

	public async syncAgentsToClaude(): Promise<{ synced: number }> {
		const fromDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		let totalSynced = 0;

		// Sync to Claude (.claude/rules/)
		const claudeDir = path.join(this._workspaceRoot, PATHS.CLAUDE_RULES_DIR);
		const claudeResult = await this._syncRulesDirectory(fromDir, claudeDir);
		totalSynced += claudeResult.synced;

		// Cursor is read-only: do not sync to .cursor/rules

		return { synced: totalSynced };
	}

	/**
	 * Sync rules from `.agents/rules/` to OpenCode format:
	 * - First active rule → `AGENTS.md` (root)
	 * - Remaining active rules → `.opencode/memories/*.md`
	 *
	 * OpenCode compatibility files are treated as derived artifacts.
	 * This method removes orphaned `.md` files in `.opencode/memories/` that are not in the current active set.
	 */
	public async syncAgentsToOpenCode(
		_openCodeService?: OpenCodeService,
	): Promise<{ synced: number }> {
		const fromDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const memoriesDir = path.join(this._workspaceRoot, OPENCODE_MEMORIES_DIR);
		const agentsMdPath = path.join(this._workspaceRoot, OPENCODE_AGENTS_MD);

		const activeRules = (await this._findMdFiles(fromDir, false))
			.map(normalizeToPosixPath)
			// Deterministic ordering is required: the first rule becomes AGENTS.md.
			.sort((a, b) => a.localeCompare(b));

		await fs.mkdir(memoriesDir, { recursive: true });

		if (activeRules.length === 0) {
			// No active rules: remove derived OpenCode artifacts.
			try {
				await fs.unlink(agentsMdPath);
			} catch {
				// ignore
			}

			await this._removeOrphanedMemories(memoriesDir, new Set());
			logger.info('[RulesService] No active rules to sync to OpenCode');
			return { synced: 0 };
		}

		let synced = 0;

		// First rule becomes AGENTS.md (root)
		const firstRulePath = path.join(fromDir, activeRules[0]);
		const firstRuleContent = await fs.readFile(firstRulePath, 'utf8');
		await fs.writeFile(agentsMdPath, firstRuleContent, 'utf8');
		synced++;
		logger.debug(`[RulesService] Synced ${activeRules[0]} → AGENTS.md`);

		// Remaining rules go to .opencode/memories/
		const expectedMemoryFiles = new Set<string>();
		for (let i = 1; i < activeRules.length; i++) {
			const ruleName = activeRules[i];
			const srcPath = path.join(fromDir, ruleName);
			const dstPath = path.join(memoriesDir, ruleName);

			await fs.mkdir(path.dirname(dstPath), { recursive: true });
			const content = await fs.readFile(srcPath, 'utf8');
			await fs.writeFile(dstPath, content, 'utf8');
			expectedMemoryFiles.add(normalizeToPosixPath(ruleName));
			synced++;
			logger.debug(`[RulesService] Synced ${ruleName} → .opencode/memories/${ruleName}`);
		}

		await this._removeOrphanedMemories(memoriesDir, expectedMemoryFiles);

		logger.info(`[RulesService] Synced ${synced} rules to OpenCode format`);
		return { synced };
	}

	private async _removeOrphanedMemories(memoriesDir: string, expected: Set<string>): Promise<void> {
		const files = await this._findMdFiles(memoriesDir, true);

		for (const rel of files) {
			const relPosix = normalizeToPosixPath(rel);
			if (expected.has(relPosix)) continue;

			const absolutePath = path.join(memoriesDir, rel);
			try {
				await fs.unlink(absolutePath);
				logger.debug(`[RulesService] Removed orphaned OpenCode memory: ${relPosix}`);
			} catch (error) {
				logger.warn(`[RulesService] Failed to delete OpenCode memory ${relPosix}:`, error);
			}
		}
	}

	public async createRule(
		name: string,
		content: string,
		provider: 'claude' | 'opencode',
		openCodeService?: OpenCodeService,
	): Promise<Rule> {
		const safeName = name.endsWith('.md') ? name : `${name}.md`;

		if (provider === 'claude') {
			const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
			await fs.mkdir(rulesDir, { recursive: true });

			const filePath = path.join(rulesDir, safeName);
			await fs.writeFile(filePath, content, 'utf8');

			// Keep Claude CLI compatibility in sync
			await this.syncAgentsToClaude();

			return {
				name: safeName,
				path: normalizeToPosixPath(path.relative(this._workspaceRoot, filePath)),
				isEnabled: true,
				source: 'claude',
			};
		}

		// OpenCode: Create file in .agents/rules/ (canonical) and sync to OpenCode format
		const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		await fs.mkdir(rulesDir, { recursive: true });

		const filePath = path.join(rulesDir, safeName);
		await fs.writeFile(filePath, content, 'utf8');

		// Sync to OpenCode format (AGENTS.md + .opencode/memories/)
		await this.syncAgentsToOpenCode(openCodeService);

		return {
			name: safeName,
			path: normalizeToPosixPath(path.relative(this._workspaceRoot, filePath)),
			isEnabled: true,
			source: 'opencode',
		};
	}

	public async toggleRule(
		rulePath: string,
		enabled: boolean,
		_source: 'claude' | 'opencode',
		openCodeService?: OpenCodeService,
	): Promise<void> {
		// Both Claude and OpenCode now use file-based rules in .agents/rules/
		await this._toggleFileRule(rulePath, enabled);

		// Keep CLI compatibility in sync
		if (this._inferRuleBase(rulePath) === 'agents') {
			await this.syncAgentsToClaude();
			await this.syncAgentsToOpenCode(openCodeService);
		}
	}

	public async deleteRule(rulePath: string, openCodeService?: OpenCodeService): Promise<void> {
		const fullPath = path.join(this._workspaceRoot, rulePath);
		try {
			await fs.unlink(fullPath);
			// Keep CLI compatibility in sync
			if (this._inferRuleBase(rulePath) === 'agents') {
				await this.syncAgentsToClaude();
				await this.syncAgentsToOpenCode(openCodeService);
			}
		} catch (error) {
			logger.error(`[RulesService] Failed to delete rule ${rulePath}:`, error);
		}
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private async _getFileRulesFromBaseDir(base: RuleBaseDir): Promise<Rule[]> {
		const rules: Rule[] = [];
		const baseDir =
			base === 'agents'
				? path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR)
				: path.join(this._workspaceRoot, PATHS.CLAUDE_RULES_DIR);

		try {
			const disabledDir = path.join(baseDir, 'disabled');

			// Active rules
			if (await this._dirExists(baseDir)) {
				const files = await this._findMdFiles(baseDir, true);
				for (const file of files) {
					if (normalizeToPosixPath(file).startsWith('disabled/')) continue;
					rules.push({
						name: path.basename(file),
						path: normalizeToPosixPath(path.join(this._toRelRoot(base), file)),
						isEnabled: true,
						source: 'claude',
					});
				}
			}

			// Disabled rules
			if (await this._dirExists(disabledDir)) {
				const files = await this._findMdFiles(disabledDir, true);
				for (const file of files) {
					rules.push({
						name: path.basename(file),
						path: normalizeToPosixPath(path.join(this._toRelRoot(base), 'disabled', file)),
						isEnabled: false,
						source: 'claude',
					});
				}
			}
		} catch (error) {
			logger.warn('[RulesService] Error scanning file-based rules:', error);
		}

		return rules;
	}

	private _toRelRoot(base: RuleBaseDir): string {
		return base === 'agents' ? PATHS.AGENTS_RULES_DIR : PATHS.CLAUDE_RULES_DIR;
	}

	private async _toggleFileRule(rulePath: string, enabled: boolean): Promise<void> {
		const base = this._inferRuleBase(rulePath);
		const baseDir =
			base === 'agents'
				? path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR)
				: path.join(this._workspaceRoot, PATHS.CLAUDE_RULES_DIR);

		const fullPath = path.join(this._workspaceRoot, rulePath);
		const fileName = path.basename(rulePath);

		const rulesDir = baseDir;
		const disabledDir = path.join(baseDir, 'disabled');
		await fs.mkdir(rulesDir, { recursive: true });
		await fs.mkdir(disabledDir, { recursive: true });

		const targetDir = enabled ? rulesDir : disabledDir;
		const targetPath = path.join(targetDir, fileName);

		try {
			await fs.rename(fullPath, targetPath);
		} catch (error) {
			logger.error(`[RulesService] Failed to toggle rule ${rulePath}:`, error);
			throw error;
		}
	}

	private _inferRuleBase(rulePath: string): RuleBaseDir {
		const posix = normalizeToPosixPath(rulePath);
		if (posix.startsWith(`${PATHS.AGENTS_RULES_DIR}/`) || posix === PATHS.AGENTS_RULES_DIR)
			return 'agents';
		return 'claude';
	}

	private async _hasAnyMdFiles(dir: string): Promise<boolean> {
		if (!(await this._dirExists(dir))) return false;
		const files = await this._findMdFiles(dir, true);
		return files.length > 0;
	}

	private async _importRulesDirectory(
		sourceRootDir: string,
		targetRootDir: string,
	): Promise<{ imported: number; skipped: number }> {
		try {
			if (!(await this._dirExists(sourceRootDir))) return { imported: 0, skipped: 0 };
			await fs.mkdir(targetRootDir, { recursive: true });

			const files = await this._findMdFiles(sourceRootDir, true);
			let imported = 0;
			let skipped = 0;

			for (const rel of files) {
				const src = path.join(sourceRootDir, rel);
				const dst = path.join(targetRootDir, rel);

				await fs.mkdir(path.dirname(dst), { recursive: true });

				if (await this._fileExists(dst)) {
					skipped++;
					continue;
				}

				await fs.copyFile(src, dst);
				imported++;
			}

			return { imported, skipped };
		} catch (error) {
			logger.warn('[RulesService] Import failed:', error);
			return { imported: 0, skipped: 0 };
		}
	}

	private async _syncRulesDirectory(
		sourceRootDir: string,
		targetRootDir: string,
	): Promise<{ synced: number }> {
		await fs.mkdir(targetRootDir, { recursive: true });
		const files = await this._findMdFiles(sourceRootDir, true);
		let synced = 0;

		for (const rel of files) {
			const src = path.join(sourceRootDir, rel);
			const dst = path.join(targetRootDir, rel);
			await fs.mkdir(path.dirname(dst), { recursive: true });
			await fs.copyFile(src, dst);
			synced++;
		}

		return { synced };
	}

	private async _dirExists(dirPath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(dirPath);
			return stat.isDirectory();
		} catch {
			return false;
		}
	}

	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			const stat = await fs.stat(filePath);
			return stat.isFile();
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
