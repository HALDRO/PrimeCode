/**
 * @file CLI Types
 * @description Shared types and interfaces for CLI executors.
 * CLIEvent is a discriminated union keyed on `type` — each variant carries
 * a strongly-typed `data` payload so downstream consumers never need
 * `as Record<string, unknown>` casts.
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
	/** Auto-approve all permissions (yoloMode / autoApprove setting). */
	autoApprove?: boolean;
	/** Granular permission policies from the UI — all OpenCode categories. */
	policies?: Partial<Record<string, string>>;
}

// =============================================================================
// CLIEvent — Discriminated Union
// =============================================================================

/** Base fields shared by every CLIEvent variant. */
interface CLIEventBase {
	normalizedEntry?: NormalizedEntry;
	sessionId?: string;
}

// -- Per-type data payloads ---------------------------------------------------

export interface MessageEventData {
	content: string;
	partId?: string;
	isDelta: boolean;
	timestamp?: string;
}

export interface ThinkingEventData {
	content: string;
	partId?: string;
	isDelta: boolean;
	timestamp?: string;
	durationMs?: number;
}

export interface ToolUseEventData {
	id?: string;
	tool?: string;
	name?: string;
	input?: unknown;
	state?: string;
	title?: string;
	metadata?: unknown;
	toolUseId?: string;
	timestamp?: string;
}

export interface ToolResultEventData {
	tool_use_id?: string;
	id?: string;
	name?: string;
	tool?: string;
	content?: string | unknown;
	is_error?: boolean;
	input?: unknown;
	title?: string;
	metadata?: unknown;
	timestamp?: string;
}

export interface ErrorEventData {
	message: string;
}

export interface FinishedEventData {
	reason: string;
}

export interface PermissionEventData {
	id?: string;
	requestId?: string;
	permission?: string;
	patterns?: unknown[];
	toolCallId?: string;
	toolUseId?: string;
	tool?: string;
	toolInput?: unknown;
	input?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface QuestionEventData {
	id: string;
	requestId: string;
	questions: import('../../common/schemas').QuestionInfo[];
	tool?: { messageID: string; callID: string };
}

export interface SessionUpdatedEventData {
	sessionId?: string;
	status?: { type: string; raw?: unknown };
	totalStats?: Record<string, unknown>;
	modelID?: string;
	providerID?: string;
}

export interface TurnTokensEventData {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	durationMs?: number;
	userMessageId?: string;
}

export interface NormalizedLogEventData {
	role?: string;
	content?: string;
	timestamp?: string;
	messageId?: string;
	attachments?: {
		files?: string[];
		codeSnippets?: Array<{
			filePath: string;
			startLine: number;
			endLine: number;
			content: string;
		}>;
		images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
	};
	[key: string]: unknown;
}

// -- Discriminated union variants ---------------------------------------------

export type CLIEvent =
	| (CLIEventBase & { type: 'message'; data: MessageEventData })
	| (CLIEventBase & { type: 'thinking'; data: ThinkingEventData })
	| (CLIEventBase & { type: 'tool_use'; data: ToolUseEventData })
	| (CLIEventBase & { type: 'tool_result'; data: ToolResultEventData })
	| (CLIEventBase & { type: 'error'; data: ErrorEventData })
	| (CLIEventBase & { type: 'finished'; data: FinishedEventData })
	| (CLIEventBase & { type: 'permission'; data: PermissionEventData })
	| (CLIEventBase & { type: 'question'; data: QuestionEventData })
	| (CLIEventBase & { type: 'session_updated'; data: SessionUpdatedEventData })
	| (CLIEventBase & { type: 'turn_tokens'; data: TurnTokensEventData })
	| (CLIEventBase & { type: 'normalized_log'; data: NormalizedLogEventData });

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
	/** Abort a single session by ID (used for timed-out subtasks). */
	abortSession?(sessionId: string): Promise<void>;
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
