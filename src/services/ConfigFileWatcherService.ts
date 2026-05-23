import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { getGlobalOpenCodeDir } from './opencode/OpenCodeConfigService';

const DEBOUNCE_MS = 500;
const OPENCODE_CONFIG_FILES = ['opencode.json', 'opencode.jsonc'] as const;
const STARTUP_GRACE_MS = 3000;
/** After a UI-initiated save, suppress watcher events for this duration. */
const UI_SAVE_SUPPRESS_MS = 2000;

export class ConfigFileWatcherService implements vscode.Disposable {
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private _isReloading = false;
	private _startedAt = 0;
	private _suppressUntil = 0;
	private _onReload: ((source: 'file-watcher' | 'manual') => Promise<void> | void) | undefined;

	public start(onReload: (source: 'file-watcher' | 'manual') => Promise<void> | void): void {
		this._onReload = onReload;

		if (this._disposables.length > 0) {
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[ConfigFileWatcherService] No workspace root, cannot start watcher');
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
		logger.info('[ConfigFileWatcherService] Disposed');
	}

	/**
	 * Notify that the UI just wrote to opencode.json.
	 * Suppresses all file watcher events for a short period after the write,
	 * preventing reload loops when multiple writes happen in quick succession
	 * (e.g. syncing multiple proxy providers at startup).
	 */
	public notifyUiSave(_contentHash?: string): void {
		this._suppressUntil = Date.now() + UI_SAVE_SUPPRESS_MS;
		logger.debug('[ConfigFileWatcherService] UI save notified (suppressing watcher)', {
			suppressUntil: new Date(this._suppressUntil).toISOString(),
		});
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
		logger.debug(`[ConfigFileWatcherService] File ${eventType}: ${uri.fsPath}`);

		if (this._startedAt && Date.now() - this._startedAt < STARTUP_GRACE_MS) {
			return;
		}

		// Suppress events caused by our own writes (time-based window)
		if (Date.now() < this._suppressUntil) {
			logger.debug('[ConfigFileWatcherService] Suppressed (within UI save window)');
			return;
		}

		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}

		this._debounceTimer = setTimeout(async () => {
			void this._performReload('file-watcher');
		}, DEBOUNCE_MS);
	}

	private async _performReload(source: 'file-watcher' | 'manual'): Promise<void> {
		if (this._isReloading) {
			logger.debug('[ConfigFileWatcherService] Reload already in progress, skipping');
			return;
		}

		this._isReloading = true;
		const startTime = Date.now();

		try {
			await this._onReload?.(source);

			void startTime;
		} catch (error) {
			logger.error('[ConfigFileWatcherService] Failed to reload config:', error);
		} finally {
			this._isReloading = false;
		}
	}
}
