/**
 * @file SubagentsHandler
 * @description Handles webview messages for subagent management.
 *              Uses `.agents/subagents/` as canonical storage and syncs/imports to
 *              `.claude/agents/` and `.opencode/agent/`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentsSubagentsService } from '../../services/AgentsSubagentsService';
import { errorService } from '../../services/ErrorService';
import type { WebviewMessage } from '../../types';

interface SubagentMessageData {
	name?: string;
	description?: string;
	content?: string;
}

export class SubagentsHandler {
	constructor(private readonly _postMessage: (message: unknown) => void) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) agentsSubagentsService.setWorkspaceRoot(root);
	}

	public async getSubagents(): Promise<void> {
		try {
			const subagents = await agentsSubagentsService.getSubagents();
			this._postMessage({ type: 'subagentsList', data: { subagents, isLoading: false } });
		} catch (error) {
			errorService.handle(error, 'SubagentsHandler.getSubagents');
			this._postMessage({
				type: 'subagentsList',
				data: {
					subagents: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async createSubagent(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SubagentMessageData;
			const name = data.name ?? message.name;
			const description = data.description ?? '';
			const content = data.content ?? message.content;

			if (!name || !content) throw new Error('Name and content are required');

			await agentsSubagentsService.saveSubagent({
				name,
				description: description || 'Subagent',
				prompt: content,
			});

			await this.getSubagents();
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async deleteSubagent(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SubagentMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to delete subagent ${name}?`,
				{ modal: true },
				'Delete',
			);
			if (confirm !== 'Delete') return;

			await agentsSubagentsService.deleteSubagent(name);
			await this.getSubagents();
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async openSubagentFile(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SubagentMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const subagents = await agentsSubagentsService.getSubagents();
			const subagent = subagents.find(s => s.name === name);
			if (!subagent) return;

			const doc = await vscode.workspace.openTextDocument(
				vscode.Uri.file(
					path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', subagent.path),
				),
			);
			await vscode.window.showTextDocument(doc);
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async importSubagentsFromCLI(): Promise<void> {
		try {
			const [fromClaude, fromOpenCode] = await Promise.all([
				agentsSubagentsService.importFromClaude(),
				agentsSubagentsService.importFromOpenCode(),
			]);
			const subagents = await agentsSubagentsService.getSubagents();
			const imported = fromClaude.imported + fromOpenCode.imported;
			this._postMessage({
				type: 'subagentsList',
				data: {
					subagents,
					isLoading: false,
					meta: {
						operation: 'import',
						message:
							imported > 0
								? `Imported ${imported} subagent${imported === 1 ? '' : 's'} from CLI`
								: 'No subagents found to import',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async syncSubagentsToCLI(): Promise<void> {
		try {
			const result = await agentsSubagentsService.syncToCLI();
			const subagents = await agentsSubagentsService.getSubagents();
			this._postMessage({
				type: 'subagentsList',
				data: {
					subagents,
					isLoading: false,
					meta: {
						operation: 'sync',
						message:
							result.synced > 0
								? `Synced ${result.synced} subagent${result.synced === 1 ? '' : 's'} to CLI configs`
								: 'Nothing to sync',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}
}
