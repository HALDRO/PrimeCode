/**
 * @file Log Normalizer
 * @description Logic for normalizing raw CLI events and stderr output into structured NormalizedEntry objects.
 *              Type definitions live in common/normalizedTypes.ts (shared with webview).
 */

import { EventEmitter } from 'node:events';

// Re-export all types from the shared location so existing consumers keep working.
export type {
	ActionType,
	ApplyPatchFile,
	CommandExitStatus,
	CommandRunResult,
	FileChange,
	LspDiagnostic,
	LspDiagnosticsByFile,
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
	ApplyPatchFile,
	FileChange,
	LspDiagnosticsByFile,
	NormalizedEntry,
	NormalizedEntryType,
} from '../../common/normalizedTypes';

import { resolveToolName } from '../../common/toolRegistry';

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
	 * Uses the unified tool registry to resolve aliases instead of hardcoded switch cases.
	 */
	public normalizeToolUse(
		toolName: string,
		input: Record<string, unknown>,
		toolCallId: string,
	): NormalizedEntry {
		const canonical = resolveToolName(toolName);
		const actionType = this.buildActionType(canonical, toolName, input);

		return {
			timestamp: new Date().toISOString(),
			entryType: {
				type: 'ToolUse',
				toolName,
				actionType,
				status: 'created',
			},
			content: `Tool Use: ${toolName}`,
			metadata: { toolCallId },
		};
	}

	/**
	 * Map a resolved canonical tool name to its ActionType.
	 * Keeps input-parsing logic intact while eliminating alias duplication.
	 */
	private buildActionType(
		canonical: string | undefined,
		rawToolName: string,
		input: Record<string, unknown>,
	): ActionType {
		const pathFromInput = () =>
			(input.path as string) || (input.file_path as string) || (input.filePath as string) || '';

		switch (canonical) {
			case 'read': {
				const readOffset = typeof input.offset === 'number' ? input.offset : undefined;
				const readLimit = typeof input.limit === 'number' ? input.limit : undefined;
				return {
					type: 'FileRead',
					path: pathFromInput(),
					...(readOffset !== undefined && { offset: readOffset }),
					...(readLimit !== undefined && { limit: readLimit }),
				};
			}

			case 'write': {
				const content = (input.content as string) || (input.contents as string) || '';
				return {
					type: 'FileEdit',
					path: pathFromInput(),
					changes: [{ type: 'Write', content }],
				};
			}

			case 'edit':
			case 'multiedit':
			case 'patch': {
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
				if (diff) {
					change = { type: 'Edit', unifiedDiff: diff, hasLineNumbers: false };
				} else if (oldString || newString) {
					change = { type: 'Replace', oldContent: oldString, newContent: newString };
				} else {
					change = { type: 'Edit', unifiedDiff: '', hasLineNumbers: false };
				}

				return { type: 'FileEdit', path: pathFromInput(), changes: [change] };
			}

			case 'bash':
				return { type: 'CommandRun', command: (input.command as string) || '' };

			case 'search':
			case 'grep':
				return {
					type: 'Search',
					query: (input.query as string) || (input.pattern as string) || '',
				};

			case 'semanticsearch':
			case 'glob':
				return {
					type: 'Search',
					query:
						(input.query as string) ||
						(input.glob_pattern as string) ||
						(input.glob as string) ||
						(input.pattern as string) ||
						'',
				};

			case 'ls':
				return { type: 'Tool', toolName: 'ls', arguments: input };

			case 'task':
				return {
					type: 'TaskCreate',
					description: (input.description as string) || (input.prompt as string) || '',
				};

			case 'apply_patch': {
				const patch = (input.patch as string) || (input.diff as string) || '';
				const files = LogNormalizer.parseApplyPatchFiles(patch, input);
				return { type: 'ApplyPatch', files };
			}

			case 'lsp': {
				const operation = (input.operation as string) || 'unknown';
				const lspPath = (input.filePath as string) || (input.file_path as string) || '';
				const line = typeof input.line === 'number' ? input.line : 0;
				const character = typeof input.character === 'number' ? input.character : 0;
				return {
					type: 'Tool',
					toolName: 'lsp',
					arguments: { operation, filePath: lspPath, line, character },
				};
			}

			case 'websearch':
				return {
					type: 'WebSearch',
					query: (input.query as string) || (input.search_query as string) || '',
				};

			case 'codesearch':
				return {
					type: 'CodeSearch',
					query: (input.query as string) || (input.search_query as string) || '',
				};

			case 'skill':
				return { type: 'Tool', toolName: 'skill', arguments: input };

			case 'todowrite':
				return {
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

			default:
				return { type: 'Tool', toolName: rawToolName, arguments: input };
		}
	}

	/**
	 * Check whether a file path belongs to the given workspace root.
	 * Relative paths (no drive letter / no leading slash) are assumed workspace-local.
	 */
	private static isInsideWorkspace(filePath: string, workspaceRoot?: string): boolean {
		if (!workspaceRoot) return true;
		const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const root = normalize(workspaceRoot);
		const file = normalize(filePath);
		// Relative paths are workspace-local by convention
		if (!/^[a-z]:|^\//i.test(filePath)) return true;
		return file.startsWith(`${root}/`) || file === root;
	}

	/**
	 * Extract LSP diagnostics from tool_result metadata and return them
	 * in a normalized format. OpenCode sends diagnostics as
	 * `metadata.diagnostics: Record<string, Diagnostic[]>` on edit/write/apply_patch results.
	 * When `workspaceRoot` is provided, diagnostics from files outside the workspace are filtered out.
	 */
	public static extractDiagnostics(
		metadata: Record<string, unknown> | undefined,
		workspaceRoot?: string,
	): LspDiagnosticsByFile | undefined {
		if (!metadata) return undefined;
		const raw = metadata.diagnostics;
		if (!raw || typeof raw !== 'object') return undefined;
		const result: LspDiagnosticsByFile = {};
		for (const [filePath, diags] of Object.entries(raw as Record<string, unknown>)) {
			if (!Array.isArray(diags)) continue;
			// Skip diagnostics from files outside the current workspace
			if (!LogNormalizer.isInsideWorkspace(filePath, workspaceRoot)) continue;
			result[filePath] = diags.filter(
				d => d && typeof d === 'object' && 'message' in d && 'range' in d,
			);
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}

	/**
	 * Parse apply_patch input into structured file entries.
	 * The patch format uses `*** filepath` headers with `@@` hunks.
	 */
	private static parseApplyPatchFiles(
		patch: string,
		input: Record<string, unknown>,
	): ApplyPatchFile[] {
		if (!patch) {
			// Fallback: try to extract from structured input
			const files = input.files;
			if (Array.isArray(files)) {
				return files.map(f => {
					const file = f as Record<string, unknown>;
					return {
						path: (file.path as string) || '',
						status: ((file.status as string) || 'update') as ApplyPatchFile['status'],
						newPath: file.newPath as string | undefined,
						oldContent: file.oldContent as string | undefined,
						newContent: file.newContent as string | undefined,
					};
				});
			}
			return [];
		}

		const result: ApplyPatchFile[] = [];
		const fileBlocks = patch.split(/^(?=\*{3}\s)/m);

		for (const block of fileBlocks) {
			const headerMatch = /^\*{3}\s+(.+?)(?:\s|$)/m.exec(block);
			if (!headerMatch) continue;

			const filePath = headerMatch[1].trim();
			let status: ApplyPatchFile['status'] = 'update';

			// Detect status from content
			if (/^Add\s/i.test(block) || block.includes('*** /dev/null')) {
				status = 'add';
			} else if (/^Delete\s/i.test(block) || block.includes('+++ /dev/null')) {
				status = 'delete';
			} else if (/^Rename\s|^Move\s/i.test(block)) {
				status = 'move';
			}

			result.push({ path: filePath, status });
		}

		return result.length > 0 ? result : [{ path: 'patch', status: 'update' }];
	}
}
