import * as path from 'node:path';
import * as vscode from 'vscode';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import {
	getGlobalAgentsDir,
	getGlobalClaudeDir,
	getGlobalOpenCodeDir,
} from './opencode/OpenCodeConfigService';
import type { ResourceType } from './ResourceService';

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

type WatchedResourceType = ResourceType | 'plugins' | 'rules';

export class ResourceWatcherService implements vscode.Disposable {
	private disposables: vscode.Disposable[] = [];
	private debounceTimers = new Map<WatchedResourceType, ReturnType<typeof setTimeout>>();

	public start(
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		if (this.disposables.length > 0) return;

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[ResourceWatcherService] No workspace root, cannot start');
			return;
		}

		this.registerProjectWatchers(workspaceRoot, onResourceChanged);
		this.registerGlobalWatchers(onResourceChanged);
	}

	public dispose(): void {
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
		logger.info('[ResourceWatcherService] Disposed');
	}

	private registerProjectWatchers(
		workspaceRoot: string,
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		this.registerOpenCodeResourceWatchers(
			path.join(workspaceRoot, PATHS.OPENCODE_DIR),
			onResourceChanged,
		);
		this.registerInstructionWatchers(workspaceRoot, PROJECT_INSTRUCTION_FILES, onResourceChanged);

		for (const compatibleDir of COMPATIBLE_SKILL_DIRS) {
			this.watchPattern(workspaceRoot, `${compatibleDir}/**/SKILL.md`, 'skills', onResourceChanged);
		}
	}

	private registerGlobalWatchers(
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		const globalOpenCodeDir = getGlobalOpenCodeDir();
		if (globalOpenCodeDir) {
			this.registerOpenCodeResourceWatchers(globalOpenCodeDir, onResourceChanged);
			this.registerInstructionWatchers(globalOpenCodeDir, ['AGENTS.md'], onResourceChanged);
		}

		const globalClaudeDir = getGlobalClaudeDir();
		if (globalClaudeDir) {
			this.watchPattern(globalClaudeDir, 'skills/**/SKILL.md', 'skills', onResourceChanged);
			this.registerInstructionWatchers(
				globalClaudeDir,
				GLOBAL_CLAUDE_INSTRUCTION_FILES,
				onResourceChanged,
			);
		}

		const globalAgentsDir = getGlobalAgentsDir();
		if (globalAgentsDir) {
			this.watchPattern(globalAgentsDir, 'skills/**/SKILL.md', 'skills', onResourceChanged);
		}
	}

	private registerOpenCodeResourceWatchers(
		configDir: string,
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		for (const spec of OPENCODE_RESOURCE_SPECS) {
			for (const dir of spec.dirs) {
				this.watchPattern(configDir, `${dir}/${spec.pattern}`, spec.type, onResourceChanged);
			}
		}
	}

	private registerInstructionWatchers(
		basePath: string,
		files: readonly (typeof PROJECT_INSTRUCTION_FILES)[number][],
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		for (const file of files) {
			this.watchPattern(basePath, file, 'rules', onResourceChanged);
		}
	}

	private watchPattern(
		basePath: string,
		pattern: string,
		type: WatchedResourceType,
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(basePath, pattern),
		);
		watcher.onDidCreate(() => this.scheduleReload(type, onResourceChanged));
		watcher.onDidChange(() => this.scheduleReload(type, onResourceChanged));
		watcher.onDidDelete(() => this.scheduleReload(type, onResourceChanged));
		this.disposables.push(watcher);
	}

	private scheduleReload(
		type: WatchedResourceType,
		onResourceChanged: (resourceType: WatchedResourceType) => Promise<void> | void,
	): void {
		const existing = this.debounceTimers.get(type);
		if (existing) clearTimeout(existing);

		this.debounceTimers.set(
			type,
			setTimeout(() => {
				this.debounceTimers.delete(type);
				void onResourceChanged(type);
			}, DEBOUNCE_MS),
		);
	}
}
