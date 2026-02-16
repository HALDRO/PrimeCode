/**
 * @file Webview constants - centralized configuration and static data
 * @description Contains all static constants used across webview components including
 * slash commands, built-in snippets, and navigation items. Centralizing
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
	type: 'snippet' | 'cli' | 'custom' | 'subagent';
	prompt?: string;
}

// ============================================================================
// Settings Navigation
// ============================================================================

export type SettingsTab = 'main' | 'agents' | 'permissions' | 'mcp';

interface NavItem {
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
 * Heavy tools like Bash, Edit, Write are shown individually.
 * Tool names may come in different casings depending on source adapters.
 */
export const NON_GROUPABLE_TOOLS = [
	'Bash',
	'TodoWrite',
	'Edit',
	'Write',
	'MultiEdit',
	'Patch',
	'ApplyPatch',
	'bash',
	'todowrite',
	'edit',
	'write',
	'multiedit',
	'patch',
	'apply_patch',
] as const;

/**
 * Normalize tool name to lowercase for comparison
 */
const normalizeToolName = (toolName: string | undefined): string =>
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
 * Check if tool is an MCP tool based on naming conventions:
 * - Legacy prefixed format: mcp__server__tool or mcp_server_tool
 * - OpenCode format: ServerName_tool-name (PascalCase server + underscore + tool)
 *
 * @param toolName - The tool name to check
 * @param mcpServerNames - Optional list of known MCP server names for OpenCode format detection
 */
export const isMcpTool = (toolName: string | undefined, mcpServerNames?: string[]): boolean => {
	if (!toolName) {
		return false;
	}

	// Legacy prefixed format
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

// ============================================================================
// Timeout Configuration
// ============================================================================

/**
 * Centralized timeout constants for network operations and loading states.
 * All timeouts are in milliseconds.
 * Re-exports from @shared to maintain synchronization with extension backend.
 */

// (intentionally no re-exports here; import TIMEOUTS from src/common/constants)
