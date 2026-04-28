/**
 * @file Rules Service
 * @description Manages rule files in `.opencode/rules/`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import { normalizeToPosixPath } from '../utils/path';
import { getGlobalOpenCodeDir } from './opencode/OpenCodeConfigService';

export interface Rule {
	name: string;
	path: string;
	source: 'opencode';
	content?: string;
}

export interface InstructionSource {
	path: string;
	scope: 'project' | 'global';
	label: string;
}

export class RulesService {
	constructor(private _workspaceRoot: string) {}

	/**
	 * Guard against path traversal: ensure the resolved path stays inside the workspace root.
	 * Throws if the path escapes the workspace boundary.
	 */
	private _assertInsideWorkspace(rulePath: string): string {
		const resolved = path.resolve(this._workspaceRoot, rulePath);
		const root = path.resolve(this._workspaceRoot);
		if (!resolved.startsWith(root + path.sep) && resolved !== root) {
			throw new Error(`Path traversal detected: ${rulePath}`);
		}
		return resolved;
	}

	/** Get all project rule files from `.opencode/rules/`. */
	public async getRules(): Promise<Rule[]> {
		const rules: Rule[] = [];
		const rulesDir = path.join(this._workspaceRoot, PATHS.OPENCODE_RULES_DIR);

		try {
			if (await this._dirExists(rulesDir)) {
				const files = await this._findMdFiles(rulesDir, false);
				for (const file of files) {
					rules.push({
						name: file,
						path: normalizeToPosixPath(path.join(PATHS.OPENCODE_RULES_DIR, file)),
						source: 'opencode',
					});
				}
			}
		} catch (error) {
			logger.warn('[RulesService] Error scanning rules:', error);
		}

		return rules.sort((a, b) => a.name.localeCompare(b.name));
	}

	public async getInstructionSources(): Promise<InstructionSource[]> {
		const sources: InstructionSource[] = [];
		const projectAgentsPath = path.join(this._workspaceRoot, 'AGENTS.md');
		if (await this._fileExists(projectAgentsPath)) {
			sources.push({
				path: normalizeToPosixPath('AGENTS.md'),
				scope: 'project',
				label: 'Project AGENTS.md',
			});
		}

		const globalDir = getGlobalOpenCodeDir();
		if (globalDir) {
			const globalAgentsPath = path.join(globalDir, 'AGENTS.md');
			if (await this._fileExists(globalAgentsPath)) {
				sources.push({
					path: normalizeToPosixPath(globalAgentsPath),
					scope: 'global',
					label: 'Global ~/.config/opencode/AGENTS.md',
				});
			}
		}

		return sources;
	}

	/**
	 * Create a new rule and auto-sync to CLI formats
	 */
	public async createRule(name: string, content: string): Promise<Rule> {
		const safeName = name.endsWith('.md') ? name : `${name}.md`;
		const rulesDirUri = vscode.Uri.file(path.join(this._workspaceRoot, PATHS.OPENCODE_RULES_DIR));
		try {
			await vscode.workspace.fs.createDirectory(rulesDirUri);
		} catch {
			/* may exist */
		}

		const fileUri = vscode.Uri.joinPath(rulesDirUri, safeName);
		await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

		return {
			name: safeName,
			path: normalizeToPosixPath(path.join(PATHS.OPENCODE_RULES_DIR, safeName)),
			source: 'opencode',
		};
	}

	/**
	 * Delete rule and auto-sync
	 */
	public async deleteRule(rulePath: string): Promise<void> {
		this._assertInsideWorkspace(rulePath);

		const fileUri = vscode.Uri.file(path.join(this._workspaceRoot, rulePath));
		try {
			await vscode.workspace.fs.delete(fileUri);
		} catch (error) {
			logger.error(`[RulesService] Failed to delete rule ${rulePath}:`, error);
			throw error;
		}
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

	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
			return (stat.type & vscode.FileType.File) !== 0;
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
