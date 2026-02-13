/**
 * @file AgentsHooksService
 * @description Manages hook definitions stored under `.agents/hooks/`.
 *              Focuses on hookify rule files (`hookify.*.local.md`) as the
 *              lowest-common-denominator hook format we can safely sync to CLI directories.
 *              OpenCode hooks are currently experimental and intentionally handled separately.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ParsedHook } from '../common';
import { PATHS } from '../common/constants';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { normalizeToPosixPath } from '../utils/path';

export class AgentsHooksService {
	private _workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	private get workspaceRoot(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return this._workspaceRoot;
	}

	private get agentsHooksDir(): string {
		return path.join(this.workspaceRoot, PATHS.AGENTS_HOOKS_DIR);
	}

	public async getHooks(): Promise<ParsedHook[]> {
		await fs.mkdir(this.agentsHooksDir, { recursive: true });
		const files = await fs.readdir(this.agentsHooksDir, { withFileTypes: true });
		const hooks: ParsedHook[] = [];

		for (const entry of files) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith('.md')) continue;

			const fullPath = path.join(this.agentsHooksDir, entry.name);
			try {
				const content = await fs.readFile(fullPath, 'utf8');
				hooks.push(this._parseHookFile(content, entry.name));
			} catch {
				// Skip broken file
			}
		}

		return hooks.sort((a, b) => a.name.localeCompare(b.name));
	}

	public async saveHook(
		hook: Pick<ParsedHook, 'name' | 'event' | 'enabled' | 'pattern' | 'action' | 'content'>,
	): Promise<void> {
		await fs.mkdir(this.agentsHooksDir, { recursive: true });
		const safeName = this._sanitizeName(hook.name);
		const fileName = this._fileNameForHook(safeName);
		const filePath = path.join(this.agentsHooksDir, fileName);
		await fs.writeFile(filePath, this._stringifyHook({ ...hook, name: safeName }), 'utf8');
	}

	public async deleteHook(name: string): Promise<void> {
		await fs.mkdir(this.agentsHooksDir, { recursive: true });
		const safeName = this._sanitizeName(name);

		// Delete any file that resolves to this hook name.
		const hooks = await this.getHooks();
		const match = hooks.find(h => h.name === safeName);
		if (!match) return;

		await fs.unlink(path.join(this.workspaceRoot, match.path));
	}

	private _sanitizeName(name: string): string {
		const trimmed = name.trim();
		if (!trimmed) throw new Error('Hook name is required');
		return trimmed.replace(/[\\/:*?"<>|]/g, '-');
	}

	private _fileNameForHook(name: string): string {
		// Preserve hookify naming convention.
		return `hookify.${name}.local.md`;
	}

	private _parseHookFile(raw: string, filename: string): ParsedHook {
		const nameFromFile = filename
			.replace(/^hookify\./, '')
			.replace(/\.local\.md$/, '')
			.replace(/\.md$/, '');

		const { attributes, body } = parseFrontmatter(raw);

		return {
			name: String(attributes.name || nameFromFile),
			enabled: attributes.enabled !== false,
			event: String(attributes.event || 'all'),
			pattern: attributes.pattern ? String(attributes.pattern) : undefined,
			action: attributes.action ? String(attributes.action) : undefined,
			content: body,
			path: normalizeToPosixPath(path.join(PATHS.AGENTS_HOOKS_DIR, filename)),
		};
	}

	private _stringifyHook(
		hook: Pick<ParsedHook, 'name' | 'enabled' | 'event' | 'pattern' | 'action' | 'content'>,
	): string {
		const attributes: Record<string, string | boolean | undefined> = {
			name: hook.name,
			enabled: hook.enabled,
			event: hook.event,
			pattern: hook.pattern,
			action: hook.action,
		};
		return stringifyFrontmatter(attributes, hook.content ?? '');
	}
}

export const agentsHooksService = new AgentsHooksService();
