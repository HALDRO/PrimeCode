/**
 * @file CLI Service Types
 * @description Shared types for CLI service implementations (Claude, OpenCode)
 */

export interface CLIProcessOptions {
	workspaceDir?: string;
	apiKey?: string;
	model?: string;
	provider?: string;
	customInstructions?: string;
	mcpServers?: Record<string, unknown>;
	sessionId?: string;
	selectedModel?: string;
	message?: string;
	command?: string;
	commandArgs?: string[];
	agent?: string;
	tools?: string[];
	systemPrompt?: string;
	noReply?: boolean;
	proxyConfig?: {
		enabled?: boolean;
		targetBaseUrl: string;
		baseUrl?: string;
		apiKey: string;
		model?: string;
		useSingleModel?: boolean;
		haikuModel?: string;
		sonnetModel?: string;
		opusModel?: string;
		subagentModel?: string;
	};
}

export interface CLIStreamData {
	type:
		| 'message'
		| 'tool'
		| 'tool_result'
		| 'thinking'
		| 'error'
		| 'usage'
		| 'session'
		| 'system'
		| 'subtask'
		| 'assistant'
		| 'stream_event'
		| 'tool_progress'
		| 'auth_status'
		| 'result'
		| 'user'
		| 'part-update'
		| 'message-update'
		| 'permission-required'
		| 'session-updated'
		| 'session-idle';
	content?: string;
	toolName?: string;
	toolInput?: unknown;
	toolResult?: string;
	error?: string;
	errors?: unknown[];
	usage?: ModelUsage;
	sessionId?: string;
	parts?: MessagePart[];
	message?: unknown;
	modelUsage?: ModelUsage;
	result?: unknown;
	subtype?: string;
	subtask?: unknown;
	streamEvent?: unknown;
	toolProgress?: unknown;
	authStatus?: unknown;
	tools?: unknown[];
	status?: string | null;
	compactMetadata?: unknown;
	contextId?: string;
	structuredOutput?: unknown;
	mcpServers?: unknown;
	part?: unknown;
	durationMs?: number;
	permission?: unknown;
	sessionTitle?: string;
	isError?: boolean;
	sessionStatus?: string;
	fullMessage?: unknown;
	totalCostUsd?: number;
	durationApiMs?: number;
	numTurns?: number;
	permissionDenials?: unknown[];
}

export interface CLISession {
	id: string;
	title: string;
	createdAt?: string;
	updatedAt?: string;
	projectID?: string;
	directory?: string;
	time?: {
		created: number;
		updated: number;
	};
}

export interface CLIAgent {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
}

export interface CLIConfig {
	provider: string;
	model?: string;
	apiKey?: string;
}

export interface CLIModelInfo {
	id: string;
	name: string;
	provider: string;
	contextWindow?: number;
	reasoning?: boolean;
	temperature?: number;
}

export interface CLIProvidersResponse {
	providers: Array<{
		id: string;
		name: string;
		models: CLIModelInfo[];
	}>;
}

export interface PermissionResponse {
	allowed: boolean;
	reason?: string;
}

export interface PermissionDenial {
	tool: string;
	reason: string;
}

export interface ModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	reasoning_tokens?: number;
}

export interface MessagePart {
	id: string;
	type: 'text' | 'tool_use' | 'tool_result';
	content?: string;
	toolName?: string;
	toolInput?: unknown;
	toolResult?: string;
	state?: ToolState;
}

export type ToolState = 'pending' | 'running' | 'success' | 'error';
