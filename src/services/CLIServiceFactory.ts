/**
 * @file CLI Service Factory
 * @description Provides a centralized way to get ICLIService instances.
 * Implements Lazy Loading for provider implementations to optimize startup time.
 * Uses initialization lock to prevent duplicate service creation during async init.
 *
 * NOTE: Provider resolution is delegated to ProviderResolver for consistency.
 * This factory focuses on service instantiation and lifecycle management.
 */

import * as vscode from 'vscode';
import { isModelInProxyList } from '../shared/constants';
import { logger } from '../utils/logger';
import type { AccessService } from './AccessService';
import type { ICLIService } from './ICLIService';
import {
	type CLIProviderType,
	getGlobalProvider,
	getWorkspaceRoot,
	isClaude as providerIsClaude,
	isOpenCode as providerIsOpenCode,
} from './ProviderResolver';

let currentInstance: ICLIService | null = null;
let currentProvider: CLIProviderType | null = null;
let initializationPromise: Promise<ICLIService> | null = null;
let accessServiceInstance: AccessService | null = null;

export function setAccessService(service: AccessService): void {
	accessServiceInstance = service;
}

/**
 * Get or create a CLI service instance based on configuration.
 * Handles provider switching and disposal of previous instances.
 * Uses initialization lock to prevent duplicate service creation.
 */
export async function getService(forceProvider?: CLIProviderType): Promise<ICLIService> {
	const provider = forceProvider || getGlobalProvider();

	// Return existing if provider hasn't changed and is ready
	if (currentInstance && currentProvider === provider) {
		return currentInstance;
	}

	// If initialization is in progress for the same provider, wait for it
	if (initializationPromise && currentProvider === provider) {
		logger.debug(`[CLIServiceFactory] Waiting for existing initialization of ${provider}...`);
		return initializationPromise;
	}

	// If switching providers, dispose previous and reset
	if (currentInstance && currentProvider !== provider) {
		await currentInstance.dispose();
		currentInstance = null;
		initializationPromise = null;
	}

	// Start new initialization
	currentProvider = provider;
	initializationPromise = _initializeService(provider);

	try {
		currentInstance = await initializationPromise;
		return currentInstance;
	} catch (error) {
		// Reset state on failure
		currentInstance = null;
		currentProvider = null;
		initializationPromise = null;
		throw error;
	}
}

/**
 * Internal initialization logic - separated to allow promise reuse.
 */
async function _initializeService(provider: CLIProviderType): Promise<ICLIService> {
	logger.info(`[CLIServiceFactory] Initializing provider: ${provider}`);

	try {
		let service: ICLIService;

		if (provider === 'opencode') {
			const { OpenCodeService } = await import('./cli/opencode/OpenCodeService.js');
			service = new OpenCodeService();
		} else {
			const { ClaudeSDKService } = await import('./cli/claude/ClaudeSDKService.js');
			if (!accessServiceInstance) {
				throw new Error(
					'[CLIServiceFactory] AccessService not initialized. Call setAccessService first.',
				);
			}
			service = new ClaudeSDKService(accessServiceInstance);
		}

		// Initialize with workspace root
		const workspaceRoot = getWorkspaceRoot();
		await service.initialize(workspaceRoot);

		return service;
	} catch (error) {
		logger.error(`[CLIServiceFactory] Failed to initialize ${provider}:`, error);
		throw error;
	}
}

export function getCurrentProvider(): CLIProviderType | null {
	return currentProvider;
}

/**
 * Check if the currently instantiated service is OpenCode.
 * NOTE: This checks the *instantiated* service, not the config.
 * For config-based checks, use ProviderResolver.isOpenCode().
 */
export function isOpenCode(): boolean {
	// If we have an instance, check it; otherwise fall back to config
	return currentProvider ? currentProvider === 'opencode' : providerIsOpenCode();
}

/**
 * Check if the currently instantiated service is Claude.
 * NOTE: This checks the *instantiated* service, not the config.
 * For config-based checks, use ProviderResolver.isClaude().
 */
export function isClaude(): boolean {
	// If we have an instance, check it; otherwise fall back to config
	return currentProvider ? currentProvider === 'claude' : providerIsClaude();
}

/**
 * Build proxy configuration for a given model.
 * Centralized logic - single source of truth for proxy config.
 * Proxy is enabled when:
 * 1. Provider is Claude (OpenCode handles OpenAI models natively)
 * 2. Model is in the enabledProxyModels list
 */
export function buildProxyConfig(
	model?: string,
	providerType?: CLIProviderType | null,
):
	| {
			enabled: boolean;
			baseUrl: string;
			apiKey?: string;
			useSingleModel?: boolean;
			haikuModel?: string;
			sonnetModel?: string;
			opusModel?: string;
			subagentModel?: string;
	  }
	| undefined {
	const config = vscode.workspace.getConfiguration('primeCode');
	const effectiveProvider = providerType ?? currentProvider ?? getGlobalProvider();

	// OpenCode doesn't need proxy - it handles OpenAI-compatible models natively
	if (effectiveProvider === 'opencode') {
		return undefined;
	}

	// Check if model is in the enabled proxy models list (handles oai/ prefix)
	const enabledProxyModels = config.get<string[]>('proxy.enabledModels', []);
	if (!isModelInProxyList(model, enabledProxyModels)) {
		return undefined;
	}

	const proxyBaseUrl = config.get<string>('proxy.baseUrl', 'http://localhost:11434');
	if (!proxyBaseUrl) {
		logger.warn(
			`[CLIServiceFactory] Model "${model}" is in enabledProxyModels but proxy.baseUrl is not configured`,
		);
		return undefined;
	}

	const useSingleModel = config.get<boolean>('proxy.useSingleModel', true);

	return {
		enabled: true,
		baseUrl: proxyBaseUrl,
		apiKey: config.get<string>('proxy.apiKey'),
		useSingleModel,
		haikuModel: useSingleModel ? undefined : config.get<string>('proxy.haikuModel') || undefined,
		sonnetModel: useSingleModel ? undefined : config.get<string>('proxy.sonnetModel') || undefined,
		opusModel: useSingleModel ? undefined : config.get<string>('proxy.opusModel') || undefined,
		subagentModel: useSingleModel
			? undefined
			: config.get<string>('proxy.subagentModel') || undefined,
	};
}

export async function dispose(): Promise<void> {
	if (currentInstance) {
		await currentInstance.dispose();
		currentInstance = null;
		currentProvider = null;
		initializationPromise = null;
	}
}

/**
 * Force re-creation of the service (e.g. after config change)
 */
export async function refresh(): Promise<ICLIService> {
	currentProvider = null;
	initializationPromise = null;
	return getService();
}

// Re-export as namespace for backward compatibility
export const CLIServiceFactory = {
	getService,
	setAccessService,
	getCurrentProvider,
	isOpenCode,
	isClaude,
	buildProxyConfig,
	dispose,
	refresh,
};

// Re-export CLIProviderType from ProviderResolver for backward compatibility
export type { CLIProviderType } from './ProviderResolver';
