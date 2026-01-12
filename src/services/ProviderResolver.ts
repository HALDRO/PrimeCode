/**
 * @file Provider Resolver - Single Source of Truth for CLI Provider and Workspace
 * @description Centralized service for determining the active CLI provider (Claude/OpenCode)
 * and workspace root path. All provider-related logic should go through this module
 * to avoid duplication and ensure consistency across the codebase.
 *
 * This module provides:
 * - Global provider resolution from VS Code settings
 * - Session-aware provider resolution with fallback
 * - Type-safe provider checks (isOpenCode, isClaude)
 * - Workspace root path resolution
 * - OpenCode service access helpers
 *
 * NOTE: CLIProviderType is derived from the TypeBox schema in `src/types/schemas.ts`
 * (re-exported via `src/types/index.ts`) and imported here type-only.
 */

import * as vscode from 'vscode';
import type { CLIProviderType } from '../types';
import { logger } from '../utils/logger';

export type { CLIProviderType } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Default CLI provider when not configured.
 */
export const DEFAULT_CLI_PROVIDER: CLIProviderType = 'claude';

/**
 * VS Code configuration section name.
 */
const CONFIG_SECTION = 'primeCode';

/**
 * Configuration key for provider setting.
 */
const PROVIDER_KEY = 'provider';

// =============================================================================
// Session Provider Interface
// =============================================================================

/**
 * Minimal interface for session objects that can hold provider type.
 * Used to avoid circular dependencies with SessionContext.
 */
export interface IProviderAwareSession {
	/** CLI provider type used for this session */
	providerType?: CLIProviderType;
	/** Set the provider type for this session */
	setProviderType?(value: CLIProviderType | undefined): void;
}

// =============================================================================
// Core Provider Resolution
// =============================================================================

/**
 * Get the globally configured CLI provider from VS Code settings.
 * This is the single source of truth for the provider setting.
 *
 * @returns The configured CLI provider type, defaults to 'claude'
 */
export function getGlobalProvider(): CLIProviderType {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const provider = config.get<CLIProviderType>(PROVIDER_KEY, DEFAULT_CLI_PROVIDER);

	// Validate provider value
	if (provider !== 'claude' && provider !== 'opencode') {
		logger.warn(
			`[ProviderResolver] Invalid provider value "${provider}", falling back to "${DEFAULT_CLI_PROVIDER}"`,
		);
		return DEFAULT_CLI_PROVIDER;
	}

	return provider;
}

/**
 * Get the effective provider for a session.
 * Uses session's saved provider if available, otherwise falls back to global config.
 *
 * @param session - Optional session object with provider type
 * @returns The effective CLI provider type for the session
 */
export function getSessionProvider(session?: IProviderAwareSession | null): CLIProviderType {
	// If session has a saved provider, use it
	if (session?.providerType) {
		return session.providerType;
	}

	// Fall back to global provider
	return getGlobalProvider();
}

/**
 * Initialize a session's provider type from global config if not already set.
 * This should be called when creating or resuming a session.
 *
 * @param session - Session object to initialize
 * @returns The provider type that was set
 */
export function initializeSessionProvider(session: IProviderAwareSession): CLIProviderType {
	if (session.providerType) {
		logger.debug(`[ProviderResolver] Session already has provider: ${session.providerType}`);
		return session.providerType;
	}

	const globalProvider = getGlobalProvider();
	if (session.setProviderType) {
		session.setProviderType(globalProvider);
		logger.info(
			`[ProviderResolver] Initialized session provider from global config: ${globalProvider}`,
		);
	}

	return globalProvider;
}

// =============================================================================
// Provider Type Checks
// =============================================================================

/**
 * Check if the global provider is OpenCode.
 *
 * @returns true if OpenCode is the configured provider
 */
export function isOpenCode(): boolean {
	return getGlobalProvider() === 'opencode';
}

/**
 * Check if the global provider is Claude.
 *
 * @returns true if Claude is the configured provider
 */
export function isClaude(): boolean {
	return getGlobalProvider() === 'claude';
}

/**
 * Check if the session's effective provider is OpenCode.
 *
 * @param session - Optional session object
 * @returns true if OpenCode is the effective provider for the session
 */
export function isSessionOpenCode(session?: IProviderAwareSession | null): boolean {
	return getSessionProvider(session) === 'opencode';
}

/**
 * Check if the session's effective provider is Claude.
 *
 * @param session - Optional session object
 * @returns true if Claude is the effective provider for the session
 */
export function isSessionClaude(session?: IProviderAwareSession | null): boolean {
	return getSessionProvider(session) === 'claude';
}

// =============================================================================
// Workspace Utilities
// =============================================================================

/**
 * Get the workspace root path.
 * This is the single source of truth for workspace root resolution.
 *
 * @returns The workspace root path, or undefined if no workspace is open
 */
export function getWorkspaceRoot(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Get the workspace root path, throwing an error if not available.
 * Use this when workspace root is required for the operation.
 *
 * @throws Error if no workspace is open
 * @returns The workspace root path
 */
export function getWorkspaceRootOrThrow(): string {
	const root = getWorkspaceRoot();
	if (!root) {
		throw new Error('No workspace folder is open');
	}
	return root;
}

// =============================================================================
// OpenCode Service Helpers
// =============================================================================

// Import types for return type annotations
import type { OpenCodeService } from './cli/opencode/OpenCodeService.js';

/**
 * Get OpenCode service for read operations.
 * Always tries to get the service regardless of current provider.
 * Useful for reading OpenCode-specific data even when Claude is active.
 *
 * @returns OpenCode service instance or undefined if not available
 */
export async function getOpenCodeServiceForRead(): Promise<OpenCodeService | undefined> {
	try {
		// Dynamic import to avoid circular dependencies
		const { CLIServiceFactory } = await import('./CLIServiceFactory.js');
		const { OpenCodeService: OpenCodeServiceClass } = await import(
			'./cli/opencode/OpenCodeService.js'
		);
		const service = await CLIServiceFactory.getService('opencode');
		if (service instanceof OpenCodeServiceClass) {
			return service;
		}
	} catch {
		// OpenCode not available, that's fine for read operations
	}
	return undefined;
}

/**
 * Get OpenCode service for write operations.
 * Only returns the service if OpenCode is the current provider.
 * Use this when you need to write OpenCode-specific data.
 *
 * @param session - Optional session to check provider from
 * @returns OpenCode service instance or undefined if not OpenCode provider
 */
export async function getOpenCodeService(
	session?: IProviderAwareSession | null,
): Promise<OpenCodeService | undefined> {
	if (getSessionProvider(session) === 'opencode') {
		return getOpenCodeServiceForRead();
	}
	return undefined;
}

// =============================================================================
// Namespace Export for Backward Compatibility
// =============================================================================

/**
 * ProviderResolver namespace - provides all provider resolution utilities.
 * Use this for a cleaner API: `ProviderResolver.getGlobalProvider()`
 */
export const ProviderResolver = {
	// Types
	DEFAULT_CLI_PROVIDER,

	// Core resolution
	getGlobalProvider,
	getSessionProvider,
	initializeSessionProvider,

	// Type checks
	isOpenCode,
	isClaude,
	isSessionOpenCode,
	isSessionClaude,

	// Workspace utilities
	getWorkspaceRoot,
	getWorkspaceRootOrThrow,

	// OpenCode service helpers
	getOpenCodeServiceForRead,
	getOpenCodeService,
} as const;
