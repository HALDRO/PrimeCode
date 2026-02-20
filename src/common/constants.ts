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
} as const;

// =============================================================================
// Provider IDs
// =============================================================================

/** Canonical provider ID for OpenAI-compatible APIs (OpenCode provider id). */
export const OPENAI_COMPATIBLE_PROVIDER_ID = 'oai' as const;

/** Providers that are built-in and must not be disconnected from UI. */
const NON_DISCONNECTABLE_PROVIDER_IDS = ['opencode', 'opencode-zen', 'zen'] as const;

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
 * Parses a composite model ID ("providerId/modelId") into its parts.
 * Only splits on the first "/" so model IDs containing "/" are preserved.
 *
 * @example
 * parseModelId("anthropic/claude-opus-4-5")  // { providerId: "anthropic", modelId: "claude-opus-4-5" }
 * parseModelId("provider/ns/model")          // { providerId: "provider", modelId: "ns/model" }
 * parseModelId("no-slash")                   // undefined
 */
export const parseModelId = (
	compositeId: string,
): { providerId: string; modelId: string } | undefined => {
	if (!compositeId) return undefined;
	const trimmed = compositeId.trim();
	const slash = trimmed.indexOf('/');
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return {
		providerId: trimmed.substring(0, slash),
		modelId: trimmed.substring(slash + 1),
	};
};

/**
 * Resolves a composite model ID to its display name by looking up providers and proxy models.
 * Returns model.name if found, otherwise falls back to the modelId part, or the raw ID.
 *
 * @example
 * resolveModelDisplayName("minimax/minimax-m2.5-free", providers)  // "MiniMax M2.5 Free"
 * resolveModelDisplayName("oai/gpt-4", providers, proxyModels)     // "GPT-4"
 * resolveModelDisplayName("default", providers)                    // "default"
 */
export const resolveModelDisplayName = (
	compositeId: string,
	providers: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string; name: string }> }>,
	proxyModels?: ReadonlyArray<{ id: string; name: string }>,
): string => {
	if (!compositeId) return '';

	const parsed = parseModelId(compositeId);

	if (!parsed) {
		// No slash — check proxy models by raw ID
		if (proxyModels) {
			const pm = proxyModels.find(m => m.id === compositeId);
			if (pm) return pm.name;
		}
		return compositeId;
	}

	// Check proxy models for proxy/oai provider prefixes
	if (proxyModels && (parsed.providerId === 'proxy' || parsed.providerId === 'oai')) {
		const pm = proxyModels.find(m => m.id === parsed.modelId);
		if (pm) return pm.name;
	}

	const provider = providers.find(p => p.id === parsed.providerId);
	const model = provider?.models.find(m => m.id === parsed.modelId);
	return model?.name || parsed.modelId;
};

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
 * Project directory paths for OpenCode native structure.
 * All paths are relative to workspace root.
 */
export const PATHS = {
	/** OpenCode project config directory */
	OPENCODE_DIR: '.opencode',

	/** OpenCode project config file */
	OPENCODE_CONFIG: 'opencode.json',

	// Resource directories (OpenCode native)
	OPENCODE_COMMANDS_DIR: '.opencode/commands',
	OPENCODE_RULES_DIR: '.opencode/rules',
	OPENCODE_SKILLS_DIR: '.opencode/skills',
	OPENCODE_PLUGINS_DIR: '.opencode/plugins',
	OPENCODE_AGENTS_DIR: '.opencode/agents',
} as const;

// =============================================================================
// File Search Exclusion Patterns
// =============================================================================

/**
 * Centralized file exclusion patterns for workspace file search.
 */
export const EXCLUDE_PATTERNS = {
	/** Ripgrep exclusion arguments. */
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
