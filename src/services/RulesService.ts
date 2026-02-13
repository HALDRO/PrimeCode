/**
 * @file Rules Service
 * @description Manages rule files with automatic sync to CLI formats.
 *              Single source of truth: `.agents/rules/` (active) and `.agents/rules/disabled/` (inactive)
 *              Auto-syncs to CLI directories and generates `AGENTS.md` + `.opencode/memories/`
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import { normalizeToPosixPath } from '../utils/path';

export interface Rule {
	name: string;
	path: string;
	isEnabled: boolean;
	source: 'opencode';
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
						source: 'opencode',
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
						source: 'opencode',
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
	public async createRule(name: string, content: string): Promise<Rule> {
		const safeName = name.endsWith('.md') ? name : `${name}.md`;
		const rulesDirUri = vscode.Uri.file(path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR));
		try {
			await vscode.workspace.fs.createDirectory(rulesDirUri);
		} catch {
			/* may exist */
		}

		const fileUri = vscode.Uri.joinPath(rulesDirUri, safeName);
		await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

		// Auto-sync to CLI formats
		await this._autoSync();

		return {
			name: safeName,
			path: normalizeToPosixPath(path.join(PATHS.AGENTS_RULES_DIR, safeName)),
			isEnabled: true,
			source: 'opencode',
		};
	}

	/**
	 * Toggle rule enabled/disabled and auto-sync
	 */
	public async toggleRule(rulePath: string, enabled: boolean): Promise<void> {
		const rulesDir = path.join(this._workspaceRoot, PATHS.AGENTS_RULES_DIR);
		const disabledDir = path.join(rulesDir, 'disabled');
		const fullPath = path.join(this._workspaceRoot, rulePath);
		const fileName = path.basename(rulePath);

		const rulesDirUri = vscode.Uri.file(rulesDir);
		const disabledDirUri = vscode.Uri.file(disabledDir);
		try {
			await vscode.workspace.fs.createDirectory(rulesDirUri);
		} catch {
			/* may exist */
		}
		try {
			await vscode.workspace.fs.createDirectory(disabledDirUri);
		} catch {
			/* may exist */
		}

		const targetDir = enabled ? rulesDir : disabledDir;
		const sourceUri = vscode.Uri.file(fullPath);
		const targetUri = vscode.Uri.file(path.join(targetDir, fileName));

		try {
			await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: true });
			await this._autoSync();
		} catch (error) {
			logger.error(`[RulesService] Failed to toggle rule ${rulePath}:`, error);
			throw error;
		}
	}

	/**
	 * Delete rule and auto-sync
	 */
	public async deleteRule(rulePath: string): Promise<void> {
		const fileUri = vscode.Uri.file(path.join(this._workspaceRoot, rulePath));
		try {
			await vscode.workspace.fs.delete(fileUri);
			await this._autoSync();
		} catch (error) {
			logger.error(`[RulesService] Failed to delete rule ${rulePath}:`, error);
		}
	}

	/**
	 * Auto-sync: `.agents/rules/` → `AGENTS.md` + `.opencode/memories/`
	 */
	private async _autoSync(): Promise<void> {
		await this._syncToOpenCode();
	}

	/**
	 * Generate `AGENTS.md` (first enabled rule) + `.opencode/memories/` (rest)
	 */
	private async _syncToOpenCode(): Promise<void> {
		// TODO: Implement OpenCode sync via CLIRunner if needed
	}

	// =========================================================================
	// Helper Methods
	// =========================================================================

	private async _dirExists(dirPath: string): Promise<boolean> {
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dirPath));
			return (stat.type & vscode.FileType.Directory) !== 0;
		} catch {
			return false;
		}
	}

	private async _findMdFiles(dir: string, recursive: boolean): Promise<string[]> {
		try {
			const dirUri = vscode.Uri.file(dir);
			const entries = await vscode.workspace.fs.readDirectory(dirUri);
			const files: string[] = [];

			for (const [name, type] of entries) {
				if (type === vscode.FileType.File && name.endsWith('.md')) {
					files.push(name);
				} else if (recursive && type === vscode.FileType.Directory) {
					const subFiles = await this._findMdFiles(path.join(dir, name), true);
					files.push(...subFiles.map(f => path.join(name, f)));
				}
			}
			return files;
		} catch {
			return [];
		}
	}
}
