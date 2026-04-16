/**
 * @file Log Normalizer
 * @description Logic for normalizing raw CLI events and stderr output into structured NormalizedEntry objects.
 *              Type definitions live in common/normalizedTypes.ts (shared with webview).
 */

import { EventEmitter } from 'node:events';

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
// Re-export shared normalized contracts so existing consumers keep working.
export { buildToolActionType } from '../../common/normalizedTypes';

import type {
	ActionType,
	LspDiagnosticsByFile,
	NormalizedEntry,
	NormalizedEntryType,
} from '../../common/normalizedTypes';
import { buildToolActionType } from '../../common/normalizedTypes';

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
		const actionType = buildToolActionType(toolName, input);

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
	 * Extract LSP diagnostics from tool_result metadata and return them
	 * in a normalized format. OpenCode sends diagnostics as
	 * `metadata.diagnostics: Record<string, Diagnostic[]>` on edit/write/apply_patch results.
	 */
	public static extractDiagnostics(
		metadata: Record<string, unknown> | undefined,
	): LspDiagnosticsByFile | undefined {
		if (!metadata) return undefined;
		const raw = metadata.diagnostics;
		if (!raw || typeof raw !== 'object') return undefined;
		const result: LspDiagnosticsByFile = {};
		for (const [filePath, diags] of Object.entries(raw as Record<string, unknown>)) {
			if (!Array.isArray(diags)) continue;
			result[filePath] = diags.filter(
				d => d && typeof d === 'object' && 'message' in d && 'range' in d,
			);
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}
}
