/**
 * @file PrimeCode Config
 * @description Persistent config for PrimeCode stored at ~/.config/opencode/primecode.json.
 * Architecture: in-memory cache is the single source of truth. File is just persistence.
 * - On startup: load file into cache (once).
 * - On mutation: update cache, then dump entire cache to disk synchronously.
 * - On external change (file watcher): reload file into cache.
 * No read-modify-write. No partial patches to disk. No async queues.
 * Every write is the full cache serialized to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { logger } from '../../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RuntimeEntry {
	runtimeId: string;
	serverUrl: string;
	authorization: string;
	workspaceRoot: string;
	createdAt: number;
	pid: number | null;
	ownerPid: number;
}

export interface ModelSettings {
	enabledModels: string[];
	providerModelVisibility: Record<string, boolean | undefined>;
	modelVariants: Record<string, string | undefined>;
}

export interface ProxyEndpoint {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	protocol?: 'openai-compatible' | 'openai-responses' | 'anthropic';
	enabledModels: string[];
	headers?: Record<string, string>;
	modelVariants?: Record<string, string[]>;
}

export interface AppSettings {
	proxyEndpoints: ProxyEndpoint[];
	providersDisabled: string[];
	promptImproveModel: string;
	promptImproveTemplate: string;
	opencodeAgent: string;
}

export interface PrimeCodeConfig {
	runtimes: RuntimeEntry[];
	models: ModelSettings;
	app: AppSettings;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
	enabledModels: [],
	providerModelVisibility: {},
	modelVariants: {},
};

const DEFAULT_APP_SETTINGS: AppSettings = {
	proxyEndpoints: [],
	providersDisabled: [],
	promptImproveModel: '',
	promptImproveTemplate: '',
	opencodeAgent: '',
};

function defaultConfig(): PrimeCodeConfig {
	return {
		runtimes: [],
		models: { ...DEFAULT_MODEL_SETTINGS },
		app: { ...DEFAULT_APP_SETTINGS },
	};
}

// ─── State ───────────────────────────────────────────────────────────────────

export const CONFIG_PATH = path.join(homedir(), '.config', 'opencode', 'primecode.json');

let cache: PrimeCodeConfig = defaultConfig();

// Load from disk on module init
loadFromDisk();

// ─── Disk I/O ────────────────────────────────────────────────────────────────

function ensureConfigDir(): void {
	const dir = path.dirname(CONFIG_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Load config from disk into cache. Called once at startup and on external file changes.
 * If file doesn't exist or is corrupted — keeps current cache intact.
 */
function loadFromDisk(): void {
	try {
		if (!existsSync(CONFIG_PATH)) return;
		const raw = readFileSync(CONFIG_PATH, 'utf-8');
		if (!raw.trim()) return;
		const parsed = JSON.parse(raw) as Partial<PrimeCodeConfig>;
		// Merge parsed data into cache, preserving cache values for missing fields
		cache = {
			runtimes: Array.isArray(parsed.runtimes) ? parsed.runtimes : cache.runtimes,
			models: mergeModelSettings(parsed.models),
			app: mergeAppSettings(parsed.app),
		};
	} catch (error) {
		logger.warn('[PrimeCodeConfig] Failed to load primecode.json, using cached state:', error);
	}
}

function mergeModelSettings(raw: unknown): ModelSettings {
	if (!raw || typeof raw !== 'object') return cache.models;
	const obj = raw as Record<string, unknown>;

	// Clean up legacy "oai-" prefixed keys from providerModelVisibility
	let visibility = cache.models.providerModelVisibility;
	if (
		obj.providerModelVisibility &&
		typeof obj.providerModelVisibility === 'object' &&
		!Array.isArray(obj.providerModelVisibility)
	) {
		const raw = obj.providerModelVisibility as Record<string, boolean | undefined>;
		visibility = {};
		for (const [key, value] of Object.entries(raw)) {
			// Strip all "oai-" prefixes from keys (legacy data cleanup)
			let cleanKey = key;
			while (cleanKey.startsWith('oai-')) {
				cleanKey = cleanKey.slice(4);
			}
			// Keep the most permissive value if duplicates exist after normalization
			if (visibility[cleanKey] === undefined || value === true) {
				visibility[cleanKey] = value;
			}
		}
	}

	return {
		enabledModels: Array.isArray(obj.enabledModels)
			? obj.enabledModels.filter((v): v is string => typeof v === 'string')
			: cache.models.enabledModels,
		providerModelVisibility: visibility,
		modelVariants:
			obj.modelVariants &&
			typeof obj.modelVariants === 'object' &&
			!Array.isArray(obj.modelVariants)
				? (obj.modelVariants as Record<string, string | undefined>)
				: cache.models.modelVariants,
	};
}

function mergeAppSettings(raw: unknown): AppSettings {
	if (!raw || typeof raw !== 'object') return cache.app;
	const obj = raw as Record<string, unknown>;
	return {
		proxyEndpoints: Array.isArray(obj.proxyEndpoints)
			? obj.proxyEndpoints
			: cache.app.proxyEndpoints,
		providersDisabled: Array.isArray(obj.providersDisabled)
			? obj.providersDisabled.filter((v): v is string => typeof v === 'string')
			: cache.app.providersDisabled,
		promptImproveModel:
			typeof obj.promptImproveModel === 'string'
				? obj.promptImproveModel
				: cache.app.promptImproveModel,
		promptImproveTemplate:
			typeof obj.promptImproveTemplate === 'string'
				? obj.promptImproveTemplate
				: cache.app.promptImproveTemplate,
		opencodeAgent:
			typeof obj.opencodeAgent === 'string' ? obj.opencodeAgent : cache.app.opencodeAgent,
	};
}

/**
 * Persist entire cache to disk. Synchronous. Always writes the full state.
 * This is the ONLY function that writes to the file.
 */
function persistToDisk(): void {
	try {
		ensureConfigDir();
		writeFileSync(CONFIG_PATH, JSON.stringify(cache, null, 2), 'utf-8');
	} catch (error) {
		logger.error('[PrimeCodeConfig] Failed to persist primecode.json:', error);
	}
}

// ─── Public API: Cache Invalidation ──────────────────────────────────────────

/**
 * Reload config from disk (e.g. after external file change from another VS Code window).
 * Forces a re-read regardless of mtime — the caller already knows the file changed.
 */
export function invalidateConfigCache(): void {
	loadFromDisk();
}

/** Reset all in-memory state to defaults. For tests only. */
export function resetConfigForTesting(): void {
	cache = defaultConfig();
}

/** Wait for all pending writes to complete. No-op in sync architecture, kept for API compat. */
export function flushWrites(): Promise<void> {
	return Promise.resolve();
}

// ─── Public API: Runtime Registry ────────────────────────────────────────────

export function addRuntime(entry: RuntimeEntry): void {
	cache.runtimes = cache.runtimes.filter(r => r.runtimeId !== entry.runtimeId);
	cache.runtimes.push(entry);
	persistToDisk();
	logger.info('[PrimeCodeConfig] Added runtime entry', {
		runtimeId: entry.runtimeId,
		pid: entry.pid,
		port: entry.serverUrl,
	});
}

export function removeRuntime(runtimeId: string): void {
	const before = cache.runtimes.length;
	cache.runtimes = cache.runtimes.filter(r => r.runtimeId !== runtimeId);
	if (cache.runtimes.length < before) {
		persistToDisk();
		logger.info('[PrimeCodeConfig] Removed runtime entry', { runtimeId });
	}
}

export function getRuntimesForWorkspace(workspaceRoot: string): RuntimeEntry[] {
	return cache.runtimes.filter(r => r.workspaceRoot === workspaceRoot);
}

export function getAllRuntimes(): RuntimeEntry[] {
	return cache.runtimes;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// ─── Public API: Settings ────────────────────────────────────────────────────

export type ModelSettingsPatch = Partial<ModelSettings>;

export function getModelSettings(): ModelSettings {
	return cache.models;
}

export function getAppSettings(): AppSettings {
	return cache.app;
}

/**
 * Batch update — merges model and app changes into cache, persists to disk.
 */
export function updateConfig(patch: {
	models?: ModelSettingsPatch;
	app?: Partial<AppSettings>;
}): void {
	if (patch.models) {
		const m = patch.models;
		if (m.enabledModels !== undefined) cache.models.enabledModels = m.enabledModels;
		if (m.providerModelVisibility !== undefined) {
			cache.models.providerModelVisibility = {
				...cache.models.providerModelVisibility,
				...m.providerModelVisibility,
			};
		}
		if (m.modelVariants !== undefined) {
			cache.models.modelVariants = { ...cache.models.modelVariants, ...m.modelVariants };
		}
	}

	if (patch.app) {
		cache.app = { ...cache.app, ...patch.app };
	}

	persistToDisk();
}

export function updateModelSettings(patch: ModelSettingsPatch): void {
	updateConfig({ models: patch });
}

export function updateAppSettings(patch: Partial<AppSettings>): void {
	updateConfig({ app: patch });
}
