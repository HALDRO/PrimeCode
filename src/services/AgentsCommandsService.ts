/**
 * @file AgentsCommandsService
 * @description Manages custom commands (prompts) in .agents/commands/.
 *              Extends BaseAgentResourceService for CRUD with vscode.workspace.fs.
 *              Supports import from legacy CLI directories (.opencode/command/, .cursor/commands/).
 */

import type { ParsedCommand } from '../common';
import { PATHS } from '../common/constants';
import { BaseAgentResourceService } from './BaseAgentResourceService';

export class AgentsCommandsService extends BaseAgentResourceService<ParsedCommand> {
	protected readonly resourceDir = PATHS.AGENTS_COMMANDS_DIR;

	protected parseResource(
		attributes: Record<string, string | boolean>,
		body: string,
		fileName: string,
	): ParsedCommand {
		const name = this.getNameFromFileName(fileName);
		return {
			name,
			description: String(attributes.description || ''),
			prompt: body,
			allowedTools: attributes['allowed-tools']
				? String(attributes['allowed-tools'])
						.split(',')
						.map((s: string) => s.trim())
				: undefined,
			argumentHint: attributes['argument-hint'] ? String(attributes['argument-hint']) : undefined,
			agent: attributes.agent ? String(attributes.agent) : undefined,
			model: attributes.model ? String(attributes.model) : undefined,
			subtask: attributes.subtask === true,
			path: this.buildRelativePath(fileName),
		};
	}

	protected stringifyResource(item: Partial<ParsedCommand> & { name: string }): {
		attributes: Record<string, string | boolean | undefined>;
		body: string;
	} {
		return {
			attributes: {
				description: item.description,
				'allowed-tools': item.allowedTools?.join(', '),
				'argument-hint': item.argumentHint,
				agent: item.agent,
				model: item.model,
				subtask: item.subtask,
			},
			body: item.prompt ?? '',
		};
	}

	public async importFromAllSources(): Promise<{ imported: number; sources: string[] }> {
		if (!this._workspaceRoot) return { imported: 0, sources: [] };

		let count = 0;
		const sources = new Set<string>();

		const legacyCount = await this.importFromFlatDir('.claude/commands');
		if (legacyCount > 0) {
			count += legacyCount;
			sources.add('.claude/commands');
		}

		const openCodeCount = await this.importFromFlatDir(PATHS.OPENCODE_COMMAND_DIR);
		if (openCodeCount > 0) {
			count += openCodeCount;
			sources.add('OpenCode CLI');
		}

		const cursorCount = await this.importFromFlatDir(PATHS.CURSOR_COMMANDS_DIR);
		if (cursorCount > 0) {
			count += cursorCount;
			sources.add('Cursor');
		}

		return { imported: count, sources: Array.from(sources) };
	}

	public async syncToCLI(): Promise<void> {
		await this.syncToFlatDir(PATHS.OPENCODE_COMMAND_DIR);
	}
}
