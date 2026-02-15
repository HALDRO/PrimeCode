/**
 * @file ResourceService
 * @description Unified service for all agent resources (commands, skills, hooks, subagents).
 *              Config-driven implementation. Uses vscode.workspace.fs for Remote Development.
 */

import * as path from 'node:path';
import yaml from 'js-yaml';
import * as vscode from 'vscode';
import type { ParsedCommand, ParsedHook, ParsedSkill, ParsedSubagent } from '../common';
import { PATHS } from '../common/constants';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { normalizeToPosixPath } from '../utils/path';

// =============================================================================
// Types
// =============================================================================

export type ResourceType = 'commands' | 'skills' | 'hooks' | 'subagents';

type ResourceItem = ParsedCommand | ParsedSkill | ParsedHook | ParsedSubagent;

interface ResourceConfig<T extends ResourceItem> {
	dir: string;
	/** If true, uses subdirectory layout: <dir>/<name>/SKILL.md */
	subdirLayout: boolean;
	getFileName: (name: string) => string;
	getNameFromFileName: (fileName: string) => string;
	parse: (
		attrs: Record<string, string | boolean>,
		body: string,
		fileName: string,
		buildPath: (...s: string[]) => string,
	) => T;
	stringify: (item: Partial<T> & { name: string }) => {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	};
	/** Custom save logic (e.g. subagents use yaml.dump) */
	customSave?: (item: Partial<T> & { name: string }, helpers: SaveHelpers) => Promise<void>;
}

interface SaveHelpers {
	dirUri: vscode.Uri;
	ensureDir: (uri: vscode.Uri) => Promise<void>;
	writeTextFile: (uri: vscode.Uri, content: string) => Promise<void>;
	sanitizeName: (name: string) => string;
}

// =============================================================================
// Resource Configs
// =============================================================================

const CONFIGS: Record<ResourceType, ResourceConfig<ResourceItem>> = {
	commands: {
		dir: PATHS.OPENCODE_COMMANDS_DIR,
		subdirLayout: false,
		getFileName: name => `${name}.md`,
		getNameFromFileName: fn => fn.replace(/\.md$/, ''),
		parse: (attrs, body, fileName, buildPath) => ({
			name: fileName.replace(/\.md$/, ''),
			description: String(attrs.description || ''),
			prompt: body,
			allowedTools: attrs['allowed-tools']
				? String(attrs['allowed-tools'])
						.split(',')
						.map((s: string) => s.trim())
				: undefined,
			argumentHint: attrs['argument-hint'] ? String(attrs['argument-hint']) : undefined,
			agent: attrs.agent ? String(attrs.agent) : undefined,
			model: attrs.model ? String(attrs.model) : undefined,
			subtask: attrs.subtask === true,
			path: buildPath(fileName),
		}),
		stringify: (item: Partial<ParsedCommand> & { name: string }) => ({
			attributes: {
				description: item.description,
				'allowed-tools': item.allowedTools?.join(', '),
				'argument-hint': item.argumentHint,
				agent: item.agent,
				model: item.model,
				subtask: item.subtask,
			},
			body: item.prompt ?? '',
		}),
	},

	hooks: {
		dir: PATHS.OPENCODE_PLUGINS_DIR,
		subdirLayout: false,
		getFileName: name => `hookify.${name}.local.md`,
		getNameFromFileName: fn =>
			fn
				.replace(/^hookify\./, '')
				.replace(/\.local\.md$/, '')
				.replace(/\.md$/, ''),
		parse: (attrs, body, fileName, buildPath) => {
			const nameFromFile = fileName
				.replace(/^hookify\./, '')
				.replace(/\.local\.md$/, '')
				.replace(/\.md$/, '');
			return {
				name: String(attrs.name || nameFromFile),
				enabled: attrs.enabled !== false,
				event: String(attrs.event || 'all'),
				pattern: attrs.pattern ? String(attrs.pattern) : undefined,
				action: attrs.action ? String(attrs.action) : undefined,
				content: body,
				path: buildPath(fileName),
			};
		},
		stringify: (item: Partial<ParsedHook> & { name: string }) => ({
			attributes: {
				name: item.name,
				enabled: item.enabled,
				event: item.event,
				pattern: item.pattern,
				action: item.action,
			},
			body: item.content ?? '',
		}),
	},

	skills: {
		dir: PATHS.OPENCODE_SKILLS_DIR,
		subdirLayout: true,
		getFileName: name => `${name}.md`,
		getNameFromFileName: fn => fn.replace(/\.md$/, ''),
		parse: (attrs, body, skillName, buildPath) => ({
			name: String(attrs.name || skillName),
			description: String(attrs.description || ''),
			version: attrs.version ? String(attrs.version) : undefined,
			content: body,
			path: buildPath(skillName, 'SKILL.md'),
		}),
		stringify: (item: Partial<ParsedSkill> & { name: string }) => ({
			attributes: {
				name: item.name,
				description: item.description,
				version: item.version,
			},
			body: item.content ?? '',
		}),
	},

	subagents: {
		dir: PATHS.OPENCODE_AGENTS_DIR,
		subdirLayout: false,
		getFileName: name => `${name}.md`,
		getNameFromFileName: fn => fn.replace(/\.md$/, ''),
		parse: (attrs, body, fileName, buildPath) => {
			const inferredName = fileName.replace(/\.md$/, '');
			const name =
				typeof attrs.name === 'string' && (attrs.name as string).trim()
					? (attrs.name as string).trim()
					: inferredName;
			return {
				name,
				description: typeof attrs.description === 'string' ? attrs.description : 'Subagent',
				prompt: body.trim(),
				path: buildPath(fileName),
			};
		},
		stringify: (item: Partial<ParsedSubagent> & { name: string }) => ({
			attributes: { name: item.name, description: item.description },
			body: item.prompt ?? '',
		}),
		customSave: async (item, helpers) => {
			const safeName = helpers.sanitizeName(item.name).replace(/\s/g, '-');
			await helpers.ensureDir(helpers.dirUri);
			const sub = item as Partial<ParsedSubagent> & { opencode?: Record<string, unknown> };
			const attrs: Record<string, unknown> = {
				name: safeName,
				description: sub.description,
				...(sub.opencode ? { opencode: sub.opencode } : {}),
			};
			const yamlStr = yaml.dump(attrs, { lineWidth: -1 }).trim();
			const content = `---\n${yamlStr}\n---\n\n${((item as Partial<ParsedSubagent>).prompt ?? '').trim()}\n`;
			const uri = vscode.Uri.joinPath(helpers.dirUri, `${safeName}.md`);
			await helpers.writeTextFile(uri, content);
		},
	},
};

// =============================================================================
// Unified Service
// =============================================================================

export class ResourceService {
	private _workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	// =========================================================================
	// Public API
	// =========================================================================

	public async getAll(type: ResourceType): Promise<ResourceItem[]> {
		if (!this._workspaceRoot) return [];
		const cfg = CONFIGS[type];
		const dir = this.dirUri(cfg.dir);
		await this.ensureDir(dir);

		try {
			if (cfg.subdirLayout) {
				return await this.getAllSubdir(cfg, dir);
			}
			return await this.getAllFlat(cfg, dir);
		} catch {
			return [];
		}
	}

	public async save(
		type: ResourceType,
		item: Partial<ResourceItem> & { name: string },
	): Promise<void> {
		if (!this._workspaceRoot) return;
		const cfg = CONFIGS[type];
		const safeName = this.sanitizeName(item.name);

		if (cfg.customSave) {
			await cfg.customSave({ ...item, name: safeName }, this.saveHelpers(cfg));
			return;
		}

		if (cfg.subdirLayout) {
			await this.saveSubdir(cfg, { ...item, name: safeName });
		} else {
			await this.saveFlat(cfg, { ...item, name: safeName });
		}
	}

	public async delete(type: ResourceType, name: string): Promise<void> {
		if (!this._workspaceRoot) return;
		const cfg = CONFIGS[type];
		const safeName = this.sanitizeName(name);

		if (cfg.subdirLayout) {
			const subDir = vscode.Uri.joinPath(this.dirUri(cfg.dir), safeName);
			await this.deleteFileOrDir(subDir, true);
		} else {
			const uri = vscode.Uri.joinPath(this.dirUri(cfg.dir), cfg.getFileName(safeName));
			await this.deleteFileOrDir(uri);
		}
	}

	// =========================================================================
	// Flat layout (commands, hooks, subagents)
	// =========================================================================

	/**
	 * Read and parse a single .md resource file.
	 * Shared by both flat and subdir layouts to avoid duplication.
	 */
	private async _loadResource(
		cfg: ResourceConfig<ResourceItem>,
		uri: vscode.Uri,
		identifier: string,
		buildPath: (...s: string[]) => string,
	): Promise<ResourceItem | null> {
		try {
			const content = await this.readTextFile(uri);
			const { attributes, body } = parseFrontmatter(content);
			return cfg.parse(attributes, body, identifier, buildPath);
		} catch {
			return null;
		}
	}

	private async getAllFlat(
		cfg: ResourceConfig<ResourceItem>,
		dir: vscode.Uri,
	): Promise<ResourceItem[]> {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const buildPath = (...s: string[]) => normalizeToPosixPath(path.join(cfg.dir, ...s));

		const results = await Promise.all(
			entries
				.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
				.map(([name]) => {
					const uri = vscode.Uri.joinPath(dir, name);
					return this._loadResource(cfg, uri, name, buildPath);
				}),
		);

		return results
			.filter((item): item is ResourceItem => item !== null)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async saveFlat(
		cfg: ResourceConfig<ResourceItem>,
		item: Partial<ResourceItem> & { name: string },
	): Promise<void> {
		const dir = this.dirUri(cfg.dir);
		await this.ensureDir(dir);
		const { attributes, body } = cfg.stringify(item);
		const content = stringifyFrontmatter(attributes, body);
		const uri = vscode.Uri.joinPath(dir, cfg.getFileName(item.name));
		await this.writeTextFile(uri, content);
	}

	// =========================================================================
	// Subdir layout (skills)
	// =========================================================================

	private async getAllSubdir(
		cfg: ResourceConfig<ResourceItem>,
		dir: vscode.Uri,
	): Promise<ResourceItem[]> {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const buildPath = (...s: string[]) => normalizeToPosixPath(path.join(cfg.dir, ...s));

		const results = await Promise.all(
			entries
				.filter(([, type]) => type === vscode.FileType.Directory)
				.map(async ([name]) => {
					const skillFileUri = vscode.Uri.joinPath(dir, name, 'SKILL.md');
					if (!(await this.fileExists(skillFileUri))) return null;
					return this._loadResource(cfg, skillFileUri, name, buildPath);
				}),
		);

		return results
			.filter((item): item is ResourceItem => item !== null)
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private async saveSubdir(
		cfg: ResourceConfig<ResourceItem>,
		item: Partial<ResourceItem> & { name: string },
	): Promise<void> {
		const subDir = vscode.Uri.joinPath(this.dirUri(cfg.dir), item.name);
		await this.ensureDir(subDir);
		const { attributes, body } = cfg.stringify(item);
		const content = stringifyFrontmatter(attributes, body);
		const uri = vscode.Uri.joinPath(subDir, 'SKILL.md');
		await this.writeTextFile(uri, content);
	}

	// =========================================================================
	// FS Helpers
	// =========================================================================

	private get workspaceRoot(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return this._workspaceRoot;
	}

	private dirUri(relativePath: string): vscode.Uri {
		return vscode.Uri.file(path.join(this.workspaceRoot, relativePath));
	}

	private async ensureDir(uri: vscode.Uri): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(uri);
		} catch {
			/* exists */
		}
	}

	private async readTextFile(uri: vscode.Uri): Promise<string> {
		const bytes = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(bytes);
	}

	private async writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	}

	private async fileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async deleteFileOrDir(uri: vscode.Uri, recursive = false): Promise<void> {
		try {
			await vscode.workspace.fs.delete(uri, { recursive });
		} catch (e) {
			if ((e as vscode.FileSystemError).code !== 'FileNotFound') throw e;
		}
	}

	private sanitizeName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Error('Resource name is required');
		return trimmed.replace(/[\\/:*?"<>|]/g, '-');
	}

	private saveHelpers(cfg: ResourceConfig<ResourceItem>): SaveHelpers {
		return {
			dirUri: this.dirUri(cfg.dir),
			ensureDir: uri => this.ensureDir(uri),
			writeTextFile: (uri, content) => this.writeTextFile(uri, content),
			sanitizeName: name => this.sanitizeName(name),
		};
	}
}
