/**
 * @file ModelsDevService
 * @description Fetches and caches model metadata from models.dev/api.json.
 * Used as a fallback to enrich proxy models with context window sizes,
 * capabilities, and other metadata that /v1/models doesn't provide.
 *
 * Mirrors the approach used by OpenCode CLI (packages/opencode/src/provider/models.ts).
 */

import type * as vscode from 'vscode';
import { logger } from '../utils/logger';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Model metadata from models.dev */
export interface ModelsDevModelInfo {
	id: string;
	name?: string;
	context?: number;
	output?: number;
	reasoning?: boolean;
	tool_call?: boolean;
	attachment?: boolean;
	temperature?: boolean;
	modalities?: {
		input?: string[];
		output?: string[];
	};
}

/** Provider entry from models.dev */
interface ModelsDevProvider {
	name?: string;
	models?: Record<
		string,
		{
			id?: string;
			name?: string;
			reasoning?: boolean;
			tool_call?: boolean;
			attachment?: boolean;
			temperature?: boolean;
			limit?: { context?: number; output?: number; input?: number };
			modalities?: { input?: string[]; output?: string[] };
		}
	>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

export class ModelsDevService implements vscode.Disposable {
	private cache: ModelsDevData | null = null;
	private lastFetchTime = 0;
	private fetchPromise: Promise<ModelsDevData | null> | null = null;
	/** Sorted known model IDs (longest first) for substring matching. */
	private knownIds: string[] = [];

	/**
	 * Get the full models.dev database (cached, refreshed hourly).
	 */
	async getData(): Promise<ModelsDevData | null> {
		const now = Date.now();
		if (this.cache && now - this.lastFetchTime < CACHE_TTL_MS) {
			return this.cache;
		}

		// Deduplicate concurrent fetches
		if (this.fetchPromise) return this.fetchPromise;

		this.fetchPromise = this.fetchData();
		try {
			const data = await this.fetchPromise;
			return data;
		} finally {
			this.fetchPromise = null;
		}
	}

	/**
	 * Look up a model by its ID across all providers.
	 *
	 * Uses substring matching with longest-match priority so that any
	 * prefix/suffix/wrapper around a known model ID is handled automatically:
	 *   "[Kiro] claude-sonnet-4-5"          → matches "claude-sonnet-4-5"
	 *   "kiro-claude-sonnet-4-5-agentic"    → matches "claude-sonnet-4-5"
	 *   "(Beta) gpt-4o-fast"                → matches "gpt-4o"
	 *   "[Kiro] kiro-custom-model"          → no match (not in models.dev)
	 *
	 * No regex, no assumptions about prefix format.
	 */
	async lookupModel(modelId: string): Promise<ModelsDevModelInfo | undefined> {
		const data = await this.getData();
		if (!data) return undefined;

		// Build the index if needed
		if (this.knownIds.length === 0) this.buildKnownIds(data);

		// 1. Try exact match first (fast path)
		const exact = this.findExact(data, modelId);
		if (exact) return exact;

		// 2. Substring match: find the longest known ID contained in modelId
		const bestMatch = this.findLongestSubstring(modelId);
		if (!bestMatch) return undefined;

		return this.findExact(data, bestMatch);
	}

	/**
	 * Batch lookup: resolve metadata for multiple model IDs at once.
	 * Results are keyed by the original (possibly prefixed) ID so
	 * callers can map back to their models.
	 */
	async lookupModels(modelIds: string[]): Promise<Map<string, ModelsDevModelInfo>> {
		const result = new Map<string, ModelsDevModelInfo>();
		const data = await this.getData();
		if (!data) return result;

		if (this.knownIds.length === 0) this.buildKnownIds(data);

		for (const originalId of modelIds) {
			// 1. Exact match
			let info = this.findExact(data, originalId);
			if (info) {
				result.set(originalId, info);
				continue;
			}
			// 2. Substring match
			const bestMatch = this.findLongestSubstring(originalId);
			if (!bestMatch) continue;
			info = this.findExact(data, bestMatch);
			if (info) result.set(originalId, info);
		}
		return result;
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/** Build a sorted list of all known model IDs (longest first). */
	private buildKnownIds(data: ModelsDevData): void {
		const ids = new Set<string>();
		for (const provider of Object.values(data)) {
			if (!provider.models) continue;
			for (const [key, model] of Object.entries(provider.models)) {
				ids.add(model.id ?? key);
				if (model.id && model.id !== key) ids.add(key);
			}
		}
		// Sort longest first so "claude-sonnet-4-5" matches before "claude-sonnet-4"
		this.knownIds = [...ids].sort((a, b) => b.length - a.length);
	}

	/** Find the longest known model ID that is a substring of `modelId`. */
	private findLongestSubstring(modelId: string): string | undefined {
		// knownIds is already sorted longest-first, so first match = longest
		return this.knownIds.find(known => modelId.includes(known));
	}

	/** Exact lookup by model ID or key across all providers. */
	private findExact(data: ModelsDevData, modelId: string): ModelsDevModelInfo | undefined {
		for (const provider of Object.values(data)) {
			if (!provider.models) continue;
			for (const [key, model] of Object.entries(provider.models)) {
				const id = model.id ?? key;
				if (id === modelId || key === modelId) {
					return {
						id,
						name: model.name,
						context: model.limit?.context,
						output: model.limit?.output,
						reasoning: model.reasoning,
						tool_call: model.tool_call,
						attachment: model.attachment,
						temperature: model.temperature,
						modalities: model.modalities,
					};
				}
			}
		}
		return undefined;
	}

	private async fetchData(): Promise<ModelsDevData | null> {
		try {
			const response = await fetch(MODELS_DEV_URL, {
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(15000),
			});

			if (!response.ok) {
				logger.warn(
					`[ModelsDevService] Failed to fetch models.dev: ${response.status} ${response.statusText}`,
				);
				return this.cache; // Return stale cache on error
			}

			const json = (await response.json()) as unknown;
			if (!json || typeof json !== 'object') {
				logger.warn('[ModelsDevService] Invalid response from models.dev');
				return this.cache;
			}

			this.cache = json as ModelsDevData;
			this.lastFetchTime = Date.now();
			this.knownIds = []; // force rebuild on next lookup
			logger.info('[ModelsDevService] models.dev data refreshed');
			return this.cache;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			logger.warn(`[ModelsDevService] Fetch error: ${msg}`);
			return this.cache; // Return stale cache on error
		}
	}

	dispose(): void {
		this.cache = null;
		this.fetchPromise = null;
		this.knownIds = [];
	}
}
