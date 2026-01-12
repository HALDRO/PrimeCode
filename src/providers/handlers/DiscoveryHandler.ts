/**
 * @file Discovery Handler
 * @description Detects presence of rules/permissions/skills/hooks files in the workspace and
 *              reports a unified discovery status to the webview settings UI. Normalizes
 *              all returned relative paths to POSIX style for consistent rendering on Windows.
 */

import * as vscode from 'vscode';
import type { DiscoveryStatus } from '../../types';
import { logger } from '../../utils/logger';
import { normalizeToPosixPath } from '../../utils/path';

export interface DiscoveryHandlerDeps {
	postMessage: (msg: unknown) => void;
}

export class DiscoveryHandler {
	constructor(private readonly _deps: DiscoveryHandlerDeps) {}

	public async checkDiscoveryStatus(): Promise<void> {
		try {
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!workspaceRoot) return;

			// 1. Rules
			const hasAgentsMd = await this._fileExists(vscode.Uri.file(`${workspaceRoot}/AGENTS.md`));
			const hasClaudeMd = await this._fileExists(vscode.Uri.file(`${workspaceRoot}/CLAUDE.md`));
			const hasClaudeShim = hasClaudeMd && (await this._checkForShim(`${workspaceRoot}/CLAUDE.md`));

			const ruleFiles = await this._findFiles('**/.claude/rules/**/*.md');
			// OpenCode agents are in .opencode/agent/ (singular), not agents
			const opencodeAgentFiles = await this._findFiles('**/.opencode/agent/**/*.md');

			// 2. Permissions
			const hasClaudeConfig = await this._fileExists(
				vscode.Uri.file(`${workspaceRoot}/.claude/settings.json`),
			);
			const hasOpenCodeConfig = await this._fileExists(
				vscode.Uri.file(`${workspaceRoot}/opencode.json`),
			);

			// 3. Skills
			const claudeSkills = await this._findFiles('**/.claude/skills/**/SKILL.md');
			const openCodeSkills = await this._findFiles('**/.opencode/skills/**/*.md');

			// 4. Hooks (avoid brace-glob; VS Code glob support can vary)
			const hooksSh = await this._findFiles('**/.claude/hooks/**/*.sh');
			const hooksJs = await this._findFiles('**/.claude/hooks/**/*.js');
			const hooksTs = await this._findFiles('**/.claude/hooks/**/*.ts');
			const hooksPy = await this._findFiles('**/.claude/hooks/**/*.py');
			const claudeHooks = [...hooksSh, ...hooksJs, ...hooksTs, ...hooksPy];

			const status: DiscoveryStatus = {
				rules: {
					hasAgentsMd,
					hasClaudeMd,
					hasClaudeShim,
					ruleFiles: [...ruleFiles, ...opencodeAgentFiles].map(normalizeToPosixPath),
				},
				permissions: {
					claudeConfig: hasClaudeConfig ? '.claude/settings.json' : undefined,
					openCodeConfig: hasOpenCodeConfig ? 'opencode.json' : undefined,
				},
				skills: [
					...claudeSkills.map(p => ({
						name: this._getSkillName(p),
						path: normalizeToPosixPath(p),
						type: 'claude' as const,
					})),
					...openCodeSkills.map(p => ({
						name: this._getSkillName(p),
						path: normalizeToPosixPath(p),
						type: 'opencode' as const,
					})),
				],
				hooks: claudeHooks.map(p => ({
					name: this._getBaseName(p) || 'unknown',
					path: normalizeToPosixPath(p),
					type: 'claude' as const,
				})),
			};

			this._deps.postMessage({
				type: 'discoveryStatus',
				data: status,
			});
		} catch (error) {
			logger.error('[DiscoveryHandler] Error checking status:', error);
		}
	}

	public async createClaudeShim(): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return;

		const shimPath = vscode.Uri.file(`${workspaceRoot}/CLAUDE.md`);

		try {
			const exists = await this._fileExists(shimPath);
			if (exists) {
				const current = await vscode.workspace.fs.readFile(shimPath);
				const text = current.toString().trim();
				if (text.length > 0 && !text.includes('@AGENTS.md')) {
					// CLAUDE.md already exists and is not a shim - skip silently
					return;
				}
			}

			await vscode.workspace.fs.writeFile(shimPath, Buffer.from('@AGENTS.md\n'));
			await this.checkDiscoveryStatus();
			// Silent operation - no toast notifications
		} catch (error) {
			logger.error('[DiscoveryHandler] Failed to create shim:', error);
		}
	}

	// Helpers

	private async _fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async _checkForShim(filePath: string): Promise<boolean> {
		try {
			const uri = vscode.Uri.file(filePath);
			const content = await vscode.workspace.fs.readFile(uri);
			const text = content.toString().trim();
			return text.includes('@AGENTS.md');
		} catch {
			return false;
		}
	}

	private async _findFiles(pattern: string): Promise<string[]> {
		try {
			const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
			return files.map(f => normalizeToPosixPath(vscode.workspace.asRelativePath(f)));
		} catch {
			return [];
		}
	}

	private _getSkillName(filePath: string): string {
		// Extract skill name from path like .claude/skills/my-skill/SKILL.md -> my-skill
		const normalized = normalizeToPosixPath(filePath);
		const parts = normalized.split('/');
		if (parts.length >= 2) return parts[parts.length - 2];
		return normalized;
	}

	private _getBaseName(filePath: string): string | undefined {
		const normalized = normalizeToPosixPath(filePath);
		const parts = normalized.split('/');
		return parts.at(-1);
	}
}
