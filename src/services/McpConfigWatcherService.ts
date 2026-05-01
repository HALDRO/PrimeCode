import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { getGlobalOpenCodeDir } from './opencode/OpenCodeConfigService';

const DEBOUNCE_MS = 500;
const OPENCODE_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'] as const;
const STARTUP_GRACE_MS = 3000;

export class McpConfigWatcherService implements vscode.Disposable {
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private _isReloading = false;
	private _startedAt = 0;
	private _lastUiSaveHash: string | undefined;
	private _onReload: ((source: 'file-watcher' | 'manual') => Promise<void> | void) | undefined;

	public start(onReload: (source: 'file-watcher' | 'manual') => Promise<void> | void): void {
		this._onReload = onReload;

		if (this._disposables.length > 0) {
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[McpConfigWatcherService] No workspace root, cannot start watcher');
			return;
		}

		this._watchConfigFiles(workspaceRoot);
		const globalOpenCodeDir = getGlobalOpenCodeDir();
		if (globalOpenCodeDir) {
			this._watchConfigFiles(globalOpenCodeDir);
		}
		this._startedAt = Date.now();
	}

	public dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}

		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables.length = 0;
		logger.info('[McpConfigWatcherService] Disposed');
	}

	public notifyUiSave(contentHash?: string): void {
		this._lastUiSaveHash = contentHash;
		logger.debug('[McpConfigWatcherService] UI save notified', { hash: contentHash ?? 'none' });
		void this._performReload('manual');
	}

	private _watchConfigFiles(basePath: string): void {
		for (const file of OPENCODE_CONFIG_FILES) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(basePath, file),
			);
			watcher.onDidChange(uri => this._handleFileChange(uri, 'change'));
			watcher.onDidCreate(uri => this._handleFileChange(uri, 'create'));
			watcher.onDidDelete(uri => this._handleFileChange(uri, 'delete'));
			this._disposables.push(watcher);
		}
	}

	private _handleFileChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
		logger.debug(`[McpConfigWatcherService] File ${eventType}: ${uri.fsPath}`);

		if (this._startedAt && Date.now() - this._startedAt < STARTUP_GRACE_MS) {
			return;
		}

		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}

		this._debounceTimer = setTimeout(async () => {
			if (this._lastUiSaveHash && eventType !== 'delete') {
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					const content = new TextDecoder().decode(bytes);
					if (this._simpleHash(content) === this._lastUiSaveHash) {
						this._lastUiSaveHash = undefined;
						return;
					}
				} catch {
					// File read failed — proceed with reload
				}
				this._lastUiSaveHash = undefined;
			}

			void this._performReload('file-watcher');
		}, DEBOUNCE_MS);
	}

	private _simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const ch = str.charCodeAt(i);
			hash = ((hash << 5) - hash + ch) | 0;
		}
		return hash.toString(36);
	}

	private async _performReload(source: 'file-watcher' | 'manual'): Promise<void> {
		if (this._isReloading) {
			logger.debug('[McpConfigWatcherService] Reload already in progress, skipping');
			return;
		}

		this._isReloading = true;
		const startTime = Date.now();

		try {
			await this._onReload?.(source);

			void startTime;
		} catch (error) {
			logger.error('[McpConfigWatcherService] Failed to reload MCP config:', error);
		} finally {
			this._isReloading = false;
		}
	}
}
