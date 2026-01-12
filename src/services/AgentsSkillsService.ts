/**
 * @file AgentsSkillsService
 * @description Manages skills stored under `.agents/skills/<name>/SKILL.md`.
 *              Provides CRUD plus import/sync to legacy Claude (`.claude/skills/`) and
 *              OpenCode (`.opencode/skill/`) locations. Uses `.agents/` as the canonical store.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PATHS } from '../shared/constants';
import type { ParsedSkill } from '../types';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { normalizeToPosixPath } from '../utils/path';
import { ErrorCode, ExtensionError } from './ErrorService';
import { FileService } from './FileService';

const fileService = new FileService();

export class AgentsSkillsService {
	private _workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	private get workspaceRoot(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return this._workspaceRoot;
	}

	private get agentsSkillsDir(): string {
		return path.join(this.workspaceRoot, PATHS.AGENTS_SKILLS_DIR);
	}

	private get claudeSkillsDir(): string {
		return path.join(this.workspaceRoot, PATHS.CLAUDE_SKILLS_DIR);
	}

	private get openCodeSkillDir(): string {
		return path.join(this.workspaceRoot, PATHS.OPENCODE_SKILL_DIR);
	}

	private get cursorSkillsDir(): string {
		return path.join(this.workspaceRoot, PATHS.CURSOR_SKILLS_DIR);
	}

	public async getSkills(): Promise<ParsedSkill[]> {
		await fileService.ensureDirectoryExists(this.agentsSkillsDir);
		const skills: ParsedSkill[] = [];

		const entries = await fs.readdir(this.agentsSkillsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const skillName = entry.name;
			const skillPath = path.join(this.agentsSkillsDir, skillName, 'SKILL.md');
			try {
				const exists = await fileService.fileExists(skillPath);
				if (!exists) continue;
				const content = await fs.readFile(skillPath, 'utf8');
				skills.push(this._parseSkillFile(content, skillName));
			} catch {
				// Skip broken skills
			}
		}

		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	public async saveSkill(
		skill: Pick<ParsedSkill, 'name' | 'description' | 'content' | 'version'>,
	): Promise<void> {
		await fileService.ensureDirectoryExists(this.agentsSkillsDir);

		const safeName = this._sanitizeSkillName(skill.name);
		const dir = path.join(this.agentsSkillsDir, safeName);
		await fileService.ensureDirectoryExists(dir);

		const filePath = path.join(dir, 'SKILL.md');
		await fs.writeFile(filePath, this._stringifySkill({ ...skill, name: safeName }), 'utf8');
	}

	public async deleteSkill(name: string): Promise<void> {
		const safeName = this._sanitizeSkillName(name);
		const dir = path.join(this.agentsSkillsDir, safeName);
		await fs.rm(dir, { recursive: true, force: true });
	}

	public async importFromAllSources(): Promise<{ imported: number; sources: string[] }> {
		let imported = 0;
		const sources = new Set<string>();

		const fromClaude = await this._importFromDirectory(this.claudeSkillsDir, 'claude');
		if (fromClaude > 0) {
			imported += fromClaude;
			sources.add('Claude CLI');
		}

		const fromOpenCode = await this._importFromDirectory(this.openCodeSkillDir, 'opencode');
		if (fromOpenCode > 0) {
			imported += fromOpenCode;
			sources.add('OpenCode');
		}

		const fromCursor = await this._importFromDirectory(this.cursorSkillsDir, 'cursor');
		if (fromCursor > 0) {
			imported += fromCursor;
			sources.add('Cursor');
		}

		return { imported, sources: Array.from(sources) };
	}

	public async syncToCLI(): Promise<{ synced: number }> {
		const skills = await this.getSkills();
		let synced = 0;

		await fileService.ensureDirectoryExists(this.claudeSkillsDir);
		await fileService.ensureDirectoryExists(this.openCodeSkillDir);
		// Cursor is read-only: do not write .cursor/skills

		for (const skill of skills) {
			const content = this._stringifySkill(skill);

			// Sync to Claude (.claude/skills/)
			const claudeTargetDir = path.join(this.claudeSkillsDir, skill.name);
			await fileService.ensureDirectoryExists(claudeTargetDir);
			await fs.writeFile(path.join(claudeTargetDir, 'SKILL.md'), content, 'utf8');

			// Sync to OpenCode (.opencode/skill/)
			const openCodeTargetDir = path.join(this.openCodeSkillDir, skill.name);
			await fileService.ensureDirectoryExists(openCodeTargetDir);
			await fs.writeFile(path.join(openCodeTargetDir, 'SKILL.md'), content, 'utf8');

			// Cursor is read-only: do not write .cursor/skills

			synced += 1;
		}

		return { synced };
	}

	private _sanitizeSkillName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed)
			throw new ExtensionError('Skill name is required', ErrorCode.VALIDATION_INVALID_INPUT);
		// Keep it permissive but safe for folder names.
		return trimmed.replace(/[\\/:*?"<>|]/g, '-');
	}

	private _parseSkillFile(raw: string, skillName: string): ParsedSkill {
		const { attributes, body } = parseFrontmatter(raw);

		return {
			name: String(attributes.name || skillName),
			description: String(attributes.description || ''),
			version: attributes.version ? String(attributes.version) : undefined,
			content: body,
			path: normalizeToPosixPath(path.join(PATHS.AGENTS_SKILLS_DIR, skillName, 'SKILL.md')),
		};
	}

	private _stringifySkill(
		skill: Pick<ParsedSkill, 'name' | 'description' | 'content' | 'version'>,
	): string {
		const attributes: Record<string, string | boolean | undefined> = {
			name: skill.name,
			description: skill.description,
			version: skill.version,
		};
		return stringifyFrontmatter(attributes, skill.content);
	}

	private async _importFromDirectory(
		dir: string,
		_source: 'claude' | 'opencode' | 'cursor',
	): Promise<number> {
		const exists = await fileService.directoryExists(dir);
		if (!exists) return 0;

		await fileService.ensureDirectoryExists(this.agentsSkillsDir);

		const entries = await fs.readdir(dir, { withFileTypes: true });
		let count = 0;
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = entry.name;
			const srcPath = path.join(dir, name, 'SKILL.md');
			const dstDir = path.join(this.agentsSkillsDir, name);
			const dstPath = path.join(dstDir, 'SKILL.md');

			if (await fileService.fileExists(dstPath)) continue;
			if (!(await fileService.fileExists(srcPath))) continue;

			await fileService.ensureDirectoryExists(dstDir);
			const content = await fs.readFile(srcPath, 'utf8');
			// Normalize to our canonical content: keep as-is.
			await fs.writeFile(dstPath, content, 'utf8');
			count += 1;
		}

		return count;
	}
}

export const agentsSkillsService = new AgentsSkillsService();
