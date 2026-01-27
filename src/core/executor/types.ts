/**
 * @file CLI Types
 * @description Shared types and interfaces for CLI executors.
 */

import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { NormalizedEntry } from '../../common/normalizedEvents';

export interface CLIConfig {
	provider: 'claude' | 'opencode';
	model?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	/** Additional env vars for the spawned CLI process. */
	env?: Record<string, string>;
	/** Optional server startup timeout override (milliseconds). */
	serverTimeoutMs?: number;
	/** Enable auto-compaction for OpenCode. */
	autoCompact?: boolean;
	/** Enable git commit reminder checks (Claude). */
	commitReminder?: boolean;
}

export interface CLIEvent {
	type:
		| 'message'
		| 'tool_use'
		| 'tool_result'
		| 'thinking'
		| 'error'
		| 'finished'
		| 'permission'
		| 'session_updated'
		| 'normalized_log';
	data: unknown;
	normalizedEntry?: NormalizedEntry;
}

export interface CLIExecutor extends EventEmitter {
	ensureServer(config: CLIConfig): Promise<void>;
	spawn(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess>;
	/** Spawn a process specifically for code review. */
	spawnReview?(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	kill(): Promise<void>;
	parseStream(chunk: Buffer): CLIEvent[];
	getSessionId(): string | null;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;

	getAdminInfo(): { baseUrl: string; directory: string } | null;

	// Kanban-style forward compatibility: feature flags
	getCapabilities?(): ReadonlyArray<'SessionFork' | 'SetupHelper'>;
}
