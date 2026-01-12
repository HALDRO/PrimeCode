/**
 * @file HooksHandler
 * @description Handles webview messages for hookify-style hook rules.
 *              Uses `.agents/hooks/` as canonical store and syncs/imports to `.claude/`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { agentsHooksService } from '../../services/AgentsHooksService';
import { errorService } from '../../services/ErrorService';
import type { WebviewMessage } from '../../types';

interface HookMessageData {
	name?: string;
	enabled?: boolean;
	event?: string;
	pattern?: string;
	action?: string;
	content?: string;
}

export class HooksHandler {
	constructor(private readonly _postMessage: (message: unknown) => void) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (root) agentsHooksService.setWorkspaceRoot(root);
	}

	public async getHooks(): Promise<void> {
		try {
			const hooks = await agentsHooksService.getHooks();
			this._postMessage({ type: 'hooksList', data: { hooks, isLoading: false } });
		} catch (error) {
			errorService.handle(error, 'HooksHandler.getHooks');
			this._postMessage({
				type: 'hooksList',
				data: {
					hooks: [],
					isLoading: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async createHook(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as HookMessageData;
			const name = data.name ?? message.name;
			const enabled = data.enabled ?? message.enabled ?? true;
			const event = data.event ?? 'all';
			const pattern = data.pattern;
			const action = data.action;
			const content = data.content ?? message.content ?? '';

			if (!name) throw new Error('Name is required');

			await agentsHooksService.saveHook({ name, enabled, event, pattern, action, content });
			await this.getHooks();
			// Silent operation - no toast notifications
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async deleteHook(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as HookMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const confirm = await vscode.window.showWarningMessage(
				`Are you sure you want to delete hook ${name}?`,
				{ modal: true },
				'Delete',
			);

			if (confirm !== 'Delete') return;

			await agentsHooksService.deleteHook(name);
			await this.getHooks();
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async openHookFile(message: WebviewMessage): Promise<void> {
		try {
			const data = (message.data ?? message) as HookMessageData;
			const name = data.name ?? message.name;
			if (!name) return;

			const hooks = await agentsHooksService.getHooks();
			const hook = hooks.find(h => h.name === name);
			if (!hook) return;

			const doc = await vscode.workspace.openTextDocument(
				vscode.Uri.file(
					path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', hook.path),
				),
			);
			await vscode.window.showTextDocument(doc);
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async importHooksFromClaude(): Promise<void> {
		try {
			const result = await agentsHooksService.importFromClaude();
			const hooks = await agentsHooksService.getHooks();
			this._postMessage({
				type: 'hooksList',
				data: {
					hooks,
					isLoading: false,
					meta: {
						operation: 'import',
						message:
							result.imported > 0
								? `Imported ${result.imported} hook${result.imported === 1 ? '' : 's'} from Claude`
								: 'No hooks found to import',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}

	public async syncHooksToClaude(): Promise<void> {
		try {
			const result = await agentsHooksService.syncToClaude();
			const hooks = await agentsHooksService.getHooks();
			this._postMessage({
				type: 'hooksList',
				data: {
					hooks,
					isLoading: false,
					meta: {
						operation: 'sync',
						message:
							result.synced > 0
								? `Synced ${result.synced} hook${result.synced === 1 ? '' : 's'} to Claude`
								: 'Nothing to sync',
					},
				},
			});
		} catch (error) {
			errorService.showError(error);
		}
	}
}
