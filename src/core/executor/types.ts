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
	/** The agent that produced this message (e.g. 'build', 'plan'). */
	agent?: string;
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
	messageID?: string;
	tool?: string;
	name?: string;
	input?: unknown;
	state?: string;
	title?: string;
	metadata?: unknown;
	toolUseId?: string;
	partId?: string;
	timestamp?: string;
}

export interface ToolResultEventData {
	tool_use_id?: string;
	id?: string;
	messageID?: string;
	name?: string;
	tool?: string;
	content?: string | unknown;
	is_error?: boolean;
	input?: unknown;
	title?: string;
	metadata?: unknown;
	partId?: string;
	timestamp?: string;
}

export interface ToolStreamingEventData {
	id?: string;
	messageID?: string;
	name?: string;
	streamingOutput?: string;
	metadata?: Record<string, unknown>;
	partId?: string;
}

export interface ErrorEventData {
	message: string;
}

export interface FinishedEventData {
	reason: string;
}

export interface ServerReconnectedEventData {
	attempt: number;
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
	sessionID?: string;
	questions: import('../../common/schemas').QuestionInfo[];
	tool?: { messageID: string; callID: string };
}

export interface TodoItemEventData {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
	priority: 'high' | 'medium' | 'low' | string;
}

export interface TodoEventData {
	sessionID: string;
	todos: TodoItemEventData[];
}

export interface PermissionReplyEventData {
	sessionID: string;
	requestID: string;
	reply?: 'once' | 'always' | 'reject';
}

export interface QuestionReplyEventData {
	sessionID: string;
	requestID: string;
	answers?: string[][];
	rejected?: boolean;
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

export interface SessionDiffFileDiff {
	file: string;
	additions: number;
	deletions: number;
	status?: 'added' | 'deleted' | 'modified';
}

export interface SessionDiffEventData {
	sessionID: string;
	diff: SessionDiffFileDiff[];
}

export type LspUpdatedEventData = Record<string, never>;

export interface MessageRecordEventData {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	parentID?: string;
	createdAt?: number;
	completedAt?: number;
	modelID?: string;
	providerID?: string;
	agent?: string;
	tokens?: {
		input: number;
		output: number;
		reasoning?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	cost?: number;
}

export interface MessageRecordRemovedEventData {
	messageID: string;
	sessionID: string;
}

export interface MessagePartEventData {
	id: string;
	messageID: string;
	sessionID: string;
	type: 'text' | 'reasoning' | 'tool' | 'file' | 'compaction' | 'other';
	text?: string;
	callID?: string;
	tool?: string;
	state?: {
		status?: 'pending' | 'running' | 'completed' | 'error';
		input?: unknown;
		output?: string;
		title?: string;
		metadata?: unknown;
	};
	createdAt?: number;
	completedAt?: number;
	mime?: string;
	url?: string;
	filename?: string;
	synthetic?: boolean;
	auto?: boolean;
}

export interface MessagePartDeltaEventData {
	messageID: string;
	partID: string;
	field: string;
	delta: string;
	sessionID: string;
}

export interface MessagePartRemovedEventData {
	messageID: string;
	partID: string;
	sessionID: string;
}

export interface SessionCreatedEventData {
	sessionID: string;
	parentID?: string;
	title?: string;
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
	| (CLIEventBase & { type: 'tool_use'; data: ToolUseEventData })
	| (CLIEventBase & { type: 'tool_result'; data: ToolResultEventData })
	| (CLIEventBase & { type: 'tool_streaming'; data: ToolStreamingEventData })
	| (CLIEventBase & { type: 'error'; data: ErrorEventData })
	| (CLIEventBase & { type: 'finished'; data: FinishedEventData })
	| (CLIEventBase & { type: 'permission'; data: PermissionEventData })
	| (CLIEventBase & { type: 'question'; data: QuestionEventData })
	| (CLIEventBase & { type: 'todo'; data: TodoEventData })
	| (CLIEventBase & { type: 'permission_replied'; data: PermissionReplyEventData })
	| (CLIEventBase & { type: 'question_replied'; data: QuestionReplyEventData })
	| (CLIEventBase & { type: 'session_updated'; data: SessionUpdatedEventData })
	| (CLIEventBase & { type: 'session_created'; data: SessionCreatedEventData })
	| (CLIEventBase & { type: 'turn_tokens'; data: TurnTokensEventData })
	| (CLIEventBase & { type: 'normalized_log'; data: NormalizedLogEventData })
	| (CLIEventBase & { type: 'message_record'; data: MessageRecordEventData })
	| (CLIEventBase & { type: 'message_record_removed'; data: MessageRecordRemovedEventData })
	| (CLIEventBase & { type: 'message_part'; data: MessagePartEventData })
	| (CLIEventBase & { type: 'message_part_delta'; data: MessagePartDeltaEventData })
	| (CLIEventBase & { type: 'message_part_removed'; data: MessagePartRemovedEventData })
	| (CLIEventBase & { type: 'session_diff'; data: SessionDiffEventData })
	| (CLIEventBase & { type: 'lsp_updated'; data: LspUpdatedEventData });

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
	): Promise<void>;
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
	getHistory(sessionId: string, config: CLIConfig): Promise<CLIEvent[]>;

	/** Deletes a session by ID. Returns true if successful. */
	deleteSession(sessionId: string, config: CLIConfig): Promise<boolean>;
	/** Updates a session's title. Returns true if successful. */
	renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean>;

	// Kanban-style forward compatibility: feature flags
	getCapabilities?(): ReadonlyArray<'SessionFork' | 'SetupHelper'>;
}
