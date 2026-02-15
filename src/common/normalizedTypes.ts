/**
 * @file Normalized Event Types
 * @description Pure type definitions for normalized log entries.
 *              Shared between extension (core/) and webview — no Node.js imports.
 *              Runtime logic lives in core/executor/LogNormalizer.ts.
 */

export interface NormalizedEntry {
	timestamp?: string;
	entryType: NormalizedEntryType;
	content: string;
	metadata?: Record<string, unknown>;
}

export type NormalizedEntryType =
	| 'UserMessage'
	| 'UserFeedback'
	| 'AssistantMessage'
	| { type: 'ToolUse'; toolName: string; actionType: ActionType; status: ToolStatus }
	| 'SystemMessage'
	| { type: 'ErrorMessage'; errorType: NormalizedEntryError }
	| 'Thinking'
	| 'Loading'
	| { type: 'NextAction'; failed: boolean; executionProcesses: number; needsSetup: boolean }
	| { type: 'TokenUsageInfo'; info: TokenUsageInfo };

export type NormalizedEntryError = 'SetupRequired' | 'Other';

export interface TokenUsageInfo {
	totalTokens: number;
	modelContextWindow: number;
}

export type ToolStatus =
	| 'created'
	| 'success'
	| 'failed'
	| { type: 'denied'; reason?: string }
	| { type: 'pending_approval'; approvalId: string; requestedAt: string; timeoutAt: string }
	| 'timed_out';

export type ActionType =
	| { type: 'FileRead'; path: string; offset?: number; limit?: number }
	| { type: 'FileEdit'; path: string; changes: FileChange[] }
	| { type: 'CommandRun'; command: string; result?: CommandRunResult }
	| { type: 'Search'; query: string }
	| { type: 'WebFetch'; url: string }
	| { type: 'Tool'; toolName: string; arguments?: unknown; result?: ToolResult }
	| { type: 'TaskCreate'; description: string }
	| { type: 'TaskResult'; description: string; result: string; status: 'completed' | 'error' }
	| { type: 'PlanPresentation'; plan: string }
	| { type: 'TodoManagement'; todos: TodoItem[]; operation: string }
	| { type: 'Other'; description: string };

export type FileChange =
	| { type: 'Write'; content: string }
	| { type: 'Delete' }
	| { type: 'Rename'; newPath: string }
	| { type: 'Edit'; unifiedDiff: string; hasLineNumbers: boolean }
	| { type: 'Replace'; oldContent: string; newContent: string };

export interface CommandRunResult {
	exitStatus?: CommandExitStatus;
	output?: string;
}

export type CommandExitStatus =
	| { type: 'ExitCode'; code: number }
	| { type: 'Success'; success: boolean };

export type ToolResult = { type: 'Markdown'; value: string } | { type: 'Json'; value: unknown };

export interface TodoItem {
	content: string;
	status: string;
	priority?: string;
}
