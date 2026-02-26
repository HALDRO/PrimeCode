/**
 * @file Unified Tool Registry
 * @description Single source of truth for tool display names, categories, and resolution.
 *
 * Normalisation strategy: `toLowerCase()` first, then check DISPLAY_NAMES (known tools)
 * or ALIASES (non-trivial mappings where lowercasing alone is not enough).
 *
 * IMPORTANT: When OpenCode adds new tools, update ONLY this file.
 */

// ---------------------------------------------------------------------------
// Display names — the canonical list of known tools.
// Keys are lowercase canonical identifiers used everywhere internally.
// ---------------------------------------------------------------------------

/** Canonical tool display names. Keys are lowercase IDs used everywhere internally. */
export const DISPLAY_NAMES: ReadonlyMap<string, string> = new Map([
	['read', 'Read'],
	['write', 'Write'],
	['edit', 'Edit'],
	['multiedit', 'Multi Edit'],
	['patch', 'Patch'],
	['apply_patch', 'Apply Patch'],
	['bash', 'Bash'],
	['grep', 'Grep'],
	['glob', 'Glob'],
	['search', 'Search'],
	['semanticsearch', 'Semantic Search'],
	['ls', 'List'],
	['task', 'Task'],
	['lsp', 'LSP'],
	['websearch', 'Web Search'],
	['codesearch', 'Code Search'],
	['webfetch', 'Web Fetch'],
	['skill', 'Skill'],
	['todowrite', 'Todo'],
	['todoread', 'Todo Read'],
]);

// ---------------------------------------------------------------------------
// Non-trivial aliases — only entries where toLowerCase() is NOT enough.
// e.g. "run_command" → "bash", "list_dir" → "ls", "create_file" → "write"
// ---------------------------------------------------------------------------

const ALIASES: ReadonlyMap<string, string> = new Map([
	// read
	['readfile', 'read'],
	['read_file', 'read'],

	// write
	['writefile', 'write'],
	['write_file', 'write'],
	['create', 'write'],
	['create_file', 'write'],

	// edit
	['editfile', 'edit'],
	['edit_file', 'edit'],
	['apply_diff', 'edit'],
	['insert_code', 'edit'],

	// multiedit
	['multi_edit', 'multiedit'],

	// apply_patch
	['applypatch', 'apply_patch'],

	// bash
	['runcommand', 'bash'],
	['run_command', 'bash'],

	// ls
	['list_dir', 'ls'],
	['serena_list_dir', 'ls'],

	// todowrite / todoread
	['todo_write', 'todowrite'],
	['todo_read', 'todoread'],
]);

// ---------------------------------------------------------------------------
// Tool category sets (canonical lowercase names)
// ---------------------------------------------------------------------------

/** Tools that modify files — used for fileChanged events and context enrichment. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
	'write',
	'edit',
	'multiedit',
	'patch',
	'apply_patch',
]);

/** Heavy tools shown individually in the message list (not grouped). */
export const NON_GROUPABLE_TOOLS: ReadonlySet<string> = new Set([
	'bash',
	'todowrite',
	'edit',
	'write',
	'multiedit',
	'patch',
	'apply_patch',
]);

/** Tools that represent a task/subtask invocation. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(['task']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve any backend tool name to its canonical lowercase form.
 * Strategy: lowercase → check DISPLAY_NAMES (direct hit) → check ALIASES.
 * Returns `undefined` for unknown tools (MCP tools, future tools).
 */
export function resolveToolName(raw: string): string | undefined {
	const lower = raw.toLowerCase();
	if (DISPLAY_NAMES.has(lower)) return lower;
	return ALIASES.get(lower);
}

/**
 * Check if a tool name is a file-editing tool.
 * Also matches via regex fallback for unknown tools containing edit-like keywords.
 */
export function isFileEditTool(toolName: string): boolean {
	const canonical = resolveToolName(toolName);
	if (canonical && FILE_EDIT_TOOLS.has(canonical)) return true;
	return /\b(write|edit|patch|create|overwrite|insert|replace|append|delete_file)\b/i.test(
		toolName,
	);
}

/**
 * Compute actual added/removed line counts by comparing old and new content.
 * Unlike `max(0, newLines - oldLines)` which only captures the *net* delta,
 * this walks both line arrays and counts every line that differs — matching
 * the semantics of `git diff --numstat`.
 *
 * For write/create (no old content) all new lines count as added.
 * For delete (no new content) all old lines count as removed.
 * For edits, shared prefix/suffix are skipped; remaining old lines are
 * "removed" and remaining new lines are "added".
 */
export function computeDiffLineStats(
	oldContent: string,
	newContent: string,
): { added: number; removed: number } {
	if (!oldContent && !newContent) return { added: 0, removed: 0 };
	if (!oldContent) return { added: newContent.split('\n').length, removed: 0 };
	if (!newContent) return { added: 0, removed: oldContent.split('\n').length };
	if (oldContent === newContent) return { added: 0, removed: 0 };

	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');

	// Common prefix
	let prefixLen = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
		prefixLen++;
	}

	// Common suffix (not overlapping with prefix)
	let suffixLen = 0;
	while (
		suffixLen < minLen - prefixLen &&
		oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	return {
		added: Math.max(0, newLines.length - prefixLen - suffixLen),
		removed: Math.max(0, oldLines.length - prefixLen - suffixLen),
	};
}

/** Check if a tool should NOT be grouped in the message list. */
export function isNonGroupableTool(toolName: string): boolean {
	if (toolName === 'Summarize Conversation') return true;
	const canonical = resolveToolName(toolName);
	return canonical ? NON_GROUPABLE_TOOLS.has(canonical) : false;
}

/** Check if a tool is a task/subtask tool. */
export function isTaskTool(toolName: string): boolean {
	const canonical = resolveToolName(toolName);
	return canonical ? TASK_TOOLS.has(canonical) : false;
}

/**
 * Get a human-readable display name for a tool.
 * Falls back to cosmetic formatting for unknown/MCP tools.
 */
export function getToolDisplayName(toolName: string): string {
	const canonical = resolveToolName(toolName);
	if (canonical) {
		return DISPLAY_NAMES.get(canonical) ?? toolName;
	}

	// MCP tools: mcp__server__tool → "Server Tool"
	if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) {
		const parts = toolName.replace(/^mcp_+/, '').split('_');
		return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
	}

	// Generic PascalCase → spaced
	const spaced = toolName
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
	return spaced
		.split(' ')
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}

/**
 * Case-insensitive check if a tool name matches a target.
 */
export function isToolMatch(toolName: string | undefined, target: string): boolean {
	if (!toolName) return false;
	return toolName.toLowerCase() === target.toLowerCase();
}
