/**
 * @file Log Normalizer
 * @description Logic for normalizing raw CLI events and stderr output into structured NormalizedEntry objects.
 *              Type definitions live in common/normalizedTypes.ts (shared with webview).
 */

import { EventEmitter } from 'node:events';

// Re-export all types from the shared location so existing consumers keep working.
export type {
	ActionType,
	CommandExitStatus,
	CommandRunResult,
	FileChange,
	NormalizedEntry,
	NormalizedEntryError,
	NormalizedEntryType,
	TodoItem,
	TokenUsageInfo,
	ToolResult,
	ToolStatus,
} from '../../common/normalizedTypes';

import type {
	ActionType,
	FileChange,
	NormalizedEntry,
	NormalizedEntryType,
} from '../../common/normalizedTypes';

export class LogNormalizer extends EventEmitter {
	private stderrBuffer: Array<{ timestamp: number; line: string }> = [];
	private flushTimeout: NodeJS.Timeout | null = null;
	private readonly FLUSH_DELAY_MS = 200;

	/**
	 * Process a stderr line, clustering burst outputs into single error messages.
	 */
	public processStderr(line: string): void {
		const now = Date.now();
		this.stderrBuffer.push({ timestamp: now, line });

		if (this.flushTimeout) {
			clearTimeout(this.flushTimeout);
		}

		this.flushTimeout = setTimeout(() => this.flushStderr(), this.FLUSH_DELAY_MS);
	}

	private flushStderr(): void {
		if (this.stderrBuffer.length === 0) return;

		const lines = this.stderrBuffer.map(item => item.line).join('\n');
		this.stderrBuffer = [];
		this.flushTimeout = null;

		// Emit normalized error entry
		const entry: NormalizedEntry = {
			timestamp: new Date().toISOString(),
			entryType: { type: 'ErrorMessage', errorType: 'Other' },
			content: lines,
		};
		this.emit('entry', entry);
	}

	/**
	 * Process a text chunk (stdout) or message part, creating appropriate NormalizedEntries.
	 */
	public normalizeMessage(content: string, role: 'user' | 'assistant' | 'system'): NormalizedEntry {
		let entryType: NormalizedEntryType;
		switch (role) {
			case 'user':
				entryType = 'UserMessage';
				break;
			case 'assistant':
				entryType = 'AssistantMessage';
				break;
			case 'system':
				entryType = 'SystemMessage';
				break;
		}

		return {
			timestamp: new Date().toISOString(),
			entryType,
			content,
		};
	}

	/**
	 * Convert a `task` tool_result into a `NormalizedEntry` with `ActionType.TaskResult`.
	 *
	 * Note: we keep `toolName: 'task'` so UI components can treat this as a regular task tool run,
	 * while the `actionType` carries the semantic meaning (result + status).
	 */
	public normalizeTaskResult(
		toolCallId: string,
		description: string,
		result: string,
		isError: boolean,
	): NormalizedEntry {
		const actionType: ActionType = {
			type: 'TaskResult',
			description,
			result,
			status: isError ? 'error' : 'completed',
		};

		return {
			timestamp: new Date().toISOString(),
			entryType: {
				type: 'ToolUse',
				toolName: 'task',
				actionType,
				status: isError ? 'failed' : 'success',
			},
			content: result,
			metadata: { toolCallId },
		};
	}

	/**
	 * Convert a raw tool use event into a NormalizedEntry with ActionType.
	 * This mirrors the 'build_action_type' logic from the reference.
	 */
	public normalizeToolUse(
		toolName: string,
		input: Record<string, unknown>,
		toolCallId: string,
	): NormalizedEntry {
		let actionType: ActionType;

		switch (toolName) {
			case 'ReadFile':
			case 'read_file':
			case 'read': {
				const readOffset = typeof input.offset === 'number' ? input.offset : undefined;
				const readLimit = typeof input.limit === 'number' ? input.limit : undefined;
				actionType = {
					type: 'FileRead',
					path:
						(input.path as string) ||
						(input.file_path as string) ||
						(input.filePath as string) ||
						'',
					...(readOffset !== undefined && { offset: readOffset }),
					...(readLimit !== undefined && { limit: readLimit }),
				};
				break;
			}

			case 'WriteFile':
			case 'write_file':
			case 'Write':
			case 'write':
			case 'writefile': {
				const path =
					(input.path as string) || (input.file_path as string) || (input.filePath as string) || '';
				const content = (input.content as string) || (input.contents as string) || '';
				actionType = {
					type: 'FileEdit',
					path,
					changes: [{ type: 'Write', content }],
				};
				break;
			}

			case 'Edit': // Handle generic "Edit" tool used in mocks and Claude
			case 'EditFile':
			case 'edit_file':
			case 'edit':
			case 'Patch':
			case 'patch':
			case 'MultiEdit':
			case 'multiedit': {
				const path =
					(input.path as string) || (input.file_path as string) || (input.filePath as string) || '';
				const diff = (input.diff as string) || '';
				const oldString =
					(input.old_string as string) ||
					(input.old_str as string) ||
					(input.oldString as string) ||
					'';
				const newString =
					(input.new_string as string) ||
					(input.new_str as string) ||
					(input.newString as string) ||
					'';

				let change: FileChange;

				// Prefer diff if available
				if (diff) {
					change = { type: 'Edit', unifiedDiff: diff, hasLineNumbers: false };
				}
				// Otherwise try search/replace structure
				else if (oldString || newString) {
					change = { type: 'Replace', oldContent: oldString, newContent: newString };
				}
				// Fallback (shouldn't happen for valid calls)
				else {
					change = { type: 'Edit', unifiedDiff: '', hasLineNumbers: false };
				}

				actionType = {
					type: 'FileEdit',
					path,
					changes: [change],
				};
				break;
			}

			case 'RunCommand':
			case 'run_command':
			case 'Bash':
			case 'bash':
				actionType = {
					type: 'CommandRun',
					command: (input.command as string) || '',
				};
				break;

			case 'Search':
			case 'search':
			case 'grep':
				actionType = {
					type: 'Search',
					query: (input.query as string) || (input.pattern as string) || '',
				};
				break;

			case 'SemanticSearch':
			case 'semanticsearch':
			case 'Glob':
			case 'glob':
				actionType = {
					type: 'Search',
					query:
						(input.query as string) ||
						(input.glob_pattern as string) ||
						(input.glob as string) ||
						(input.pattern as string) ||
						'',
				};
				break;

			case 'LS':
			case 'ls':
			case 'list_dir':
			case 'serena_list_dir':
				// Map to Tool, preserving the name so UI can handle list rendering logic if needed,
				// or we could map to CommandRun if we just want to show the command.
				// For now, explicit Tool with 'ls' allows specific UI handling.
				actionType = {
					type: 'Tool',
					toolName: 'ls', // Normalize name
					arguments: input,
				};
				break;

			case 'Task':
			case 'task':
				actionType = {
					type: 'TaskCreate',
					description: (input.description as string) || (input.prompt as string) || '',
				};
				break;

			case 'TodoWrite':
			case 'todo_write':
			case 'todowrite':
				actionType = {
					type: 'TodoManagement',
					operation: 'write',
					todos: Array.isArray(input.todos)
						? input.todos.map(t => {
								const item = t as { content?: string; status?: string; priority?: string };
								return {
									content: item.content || '',
									status: item.status || 'pending',
									priority: item.priority || 'medium',
								};
							})
						: [],
				};
				break;

			default:
				actionType = {
					type: 'Tool',
					toolName,
					arguments: input,
				};
				break;
		}

		return {
			timestamp: new Date().toISOString(),
			entryType: {
				type: 'ToolUse',
				toolName,
				actionType,
				status: 'created', // Initial status
			},
			content: `Tool Use: ${toolName}`,
			metadata: { toolCallId },
		};
	}
}
