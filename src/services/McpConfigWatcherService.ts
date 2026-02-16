/**
 * @file McpConfigWatcherService
 * @description Watches `opencode.json` for changes and triggers hot-reload of MCP configuration.
 *              Calls OpenCode SDK dispose callback so MCP config is reloaded without extension restart.
 *              Debounces rapid file changes to prevent excessive reloads.
 *              Emits events for UI notification about config changes.
 *              Supports suppression of reload when changes originate from UI (to avoid double reload).
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import type { McpConfigService } from './McpConfigService';

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_MS = 500;
const MCP_CONFIG_PATTERN = '**/opencode.json';
/** Ignore file-watcher events for this long after start() to avoid startup noise. */
const STARTUP_GRACE_MS = 3000;

// =============================================================================
// Types
// =============================================================================

interface McpConfigChangeEvent {
	source: 'file-watcher' | 'manual';
	timestamp: number;
}

type ReloadCallback = () => Promise<void>;

// =============================================================================
// McpConfigWatcherService Class
// =============================================================================

export class McpConfigWatcherService implements vscode.Disposable {
	private _watcher: vscode.FileSystemWatcher | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _isReloading = false;
	/** Timestamp when the watcher was started. Used to suppress startup noise. */
	private _startedAt = 0;

	/** Content hash of the last UI-triggered save. Used to suppress file watcher echo. */
	private _lastUiSaveHash: string | undefined;

	private readonly _onConfigChanged = new vscode.EventEmitter<McpConfigChangeEvent>();
	public readonly onConfigChanged = this._onConfigChanged.event;

	// Callbacks for CLI providers
	private _openCodeReloadCallback: ReloadCallback | undefined;

	constructor(readonly _agentsConfigService: McpConfigService) {}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Start watching for MCP config changes
	 */
	public start(): void {
		if (this._watcher) {
			logger.debug('[McpConfigWatcherService] Watcher already started');
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[McpConfigWatcherService] No workspace root, cannot start watcher');
			return;
		}

		// Watch for opencode.json changes
		this._watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, MCP_CONFIG_PATTERN),
		);

		this._watcher.onDidChange(uri => this._handleFileChange(uri, 'change'));
		this._watcher.onDidCreate(uri => this._handleFileChange(uri, 'create'));
		this._watcher.onDidDelete(uri => this._handleFileChange(uri, 'delete'));

		this._disposables.push(this._watcher);
		this._startedAt = Date.now();
		logger.info('[McpConfigWatcherService] Started watching opencode.json');
	}

	/**
	 * Stop watching and cleanup
	 */
	public dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = undefined;
		}

		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._watcher = undefined;

		this._onConfigChanged.dispose();
		logger.info('[McpConfigWatcherService] Disposed');
	}

	// =========================================================================
	// Callback Registration
	// =========================================================================

	/**
	 * Register callback for OpenCode CLI reload
	 * Called when config changes to trigger instance.dispose() via SDK
	 */
	public setOpenCodeReloadCallback(callback: ReloadCallback): void {
		this._openCodeReloadCallback = callback;
	}

	// =========================================================================
	// Manual Reload
	// =========================================================================

	/**
	 * Manually trigger MCP config reload (e.g., from UI button)
	 */
	public async triggerReload(): Promise<void> {
		await this._performReload('manual');
	}

	/**
	 * Check if reload is currently in progress
	 */
	public isReloading(): boolean {
		return this._isReloading;
	}

	/**
	 * Notify that a UI-triggered save just happened.
	 * Computes a content hash so the file watcher can detect whether the
	 * on-disk change matches what we just wrote (our own echo) vs. an
	 * external modification.
	 */
	public notifyUiSave(contentHash?: string): void {
		this._lastUiSaveHash = contentHash;
		logger.debug('[McpConfigWatcherService] UI save notified', { hash: contentHash ?? 'none' });
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	/**
	 * Handle file system change event with debouncing.
	 * Uses content-hash comparison instead of a time window to reliably
	 * distinguish our own writes from external modifications.
	 */
	private _handleFileChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
		logger.debug(`[McpConfigWatcherService] File ${eventType}: ${uri.fsPath}`);

		// Suppress events during startup grace period (OpenCode server may touch opencode.json)
		if (this._startedAt && Date.now() - this._startedAt < STARTUP_GRACE_MS) {
			logger.debug('[McpConfigWatcherService] Suppressed (startup grace period)');
			return;
		}

		// Clear existing debounce timer
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}

		// Debounce rapid changes (e.g., editor auto-save)
		this._debounceTimer = setTimeout(async () => {
			// Hash-based suppression: read the file and compare hash
			if (this._lastUiSaveHash && eventType !== 'delete') {
				try {
					const bytes = await vscode.workspace.fs.readFile(uri);
					const content = new TextDecoder().decode(bytes);
					const fileHash = this._simpleHash(content);
					if (fileHash === this._lastUiSaveHash) {
						logger.debug('[McpConfigWatcherService] Suppressed (hash matches UI save)');
						this._lastUiSaveHash = undefined;
						return;
					}
				} catch {
					// File read failed — proceed with reload
				}
				this._lastUiSaveHash = undefined;
			}

			this._performReload('file-watcher');
		}, DEBOUNCE_MS);
	}

	/** Fast non-crypto hash for content comparison. */
	private _simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const ch = str.charCodeAt(i);
			hash = ((hash << 5) - hash + ch) | 0;
		}
		return hash.toString(36);
	}

	/**
	 * Perform the actual reload operation
	 */
	private async _performReload(source: 'file-watcher' | 'manual'): Promise<void> {
		if (this._isReloading) {
			logger.debug('[McpConfigWatcherService] Reload already in progress, skipping');
			return;
		}

		this._isReloading = true;
		const startTime = Date.now();

		try {
			logger.info(`[McpConfigWatcherService] Reloading MCP config (source: ${source})`);

			// 1. Hot-reload OpenCode runtime if callback is registered
			if (this._openCodeReloadCallback) {
				await this._openCodeReloadCallback().catch(error => {
					logger.error('[McpConfigWatcherService] OpenCode reload failed:', error);
				});
			}

			// 2. Emit change event for UI notification
			this._onConfigChanged.fire({
				source,
				timestamp: Date.now(),
			});

			const duration = Date.now() - startTime;
			logger.info(`[McpConfigWatcherService] MCP config reloaded in ${duration}ms`);
		} catch (error) {
			logger.error('[McpConfigWatcherService] Failed to reload MCP config:', error);
		} finally {
			this._isReloading = false;
		}
	}
}
