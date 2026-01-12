/**
 * @file SkillsHandler
 * @description Handles webview messages for skills management.
 *              Bridges `.agents/skills/` canonical storage with legacy import/sync targets.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentsSkillsService } from '../../services/AgentsSkillsService';
import { errorService } from '../../services/ErrorService';
import type { WebviewMessage } from '../../types';

interface SkillMessageData {
	name?: string;
	description?: string;
	content?: string;
	version?: string;
}

export class SkillsHandler {
	constructor(private readonly _postMessage: (message: unknown) => void) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) agentsSkillsService.setWorkspaceRoot(root);
	}

	public async getSkills(): Promise<void> {
		try {
			const skills = await agentsSkillsService.getSkills();
			this._postMessage({
				type: 'skillsList',
				data: { skills, isLoading: false },
			});
		} catch (error) {
			errorService.handle(error, 'SkillsHandler.getSkills');
			this._postMessage({
				type: 'skillsList',
				data: {
					skills: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async createSkill(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SkillMessageData;
			const name = data.name ?? message.name;
			const description = data.description ?? '';
			const content = data.content ?? message.content;
			const version = data.version;

			if (!name || !content) throw new Error('Name and content are required');

			await agentsSkillsService.saveSkill({ name, description, content, version });
			await this.getSkills();
			// Silent operation - no toast notifications
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async deleteSkill(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SkillMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to delete skill ${name}?`,
				{ modal: true },
				'Delete',
			);

			if (confirm !== 'Delete') return;

			await agentsSkillsService.deleteSkill(name);
			await this.getSkills();
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async openSkillFile(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as SkillMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const skills = await agentsSkillsService.getSkills();
			const skill = skills.find(s => s.name === name);
			if (!skill) return;

			const doc = await vscode.workspace.openTextDocument(
				vscode.Uri.file(
					path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', skill.path),
				),
			);
			await vscode.window.showTextDocument(doc);
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async importSkills(): Promise<void> {
		try {
			const result = await agentsSkillsService.importFromAllSources();
			const skills = await agentsSkillsService.getSkills();
			this._postMessage({
				type: 'skillsList',
				data: {
					skills,
					isLoading: false,
					meta: {
						operation: 'import',
						message:
							result.imported > 0
								? `Imported ${result.imported} skill${result.imported === 1 ? '' : 's'} from ${
										result.sources.length > 0 ? result.sources.join(', ') : 'CLI'
									}`
								: 'No skills found to import',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async syncSkills(): Promise<void> {
		try {
			const result = await agentsSkillsService.syncToCLI();
			const skills = await agentsSkillsService.getSkills();
			this._postMessage({
				type: 'skillsList',
				data: {
					skills,
					isLoading: false,
					meta: {
						operation: 'sync',
						message:
							result.synced > 0
								? `Synced ${result.synced} skill${result.synced === 1 ? '' : 's'} to CLI configs`
								: 'Nothing to sync',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}
}
