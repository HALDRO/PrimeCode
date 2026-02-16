/**
 * @file Unified Permissions Module
 * @description Single source of truth for all permission-related types, constants, and defaults.
 *              Eliminates duplication across protocol.ts, ToolHandler.ts, settingsStore.ts, and ChatProvider.ts.
 */

// =============================================================================
// Permission Types
// =============================================================================

export type PermissionPolicyValue = 'ask' | 'allow' | 'deny';

/**
 * All OpenCode permission categories.
 * This is the canonical list - any changes here automatically propagate to all consumers.
 */
export const PERMISSION_CATEGORIES = [
	'read',
	'edit',
	'glob',
	'grep',
	'list',
	'bash',
	'task',
	'skill',
	'lsp',
	'todoread',
	'todowrite',
	'webfetch',
	'websearch',
	'codesearch',
	'external_directory',
	'doom_loop',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * Permission policies interface - generated from PERMISSION_CATEGORIES.
 * All OpenCode permission categories mapped to their policy values.
 */
export interface PermissionPolicies {
	read: PermissionPolicyValue;
	edit: PermissionPolicyValue;
	glob: PermissionPolicyValue;
	grep: PermissionPolicyValue;
	list: PermissionPolicyValue;
	bash: PermissionPolicyValue;
	task: PermissionPolicyValue;
	skill: PermissionPolicyValue;
	lsp: PermissionPolicyValue;
	todoread: PermissionPolicyValue;
	todowrite: PermissionPolicyValue;
	webfetch: PermissionPolicyValue;
	websearch: PermissionPolicyValue;
	codesearch: PermissionPolicyValue;
	external_directory: PermissionPolicyValue;
	doom_loop: PermissionPolicyValue;
}

// =============================================================================
// Default Policies
// =============================================================================

/**
 * Default permission policies for new workspaces.
 * Safe defaults: allow read-only operations, ask for mutations.
 */
export const DEFAULT_POLICIES: PermissionPolicies = {
	read: 'allow',
	edit: 'ask',
	glob: 'allow',
	grep: 'allow',
	list: 'allow',
	bash: 'ask',
	task: 'ask',
	skill: 'allow',
	lsp: 'allow',
	todoread: 'allow',
	todowrite: 'allow',
	webfetch: 'ask',
	websearch: 'ask',
	codesearch: 'allow',
	external_directory: 'ask',
	doom_loop: 'ask',
};

// =============================================================================
// Validation
// =============================================================================

export const VALID_POLICY_VALUES = new Set<PermissionPolicyValue>(['ask', 'allow', 'deny']);

/**
 * Type guard to check if a value is a valid permission policy value.
 */
export function isValidPolicyValue(value: unknown): value is PermissionPolicyValue {
	return typeof value === 'string' && VALID_POLICY_VALUES.has(value as PermissionPolicyValue);
}

/**
 * Type guard to check if a key is a valid permission category.
 */
export function isPermissionCategory(key: string): key is PermissionCategory {
	return PERMISSION_CATEGORIES.includes(key as PermissionCategory);
}

// =============================================================================
// Legacy Migration
// =============================================================================

/**
 * Legacy permission keys that should be migrated to new categories.
 * Maps old keys to new keys for backward compatibility.
 */
export const LEGACY_PERMISSION_MAPPING: Record<string, PermissionCategory> = {
	terminal: 'bash',
	network: 'webfetch',
};

/**
 * Migrates legacy permission policies to current schema.
 * Converts old keys (terminal, network) to new keys (bash, webfetch).
 */
export function migrateLegacyPolicies(
	stored: Record<string, unknown>,
): Partial<PermissionPolicies> {
	const migrated: Partial<PermissionPolicies> = {};

	for (const [key, value] of Object.entries(stored)) {
		// Check if it's a legacy key that needs migration
		const targetKey = LEGACY_PERMISSION_MAPPING[key] || key;

		// Only include valid categories with valid values
		if (isPermissionCategory(targetKey) && isValidPolicyValue(value)) {
			migrated[targetKey] = value;
		}
	}

	return migrated;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Merges partial policies with defaults, ensuring all categories are present.
 */
export function mergePolicies(partial: Partial<PermissionPolicies>): PermissionPolicies {
	return { ...DEFAULT_POLICIES, ...partial };
}

/**
 * Converts PermissionPolicies to a plain object for server sync.
 * Useful for PATCH /config requests to OpenCode server.
 */
export function policiesToServerFormat(policies: PermissionPolicies): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of PERMISSION_CATEGORIES) {
		result[key] = policies[key];
	}
	return result;
}
