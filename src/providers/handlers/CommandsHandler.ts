/**
 * @file CommandsHandler.ts
 * @description Handles webview messages related to custom commands.
 *              Integrates AgentsCommandsService with the webview UI.
 *              Auto-syncs commands to CLI directories (.claude/commands/, .opencode/command/, .cursor/commands/)
 *              on create/delete so custom commands are immediately available via SDK session.command().
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentsCommandsService } from '../../services/AgentsCommandsService';
import { errorService } from '../../services/ErrorService';
import type { WebviewMessage } from '../../types';

/** Message data for command operations */
interface CommandMessageData {
	name?: string;
	content?: string;
	description?: string;
}

export class CommandsHandler {
	constructor(
		private readonly _postMessage: (message: unknown) => void,
		readonly _context: vscode.ExtensionContext,
	) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) agentsCommandsService.setWorkspaceRoot(root);
	}

	public async getCommands(): Promise<void> {
		try {
			const commands = await agentsCommandsService.getCommands();
			this._postMessage({
				type: 'commandsList',
				data: {
					custom: commands,
					isLoading: false,
				},
			});
		} catch (error) {
			errorService.handle(error, 'CommandsHandler.getCommands');
			this._postMessage({
				type: 'commandsList',
				data: {
					custom: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async createCommand(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as CommandMessageData;
			const name = data.name ?? (message as unknown as CommandMessageData).name;
			const content = data.content ?? (message as unknown as CommandMessageData).content;
			const description =
				data.description ?? (message as unknown as CommandMessageData).description;

			if (!name || !content) {
				throw new Error('Name and content are required');
			}

			await agentsCommandsService.saveCommand({
				name,
				prompt: content,
				description: description || '',
				path: '', // Will be set by service
			});

			// Auto-sync to CLI directories so commands are available via SDK session.command()
			await agentsCommandsService.syncToCLI();

			// Refresh list
			await this.getCommands();
			// Silent operation - no toast notifications
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async deleteCommand(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as CommandMessageData;
			const name = data.name ?? (message as unknown as CommandMessageData).name;
			if (!name) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to delete command /${name}?`,
				{ modal: true },
				'Delete',
			);

			if (confirm === 'Delete') {
				await agentsCommandsService.deleteCommand(name);
				// Auto-sync to CLI directories to remove command from SDK
				await agentsCommandsService.syncToCLI();
				await this.getCommands();
			}
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async openCommandFile(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as CommandMessageData;
			const name = data.name ?? (message as unknown as CommandMessageData).name;
			if (!name) return;

			const commands = await agentsCommandsService.getCommands();
			const command = commands.find(c => c.name === name);

			if (command) {
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (!root) return;

				const absolutePath = command.path.startsWith(root)
					? command.path
					: path.join(root, command.path);

				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
				await vscode.window.showTextDocument(doc);
			}
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async importCommands(): Promise<void> {
		try {
			const result = await agentsCommandsService.importFromAllSources();
			const commands = await agentsCommandsService.getCommands();
			this._postMessage({
				type: 'commandsList',
				data: {
					custom: commands,
					isLoading: false,
					meta: {
						operation: 'import',
						message:
							result.imported > 0
								? `Imported ${result.imported} command${result.imported === 1 ? '' : 's'} from ${
										result.sources.length > 0 ? result.sources.join(', ') : 'CLI'
									}`
								: 'No commands found to import',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async syncCommands(): Promise<void> {
		try {
			await agentsCommandsService.syncToCLI();
			const commands = await agentsCommandsService.getCommands();
			this._postMessage({
				type: 'commandsList',
				data: {
					custom: commands,
					isLoading: false,
					meta: {
						operation: 'sync',
						message: `Synced ${commands.length} command${commands.length === 1 ? '' : 's'} to CLI configs`,
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}
}
