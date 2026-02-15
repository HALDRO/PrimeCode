/**
 * @file AgentsSkillsService
 * @description Manages skills stored under `.agents/skills/<name>/SKILL.md`.
 *              Extends BaseAgentResourceService with subdirectory layout overrides.
 *              Uses vscode.workspace.fs for Remote Development compatibility.
 */

import * as vscode from 'vscode';
import type { ParsedSkill } from '../common';
import { PATHS } from '../common/constants';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { BaseAgentResourceService } from './BaseAgentResourceService';

export class AgentsSkillsService extends BaseAgentResourceService<ParsedSkill> {
	protected readonly resourceDir = PATHS.AGENTS_SKILLS_DIR;

	protected parseResource(
		attributes: Record<string, string | boolean>,
		body: string,
		skillName: string,
	): ParsedSkill {
		return {
			name: String(attributes.name || skillName),
			description: String(attributes.description || ''),
			version: attributes.version ? String(attributes.version) : undefined,
			content: body,
			path: this.buildRelativePath(skillName, 'SKILL.md'),
		};
	}

	protected stringifyResource(item: Partial<ParsedSkill> & { name: string }): {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	} {
		return {
			attributes: {
				name: item.name,
				description: item.description,
				version: item.version,
			},
			body: item.content ?? '',
		};
	}

	// Skills use subdirectory layout: skills/<name>/SKILL.md
	public override async getAll(): Promise<ParsedSkill[]> {
		if (!this._workspaceRoot) return [];
		const dir = this.dirUri();
		await this.ensureDir(dir);

		try {
			const entries = await vscode.workspace.fs.readDirectory(dir);
			const skills: ParsedSkill[] = [];

			for (const [name, type] of entries) {
				if (type !== vscode.FileType.Directory) continue;
				const skillFileUri = vscode.Uri.joinPath(dir, name, 'SKILL.md');
				if (!(await this.fileExists(skillFileUri))) continue;
				try {
					const content = await this.readTextFile(skillFileUri);
					const { attributes, body } = parseFrontmatter(content);
					skills.push(this.parseResource(attributes, body, name));
				} catch {
					/* skip broken */
				}
			}

			return skills.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			return [];
		}
	}

	public override async save(item: Partial<ParsedSkill> & { name: string }): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this.sanitizeName(item.name);
		const subDir = vscode.Uri.joinPath(this.dirUri(), safeName);
		await this.ensureDir(subDir);

		const { attributes, body } = this.stringifyResource({ ...item, name: safeName });
		const content = stringifyFrontmatter(attributes, body);
		const uri = vscode.Uri.joinPath(subDir, 'SKILL.md');
		await this.writeTextFile(uri, content);
	}

	public override async delete(name: string): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this.sanitizeName(name);
		const subDir = vscode.Uri.joinPath(this.dirUri(), safeName);
		await this.deleteFileOrDir(subDir, true);
	}

	public async importFromAllSources(): Promise<{ imported: number; sources: string[] }> {
		if (!this._workspaceRoot) return { imported: 0, sources: [] };
		let imported = 0;
		const sources = new Set<string>();

		const fromOC = await this._importFromSubdirSource(PATHS.OPENCODE_SKILL_DIR);
		if (fromOC > 0) {
			imported += fromOC;
			sources.add('OpenCode');
		}

		const fromCursor = await this._importFromSubdirSource(PATHS.CURSOR_SKILLS_DIR);
		if (fromCursor > 0) {
			imported += fromCursor;
			sources.add('Cursor');
		}

		return { imported, sources: Array.from(sources) };
	}

	public async syncToCLI(): Promise<{ synced: number }> {
		if (!this._workspaceRoot) return { synced: 0 };
		const skills = await this.getAll();
		const targetBase = this.dirUri(PATHS.OPENCODE_SKILL_DIR);
		await this.ensureDir(targetBase);
		let synced = 0;

		for (const skill of skills) {
			const { attributes, body } = this.stringifyResource(skill);
			const content = stringifyFrontmatter(attributes, body);
			const targetDir = vscode.Uri.joinPath(targetBase, skill.name);
			await this.ensureDir(targetDir);
			await this.writeTextFile(vscode.Uri.joinPath(targetDir, 'SKILL.md'), content);
			synced++;
		}

		return { synced };
	}

	/** Import from a source that uses the same subdirectory layout (<name>/SKILL.md). */
	private async _importFromSubdirSource(sourceRelative: string): Promise<number> {
		if (!this._workspaceRoot) return 0;
		const sourceUri = this.dirUri(sourceRelative);
		const targetUri = this.dirUri();

		try {
			await vscode.workspace.fs.stat(sourceUri);
		} catch {
			return 0;
		}
		await this.ensureDir(targetUri);

		const entries = await vscode.workspace.fs.readDirectory(sourceUri);
		let count = 0;

		for (const [name, type] of entries) {
			if (type !== vscode.FileType.Directory) continue;
			const srcFile = vscode.Uri.joinPath(sourceUri, name, 'SKILL.md');
			const dstDir = vscode.Uri.joinPath(targetUri, name);
			const dstFile = vscode.Uri.joinPath(dstDir, 'SKILL.md');

			if (await this.fileExists(dstFile)) continue;
			if (!(await this.fileExists(srcFile))) continue;

			await this.ensureDir(dstDir);
			const content = await this.readTextFile(srcFile);
			await this.writeTextFile(dstFile, content);
			count++;
		}

		return count;
	}
}
