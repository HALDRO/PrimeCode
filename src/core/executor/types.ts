/**
 * @file CLI Types
 * @description Shared types and interfaces for the OpenCode server/runtime bridge.
 */

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
}

export interface CLIExecutor extends EventEmitter {
	ensureServer(config: CLIConfig): Promise<void>;
	getAdminInfo(): { baseUrl: string; directory: string } | null;
	getAuthorizationHeader?(): string | null;
	restartServer?(config: CLIConfig): Promise<void>;
	isServerHealthy?(): Promise<boolean>;
	request?(path: string, init?: RequestInit): Promise<Response>;
	/** Returns the SDK client instance if available (OpenCode only). */
	getSdkClient?(): import('@opencode-ai/sdk/v2/client').OpencodeClient | null;
	/** Fetch skills from the OpenCode server (GET /skill). */
	listSkills?(
		directory: string,
	): Promise<Array<{ name: string; description: string; location?: string; content?: string }>>;
	/** Fetch built-in CLI commands from the OpenCode server. */
	listCommands?(directory: string): Promise<Array<{ name: string; description?: string }>>;
	/** Fetch agents from the OpenCode server (GET /agent). */
	listAgents?(directory: string): Promise<unknown>;
	/** Returns connection details for the status UI. */
	getConnectionDetails?(): {
		serverUrl: string | null;
		isServerOwner: boolean;
		port: number | null;
		uptime: number | null;
		runtimeId?: string | null;
	};
	/** Invalidate the skills cache so the next listSkills() call fetches fresh data. */
	clearSkillsCache?(): void;
	/** Invalidate the commands cache so the next fetch fetches fresh data. */
	clearCommandsCache?(): void;
	/** Invalidate the agents cache so the next listAgents() call fetches fresh data. */
	clearAgentsCache?(): void;
	/** Invalidate the MCP status cache so the next getMcpStatus() call fetches fresh data. */
	clearMcpCache?(): void;
}
