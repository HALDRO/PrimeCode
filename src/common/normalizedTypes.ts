import { pathsReferToSameFile } from '../utils/path';

/**
 * @file Normalized Event Types
 * @description Pure type definitions for normalized log entries.
 *              Shared between extension (core/) and webview with no Node.js imports.
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
	| { type: 'FileEdit'; path: string; changes: FileChange[]; diagnostics?: LspDiagnosticsByFile }
	| { type: 'CommandRun'; command: string; result?: CommandRunResult }
	| { type: 'Search'; query: string }
	| { type: 'WebFetch'; url: string }
	| { type: 'WebSearch'; query: string }
	| { type: 'CodeSearch'; query: string }
	| { type: 'ApplyPatch'; files: ApplyPatchFile[] }
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

// ---------------------------------------------------------------------------
// LSP Diagnostics (from edit/write/apply_patch tool metadata)
// ---------------------------------------------------------------------------

export interface LspDiagnostic {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	message: string;
	/** 1=Error, 2=Warning, 3=Info, 4=Hint */
	severity?: number;
}

/** Map of file path → diagnostics array */
export type LspDiagnosticsByFile = Record<string, LspDiagnostic[]>;

export function extractLspDiagnostics(
	metadata: Record<string, unknown> | undefined,
): LspDiagnosticsByFile | undefined {
	if (!metadata) return undefined;
	const raw = metadata.diagnostics;
	if (!raw || typeof raw !== 'object') return undefined;

	const result: LspDiagnosticsByFile = {};
	for (const [filePath, diags] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(diags)) continue;
		const valid = diags.filter(
			(d): d is LspDiagnostic => d && typeof d === 'object' && 'message' in d && 'range' in d,
		);
		const errors = valid.filter(d => !d.severity || d.severity === 1);
		if (errors.length > 0) result[filePath] = errors;
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

function findDiagnosticMatch(
	diagnostics: LspDiagnosticsByFile,
	filePath: string,
	workspaceRoot?: string,
): LspDiagnostic[] | undefined {
	for (const [diagnosticPath, items] of Object.entries(diagnostics)) {
		if (pathsReferToSameFile(diagnosticPath, filePath, workspaceRoot)) {
			return items;
		}
	}

	return undefined;
}

export function remapLspDiagnosticsToFilePaths(
	metadata: Record<string, unknown> | undefined,
	filePaths: string[],
	workspaceRoot?: string,
): Record<string, unknown> | undefined {
	const diagnostics = extractLspDiagnostics(metadata);
	if (!metadata || !diagnostics || filePaths.length === 0) return metadata;

	const remapped: LspDiagnosticsByFile = {};
	for (const filePath of filePaths) {
		const match = findDiagnosticMatch(diagnostics, filePath, workspaceRoot);
		if (match && match.length > 0) {
			remapped[filePath] = match;
		}
	}

	if (Object.keys(remapped).length === 0) return metadata;
	return {
		...metadata,
		diagnostics: remapped,
	};
}

// ---------------------------------------------------------------------------
// ApplyPatch (multi-file patch tool used by GPT models)
// ---------------------------------------------------------------------------

export interface ApplyPatchFile {
	path: string;
	status: 'add' | 'update' | 'delete' | 'move';
	newPath?: string;
	oldContent?: string;
	newContent?: string;
}

import { extractPatchFilePaths, resolveToolName } from './toolRegistry';

const getString = (value: unknown): string => (typeof value === 'string' ? value : '');

const getNumber = (value: unknown): number | undefined =>
	typeof value === 'number' ? value : undefined;

const getPathFromInput = (input: Record<string, unknown>) =>
	getString(input.path ?? input.file_path ?? input.filePath);

const getFirstString = (input: Record<string, unknown>, keys: string[]): string =>
	getString(keys.reduce<unknown>((value, key) => value ?? input[key], undefined));

const getSearchQuery = (input: Record<string, unknown>): string =>
	getFirstString(input, ['query', 'search_query', 'pattern', 'glob_pattern', 'glob']);

const mapEditChange = (input: Record<string, unknown>): FileChange => {
	const diff = getString(input.diff);
	const oldContent = getString(input.old_string ?? input.old_str ?? input.oldString);
	const newContent = getString(
		input.new_string ?? input.new_str ?? input.newString ?? input.content,
	);

	if (diff) return { type: 'Edit', unifiedDiff: diff, hasLineNumbers: false };
	if (oldContent || newContent) {
		return { type: 'Replace', oldContent, newContent };
	}
	return { type: 'Edit', unifiedDiff: '', hasLineNumbers: false };
};

const mapTodoItems = (input: Record<string, unknown>): TodoItem[] =>
	Array.isArray(input.todos)
		? input.todos.map(todo => {
				const item = todo as { content?: string; status?: string; priority?: string };
				return {
					content: item.content || '',
					status: item.status || 'pending',
					priority: item.priority || 'medium',
				};
			})
		: [];

export function buildToolActionType(toolName: string, input: Record<string, unknown>): ActionType {
	const canonical = resolveToolName(toolName);
	const path = getPathFromInput(input);

	switch (canonical) {
		case 'read': {
			const readOffset = getNumber(input.offset);
			const readLimit = getNumber(input.limit);
			return {
				type: 'FileRead',
				path,
				...(readOffset !== undefined && { offset: readOffset }),
				...(readLimit !== undefined && { limit: readLimit }),
			};
		}

		case 'write': {
			const content = getFirstString(input, ['content', 'contents']);
			return {
				type: 'FileEdit',
				path,
				changes: [{ type: 'Write', content }],
			};
		}

		case 'edit':
		case 'multiedit':
		case 'patch': {
			return { type: 'FileEdit', path, changes: [mapEditChange(input)] };
		}

		case 'bash':
			return { type: 'CommandRun', command: getString(input.command) };

		case 'grep':
			return { type: 'Search', query: getFirstString(input, ['pattern', 'query']) };

		case 'glob':
			return {
				type: 'Search',
				query: getFirstString(input, ['pattern', 'glob_pattern', 'glob', 'query']),
			};

		case 'list':
		case 'ls':
			return { type: 'Tool', toolName: 'list', arguments: input };

		case 'task':
			return { type: 'TaskCreate', description: getFirstString(input, ['description', 'prompt']) };

		case 'apply_patch': {
			const files = extractPatchFilePaths(input).map(path => ({
				path,
				status: 'update' as const,
			}));
			return { type: 'ApplyPatch', files };
		}

		case 'lsp': {
			const operation = getString(input.operation) || 'unknown';
			const lspPath = getFirstString(input, ['filePath', 'file_path']);
			const line = getNumber(input.line) ?? 0;
			const character = getNumber(input.character) ?? 0;
			return {
				type: 'Tool',
				toolName: 'lsp',
				arguments: { operation, filePath: lspPath, line, character },
			};
		}

		case 'websearch':
			return { type: 'WebSearch', query: getFirstString(input, ['query', 'search_query']) };

		case 'codesearch':
			return { type: 'CodeSearch', query: getFirstString(input, ['query', 'search_query']) };

		case 'skill':
			return { type: 'Tool', toolName: 'skill', arguments: input };

		case 'todowrite':
			return { type: 'TodoManagement', operation: 'write', todos: mapTodoItems(input) };

		default:
			return canonical === 'webfetch'
				? { type: 'WebFetch', url: getString(input.url) }
				: canonical === 'search'
					? { type: 'Search', query: getSearchQuery(input) }
					: { type: 'Tool', toolName, arguments: input };
	}
}
