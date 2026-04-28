/**
 * @file ResourceWatcherService
 * @description Watches `.opencode/`, `.claude/skills/`, and `.agents/skills/` resource directories
 *              for file changes and emits events so the UI auto-refreshes.
 *              Analogous to McpConfigWatcherService but for resource files.
 *              Debounces rapid changes to avoid excessive reloads.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import {
	getGlobalAgentsDir,
	getGlobalClaudeDir,
	getGlobalOpenCodeDir,
} from './opencode/OpenCodeConfigService';
import type { ResourceService, ResourceType } from './ResourceService';

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_MS = 300;

const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'] as const;
const GLOBAL_CLAUDE_INSTRUCTION_FILES = ['CLAUDE.md'] as const;
const OPENCODE_RESOURCE_SPECS = [
	{ type: 'commands', dirs: ['command', 'commands'], pattern: '**/*.md' },
	{ type: 'skills', dirs: ['skill', 'skills'], pattern: '**/SKILL.md' },
	{ type: 'subagents', dirs: ['agent', 'agents'], pattern: '**/*.md' },
	{ type: 'plugins', dirs: ['plugin', 'plugins'], pattern: '*.{ts,js}' },
	{ type: 'rules', dirs: ['rules'], pattern: '**/*.md' },
] as const satisfies ReadonlyArray<{
	type: ResourceType | 'plugins' | 'rules';
	dirs: readonly string[];
	pattern: string;
}>;

const COMPATIBLE_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

// =============================================================================
// Types
// =============================================================================

export interface ResourceChangeEvent {
	resourceType: ResourceType | 'plugins' | 'rules';
	timestamp: number;
}

// =============================================================================
// ResourceWatcherService
// =============================================================================

export class ResourceWatcherService implements vscode.Disposable {
	private _disposables: vscode.Disposable[] = [];
	private _debounceTimers = new Map<
		ResourceType | 'plugins' | 'rules',
		ReturnType<typeof setTimeout>
	>();
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

		this._registerProjectWatchers(workspaceRoot);
		this._registerGlobalWatchers();

		this._started = true;
		logger.info(
			'[ResourceWatcherService] Started watching project and global resource directories',
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

	private _registerProjectWatchers(workspaceRoot: string): void {
		this._registerOpenCodeResourceWatchers(path.join(workspaceRoot, PATHS.OPENCODE_DIR));
		this._registerInstructionWatchers(workspaceRoot, PROJECT_INSTRUCTION_FILES);

		for (const compatibleDir of COMPATIBLE_SKILL_DIRS) {
			this._watchPattern(workspaceRoot, `${compatibleDir}/**/SKILL.md`, 'skills');
		}
	}

	private _registerGlobalWatchers(): void {
		const globalOpenCodeDir = getGlobalOpenCodeDir();
		if (globalOpenCodeDir) {
			this._registerOpenCodeResourceWatchers(globalOpenCodeDir);
			this._registerInstructionWatchers(globalOpenCodeDir, ['AGENTS.md']);
		}

		const globalClaudeDir = getGlobalClaudeDir();
		if (globalClaudeDir) {
			this._watchPattern(globalClaudeDir, 'skills/**/SKILL.md', 'skills');
			this._registerInstructionWatchers(globalClaudeDir, GLOBAL_CLAUDE_INSTRUCTION_FILES);
		}

		const globalAgentsDir = getGlobalAgentsDir();
		if (globalAgentsDir) {
			this._watchPattern(globalAgentsDir, 'skills/**/SKILL.md', 'skills');
		}
	}

	private _registerOpenCodeResourceWatchers(configDir: string): void {
		for (const spec of OPENCODE_RESOURCE_SPECS) {
			for (const dir of spec.dirs) {
				this._watchPattern(configDir, `${dir}/${spec.pattern}`, spec.type);
			}
		}
	}

	private _registerInstructionWatchers(
		basePath: string,
		files: readonly (typeof PROJECT_INSTRUCTION_FILES)[number][],
	): void {
		for (const file of files) {
			this._watchPattern(basePath, file, 'rules');
		}
	}

	private _watchPattern(
		basePath: string,
		pattern: string,
		type: ResourceType | 'plugins' | 'rules',
	): void {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(basePath, pattern),
		);
		watcher.onDidCreate(() => this._scheduleReload(type));
		watcher.onDidChange(() => this._scheduleReload(type));
		watcher.onDidDelete(() => this._scheduleReload(type));
		this._disposables.push(watcher);
	}

	private _scheduleReload(type: ResourceType | 'plugins' | 'rules'): void {
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
