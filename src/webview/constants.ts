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
	// OpenCode CLI normalizes server keys by replacing dots and slashes with underscores,
	// e.g. "github.com/upstash/context7-mcp" → "github_com_upstash_context7-mcp"
	// So we must normalize server names the same way before matching.
	if (mcpServerNames && mcpServerNames.length > 0) {
		const toolNameLower = toolName.toLowerCase();
		return mcpServerNames.some(serverName => {
			const normalized = serverName.replace(/[./]/g, '_').toLowerCase();
			return toolNameLower.startsWith(`${normalized}_`);
		});
	}

	return false;
};

/**
 * Extract display-friendly server name and tool name from an MCP tool identifier.
 *
 * Handles both formats:
 * - Legacy: mcp__server__tool or mcp_server_tool
 * - OpenCode: github_com_upstash_context7-mcp_resolve-library-id
 *
 * @returns `{ server, tool }` with human-readable names, or null if not MCP
 */
export const getMcpToolDisplayInfo = (
	toolName: string | undefined,
	mcpServerNames?: string[],
): { server: string; tool: string } | null => {
	if (!toolName) return null;

	// Legacy prefixed format: mcp__server__tool or mcp_server_tool
	if (toolName.startsWith('mcp__')) {
		const rest = toolName.slice(5); // strip "mcp__"
		const idx = rest.indexOf('__');
		if (idx !== -1) {
			return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
		}
		return { server: rest, tool: rest };
	}
	if (toolName.startsWith('mcp_')) {
		const rest = toolName.slice(4); // strip "mcp_"
		const idx = rest.indexOf('_');
		if (idx !== -1) {
			return { server: rest.slice(0, idx), tool: rest.slice(idx + 1) };
		}
		return { server: rest, tool: rest };
	}

	// OpenCode format: match against known server names
	if (mcpServerNames && mcpServerNames.length > 0) {
		const toolNameLower = toolName.toLowerCase();
		for (const serverName of mcpServerNames) {
			const normalized = serverName.replace(/[./]/g, '_').toLowerCase();
			if (toolNameLower.startsWith(`${normalized}_`)) {
				const tool = toolName.slice(normalized.length + 1); // strip "servername_"
				// Extract last segment of server name for display (e.g. "context7-mcp" from "github.com/upstash/context7-mcp")
				const serverDisplay = serverName.split('/').pop() || serverName;
				return { server: serverDisplay, tool };
			}
		}
	}

	return null;
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
