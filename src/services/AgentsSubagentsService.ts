/**
 * @file AgentsSubagentsService
 * @description Manages subagent definitions stored under `.agents/subagents/`.
 *              Extends BaseAgentResourceService for CRUD with vscode.workspace.fs.
 *              Supports import/sync to OpenCode `.opencode/agent/<name>.md`.
 */

import yaml from 'js-yaml';
import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { stringifyFrontmatter } from '../utils/frontmatter';
import { BaseAgentResourceService } from './BaseAgentResourceService';

export interface ParsedSubagent {
	name: string;
	description: string;
	prompt: string;
	opencode?: Record<string, unknown>;
	path: string;
}

export class AgentsSubagentsService extends BaseAgentResourceService<ParsedSubagent> {
	protected readonly resourceDir = PATHS.AGENTS_SUBAGENTS_DIR;

	protected parseResource(
		attributes: Record<string, string | boolean>,
		body: string,
		fileName: string,
	): ParsedSubagent {
		const inferredName = this.getNameFromFileName(fileName);
		const name =
			typeof attributes.name === 'string' && (attributes.name as string).trim()
				? (attributes.name as string).trim()
				: inferredName;
		const description =
			typeof attributes.description === 'string' ? attributes.description : 'Subagent';

		return {
			name,
			description,
			prompt: body.trim(),
			path: this.buildRelativePath(fileName),
		};
	}

	protected stringifyResource(item: Partial<ParsedSubagent> & { name: string }): {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	} {
		return {
			attributes: {
				name: item.name,
				description: item.description,
			},
			body: item.prompt ?? '',
		};
	}

	/**
	 * Override save to support nested opencode fields via yaml.dump.
	 */
	public override async save(item: Partial<ParsedSubagent> & { name: string }): Promise<void> {
		if (!this._workspaceRoot) return;
		const safeName = this.sanitizeName(item.name).replace(/\s/g, '-');
		const dir = this.dirUri();
		await this.ensureDir(dir);

		const attrs: Record<string, unknown> = {
			name: safeName,
			description: item.description,
			...(item.opencode ? { opencode: item.opencode } : {}),
		};
		const yamlStr = yaml.dump(attrs, { lineWidth: -1 }).trim();
		const content = `---\n${yamlStr}\n---\n\n${(item.prompt ?? '').trim()}\n`;
		const uri = vscode.Uri.joinPath(dir, `${safeName}.md`);
		await this.writeTextFile(uri, content);
	}

	public async importFromOpenCode(): Promise<{ imported: number }> {
		const count = await this.importFromFlatDir(PATHS.OPENCODE_AGENT_DIR);
		return { imported: count };
	}

	public async syncToCLI(): Promise<{ synced: number }> {
		if (!this._workspaceRoot) return { synced: 0 };
		const subagents = await this.getAll();
		const targetUri = this.dirUri(PATHS.OPENCODE_AGENT_DIR);
		await this.ensureDir(targetUri);
		let synced = 0;

		for (const sa of subagents) {
			const safeName = this.sanitizeName(sa.name).replace(/\s/g, '-');
			const openCodeAttrs: Record<string, string | boolean | undefined> = {
				description: sa.description,
				mode: 'subagent',
				name: sa.name,
			};
			if (sa.opencode) {
				for (const [key, value] of Object.entries(sa.opencode)) {
					if (typeof value === 'string' || typeof value === 'boolean') {
						openCodeAttrs[key] = value;
					} else if (value !== undefined && value !== null) {
						openCodeAttrs[key] = String(value);
					}
				}
			}
			const content = stringifyFrontmatter(openCodeAttrs, sa.prompt);
			const uri = vscode.Uri.joinPath(targetUri, `${safeName}.md`);
			await this.writeTextFile(uri, content);
			synced++;
		}

		return { synced };
	}
}

export const agentsSubagentsService = new AgentsSubagentsService();
