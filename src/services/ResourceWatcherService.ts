/**
 * @file ResourceWatcherService
 * @description Watches `.opencode/` resource directories (commands, skills, plugins, agents)
 *              for file changes and emits events so the UI auto-refreshes.
 *              Analogous to McpConfigWatcherService but for resource files.
 *              Debounces rapid changes to avoid excessive reloads.
 */

import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import type { ResourceService, ResourceType } from './ResourceService';

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_MS = 300;

/**
 * Single glob pattern for the entire .opencode/ tree.
 * We use one FileSystemWatcher and route events by path segment.
 */
const OPENCODE_GLOB = `${PATHS.OPENCODE_DIR}/**`;

/**
 * Maps a path segment to its resource type.
 * Order doesn't matter — first match wins during routing.
 */
const PATH_SEGMENT_TO_TYPE: [segment: string, type: ResourceType][] = [
	[PATHS.OPENCODE_COMMANDS_DIR, 'commands'],
	[PATHS.OPENCODE_SKILLS_DIR, 'skills'],
	[PATHS.OPENCODE_PLUGINS_DIR, 'hooks'],
	[PATHS.OPENCODE_AGENTS_DIR, 'subagents'],
];

// =============================================================================
// Types
// =============================================================================

export interface ResourceChangeEvent {
	resourceType: ResourceType;
	timestamp: number;
}

// =============================================================================
// ResourceWatcherService
// =============================================================================

export class ResourceWatcherService implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _debounceTimers = new Map<ResourceType, ReturnType<typeof setTimeout>>();
	private _started = false;

	private readonly _onResourceChanged = new vscode.EventEmitter<ResourceChangeEvent>();
	public readonly onResourceChanged = this._onResourceChanged.event;

	constructor(readonly _resourceService: ResourceService) {}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	public start(): void {
		if (this._started) return;

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[ResourceWatcherService] No workspace root, cannot start');
			return;
		}

		// Single watcher for the entire .opencode/ tree — saves OS file descriptors
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, OPENCODE_GLOB),
		);

		watcher.onDidCreate(uri => this._routeEvent(uri));
		watcher.onDidChange(uri => this._routeEvent(uri));
		watcher.onDidDelete(uri => this._routeEvent(uri));

		this._disposables.push(watcher);

		this._started = true;
		logger.info('[ResourceWatcherService] Started watching .opencode/ resource directories');
	}

	public dispose(): void {
		for (const timer of this._debounceTimers.values()) {
			clearTimeout(timer);
		}
		this._debounceTimers.clear();

		for (const d of this._disposables) {
			d.dispose();
		}
		this._disposables = [];
		this._started = false;

		this._onResourceChanged.dispose();
		logger.info('[ResourceWatcherService] Disposed');
	}

	// =========================================================================
	// Private
	// =========================================================================

	/** Route a file event to the correct resource type based on its path. */
	private _routeEvent(uri: vscode.Uri): void {
		// Early exit: only .md files are resource files
		if (!uri.fsPath.endsWith('.md')) return;

		// Normalize to forward slashes for reliable segment matching
		const fsPath = uri.fsPath.replace(/\\/g, '/');
		for (const [segment, type] of PATH_SEGMENT_TO_TYPE) {
			if (fsPath.includes(`/${segment}/`) || fsPath.endsWith(`/${segment}`)) {
				this._scheduleReload(type);
				return;
			}
		}
		// Ignore events outside known resource directories (e.g. .opencode/rules/)
	}

	private _scheduleReload(type: ResourceType): void {
		const existing = this._debounceTimers.get(type);
		if (existing) clearTimeout(existing);

		this._debounceTimers.set(
			type,
			setTimeout(() => {
				this._debounceTimers.delete(type);
				logger.info(`[ResourceWatcherService] Resource changed: ${type}`);
				this._onResourceChanged.fire({ resourceType: type, timestamp: Date.now() });
			}, DEBOUNCE_MS),
		);
	}
}
