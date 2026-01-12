/**
 * @file Shared constants
 * @description Constants shared between Extension (Node.js) and Webview (Browser).
 *              Prevents duplication and ensures synchronization of configuration values.
 */

// =============================================================================
// Timeout Configuration
// =============================================================================

/**
 * Centralized timeout constants for network operations and loading states.
 * All timeouts are in milliseconds.
 */
export const TIMEOUTS = {
	/** Timeout for CLI status check operations */
	CLI_STATUS_CHECK: 15000,
	/** Timeout for proxy/OpenAI-compatible model fetch */
	PROXY_MODELS_FETCH: 15000,
	/** Timeout for OpenCode provider loading */
	OPENCODE_PROVIDERS_LOAD: 15000,
	/** Default network request timeout */
	NETWORK_REQUEST: 15000,
	/** Short timeout for quick operations */
	SHORT: 5000,
	/** Long timeout for heavy operations */
	LONG: 30000,
} as const;

// =============================================================================
// CLI Configuration
// =============================================================================

/**
 * CLI provider types.
 * NOTE: Kept here (not imported) so `src/shared` stays independent from other TS projects.
 */
export type CLIProviderType = 'claude' | 'opencode';

/**
 * Default CLI provider
 */
export const DEFAULT_CLI_PROVIDER: CLIProviderType = 'claude';

// =============================================================================
// Provider IDs
// =============================================================================

/** Canonical provider ID for OpenAI-compatible APIs (OpenCode provider id). */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'oai' as const;

/** Providers that are built-in and must not be disconnected from UI. */
export const NON_DISCONNECTABLE_PROVIDER_IDS = ['opencode', 'opencode-zen', 'zen'] as const;

export type NonDisconnectableProviderId = (typeof NON_DISCONNECTABLE_PROVIDER_IDS)[number];

// =============================================================================
// Provider Helpers
// =============================================================================

export const isNonDisconnectableProviderId = (providerId: string): boolean => {
	return (NON_DISCONNECTABLE_PROVIDER_IDS as readonly string[]).includes(providerId.toLowerCase());
};

// =============================================================================
// Model Utilities
// =============================================================================

/**
 * Strips any provider prefix from a model name (e.g., "oai/model" -> "model", "google/model" -> "model").
 * Provider prefix is the part before the first "/" that doesn't contain special characters like "[".
 *
 * @param model - The model name (e.g., "oai/[Kiro] claude-sonnet-4.5" or "google/gemini-2.5-flash")
 * @returns Model name without provider prefix (e.g., "[Kiro] claude-sonnet-4.5" or "gemini-2.5-flash")
 */
export const stripProviderPrefix = (model: string): string => {
	if (!model) return model;

	const slashIndex = model.indexOf('/');
	if (slashIndex === -1) return model;

	// Check if the part before "/" looks like a provider ID (no special chars like "[")
	const potentialProvider = model.substring(0, slashIndex);
	if (potentialProvider.includes('[') || potentialProvider.includes(']')) {
		// This is not a provider prefix, it's part of the model name
		return model;
	}

	return model.substring(slashIndex + 1);
};

/**
 * @deprecated Use stripProviderPrefix instead
 */
export const stripOaiPrefix = stripProviderPrefix;

/**
 * Checks if a model is in the enabled proxy models list.
 * Handles both with provider prefix (e.g., "oai/model") and without.
 *
 * @param model - The model name to check
 * @param enabledProxyModels - List of enabled proxy model names (stored without prefix)
 * @returns true if model is in the list
 */
export const isModelInProxyList = (
	model: string | undefined,
	enabledProxyModels: string[],
): boolean => {
	if (!model) return false;

	// Check both with and without provider prefix
	const modelWithoutPrefix = stripProviderPrefix(model);
	return enabledProxyModels.includes(model) || enabledProxyModels.includes(modelWithoutPrefix);
};

// =============================================================================
// Directory Paths
// =============================================================================

/**
 * Project directory paths for unified CLI structure.
 * All paths are relative to workspace root.
 */
export const PATHS = {
	/** Unified directory for all CLI configurations */
	AGENTS_DIR: '.agents',
	/** Permanent images storage */
	AGENTS_IMAGES: '.agents/images',
	/** Temporary files storage */
	AGENTS_TEMP: '.agents/temp',
	/** MCP configuration file */
	AGENTS_MCP_JSON: '.agents/mcp.json',
	/** Backups directory */
	AGENTS_BACKUPS: '.agents/.backups',

	// New Unified Structure
	AGENTS_COMMANDS_DIR: '.agents/commands',
	AGENTS_RULES_DIR: '.agents/rules',
	AGENTS_SKILLS_DIR: '.agents/skills',
	AGENTS_HOOKS_DIR: '.agents/hooks',

	// Legacy / Compatibility Paths - Claude
	CLAUDE_COMMANDS_DIR: '.claude/commands',
	CLAUDE_RULES_DIR: '.claude/rules',
	CLAUDE_SKILLS_DIR: '.claude/skills',

	// Legacy / Compatibility Paths - OpenCode
	OPENCODE_COMMAND_DIR: '.opencode/command',
	OPENCODE_INSTRUCTIONS: 'opencode.json',
	OPENCODE_SKILL_DIR: '.opencode/skill',

	// Legacy / Compatibility Paths - Cursor
	CURSOR_RULES_DIR: '.cursor/rules',
	CURSOR_COMMANDS_DIR: '.cursor/commands',
	CURSOR_SKILLS_DIR: '.cursor/skills',
} as const;

// =============================================================================
// File Search Exclusion Patterns
// =============================================================================

/**
 * Centralized file exclusion patterns for workspace file search.
 * Used by both FileService (VS Code API) and fileSearch (ripgrep).
 */
export const EXCLUDE_PATTERNS = {
	/**
	 * VS Code glob pattern for findFiles API.
	 * Single string pattern with braces syntax.
	 */
	VSCODE_GLOB:
		'{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/.nuxt/**,**/target/**,**/bin/**,**/obj/**,**/.vscode/**,**/__pycache__/**,**/out/**,**/*.pyc,**/.DS_Store,**/Thumbs.db}',

	/**
	 * Ripgrep exclusion arguments.
	 * Array of glob patterns for --glob/-g option.
	 */
	RIPGREP_ARGS: [
		'-g',
		'!**/node_modules/**',
		'-g',
		'!**/.git/**',
		'-g',
		'!**/out/**',
		'-g',
		'!**/dist/**',
		'-g',
		'!**/build/**',
		'-g',
		'!**/.next/**',
		'-g',
		'!**/.nuxt/**',
		'-g',
		'!**/target/**',
		'-g',
		'!**/bin/**',
		'-g',
		'!**/obj/**',
		'-g',
		'!**/__pycache__/**',
		'-g',
		'!**/.vscode/**',
	] as const,
} as const;
