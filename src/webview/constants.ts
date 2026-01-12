/**
 * @file Webview constants - centralized configuration and static data
 * @description Contains all static constants used across webview components including
 * slash commands, CLI commands, built-in snippets, and navigation items. Centralizing
 * these prevents duplication and makes maintenance easier. All constants are typed
 * and exported for use throughout the webview application.
 */

// ============================================================================
// Slash Commands & Snippets
// ============================================================================

export interface CommandItem {
	id: string;
	name: string;
	description: string;
	type: 'snippet' | 'cli' | 'custom';
	prompt?: string;
}

/**
 * Claude CLI commands available via slash syntax
 * Only commands that provide unique value in UI context are included.
 * Commands handled by Settings UI (config, model, mcp, etc.) are excluded.
 */
export const CLI_COMMANDS: CommandItem[] = [
	{
		id: 'bug',
		name: 'bug',
		description: 'Report bugs (sends conversation to Anthropic)',
		type: 'cli',
	},
	// { id: 'clear', name: 'clear', description: 'Clear conversation history', type: 'cli' }, // Use "New Chat" button instead
	{
		id: 'compact',
		name: 'compact',
		description: 'Compact conversation with optional focus',
		type: 'cli',
	},
	// { id: 'config', name: 'config', description: 'View/modify configuration', type: 'cli' }, // Handled by Settings UI
	// { id: 'cost', name: 'cost', description: 'Show token usage statistics', type: 'cli' }, // Handled by StatsDisplay
	// { id: 'doctor', name: 'doctor', description: 'Check Claude Code installation health', type: 'cli' }, // Use terminal directly
	// { id: 'help', name: 'help', description: 'Get usage help', type: 'cli' }, // Not useful in UI
	{ id: 'init', name: 'init', description: 'Initialize project with CLAUDE.md guide', type: 'cli' },
	// { id: 'login', name: 'login', description: 'Switch Anthropic accounts', type: 'cli' }, // Handled by Settings UI
	// { id: 'logout', name: 'logout', description: 'Sign out from Anthropic account', type: 'cli' }, // Handled by Settings UI
	// { id: 'mcp', name: 'mcp', description: 'Manage MCP server connections', type: 'cli' }, // Handled by MCP Tab
	// { id: 'memory', name: 'memory', description: 'Edit CLAUDE.md memory files', type: 'cli' }, // Handled by Rules Tab
	// { id: 'model', name: 'model', description: 'Select or change the AI model', type: 'cli' }, // Handled by model dropdown
	// { id: 'access', name: 'access', description: 'View and manage tool access', type: 'cli' }, // Handled by Permissions Tab
	{ id: 'pr-comments', name: 'pr-comments', description: 'View PR comments', type: 'cli' },
	{ id: 'review', name: 'review', description: 'Request a code review', type: 'cli' },
	// { id: 'status', name: 'status', description: 'View account and system status', type: 'cli' }, // Handled by Settings UI
	// { id: 'terminal-setup', name: 'terminal-setup', description: 'Install Shift+Enter key binding', type: 'cli' }, // Not applicable in VS Code
	// { id: 'vim', name: 'vim', description: 'Enter vim mode for multi-line editing', type: 'cli' }, // Not applicable in VS Code
];

/**
 * OpenCode CLI commands available via slash syntax.
 * Only commands that provide unique value in UI context are included.
 * Commands handled by Settings UI (config, model, provider, mcp, etc.) are excluded.
 */
export const OPENCODE_COMMANDS: CommandItem[] = [
	{ id: 'init', name: 'init', description: 'Create/update AGENTS.md for project', type: 'cli' },
	{
		id: 'review',
		name: 'review',
		description: 'Review changes (commit, branch, or PR)',
		type: 'cli',
	},
	{
		id: 'compact',
		name: 'compact',
		description: 'Summarize and compact session context',
		type: 'cli',
	},
	// { id: 'config', name: 'config', description: 'View/modify configuration', type: 'cli' }, // Handled by Settings UI
	// { id: 'model', name: 'model', description: 'Select or change the AI model', type: 'cli' }, // Handled by model dropdown
	// { id: 'provider', name: 'provider', description: 'Manage AI providers', type: 'cli' }, // Handled by Settings UI
	// { id: 'mcp', name: 'mcp', description: 'Manage MCP server connections', type: 'cli' }, // Handled by MCP Tab
	// { id: 'clear', name: 'clear', description: 'Clear conversation history', type: 'cli' }, // Use "New Chat" button instead
	{ id: 'share', name: 'share', description: 'Share current session', type: 'cli' },
	{ id: 'unshare', name: 'unshare', description: 'Unshare current session', type: 'cli' },
	// { id: 'help', name: 'help', description: 'Get usage help', type: 'cli' }, // Not useful in UI
	// { id: 'version', name: 'version', description: 'Show OpenCode version', type: 'cli' }, // Not useful in UI
];

// ============================================================================
// Settings Navigation
// ============================================================================

export type SettingsTab = 'main' | 'agents' | 'permissions' | 'mcp';

export interface NavItem {
	id: SettingsTab;
	label: string;
	iconName: 'settings' | 'server' | 'shield' | 'book' | 'sparkles' | 'plug' | 'key' | 'agents';
}

/**
 * Settings page navigation items
 * Note: Icons are referenced by name to avoid React import in constants
 */
export const SETTINGS_NAV_ITEMS: NavItem[] = [
	{
		id: 'main',
		label: 'Main',
		iconName: 'settings',
	},
	{
		id: 'agents',
		label: 'Agents',
		iconName: 'agents',
	},
	{
		id: 'permissions',
		label: 'Permissions',
		iconName: 'shield',
	},
	{
		id: 'mcp',
		label: 'MCP',
		iconName: 'server',
	},
];

// ============================================================================
// Tool Configuration
// ============================================================================

/**
 * Tools that should NOT be grouped in the message list
 * Heavy tools like Bash, Edit, Write are shown individually
 * Includes both Claude CLI (PascalCase) and OpenCode (lowercase) tool names
 */
export const NON_GROUPABLE_TOOLS = [
	'Bash',
	'TodoWrite',
	'Edit',
	'Write',
	'MultiEdit',
	'bash',
	'todowrite',
	'edit',
	'write',
	'multiedit',
] as const;

/**
 * File edit tools that show diff view
 * Includes both Claude CLI (PascalCase) and OpenCode (lowercase) tool names
 */
export const FILE_EDIT_TOOLS = [
	'Edit',
	'Write',
	'MultiEdit',
	'edit',
	'write',
	'multiedit',
] as const;

/**
 * Tools with collapsible output (Grep, Glob, LS, Serena listing tools)
 * Includes both Claude CLI (PascalCase) and OpenCode (lowercase) tool names
 */
export const COLLAPSIBLE_OUTPUT_TOOLS = [
	'Grep',
	'Glob',
	'LS',
	'grep',
	'glob',
	'ls',
	'Serena_list_dir',
	'serena_list_dir',
] as const;

/**
 * "Think" tools - agent reasoning/reflection tools (e.g., Serena think_about_*)
 * These display collapsible thought content
 */
export const THINK_TOOLS_PATTERN = 'think_about' as const;

/**
 * Check if a tool is a "think" tool (agent reasoning)
 */
export const isThinkTool = (toolName: string): boolean =>
	toolName.toLowerCase().includes(THINK_TOOLS_PATTERN);

/**
 * Search/read tools that don't modify files
 * Includes both Claude CLI (PascalCase) and OpenCode (lowercase) tool names
 */
export const SEARCH_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'read', 'grep', 'glob', 'ls'] as const;

/**
 * Action tools that modify files or execute commands
 * Includes both Claude CLI (PascalCase) and OpenCode (lowercase) tool names
 */
export const ACTION_TOOLS = [
	'Edit',
	'Write',
	'Bash',
	'MultiEdit',
	'edit',
	'write',
	'bash',
	'multiedit',
] as const;

/**
 * Normalize tool name to lowercase for comparison
 */
export const normalizeToolName = (toolName: string | undefined): string =>
	toolName ? toolName.toLowerCase() : '';

/**
 * Check if tool name matches (case-insensitive)
 */
export const isToolMatch = (toolName: string | undefined, target: string): boolean =>
	normalizeToolName(toolName) === normalizeToolName(target);

/**
 * Check if tool is in list (case-insensitive)
 */
export const isToolInList = (toolName: string | undefined, list: readonly string[]): boolean => {
	if (!toolName) {
		return false;
	}
	const normalized = normalizeToolName(toolName);
	return list.some(t => normalizeToolName(t) === normalized);
};

/**
 * Capitalize first letter of tool name for display
 */
export const formatToolNameForDisplay = (toolName: string): string =>
	toolName.charAt(0).toUpperCase() + toolName.slice(1).toLowerCase();

/**
 * Check if tool is an MCP tool based on naming conventions:
 * - Claude CLI format: mcp__server__tool or mcp_server_tool
 * - OpenCode format: ServerName_tool-name (PascalCase server + underscore + tool)
 *
 * @param toolName - The tool name to check
 * @param mcpServerNames - Optional list of known MCP server names for OpenCode format detection
 */
export const isMcpTool = (toolName: string | undefined, mcpServerNames?: string[]): boolean => {
	if (!toolName) {
		return false;
	}

	// Claude CLI format: mcp__ or mcp_ prefix
	if (toolName.startsWith('mcp__') || toolName.startsWith('mcp_')) {
		return true;
	}

	// OpenCode format: ServerName_tool-name
	// Check if tool name starts with any known MCP server name followed by underscore
	if (mcpServerNames && mcpServerNames.length > 0) {
		const toolNameLower = toolName.toLowerCase();
		return mcpServerNames.some(serverName => {
			const serverLower = serverName.toLowerCase();
			// Match: servername_ at the start (case-insensitive)
			return toolNameLower.startsWith(`${serverLower}_`);
		});
	}

	return false;
};

// ============================================================================
// UI Configuration
// ============================================================================

/**
 * Default preview line count for collapsible content
 */
export const PREVIEW_LINE_COUNT = 6;

/**
 * Default thinking preview length in characters
 */
export const THINKING_PREVIEW_LENGTH = 100;

// ============================================================================
// Timeout Configuration
// ============================================================================

/**
 * Centralized timeout constants for network operations and loading states.
 * All timeouts are in milliseconds.
 * Re-exports from @shared to maintain synchronization with extension backend.
 */
export { TIMEOUTS } from '../shared';

/**
 * Language mapping for Monaco editor based on file extension
 */
export const LANGUAGE_MAP: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	py: 'python',
	rb: 'ruby',
	java: 'java',
	go: 'go',
	rs: 'rust',
	cpp: 'cpp',
	c: 'c',
	cs: 'csharp',
	php: 'php',
	swift: 'swift',
	kt: 'kotlin',
	html: 'html',
	css: 'css',
	scss: 'scss',
	json: 'json',
	xml: 'xml',
	yaml: 'yaml',
	yml: 'yaml',
	md: 'markdown',
	sql: 'sql',
	sh: 'shell',
	bash: 'shell',
};

/**
 * Get language identifier for Monaco editor from file path
 */
export const getLanguageFromPath = (filePath?: string): string => {
	if (!filePath) {
		return 'plaintext';
	}
	const ext = filePath.split('.').pop()?.toLowerCase();
	return LANGUAGE_MAP[ext || ''] || 'plaintext';
};
