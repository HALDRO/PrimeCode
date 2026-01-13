/**
 * @file AgentsSubagentsService
 * @description Manages subagent definitions stored under `.agents/subagents/` as the canonical source.
 *              Provides import/sync bridges to CLI-specific subagent directories:
 *              - OpenCode: `.opencode/agent/<name>.md` (frontmatter: { description, mode: 'subagent', name? })
 *              - Claude Code: `.claude/agents/<name>.md` (frontmatter: { name, description, model?, tools?, permissionMode?, skills? })
 *              This intentionally mirrors the approach used by rulesync-main: subagents are markdown files with
 *              frontmatter + body prompt, and the command layer can reference them via the `agent` field.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { PATHS } from '../shared/constants';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { normalizeToPosixPath } from '../utils/path';
import { ErrorCode, ExtensionError, errorService } from './ErrorService';
import { FileService } from './FileService';

const fileService = new FileService();

export interface ParsedSubagent {
	name: string;
	description: string;
	prompt: string;
	/** Optional explicit target config for Claude Code agent frontmatter */
	claude?: {
		model?: string;
		tools?: string[];
		permissionMode?: string;
		skills?: string[];
	};
	/** Optional explicit OpenCode agent options (reserved for future) */
	opencode?: Record<string, unknown>;
	path: string;
}

type SubagentFrontmatter = {
	description?: unknown;
	name?: unknown;
	claude?: unknown;
	opencode?: unknown;
};

function toStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === 'string') {
		const items = value
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

export class AgentsSubagentsService {
	private _workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	private get workspaceRoot(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return this._workspaceRoot;
	}

	private get agentsSubagentsDir(): string {
		return path.join(this.workspaceRoot, PATHS.AGENTS_SUBAGENTS_DIR);
	}

	private get claudeAgentsDir(): string {
		return path.join(this.workspaceRoot, PATHS.CLAUDE_AGENTS_DIR);
	}

	private get openCodeAgentDir(): string {
		return path.join(this.workspaceRoot, PATHS.OPENCODE_AGENT_DIR);
	}

	public async getSubagents(): Promise<ParsedSubagent[]> {
		try {
			if (!this._workspaceRoot) return [];
			await fileService.ensureDirectoryExists(this.agentsSubagentsDir);
			const files = await fs.readdir(this.agentsSubagentsDir, { withFileTypes: true });
			const subagents: ParsedSubagent[] = [];

			for (const entry of files) {
				if (!entry.isFile()) continue;
				if (!entry.name.endsWith('.md')) continue;

				try {
					const absolutePath = path.join(this.agentsSubagentsDir, entry.name);
					const content = await fs.readFile(absolutePath, 'utf8');
					subagents.push(this._parseSubagentFile(content, entry.name));
				} catch (err) {
					// Skip broken file
					errorService.handle(err, 'AgentsSubagentsService.getSubagents.parse');
				}
			}

			return subagents.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			errorService.handle(error, 'AgentsSubagentsService.getSubagents');
			return [];
		}
	}

	public async saveSubagent(subagent: Omit<ParsedSubagent, 'path'>): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this._sanitizeName(subagent.name);
		try {
			await fileService.ensureDirectoryExists(this.agentsSubagentsDir);
			const filePath = path.join(this.agentsSubagentsDir, `${safeName}.md`);
			await fs.writeFile(
				filePath,
				this._stringifySubagent({ ...subagent, name: safeName }),
				'utf8',
			);
		} catch (error) {
			throw new ExtensionError('Failed to save subagent', ErrorCode.FS_WRITE_ERROR, undefined, {
				name: safeName,
				error,
			});
		}
	}

	public async deleteSubagent(name: string): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this._sanitizeName(name);
		try {
			await fileService.ensureDirectoryExists(this.agentsSubagentsDir);
			const filePath = path.join(this.agentsSubagentsDir, `${safeName}.md`);
			await fs.unlink(filePath);
		} catch (error) {
			if ((error as { code?: string }).code !== 'ENOENT') throw error;
		}
	}

	public async importFromClaude(): Promise<{ imported: number }> {
		if (!this._workspaceRoot) return { imported: 0 };
		try {
			const exists = await fileService.directoryExists(this.claudeAgentsDir);
			if (!exists) return { imported: 0 };

			await fileService.ensureDirectoryExists(this.agentsSubagentsDir);
			const files = await fs.readdir(this.claudeAgentsDir);
			let imported = 0;

			for (const file of files) {
				if (!file.endsWith('.md')) continue;
				const sourcePath = path.join(this.claudeAgentsDir, file);
				const targetPath = path.join(this.agentsSubagentsDir, file);
				if (await fileService.fileExists(targetPath)) continue;
				const content = await fs.readFile(sourcePath, 'utf8');
				await fs.writeFile(targetPath, content, 'utf8');
				imported += 1;
			}

			return { imported };
		} catch (error) {
			errorService.handle(error, 'AgentsSubagentsService.importFromClaude');
			return { imported: 0 };
		}
	}

	public async importFromOpenCode(): Promise<{ imported: number }> {
		if (!this._workspaceRoot) return { imported: 0 };
		try {
			const exists = await fileService.directoryExists(this.openCodeAgentDir);
			if (!exists) return { imported: 0 };

			await fileService.ensureDirectoryExists(this.agentsSubagentsDir);
			const files = await fs.readdir(this.openCodeAgentDir);
			let imported = 0;

			for (const file of files) {
				if (!file.endsWith('.md')) continue;
				const sourcePath = path.join(this.openCodeAgentDir, file);
				const targetPath = path.join(this.agentsSubagentsDir, file);
				if (await fileService.fileExists(targetPath)) continue;
				const content = await fs.readFile(sourcePath, 'utf8');
				await fs.writeFile(targetPath, content, 'utf8');
				imported += 1;
			}

			return { imported };
		} catch (error) {
			errorService.handle(error, 'AgentsSubagentsService.importFromOpenCode');
			return { imported: 0 };
		}
	}

	public async syncToCLI(): Promise<{ synced: number }> {
		if (!this._workspaceRoot) return { synced: 0 };

		const subagents = await this.getSubagents();
		await fileService.ensureDirectoryExists(this.claudeAgentsDir);
		await fileService.ensureDirectoryExists(this.openCodeAgentDir);

		let synced = 0;
		for (const sa of subagents) {
			const fileName = `${this._sanitizeName(sa.name)}.md`;
			// Claude
			const claudeFrontmatter: Record<string, string | boolean | undefined> = {
				name: sa.name,
				description: sa.description,
				...(sa.claude?.model ? { model: sa.claude.model } : {}),
				...(sa.claude?.tools ? { tools: sa.claude.tools.join(',') } : {}),
				...(sa.claude?.permissionMode ? { permissionMode: sa.claude.permissionMode } : {}),
				...(sa.claude?.skills ? { skills: sa.claude.skills.join(',') } : {}),
			};
			await fs.writeFile(
				path.join(this.claudeAgentsDir, fileName),
				stringifyFrontmatter(claudeFrontmatter, sa.prompt),
				'utf8',
			);

			// OpenCode
			const openCodeFrontmatter: Record<string, string | boolean | undefined> = {
				description: sa.description,
				mode: 'subagent',
				name: sa.name,
			};
			// Merge opencode-specific fields (convert unknown to string/boolean)
			if (sa.opencode) {
				for (const [key, value] of Object.entries(sa.opencode)) {
					if (typeof value === 'string' || typeof value === 'boolean') {
						openCodeFrontmatter[key] = value;
					} else if (value !== undefined && value !== null) {
						openCodeFrontmatter[key] = String(value);
					}
				}
			}
			await fs.writeFile(
				path.join(this.openCodeAgentDir, fileName),
				stringifyFrontmatter(openCodeFrontmatter, sa.prompt),
				'utf8',
			);

			synced += 1;
		}

		return { synced };
	}

	private _sanitizeName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed)
			throw new ExtensionError('Subagent name is required', ErrorCode.VALIDATION_INVALID_INPUT);
		return trimmed.replace(/[\\/:*?"<>|\s]/g, '-');
	}

	private _parseSubagentFile(raw: string, filename: string): ParsedSubagent {
		const inferredName = filename.replace(/\.md$/, '');
		const { attributes, body } = parseFrontmatter(raw);
		const frontmatter = attributes as SubagentFrontmatter;

		const name =
			typeof frontmatter.name === 'string' && frontmatter.name.trim()
				? frontmatter.name.trim()
				: inferredName;

		const description =
			typeof frontmatter.description === 'string' ? frontmatter.description : 'Subagent';

		const claudeRaw =
			frontmatter.claude && typeof frontmatter.claude === 'object' ? frontmatter.claude : undefined;
		const claude = claudeRaw
			? {
					model:
						typeof (claudeRaw as Record<string, unknown>).model === 'string'
							? String((claudeRaw as Record<string, unknown>).model)
							: undefined,
					tools: toStringArray((claudeRaw as Record<string, unknown>).tools),
					permissionMode:
						typeof (claudeRaw as Record<string, unknown>).permissionMode === 'string'
							? String((claudeRaw as Record<string, unknown>).permissionMode)
							: undefined,
					skills: toStringArray((claudeRaw as Record<string, unknown>).skills),
				}
			: undefined;

		const opencode =
			frontmatter.opencode && typeof frontmatter.opencode === 'object'
				? (frontmatter.opencode as Record<string, unknown>)
				: undefined;

		return {
			name,
			description,
			prompt: body.trim(),
			claude,
			opencode,
			path: normalizeToPosixPath(path.join(PATHS.AGENTS_SUBAGENTS_DIR, filename)),
		};
	}

	private _stringifySubagent(subagent: Omit<ParsedSubagent, 'path'>): string {
		// Use yaml.dump directly for canonical format to support nested objects (claude, opencode)
		const attributes: Record<string, unknown> = {
			name: subagent.name,
			description: subagent.description,
			...(subagent.claude ? { claude: subagent.claude } : {}),
			...(subagent.opencode ? { opencode: subagent.opencode } : {}),
		};
		const yamlStr = yaml.dump(attributes, { lineWidth: -1 }).trim();
		return `---\n${yamlStr}\n---\n\n${subagent.prompt.trim()}\n`;
	}
}

export const agentsSubagentsService = new AgentsSubagentsService();
