/**
 * @file AgentsCommandsService
 * @description Manages custom commands (prompts) in .agents/commands/
 *              Handles reading, writing, importing, and syncing commands.
 *              Supports both Claude CLI (.claude/commands/) and OpenCode CLI (.opencode/command/) formats.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PATHS } from '../shared/constants';
import type { ParsedCommand } from '../types';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter';
import { logger } from '../utils/logger';
import { ErrorCode, ExtensionError, errorService } from './ErrorService';
import { FileService } from './FileService';

const fileService = new FileService();

export class AgentsCommandsService {
	private _workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this._workspaceRoot = root;
	}

	private get agentsCommandsDir(): string {
		if (!this._workspaceRoot) throw new Error('Workspace root not set');
		return path.join(this._workspaceRoot, PATHS.AGENTS_COMMANDS_DIR);
	}

	/**
	 * Get all commands from .agents/commands/
	 */
	public async getCommands(): Promise<ParsedCommand[]> {
		try {
			if (!this._workspaceRoot) return [];

			// Ensure directory exists
			await fileService.ensureDirectoryExists(this.agentsCommandsDir);

			const files = await fs.readdir(this.agentsCommandsDir);
			const commands: ParsedCommand[] = [];

			for (const file of files) {
				if (!file.endsWith('.md')) continue;

				try {
					const filePath = path.join(this.agentsCommandsDir, file);
					const content = await fs.readFile(filePath, 'utf-8');
					const command = this.parseCommandFile(content, file);
					commands.push(command);
				} catch (err) {
					logger.warn(`[AgentsCommandsService] Failed to parse command ${file}:`, err);
				}
			}

			return commands.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			errorService.handle(error, 'AgentsCommandsService.getCommands');
			return [];
		}
	}

	/**
	 * Parse markdown file with YAML frontmatter
	 */
	private parseCommandFile(content: string, filename: string): ParsedCommand {
		const name = filename.replace(/\.md$/, '');
		const { attributes, body } = parseFrontmatter(content);

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
			path: path.join(PATHS.AGENTS_COMMANDS_DIR, filename),
		};
	}

	/**
	 * Create or update a command
	 */
	public async saveCommand(command: ParsedCommand): Promise<void> {
		if (!this._workspaceRoot) return;

		try {
			await fileService.ensureDirectoryExists(this.agentsCommandsDir);

			const filePath = path.join(this.agentsCommandsDir, `${command.name}.md`);
			const content = this.stringifyCommand(command);

			await fs.writeFile(filePath, content, 'utf-8');
		} catch (error) {
			throw new ExtensionError('Failed to save command', ErrorCode.FS_WRITE_ERROR, undefined, {
				name: command.name,
				error,
			});
		}
	}

	/**
	 * Convert command object to markdown with frontmatter
	 */
	private stringifyCommand(command: ParsedCommand): string {
		const attributes: Record<string, string | boolean | undefined> = {
			description: command.description,
			'allowed-tools': command.allowedTools?.join(', '),
			'argument-hint': command.argumentHint,
			agent: command.agent,
			model: command.model,
			subtask: command.subtask,
		};

		return stringifyFrontmatter(attributes, command.prompt);
	}

	/**
	 * Delete a command
	 */
	public async deleteCommand(name: string): Promise<void> {
		if (!this._workspaceRoot) return;

		try {
			const filePath = path.join(this.agentsCommandsDir, `${name}.md`);
			await fs.unlink(filePath);
		} catch (error) {
			// Ignore if file doesn't exist
			if ((error as { code?: string }).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	/**
	 * Import commands from all legacy sources
	 */
	public async importFromAllSources(): Promise<{ imported: number; sources: string[] }> {
		if (!this._workspaceRoot) return { imported: 0, sources: [] };

		let count = 0;
		const sources = new Set<string>();

		// 1. Claude CLI (.claude/commands/)
		const claudeDir = path.join(this._workspaceRoot, PATHS.CLAUDE_COMMANDS_DIR);
		const claudeCount = await this.importFromDir(claudeDir);
		if (claudeCount > 0) {
			count += claudeCount;
			sources.add('Claude CLI');
		}

		// 2. OpenCode CLI (.opencode/command/)
		const openCodeDir = path.join(this._workspaceRoot, PATHS.OPENCODE_COMMAND_DIR);
		const openCodeCount = await this.importFromDir(openCodeDir);
		if (openCodeCount > 0) {
			count += openCodeCount;
			sources.add('OpenCode CLI');
		}

		// 3. Cursor (.cursor/commands/)
		const cursorDir = path.join(this._workspaceRoot, PATHS.CURSOR_COMMANDS_DIR);
		const cursorCount = await this.importFromDir(cursorDir);
		if (cursorCount > 0) {
			count += cursorCount;
			sources.add('Cursor');
		}

		return { imported: count, sources: Array.from(sources) };
	}

	private async importFromDir(sourceDir: string): Promise<number> {
		try {
			const exists = await fileService.directoryExists(sourceDir);
			if (!exists) return 0;

			const files = await fs.readdir(sourceDir);
			let count = 0;

			for (const file of files) {
				if (!file.endsWith('.md')) continue;

				const sourcePath = path.join(sourceDir, file);
				const targetPath = path.join(this.agentsCommandsDir, file);

				// Only import if doesn't exist in .agents/commands/
				if (!(await fileService.fileExists(targetPath))) {
					const content = await fs.readFile(sourcePath, 'utf-8');
					await this.saveCommand(this.parseCommandFile(content, file));
					count++;
				}
			}
			return count;
		} catch (_e) {
			return 0;
		}
	}

	/**
	 * Sync commands to CLI directories
	 */
	public async syncToCLI(): Promise<void> {
		if (!this._workspaceRoot) return;

		const commands = await this.getCommands();

		// Sync to Claude (.claude/commands/)
		const claudeDir = path.join(this._workspaceRoot, PATHS.CLAUDE_COMMANDS_DIR);
		await fileService.ensureDirectoryExists(claudeDir);

		for (const cmd of commands) {
			await fs.writeFile(
				path.join(claudeDir, `${cmd.name}.md`),
				this.stringifyCommand(cmd),
				'utf-8',
			);
		}

		// Sync to OpenCode (.opencode/command/)
		const openCodeDir = path.join(this._workspaceRoot, PATHS.OPENCODE_COMMAND_DIR);
		await fileService.ensureDirectoryExists(openCodeDir);

		for (const cmd of commands) {
			await fs.writeFile(
				path.join(openCodeDir, `${cmd.name}.md`),
				this.stringifyCommand(cmd),
				'utf-8',
			);
		}

		// Cursor is read-only: do not write .cursor/commands
	}
}

export const agentsCommandsService = new AgentsCommandsService();
