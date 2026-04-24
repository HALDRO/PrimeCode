/**
 * @file CLI Types
 * @description Shared types and interfaces for CLI executors.
 */

import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export interface CLIConfig {
	provider: 'opencode';
	model?: string;
	/** Optional stable message ID for OpenCode prompts (used for edit/revert flows). */
	messageID?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	/** Thinking effort variant (e.g. 'high', 'max', 'low'). Sent to CLI as-is. */
	variant?: string;
	/** Additional env vars for the spawned CLI process. */
	env?: Record<string, string>;
	/** Optional server startup timeout override (milliseconds). */
	serverTimeoutMs?: number;
	/** Optional existing server URL to connect to. */
	serverUrl?: string;
	/** Enable auto-compaction for OpenCode. */
	autoCompact?: boolean;
	/** Auto-approve all permissions (yoloMode / autoApprove setting). */
	autoApprove?: boolean;
	/** Granular permission policies from the UI — all OpenCode categories. */
	policies?: Partial<Record<string, string>>;
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
	/** Delete a message and all newer messages without reverting workspace snapshot. */
	deleteSessionMessagesFrom?(
		sessionId: string,
		messageId: string,
		config: CLIConfig,
	): Promise<string[]>;
	/** Execute a slash command (e.g. /compact, /summarize) via the appropriate API. */
	executeCommand(
		command: string,
		args: string[],
		config: CLIConfig,
		sessionId?: string,
	): Promise<void>;
	/** Spawn a process specifically for code review. */
	spawnReview?(prompt: string, config: CLIConfig): Promise<ChildProcess | null>;
	createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess | null>;
	/** Creates an empty session without sending a message. Returns the session ID. */
	createEmptySession(config: CLIConfig): Promise<string>;
	kill(): Promise<void>;
	abort(): Promise<void>;
	/** Abort a single session by ID. */
	abortSession?(sessionId: string): Promise<void>;
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
	/** Returns true if the given session is currently active (busy) on the backend. */
	isSessionActive?(sessionId: string): boolean;
	/** Returns the SDK client instance if available (OpenCode only). */
	getSdkClient?(): import('@opencode-ai/sdk/v2/client').OpencodeClient | null;
	/** Fetch skills from the OpenCode server (GET /skill). */
	listSkills?(
		directory: string,
	): Promise<Array<{ name: string; description: string; location?: string; content?: string }>>;
	/** Fetch agents from the OpenCode server (GET /agent). */
	listAgents?(directory: string): Promise<unknown>;
	/** Returns connection details for the status UI. */
	getConnectionDetails?(): {
		serverUrl: string | null;
		isServerOwner: boolean;
		port: number | null;
		uptime: number | null;
	};
	/** Restart the local OpenCode server, if this window owns it. */
	restartServer?(): Promise<boolean>;
	/** Invalidate the skills cache so the next listSkills() call fetches fresh data. */
	clearSkillsCache?(): void;
	/** Invalidate the commands cache so the next fetch fetches fresh data. */
	clearCommandsCache?(): void;
	/** Invalidate the agents cache so the next listAgents() call fetches fresh data. */
	clearAgentsCache?(): void;
	listSessions(config: CLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>
	>;
	syncSessionSnapshotTotal?(
		sessionId: string,
		turnTokens: Record<string, { total?: number }>,
	): void;

	/** Deletes a session by ID. Returns true if successful. */
	deleteSession(sessionId: string, config: CLIConfig): Promise<boolean>;
	/** Updates a session's title. Returns true if successful. */
	renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean>;

	// Kanban-style forward compatibility: feature flags
	getCapabilities?(): ReadonlyArray<'SessionFork' | 'SetupHelper'>;
}
