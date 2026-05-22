/**
 * @file ServiceRegistry — central service container and RuntimeReloadService.
 * @description Owns all shared extension services and provides a unified deferred-dispose
 *              mechanism (RuntimeReloadService) for OpenCode runtime. Tracks session busy/idle
 *              state from SSE events and defers instance.dispose() until all sessions are idle,
 *              preventing interruption of active agent work. Coalesces multiple reload requests
 *              into one dispose cycle.
 */

import * as vscode from 'vscode';
import { ConfigFileWatcherService } from '../services/ConfigFileWatcherService';
import { McpConfigService } from '../services/McpConfigService';
import { ModelsDevService } from '../services/ModelsDevService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { OpenCodeClientService } from '../services/OpenCodeClientService';
import { AgentResourceService } from '../services/opencode/AgentResourceService';
import { OpenCodeConfigService } from '../services/opencode/OpenCodeConfigService';
import { ResourceService } from '../services/ResourceService';
import { ResourceWatcherService } from '../services/ResourceWatcherService';
import { RulesService } from '../services/RulesService';
import { logger } from '../utils/logger';
import { normalizeDriveLetter } from '../utils/path';

// ─── RuntimeReloadService ───────────────────────────────────────────────────

type SessionStatus = { type: string };

export type ReloadExecutor = (source: string) => Promise<void>;

export class RuntimeReloadService {
	private _busySessions = new Set<string>();
	private _pendingReload: string | null = null;
	private _performReload: ReloadExecutor | null = null;
	private _isReloading = false;

	/**
	 * Register the callback that performs the actual runtime reload.
	 * Called once during ChatProvider initialization.
	 */
	public setReloadExecutor(executor: ReloadExecutor): void {
		this._performReload = executor;
	}

	/**
	 * Feed session status events from the SSE bridge.
	 * Call this for every `session.status` event received from the backend.
	 */
	public updateSessionStatus(sessionId: string, status: SessionStatus): void {
		const wasBusy = this._busySessions.size > 0;

		if (status.type === 'busy') {
			this._busySessions.add(sessionId);
		} else {
			this._busySessions.delete(sessionId);
		}

		// Transition from busy → idle: flush pending reload
		if (wasBusy && this._busySessions.size === 0 && this._pendingReload) {
			const source = this._pendingReload;
			this._pendingReload = null;
			logger.info('[RuntimeReloadService] All sessions idle, executing deferred reload', {
				source,
			});
			void this._executeReload(source);
		}
	}

	/**
	 * Notify that a session was deleted or is no longer tracked.
	 * Prevents stale busy entries from blocking reload indefinitely.
	 */
	public removeSession(sessionId: string): void {
		this._busySessions.delete(sessionId);
		if (this._busySessions.size === 0 && this._pendingReload) {
			const source = this._pendingReload;
			this._pendingReload = null;
			void this._executeReload(source);
		}
	}

	/**
	 * Request a runtime reload. If sessions are busy, defers until idle.
	 * Multiple requests while deferred are coalesced (last source wins).
	 */
	public requestReload(source: string): void {
		if (this._isReloading) {
			logger.debug('[RuntimeReloadService] Reload already in progress, queuing', { source });
			this._pendingReload = source;
			return;
		}

		if (this._busySessions.size > 0) {
			logger.info('[RuntimeReloadService] Sessions busy, deferring reload', {
				source,
				busySessions: Array.from(this._busySessions),
			});
			this._pendingReload = source;
			return;
		}

		void this._executeReload(source);
	}

	/**
	 * Force an immediate reload regardless of busy state.
	 * Used for explicit user actions (Reload button, restart command).
	 */
	public forceReload(source: string): void {
		this._pendingReload = null;
		void this._executeReload(source);
	}

	/** Whether any session is currently busy. */
	public get hasBusySessions(): boolean {
		return this._busySessions.size > 0;
	}

	/** Whether a reload is pending (waiting for sessions to become idle). */
	public get hasPendingReload(): boolean {
		return this._pendingReload !== null;
	}

	/** Clear all tracked state. Called on full extension dispose. */
	public dispose(): void {
		this._busySessions.clear();
		this._pendingReload = null;
		this._performReload = null;
	}

	private async _executeReload(source: string): Promise<void> {
		if (!this._performReload) {
			logger.warn('[RuntimeReloadService] No reload executor registered');
			return;
		}

		// Guard against re-entrant parallel execution
		if (this._isReloading) {
			this._pendingReload = source;
			return;
		}

		this._isReloading = true;
		try {
			await this._performReload(source);
		} catch (error) {
			logger.error('[RuntimeReloadService] Reload failed', { source, error });
		} finally {
			this._isReloading = false;

			// If another reload was requested during execution, flush it
			if (this._pendingReload && this._busySessions.size === 0) {
				const nextSource = this._pendingReload;
				this._pendingReload = null;
				void this._executeReload(nextSource);
			}
		}
	}
}

// ─── ServiceRegistry ────────────────────────────────────────────────────────

export class ServiceRegistry implements vscode.Disposable {
	public readonly resources: ResourceService;
	public readonly resourceWatcher: ResourceWatcherService;
	public readonly mcpConfig: McpConfigService;
	public readonly configFileWatcher: ConfigFileWatcherService;
	public readonly mcpManagement: McpManagementService;
	public readonly openCodeClient: OpenCodeClientService;
	public readonly openCodeConfig: OpenCodeConfigService;
	public readonly agentResources: AgentResourceService;
	public readonly modelsDev: ModelsDevService;
	public readonly runtimeReload: RuntimeReloadService;
	public rules: RulesService | null = null; // RulesService depends on workspace root

	private disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.resources = new ResourceService();
		this.resourceWatcher = new ResourceWatcherService();
		this.mcpConfig = new McpConfigService();
		this.openCodeConfig = new OpenCodeConfigService();
		this.configFileWatcher = new ConfigFileWatcherService();
		this.agentResources = new AgentResourceService(this.resources, this.openCodeConfig);

		this.openCodeClient = new OpenCodeClientService();
		this.modelsDev = new ModelsDevService();
		this.runtimeReload = new RuntimeReloadService();

		this.mcpManagement = new McpManagementService(
			context,
			msg => this._onMcpMessage.fire(msg),
			this.mcpConfig,
			this.openCodeConfig,
		);

		// Connect UI-save suppression: when McpManagement writes config,
		// notify the watcher so it doesn't trigger a redundant reload.
		this.mcpManagement.setOnConfigSaved(contentHash => {
			this.configFileWatcher.notifyUiSave(contentHash);
		});

		// Initialize workspace-scoped services if workspace is already open
		const rawRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const workspaceRoot = rawRoot ? normalizeDriveLetter(rawRoot) : undefined;
		if (workspaceRoot) {
			this.setWorkspaceRoot(workspaceRoot);
		}

		this.disposables.push(this.configFileWatcher, this.resourceWatcher);
	}

	private _onMcpMessage = new vscode.EventEmitter<unknown>();
	public readonly onMcpMessage = this._onMcpMessage.event;

	public setWorkspaceRoot(root: string) {
		this.resources.setWorkspaceRoot(root);
		this.openCodeConfig.setWorkspaceRoot(root);
		this.rules = new RulesService(root);
		this.openCodeClient.setWorkspaceRoot?.(root);
	}

	dispose() {
		this._onMcpMessage.dispose();
		this.runtimeReload.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		// Dispose services that may hold connections or timers
		if ('dispose' in this.mcpManagement && typeof this.mcpManagement.dispose === 'function') {
			this.mcpManagement.dispose();
		}
	}
}
