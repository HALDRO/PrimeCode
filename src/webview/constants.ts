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

// Re-export tool helpers from the unified registry (single source of truth).
// Webview consumers should import from here or directly from '@common/toolRegistry'.
export {
	getToolDisplayName,
	isFileEditTool,
	isNonGroupableTool,
	isTaskTool,
	isToolMatch,
	NON_GROUPABLE_TOOLS,
} from '../common/toolRegistry';

/**
 * Check if tool is in list (case-insensitive)
 */
export const isToolInList = (toolName: string | undefined, list: readonly string[]): boolean => {
	if (!toolName) {
		return false;
	}
	const normalized = toolName.toLowerCase();
	return list.some(t => t.toLowerCase() === normalized);
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
