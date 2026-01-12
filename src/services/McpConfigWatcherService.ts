/**
 * @file McpConfigWatcherService
 * @description Watches `.agents/mcp.json` for changes and triggers hot-reload of MCP configuration.
 *              For OpenCode: calls `instance.dispose()` via SDK to reload config without server restart.
 *              For Claude: re-syncs `mcp-servers.json` with updated user MCP servers.
 *              Debounces rapid file changes to prevent excessive reloads.
 *              Emits events for UI notification about config changes.
 *              Supports suppression of reload when changes originate from UI (to avoid double reload).
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import type { AgentsConfigService } from './AgentsConfigService';
import type { AgentsSyncService } from './AgentsSyncService';

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_MS = 500;
const AGENTS_MCP_PATTERN = '**/.agents/mcp.json';
const SUPPRESSION_WINDOW_MS = 2000; // Ignore file changes within 2s of UI-triggered save

// =============================================================================
// Types
// =============================================================================

export interface McpConfigChangeEvent {
	source: 'file-watcher' | 'manual';
	timestamp: number;
}

export type ReloadCallback = () => Promise<void>;

// =============================================================================
// McpConfigWatcherService Class
// =============================================================================

export class McpConfigWatcherService implements vscode.Disposable {
	private _watcher: vscode.FileSystemWatcher | undefined;
	private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposables: vscode.Disposable[] = [];
	private _isReloading = false;
	private _lastUiSaveTimestamp = 0;

	private readonly _onConfigChanged = new vscode.EventEmitter<McpConfigChangeEvent>();
	public readonly onConfigChanged = this._onConfigChanged.event;

	// Callbacks for different CLI providers
	private _openCodeReloadCallback: ReloadCallback | undefined;
	private _claudeReloadCallback: ReloadCallback | undefined;

	constructor(
		readonly _agentsConfigService: AgentsConfigService,
		private readonly _agentsSyncService: AgentsSyncService,
	) {}

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

		// Watch for .agents/mcp.json changes
		this._watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, AGENTS_MCP_PATTERN),
		);

		this._watcher.onDidChange(uri => this._handleFileChange(uri, 'change'));
		this._watcher.onDidCreate(uri => this._handleFileChange(uri, 'create'));
		this._watcher.onDidDelete(uri => this._handleFileChange(uri, 'delete'));

		this._disposables.push(this._watcher);
		logger.info('[McpConfigWatcherService] Started watching .agents/mcp.json');
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

	/**
	 * Register callback for Claude CLI reload
	 * Called when config changes to re-sync mcp-servers.json
	 */
	public setClaudeReloadCallback(callback: ReloadCallback): void {
		this._claudeReloadCallback = callback;
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
	 * This suppresses the file watcher from triggering a redundant reload.
	 */
	public notifyUiSave(): void {
		this._lastUiSaveTimestamp = Date.now();
		logger.debug('[McpConfigWatcherService] UI save notified, suppressing file watcher');
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	/**
	 * Handle file system change event with debouncing
	 */
	private _handleFileChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
		logger.debug(`[McpConfigWatcherService] File ${eventType}: ${uri.fsPath}`);

		// Check if this change was triggered by UI save (suppress to avoid double reload)
		const timeSinceUiSave = Date.now() - this._lastUiSaveTimestamp;
		if (timeSinceUiSave < SUPPRESSION_WINDOW_MS) {
			logger.debug(
				`[McpConfigWatcherService] Suppressing file watcher (UI save ${timeSinceUiSave}ms ago)`,
			);
			return;
		}

		// Clear existing debounce timer
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}

		// Debounce rapid changes (e.g., editor auto-save)
		this._debounceTimer = setTimeout(() => {
			this._performReload('file-watcher');
		}, DEBOUNCE_MS);
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

			// 1. Sync to supported CLI formats first (for OpenCode + UI registry)
			await this._agentsSyncService.syncAllProject();

			// 2. Call provider-specific reload callbacks
			const reloadPromises: Promise<void>[] = [];

			if (this._openCodeReloadCallback) {
				reloadPromises.push(
					this._openCodeReloadCallback().catch(error => {
						logger.error('[McpConfigWatcherService] OpenCode reload failed:', error);
					}),
				);
			}

			// Claude SDK consumes MCP servers from `.agents/mcp.json` directly via SDK options.
			// No need to write `.mcp.json` (legacy Claude CLI) but we DO hot-swap active query servers.
			if (this._claudeReloadCallback) {
				reloadPromises.push(
					this._claudeReloadCallback().catch(error => {
						logger.error('[McpConfigWatcherService] Claude reload failed:', error);
					}),
				);
			}

			await Promise.all(reloadPromises);

			// 3. Emit change event for UI notification
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
