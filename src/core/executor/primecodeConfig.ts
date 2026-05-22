/**
 * @file PrimeCode Config
 * @description Single source of truth for PrimeCode-specific persistent state.
 * Stored at ~/.config/opencode/primecode.json — survives VS Code crashes, reloads, and window switches.
 * Read: synchronous from in-memory cache with stat-based mtime validation (non-blocking for callers).
 * Write: async with sequential queue to prevent race conditions between concurrent writes.
 * On parse errors: returns cached/default values in memory WITHOUT overwriting the file on disk.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
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

// ─── File I/O ────────────────────────────────────────────────────────────────

export const CONFIG_PATH = path.join(homedir(), '.config', 'opencode', 'primecode.json');

let configCache: PrimeCodeConfig = defaultConfig();
let configMtime = 0;

function ensureConfigDir(): void {
	const dir = path.dirname(CONFIG_PATH);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Synchronous read with stat-based cache validation.
 * Returns cached config if file mtime hasn't changed.
 * On parse error: returns current cache or defaults — never overwrites the file.
 */
function readConfig(): PrimeCodeConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			// No file yet — return defaults but don't write anything
			if (configMtime === 0) return configCache;
			configMtime = 0;
			return configCache;
		}

		const stat = statSync(CONFIG_PATH);
		if (stat.mtimeMs === configMtime) {
			return configCache;
		}

		const raw = readFileSync(CONFIG_PATH, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<PrimeCodeConfig>;
		configCache = {
			runtimes: Array.isArray(parsed.runtimes) ? parsed.runtimes : configCache.runtimes,
			models: parseModelSettings(parsed.models),
			app: parseAppSettings(parsed.app),
		};
		configMtime = stat.mtimeMs;
		return configCache;
	} catch (error) {
		// Parse error or disk error — return current cache, do NOT reset or overwrite file
		logger.warn('[PrimeCodeConfig] Failed to read primecode.json, using cached state:', error);
		return configCache;
	}
}

/** Force re-read from disk on next access (e.g. after external file change). */
export function invalidateConfigCache(): void {
	configMtime = 0;
}

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseModelSettings(raw: unknown): ModelSettings {
	if (!raw || typeof raw !== 'object') return configCache.models;
	const obj = raw as Record<string, unknown>;
	return {
		enabledModels: Array.isArray(obj.enabledModels)
			? obj.enabledModels.filter((v): v is string => typeof v === 'string')
			: [],
		providerModelVisibility:
			obj.providerModelVisibility &&
			typeof obj.providerModelVisibility === 'object' &&
			!Array.isArray(obj.providerModelVisibility)
				? (obj.providerModelVisibility as Record<string, boolean | undefined>)
				: {},
		modelVariants:
			obj.modelVariants &&
			typeof obj.modelVariants === 'object' &&
			!Array.isArray(obj.modelVariants)
				? (obj.modelVariants as Record<string, string | undefined>)
				: {},
	};
}

function parseAppSettings(raw: unknown): AppSettings {
	if (!raw || typeof raw !== 'object') return configCache.app;
	const obj = raw as Record<string, unknown>;
	return {
		proxyEndpoints: Array.isArray(obj.proxyEndpoints) ? obj.proxyEndpoints : [],
		providersDisabled: Array.isArray(obj.providersDisabled)
			? obj.providersDisabled.filter((v): v is string => typeof v === 'string')
			: [],
		promptImproveModel: typeof obj.promptImproveModel === 'string' ? obj.promptImproveModel : '',
		promptImproveTemplate:
			typeof obj.promptImproveTemplate === 'string' ? obj.promptImproveTemplate : '',
		opencodeAgent: typeof obj.opencodeAgent === 'string' ? obj.opencodeAgent : '',
	};
}

// ─── Async Write Queue ───────────────────────────────────────────────────────

let writeQueue: Promise<void> = Promise.resolve();

/** Wait for all pending writes to complete. Useful for tests. */
export function flushWrites(): Promise<void> {
	return writeQueue;
}

/**
 * Async atomic write with sequential queue.
 * Reads raw JSON from disk, updates ONLY models/app sections, writes back.
 * Never touches runtimes. If file is corrupted, does not write to disk.
 */
function enqueueWrite(config: PrimeCodeConfig): void {
	// Update cache immediately so subsequent sync reads see the new state
	configCache = config;

	writeQueue = writeQueue.then(async () => {
		try {
			ensureConfigDir();
			let fileData: Record<string, unknown> = {};
			if (existsSync(CONFIG_PATH)) {
				try {
					const raw = readFileSync(CONFIG_PATH, 'utf-8');
					fileData = JSON.parse(raw) as Record<string, unknown>;
				} catch {
					logger.warn(
						'[PrimeCodeConfig] Cannot parse primecode.json for settings write, skipping disk write',
					);
					return;
				}
			}
			fileData.models = config.models;
			fileData.app = config.app;
			const tempPath = `${CONFIG_PATH}.tmp`;
			await writeFile(tempPath, JSON.stringify(fileData, null, 2), 'utf-8');
			await rename(tempPath, CONFIG_PATH);
			try {
				const stat = statSync(CONFIG_PATH);
				configMtime = stat.mtimeMs;
			} catch {
				configMtime = 0;
			}
		} catch (error) {
			logger.error('[PrimeCodeConfig] Failed to write primecode.json:', error);
		}
	});
}

/**
 * Partial write: reads raw JSON from disk, updates ONLY the runtimes section,
 * writes back. Never touches models/app. If file is corrupted, does not write.
 */
function writeRuntimesSync(runtimes: RuntimeEntry[]): void {
	try {
		ensureConfigDir();
		let fileData: Record<string, unknown> = {};
		if (existsSync(CONFIG_PATH)) {
			try {
				const raw = readFileSync(CONFIG_PATH, 'utf-8');
				fileData = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// File corrupted — do not overwrite, just update in-memory cache
				logger.warn(
					'[PrimeCodeConfig] Cannot parse primecode.json for runtime write, skipping disk write',
				);
				configCache.runtimes = runtimes;
				return;
			}
		}
		fileData.runtimes = runtimes;
		const tempPath = `${CONFIG_PATH}.tmp`;
		writeFileSync(tempPath, JSON.stringify(fileData, null, 2), 'utf-8');
		renameSync(tempPath, CONFIG_PATH);
		const stat = statSync(CONFIG_PATH);
		configCache.runtimes = runtimes;
		configMtime = stat.mtimeMs;
	} catch (error) {
		logger.error('[PrimeCodeConfig] Failed to write runtimes:', error);
	}
}

// ─── Runtime Registry (sync — must persist before process continues) ─────────

export function addRuntime(entry: RuntimeEntry): void {
	// Read fresh runtimes from disk to avoid stale cache
	let currentRuntimes: RuntimeEntry[] = [];
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = readFileSync(CONFIG_PATH, 'utf-8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			currentRuntimes = Array.isArray(parsed.runtimes) ? parsed.runtimes : [];
		} catch {}
	}
	currentRuntimes = currentRuntimes.filter(r => r.runtimeId !== entry.runtimeId);
	currentRuntimes.push(entry);
	writeRuntimesSync(currentRuntimes);
	logger.info('[PrimeCodeConfig] Added runtime entry', {
		runtimeId: entry.runtimeId,
		pid: entry.pid,
		port: entry.serverUrl,
	});
}

export function removeRuntime(runtimeId: string): void {
	let currentRuntimes: RuntimeEntry[] = [];
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = readFileSync(CONFIG_PATH, 'utf-8');
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			currentRuntimes = Array.isArray(parsed.runtimes) ? parsed.runtimes : [];
		} catch {}
	}
	const before = currentRuntimes.length;
	currentRuntimes = currentRuntimes.filter(r => r.runtimeId !== runtimeId);
	if (currentRuntimes.length < before) {
		writeRuntimesSync(currentRuntimes);
		logger.info('[PrimeCodeConfig] Removed runtime entry', { runtimeId });
	}
}

export function getRuntimesForWorkspace(workspaceRoot: string): RuntimeEntry[] {
	return readConfig().runtimes.filter(r => r.workspaceRoot === workspaceRoot);
}

export function getAllRuntimes(): RuntimeEntry[] {
	return readConfig().runtimes;
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// ─── Settings (async write, sync read from cache) ────────────────────────────

export type ModelSettingsPatch = Partial<ModelSettings>;

export function getModelSettings(): ModelSettings {
	return readConfig().models;
}

export function getAppSettings(): AppSettings {
	return readConfig().app;
}

/**
 * Batch update — merges model and app changes, writes async.
 * Cache is updated immediately for instant sync reads.
 */
export function updateConfig(patch: {
	models?: ModelSettingsPatch;
	app?: Partial<AppSettings>;
}): void {
	const config = readConfig();

	if (patch.models) {
		const m = patch.models;
		const models = config.models;
		if (m.enabledModels !== undefined) models.enabledModels = m.enabledModels;
		if (m.providerModelVisibility !== undefined) {
			models.providerModelVisibility = {
				...models.providerModelVisibility,
				...m.providerModelVisibility,
			};
		}
		if (m.modelVariants !== undefined) {
			models.modelVariants = { ...models.modelVariants, ...m.modelVariants };
		}
	}

	if (patch.app) {
		config.app = { ...config.app, ...patch.app };
	}

	enqueueWrite(config);
}

// Convenience wrappers

export function updateModelSettings(patch: ModelSettingsPatch): void {
	updateConfig({ models: patch });
}

export function updateAppSettings(patch: Partial<AppSettings>): void {
	updateConfig({ app: patch });
}
