/**
 * @file ResourceWatcherService
 * @description Watches `.opencode/`, `.agents/skills/`, `.claude/skills/` resource directories
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
 * Glob pattern for external .agents/skills/ directory (cross-agent interop).
 * Only skills are loaded from this directory — agents, commands, plugins are .opencode/-only.
 */
const EXTERNAL_SKILLS_GLOBS = [
	`${PATHS.EXTERNAL_AGENTS_SKILLS_DIR}/**`,
	`${PATHS.EXTERNAL_CLAUDE_SKILLS_DIR}/**`,
];

/**
 * Maps a path segment to its resource type.
 * Order doesn't matter — first match wins during routing.
 */
const PATH_SEGMENT_TO_TYPE: [segment: string, type: ResourceType][] = [
	[PATHS.OPENCODE_COMMANDS_DIR, 'commands'],
	[PATHS.OPENCODE_SKILLS_DIR, 'skills'],
	[PATHS.OPENCODE_AGENTS_DIR, 'subagents'],
];

// =============================================================================
// Types
// =============================================================================

export interface ResourceChangeEvent {
	resourceType: ResourceType | 'rules';
	timestamp: number;
}

// =============================================================================
// ResourceWatcherService
// =============================================================================

export class ResourceWatcherService implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _debounceTimers = new Map<ResourceType | 'rules', ReturnType<typeof setTimeout>>();
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

		// Watcher for the entire .opencode/ tree — saves OS file descriptors
		const opencodeWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, OPENCODE_GLOB),
		);

		opencodeWatcher.onDidCreate(uri => this._routeEvent(uri));
		opencodeWatcher.onDidChange(uri => this._routeEvent(uri));
		opencodeWatcher.onDidDelete(uri => this._routeEvent(uri));

		this._disposables.push(opencodeWatcher);

		// Watchers for external skill directories (.agents/skills/, .claude/skills/)
		for (const glob of EXTERNAL_SKILLS_GLOBS) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(workspaceRoot, glob),
			);

			watcher.onDidCreate(uri => this._routeExternalSkillEvent(uri));
			watcher.onDidChange(uri => this._routeExternalSkillEvent(uri));
			watcher.onDidDelete(uri => this._routeExternalSkillEvent(uri));

			this._disposables.push(watcher);
		}

		this._started = true;
		logger.info(
			'[ResourceWatcherService] Started watching .opencode/, .agents/skills/, .claude/skills/',
		);
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
		if (
			fsPath.includes(`/${PATHS.OPENCODE_RULES_DIR}/`) ||
			fsPath.endsWith(`/${PATHS.OPENCODE_RULES_DIR}`)
		) {
			this._scheduleReload('rules');
			return;
		}
		// Ignore events outside known resource directories
	}

	/** Route external skill directory events (.agents/skills/, .claude/skills/) → skills reload. */
	private _routeExternalSkillEvent(uri: vscode.Uri): void {
		if (!uri.fsPath.endsWith('.md')) return;
		this._scheduleReload('skills');
	}

	private _scheduleReload(type: ResourceType | 'rules'): void {
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
