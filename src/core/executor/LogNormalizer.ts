/**
 * @file Log Normalizer
 * @description Logic for normalizing raw CLI events and stderr output into structured NormalizedEntry objects.
 */

import { EventEmitter } from 'node:events';
import type { ActionType, NormalizedEntry } from '../../common/normalizedEvents';

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
		let entryType: import('../../common/normalizedEvents').NormalizedEntryType;
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
				actionType = {
					type: 'FileRead',
					path: (input.path as string) || (input.file_path as string) || '',
				};
				break;

			case 'WriteFile':
			case 'write_file': {
				const path = (input.path as string) || (input.file_path as string) || '';
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
			case 'edit_file': {
				const path = (input.path as string) || (input.file_path as string) || '';
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

				let change: import('../../common/normalizedEvents').FileChange;

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

			case 'Task':
			case 'task':
				actionType = {
					type: 'TaskCreate',
					description: (input.description as string) || (input.prompt as string) || '',
				};
				break;

			case 'TodoWrite':
			case 'todo_write':
				actionType = {
					type: 'TodoManagement',
					operation: 'write',
					todos: Array.isArray(input.todos)
						? input.todos.map((t: any) => ({
								content: t.content,
								status: t.status,
								priority: t.priority,
							}))
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
