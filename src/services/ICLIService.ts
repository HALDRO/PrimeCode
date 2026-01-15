/**
 * @file CLI Service Interface
 * @description Defines the unified contract for all AI coding assistant providers (Claude, OpenCode).
 * Ensures consistent behavior across different backends.
 */

import type { CLIProviderType } from '../shared/constants';
import type { TokenUsageAPI } from '../types';

// =============================================================================
// Configuration Types
// =============================================================================

export interface CLIProcessOptions {
	message: string;
	sessionId?: string;
	selectedModel?: string;
	yoloMode?: boolean;
	mcpConfigPath?: string;
	agent?: string;
	proxyConfig?: {
		enabled: boolean;
		baseUrl: string;
		apiKey?: string;
		/** When true, only main model is used for all tasks. When false, task-specific models are used. */
		useSingleModel?: boolean;
		/** Model for fast/simple tasks (Explore agent, quick checks). Defaults to main model. */
		haikuModel?: string;
		/** Model for standard tasks. Defaults to main model. */
		sonnetModel?: string;
		/** Model for complex tasks (plan mode). Defaults to main model. */
		opusModel?: string;
		/** Model for subagents. Defaults to main model. */
		subagentModel?: string;
	};
	// OpenCode SDK v2 additional options
	/** Control which tools are enabled/disabled */
	tools?: Record<string, boolean>;
	/** Custom system prompt for this request */
	systemPrompt?: string;
	/** If true, AI won't reply (useful for adding context) */
	noReply?: boolean;
	/** OpenCode command to execute (e.g., 'init', 'review', 'commit') - uses session.command() instead of session.prompt() */
	command?: string;
	/** Arguments for the command */
	commandArgs?: string;
}

// =============================================================================
// Stream Data Types
// =============================================================================

/** Per-model usage statistics (from SDK) */
export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	webSearchRequests: number;
	costUSD: number;
	contextWindow: number;
}

/** Permission denial record (from SDK) */
export interface PermissionDenial {
	tool_name: string;
	tool_use_id: string;
	tool_input: Record<string, unknown>;
}

export interface ToolState {
	status: 'pending' | 'running' | 'completed' | 'error';
	input?: Record<string, unknown>;
	output?: string;
	error?: string;
	title?: string;
	time?: { start: number; end?: number; compacted?: number };
	metadata?: Record<string, unknown>;
	/** Attached files from tool execution (e.g., screenshots, generated images) */
	attachments?: Array<{
		id: string;
		sessionID: string;
		messageID: string;
		type: 'file';
		mime: string;
		filename?: string;
		url: string;
	}>;
}

export interface MessagePart {
	id: string;
	type:
		| 'text'
		| 'reasoning'
		| 'tool'
		| 'file'
		| 'step-start'
		| 'step-finish'
		| 'thinking'
		| 'subtask';
	text?: string;
	tool?: string;
	state?: ToolState;
	snapshot?: string;
	messageID?: string;
	callID?: string;
	// Extended reasoning fields (Azure OpenAI, Copilot API, Anthropic)
	reasoning_text?: string;
	reasoning_opaque?: string;
	cot_id?: string;
	cot_summary?: string;
	signature?: string;
	// Step-finish fields (OpenCode SDK)
	cost?: number;
	tokens?: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
	// Subtask fields
	prompt?: string;
	description?: string;
	agent?: string;
	command?: string;
}

export interface CLIStreamData {
	type:
		| 'system'
		| 'assistant'
		| 'user'
		| 'result'
		| 'error'
		| 'part-update'
		| 'message-update'
		| 'permission-required'
		| 'session-updated'
		| 'thinking'
		| 'stream_event'
		| 'tool_progress'
		| 'auth_status'
		| 'subtask'
		| 'child-session-created'
		| 'session-idle';
	// Reserved for future use:
	// | 'session_id'
	// | 'clear';
	subtype?: string;
	sessionId?: string;
	sessionTitle?: string;
	/** Session status for session.status events (idle, busy, retry) */
	sessionStatus?: 'idle' | 'busy' | 'retry';
	tools?: string[];
	mcpServers?: string[];
	isError?: boolean;
	result?: string;
	totalCostUsd?: number;
	durationMs?: number;
	/** API call duration in milliseconds */
	durationApiMs?: number;
	numTurns?: number;
	/** Token usage statistics */
	usage?: TokenUsageAPI;
	/** Per-model usage breakdown */
	modelUsage?: Record<string, ModelUsage>;
	/** Permission denials during execution */
	permissionDenials?: PermissionDenial[];
	/** Structured output (when using JSON schema output format) */
	structuredOutput?: unknown;
	/** Error messages (for error result subtypes) */
	errors?: string[];

	message?: {
		id?: string;
		role?: 'user' | 'assistant';
		content: Array<{
			type: string;
			text?: string;
			thinking?: string;
			name?: string;
			id?: string;
			input?: { file_path?: string; todos?: unknown[]; [key: string]: unknown };
			content?: string | unknown;
			is_error?: boolean;
			tool_use_id?: string;
			// Extended reasoning fields (Azure OpenAI, Copilot API, Anthropic)
			reasoning_text?: string;
			reasoning_opaque?: string;
			cot_id?: string;
			cot_summary?: string;
			signature?: string;
		}>;
		usage?: TokenUsageAPI;
	};

	// Stream event for partial message updates (--include-partial-messages)
	streamEvent?: {
		uuid: string;
		event: {
			type: string;
			index?: number;
			delta?: {
				type: string;
				text?: string;
				thinking?: string;
				partial_json?: string;
			};
			content_block?: {
				type: string;
				id?: string;
				name?: string;
				text?: string;
			};
		};
		parentToolUseId?: string;
	};

	part?: MessagePart & { messageID: string };

	fullMessage?: {
		id: string;
		role: 'user' | 'assistant';
		parts?: MessagePart[];
	};

	permission?: {
		id: string;
		type: string;
		pattern?: string | string[];
		sessionID: string;
		messageID: string;
		callID?: string;
		title: string;
		metadata: Record<string, unknown>;
		time: { created: number };
	};

	// Compact boundary (when type === 'system' && subtype === 'compact_boundary')
	compactMetadata?: {
		trigger: 'manual' | 'auto';
		preTokens: number;
	};

	// Status (when type === 'system' && subtype === 'status')
	status?: 'compacting' | null;

	// Hook response (when type === 'system' && subtype === 'hook_response')
	hookResponse?: {
		hookName: string;
		hookEvent: string;
		stdout: string;
		stderr: string;
		exitCode?: number;
	};

	// Tool progress (when type === 'tool_progress')
	toolProgress?: {
		toolUseId: string;
		toolName: string;
		parentToolUseId?: string;
		elapsedTimeSeconds: number;
	};

	// Auth status (when type === 'auth_status')
	authStatus?: {
		isAuthenticating: boolean;
		output: string[];
		error?: string;
	};

	// Subtask data (when type === 'subtask')
	subtask?: {
		id: string;
		prompt: string;
		description: string;
		agent: string;
		command?: string;
		messageID: string;
		/** Subtask status - used by Claude SDK subagent events */
		status?: 'running' | 'completed' | 'error';
		/** Result message when subtask completes */
		result?: string;
	};

	/** Unified context ID (thread ID) for grouping messages. Used by both Claude and OpenCode. */
	contextId?: string;
}

// =============================================================================
// Entitiy Types
// =============================================================================

export type PermissionResponse = 'once' | 'always' | 'reject';

export interface CLIAgent {
	name: string;
	description?: string;
	mode: 'subagent' | 'primary' | 'all';
	builtIn: boolean;
	options?: Record<string, unknown>;
}

export interface CLISession {
	id: string;
	title: string;
	projectID?: string;
	directory?: string;
	time?: { created: number; updated: number };
}

export interface OpenCodeFullConfig {
	permission?: {
		edit?: 'ask' | 'allow' | 'deny';
		bash?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
		skill?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
		webfetch?: 'ask' | 'allow' | 'deny';
		doom_loop?: 'ask' | 'allow' | 'deny';
		external_directory?: 'ask' | 'allow' | 'deny';
	};
	instructions?: string[];
	[key: string]: unknown;
}

// =============================================================================
// Service Interface
// =============================================================================

export interface ICLIService {
	/** Initialize the service (e.g. check deps, start server) */
	initialize(workspaceRoot?: string): Promise<void>;

	/** Check if ready to accept requests */
	isReady(): boolean;

	/** Get current provider type identifier */
	getProviderType(): CLIProviderType;

	/** Get associated workspace root */
	getWorkspaceRoot(): string | undefined;

	// Process Management
	startProcess(
		options: CLIProcessOptions,
		onData: (data: CLIStreamData) => void,
		onClose: (code: number | null, errorOutput: string) => void,
		onError: (error: Error) => void,
	): Promise<void>;

	/**
	 * Stop the currently running process.
	 * @description For providers that support parallel sessions (OpenCode), callers may
	 * pass a sessionId to stop only that session's stream.
	 */
	stopProcess(sessionId?: string): Promise<boolean>;
	/**
	 * Check if a process is running.
	 * @description For providers that support parallel sessions (OpenCode), callers may
	 * pass a sessionId to query only that session.
	 */
	isProcessRunning(sessionId?: string): boolean;
	dispose(): Promise<void>;

	// Simple One-Shot Requests
	/**
	 * Run a simple prompt and get a text response (no streaming, no session).
	 * Used for utility tasks like Prompt Improver where we just need a quick text response.
	 * @param prompt - The prompt text to send
	 * @param options - Optional configuration (model, timeout, proxyConfig)
	 * @returns The text response from the model
	 */
	runSimplePrompt?(
		prompt: string,
		options?: {
			model?: string;
			timeoutMs?: number;
			proxyConfig?: CLIProcessOptions['proxyConfig'];
		},
	): Promise<string>;

	// Session Management
	getCurrentSessionId(): string | null;
	getCurrentSessionTitle(): string;
	createSession(): Promise<string>;
	listSessions(): Promise<CLISession[]>;
	switchSession(sessionId: string): Promise<CLISession>;
	getMessages(sessionId: string): Promise<Array<{ info: unknown; parts: unknown[] }>>;
	abortSession(sessionId?: string): Promise<void>;

	// Session Management - Extended (optional - primarily for OpenCode)
	/** Revert session to a specific message (undo changes after that message) */
	revertToMessage?(
		sessionId: string,
		messageId: string,
	): Promise<{ success: boolean; error?: string }>;
	/** Unrevert session - undo the last revert operation */
	unrevertSession?(sessionId: string): Promise<{ success: boolean; error?: string }>;
	/** Fork session at a specific message, creating a new session with preserved context */
	forkSession?(
		sessionId: string,
		messageId: string,
	): Promise<{ success: boolean; newSessionId?: string; error?: string }>;
	/** Delete a session permanently */
	deleteSession?(sessionId: string): Promise<{ success: boolean; error?: string }>;
	/** Update session properties (e.g., title) */
	updateSession?(
		sessionId: string,
		updates: { title?: string },
	): Promise<{ success: boolean; error?: string }>;
	/** Get file diffs for a session */
	getSessionDiff?(
		sessionId: string,
		messageId?: string,
	): Promise<Array<{
		file: string;
		before: string;
		after: string;
		additions: number;
		deletions: number;
	}> | null>;
	/** Get status of all sessions (idle, busy, retry) */
	getSessionStatus?(): Promise<Record<string, { type: string }> | null>;

	// Health & Monitoring (optional)
	/** Check server health */
	checkHealth?(): Promise<{ healthy: boolean; version?: string }>;
	/** Get global health with version info */
	getGlobalHealth?(): Promise<{ healthy: boolean; version?: string }>;
	/** Get list of pending permissions */
	getPendingPermissions?(): Promise<Array<{
		id: string;
		type: string;
		sessionID: string;
		title: string;
	}> | null>;
	/** List all pending permissions with full details */
	listPendingPermissions?(): Promise<Array<{
		id: string;
		type: string;
		sessionID: string;
		messageID: string;
		title: string;
		metadata: Record<string, unknown>;
	}> | null>;

	// VCS Integration (optional - primarily for OpenCode)
	/** Get VCS (git) information */
	getVcsInfo?(): Promise<{ branch?: string } | null>;
	/** Get git status of files */
	getFileStatus?(): Promise<Array<{
		path: string;
		added: number;
		removed: number;
		status: 'added' | 'deleted' | 'modified';
	}> | null>;

	// Advanced Features
	getAgents(): Promise<CLIAgent[]>;
	/**
	 * Respond to a permission request from the AI assistant.
	 * @param permissionId - The unique permission request ID (requestID in SDK v2)
	 * @param response - The response: 'once' (allow this time), 'always' (allow permanently), 'reject' (deny)
	 * @param message - Optional message explaining the response (SDK v2 feature)
	 */
	respondToPermission(
		permissionId: string,
		response: PermissionResponse,
		message?: string,
	): Promise<void>;

	// Configuration (optional - primarily for OpenCode)
	getConfig?(): Promise<CLIConfig | null>;
	getProviders?(): Promise<CLIProvidersResponse | null>;

	// Provider Management (optional - primarily for OpenCode)
	setProviderAuth?(
		providerId: string,
		apiKey: string,
	): Promise<{ success: boolean; error?: string }>;
	disconnectProvider?(providerId: string): Promise<{ success: boolean; error?: string }>;
	addCustomProvider?(config: {
		id: string;
		name: string;
		baseURL: string;
		apiKey: string;
		models?: Array<{ id: string; name: string }>;
	}): Promise<{ success: boolean; error?: string }>;
	setActiveModel?(model: string): Promise<{ success: boolean; error?: string }>;
	updateConfig?(config: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
	getAvailableProviders?(): Promise<Array<{ id: string; name: string; env: string[] }> | null>;
	getMcpStatus?(): Promise<Record<string, { status: string; error?: string }> | null>;
	startMcpAuth?(
		name: string,
	): Promise<{ success: boolean; authorizationUrl?: string; error?: string }>;
	authenticateMcp?(name: string): Promise<{ success: boolean; error?: string }>;

	// Session Extended Operations (optional - primarily for OpenCode)
	/** Get todo list for a session */
	getSessionTodos?(
		sessionId: string,
	): Promise<Array<{ id: string; content: string; status: string; priority: string }> | null>;
	/** Initialize session - analyzes project and creates AGENTS.md */
	initSession?(
		sessionId: string,
		options?: { providerID?: string; modelID?: string; messageID?: string },
	): Promise<{ success: boolean; error?: string }>;
	/** Execute a command in a session (e.g., /commit, /review) */
	executeCommand?(
		sessionId: string,
		command: string,
		args?: string,
		options?: { agent?: string; model?: string },
	): Promise<{ success: boolean; error?: string }>;
	/** Execute a shell command in session context */
	executeShell?(
		sessionId: string,
		command: string,
		options?: { agent?: string; providerID?: string; modelID?: string },
	): Promise<{ success: boolean; error?: string }>;
	/** Summarize a session using AI compaction */
	summarizeSession?(
		sessionId: string,
		options?: { providerID?: string; modelID?: string; auto?: boolean },
	): Promise<{ success: boolean; error?: string }>;
	/** Share a session - creates a shareable link */
	shareSession?(
		sessionId: string,
		options?: { providerID?: string; modelID?: string },
	): Promise<{ success: boolean; shareUrl?: string; error?: string }>;
	/** Unshare a session - removes the shareable link */
	unshareSession?(sessionId: string): Promise<{ success: boolean; error?: string }>;
	/** Get child sessions (forked from this session) */
	getSessionChildren?(sessionId: string): Promise<CLISession[] | null>;

	// Find Operations (optional - primarily for OpenCode)
	/** Search for text patterns across files using ripgrep */
	findText?(pattern: string): Promise<Array<{
		path: string;
		lineNumber: number;
		text: string;
		matches: Array<{ text: string; start: number; end: number }>;
	}> | null>;
	/** Search for files by name or pattern */
	findFiles?(query: string, includeDirs?: boolean): Promise<string[] | null>;
	/** Search for workspace symbols using LSP */
	findSymbols?(query: string): Promise<Array<{
		name: string;
		kind: number;
		location: {
			uri: string;
			range: {
				start: { line: number; character: number };
				end: { line: number; character: number };
			};
		};
	}> | null>;

	// File Operations (optional - primarily for OpenCode)
	/** List files and directories in a path */
	listFiles?(filePath: string): Promise<Array<{
		name: string;
		path: string;
		absolute: string;
		type: 'file' | 'directory';
		ignored: boolean;
	}> | null>;
	/** Read file content */
	readFile?(
		filePath: string,
	): Promise<{ type: 'text'; content: string; diff?: string; mimeType?: string } | null>;

	// Command & Status Operations (optional - primarily for OpenCode)
	/** Get list of available commands */
	getCommands?(): Promise<Array<{
		name: string;
		description?: string;
		agent?: string;
		model?: string;
		template: string;
		subtask?: boolean;
	}> | null>;
	/** Get LSP server status */
	getLspStatus?(): Promise<Array<{
		id: string;
		name: string;
		root: string;
		status: 'connected' | 'error';
	}> | null>;
	/** Get formatter status */
	getFormatterStatus?(): Promise<Array<{
		name: string;
		extensions: string[];
		enabled: boolean;
	}> | null>;

	// Provider Auth Operations (optional - primarily for OpenCode)
	/** Get available authentication methods for providers */
	getProviderAuthMethods?(): Promise<Record<
		string,
		Array<{ type: 'oauth' | 'api'; label: string }>
	> | null>;
	/** Start OAuth authorization for a provider */
	startProviderOAuth?(
		providerId: string,
		methodIndex?: number,
	): Promise<{
		success: boolean;
		url?: string;
		method?: string;
		instructions?: string;
		error?: string;
	}>;
	/** Complete OAuth callback for a provider */
	completeProviderOAuth?(
		providerId: string,
		code: string,
		methodIndex?: number,
	): Promise<{ success: boolean; error?: string }>;

	// MCP Management (optional - primarily for OpenCode)
	/** Add a new MCP server */
	addMcpServer?(
		name: string,
		config:
			| {
					type: 'local';
					command: string[];
					environment?: Record<string, string>;
					enabled?: boolean;
			  }
			| {
					type: 'remote';
					url: string;
					enabled?: boolean;
					headers?: Record<string, string>;
			  },
	): Promise<{ success: boolean; error?: string }>;
	/** Connect to an MCP server */
	connectMcpServer?(name: string): Promise<{ success: boolean; error?: string }>;
	/** Disconnect from an MCP server */
	disconnectMcpServer?(name: string): Promise<{ success: boolean; error?: string }>;

	// Logging (optional - primarily for OpenCode)
	/** Write a log entry to the server */
	writeLog?(
		level: 'debug' | 'info' | 'warn' | 'error',
		message: string,
		extra?: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }>;

	// Project Management (optional - primarily for OpenCode)
	/** List all projects */
	listProjects?(): Promise<Array<{
		id: string;
		worktree: string;
		name?: string;
		vcs?: 'git';
		time: { created: number; updated: number; initialized?: number };
	}> | null>;
	/** Get current project */
	getCurrentProject?(): Promise<{
		id: string;
		worktree: string;
		name?: string;
		vcs?: 'git';
		time: { created: number; updated: number; initialized?: number };
	} | null>;
	/** Update project properties */
	updateProject?(
		projectId: string,
		updates: { name?: string; icon?: { url?: string; color?: string } },
	): Promise<{ success: boolean; error?: string }>;

	// Part Management (optional - primarily for OpenCode)
	/** Delete a part from a message */
	deletePart?(
		sessionId: string,
		messageId: string,
		partId: string,
	): Promise<{ success: boolean; error?: string }>;
	/** Update a part in a message */
	updatePart?(
		sessionId: string,
		messageId: string,
		partId: string,
		partData: Record<string, unknown>,
	): Promise<{ success: boolean; error?: string }>;

	// Tool Management (optional - primarily for OpenCode)
	/** Get list of available tool IDs */
	getToolIds?(): Promise<string[] | null>;
	/** Get list of tools with their JSON schema for a specific provider/model */
	getTools?(
		provider: string,
		model: string,
	): Promise<Array<{ id: string; description: string; parameters: unknown }> | null>;
}
// Configuration Response Types
// =============================================================================

/** CLI configuration (model selection, etc.) */
export interface CLIConfig {
	model?: string; // Format: "provider/model"
	small_model?: string;
	disabled_providers?: string[];
	enabled_providers?: string[];
	mcp?: Record<string, unknown>;
}

/** Model info from providers */
export interface CLIModelInfo {
	id?: string;
	name?: string;
	temperature?: boolean;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
}

/** Provider info */
export interface CLIProviderInfo {
	id?: string;
	name?: string;
	api?: string;
	npm?: string;
	hasKey?: boolean;
	models?: Record<string, CLIModelInfo>;
}

/** Providers response - map of providerId to provider info */
export interface CLIProvidersResponse {
	[providerId: string]: CLIProviderInfo;
}
