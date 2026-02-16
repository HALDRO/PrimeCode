/**
 * @file CLI Types
 * @description Shared types and interfaces for CLI executors.
 */

import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { NormalizedEntry } from './LogNormalizer';

export interface CLIConfig {
	provider: 'opencode';
	model?: string;
	/** Optional stable message ID for OpenCode prompts (used for edit/revert flows). */
	messageID?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	/** Additional env vars for the spawned CLI process. */
	env?: Record<string, string>;
	/** Optional server startup timeout override (milliseconds). */
	serverTimeoutMs?: number;
	/** Optional existing server URL to connect to. */
	serverUrl?: string;
	/** Enable auto-compaction for OpenCode. */
	autoCompact?: boolean;
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
		| 'question'
		| 'session_updated'
		| 'normalized_log'
		| 'turn_tokens';
	data: unknown;
	normalizedEntry?: NormalizedEntry;
	sessionId?: string;
}

export interface CLIExecutor extends EventEmitter {
	ensureServer(config: CLIConfig): Promise<void>;
	spawn(prompt: string, config: CLIConfig): Promise<ChildProcess | null>;
	spawnFollowUp(
		prompt: string,
		sessionId: string,
		config: CLIConfig,
		attachments?: {
			files?: string[];
			codeSnippets?: Array<{
				filePath: string;
				content: string;
				startLine?: number;
				endLine?: number;
			}>;
			images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
		},
	): Promise<ChildProcess | null>;
	/** Truncate session history at a specific message ID (OpenCode only). */
	truncateSession?(sessionId: string, messageId: string, config: CLIConfig): Promise<void>;
	/** Spawn a process specifically for code review. */
	spawnReview?(prompt: string, config: CLIConfig): Promise<ChildProcess | null>;
	createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess | null>;
	/** Creates an empty session without sending a message. Returns the session ID. */
	createEmptySession(config: CLIConfig): Promise<string>;
	kill(): Promise<void>;
	abort(): Promise<void>;
	parseStream(chunk: Buffer): CLIEvent[];
	getSessionId(): string | null;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;

	/** Reply to an OpenCode question tool prompt. */
	respondToQuestion?(decision: { requestId: string; answers: string[][] }): Promise<void>;
	/** Reject/dismiss an OpenCode question. */
	rejectQuestion?(requestId: string): Promise<void>;

	getAdminInfo(): { baseUrl: string; directory: string } | null;
	/** Returns the SDK client instance if available (OpenCode only). */
	getSdkClient?(): import('@opencode-ai/sdk').OpencodeClient | null;
	listSessions(config: CLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>
	>;
	getHistory(sessionId: string, config: CLIConfig): Promise<CLIEvent[]>;

	/** Deletes a session by ID. Returns true if successful. */
	deleteSession(sessionId: string, config: CLIConfig): Promise<boolean>;
	/** Updates a session's title. Returns true if successful. */
	renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean>;

	// Kanban-style forward compatibility: feature flags
	getCapabilities?(): ReadonlyArray<'SessionFork' | 'SetupHelper'>;
}
