/**
 * @file Virtual diff document content cache with TTL-based cleanup
 * @description Caches diff content for virtual diff documents in VS Code.
 * Uses URI path as key with timestamp tracking for automatic TTL cleanup.
 * Prevents memory leaks during long sessions by removing stale entries.
 */

import * as vscode from 'vscode';

// =============================================================================
// Types
// =============================================================================

interface DiffCacheEntry {
	content: string;
	timestamp: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Time-to-live for cache entries in milliseconds (1 hour) */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum cache size before forced cleanup */
const MAX_CACHE_SIZE = 100;

// =============================================================================
// Cache Storage
// =============================================================================

/**
 * Cache for virtual diff document contents
 * Uses URI path as key, stores content with timestamp for TTL cleanup
 */
const diffContentCache = new Map<string, DiffCacheEntry>();

// =============================================================================
// Public API
// =============================================================================

/**
 * Store content in diff cache and return a unique URI for it
 * @param content - The content to cache
 * @param label - Human-readable label for the URI
 * @param fileExtension - Optional file extension for syntax highlighting (e.g., '.ts', '.html')
 * @returns URI that can be used to retrieve the content
 */
export function cacheDiffContent(
	content: string,
	label: string,
	fileExtension?: string,
): vscode.Uri {
	const id = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
	// Add file extension to path for syntax highlighting
	const ext = fileExtension || '';
	const path = `/${encodeURIComponent(label)}/${id}${ext}`;

	diffContentCache.set(path, {
		content,
		timestamp: Date.now(),
	});

	return vscode.Uri.parse(`prime-diff:${path}`);
}

/**
 * Clear old entries from diff cache using TTL-based cleanup.
 * Removes entries older than 1 hour, and if cache is still too large,
 * removes oldest entries until under MAX_CACHE_SIZE.
 */
export function cleanupDiffCache(): void {
	const now = Date.now();

	// First pass: remove expired entries (older than TTL)
	for (const [key, entry] of diffContentCache) {
		if (now - entry.timestamp > CACHE_TTL_MS) {
			diffContentCache.delete(key);
		}
	}

	// Second pass: if still too large, remove oldest entries
	if (diffContentCache.size > MAX_CACHE_SIZE) {
		const entries = Array.from(diffContentCache.entries()).sort(
			([, a], [, b]) => a.timestamp - b.timestamp,
		);

		const toRemove = entries.slice(0, entries.length - MAX_CACHE_SIZE);
		for (const [key] of toRemove) {
			diffContentCache.delete(key);
		}
	}
}

/**
 * Retrieve content from diff cache
 */
export function getDiffContent(uri: vscode.Uri): string {
	// VS Code decodes the path, but we stored it encoded
	// So we need to re-encode the path to match the cache key
	const decodedPath = uri.path;
	const encodedPath = `/${decodedPath.split('/').slice(1).map(encodeURIComponent).join('/')}`;

	// Try encoded path first (how we store it)
	let entry = diffContentCache.get(encodedPath);
	if (entry !== undefined) {
		return entry.content;
	}

	// Try decoded path as fallback
	entry = diffContentCache.get(decodedPath);
	if (entry !== undefined) {
		return entry.content;
	}

	return '';
}
