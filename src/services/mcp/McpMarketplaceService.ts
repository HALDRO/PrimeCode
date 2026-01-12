/**
 * @file McpMarketplaceService
 * @description Provides an MCP "marketplace" catalog using Cline API.
 *              - GET /marketplace — returns list of MCP servers with metadata
 *              - POST /download — returns README and installation instructions for AI-assisted setup
 *              Caches catalog in extension globalState.
 */

import type * as vscode from 'vscode';
import type { McpMarketplaceCatalog, McpMarketplaceItem } from '../../types';

const EMPTY_CATALOG: McpMarketplaceCatalog = { schemaVersion: 1, items: [] };

export interface McpDownloadResponse {
	mcpId: string;
	githubUrl: string;
	name: string;
	author: string;
	description: string;
	readmeContent: string;
	llmsInstallationContent: string;
	requiresApiKey: boolean;
}

export class McpMarketplaceService {
	private static readonly CACHE_KEY = 'mcpMarketplaceCatalog';
	private static readonly API_BASE_URL = 'https://api.cline.bot/v1/mcp';
	private static readonly FETCH_TIMEOUT_MS = 15_000;

	constructor(private readonly _context: vscode.ExtensionContext) {}

	/**
	 * Fetch marketplace catalog from Cline API.
	 */
	public async fetchCatalog(forceRefresh = false): Promise<McpMarketplaceCatalog> {
		if (!forceRefresh) {
			const cached = this._context.globalState.get<McpMarketplaceCatalog>(
				McpMarketplaceService.CACHE_KEY,
			);
			if (cached?.items?.length) return cached;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), McpMarketplaceService.FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(`${McpMarketplaceService.API_BASE_URL}/marketplace`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'primecode-vscode-extension',
				},
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`Marketplace request failed: ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as unknown[];
			const rawItems = Array.isArray(data) ? data : [];

			// Map API response to our McpMarketplaceItem format
			const items: McpMarketplaceItem[] = rawItems
				.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
				.map(item => ({
					mcpId: String(item.mcpId ?? ''),
					name: String(item.name ?? ''),
					author: String(item.author ?? ''),
					description: String(item.description ?? ''),
					githubUrl: String(item.githubUrl ?? ''),
					logoUrl: String(item.logoUrl ?? ''),
					category: String(item.category ?? ''),
					tags: Array.isArray(item.tags) ? item.tags : [],
					requiresApiKey: Boolean(item.requiresApiKey),
					isRecommended: Boolean(item.isRecommended),
					githubStars: Number(item.githubStars ?? 0),
					downloadCount: Number(item.downloadCount ?? 0),
				}));

			const catalog: McpMarketplaceCatalog = {
				schemaVersion: 1,
				items,
			};

			await this._context.globalState.update(McpMarketplaceService.CACHE_KEY, catalog);
			return catalog;
		} catch {
			// Online fetch failed: return empty catalog.
			return EMPTY_CATALOG;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Download MCP server details (README + installation instructions) from Cline API.
	 * This is used for AI-assisted installation.
	 */
	public async downloadMcpDetails(mcpId: string): Promise<McpDownloadResponse | null> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), McpMarketplaceService.FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(`${McpMarketplaceService.API_BASE_URL}/download`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'primecode-vscode-extension',
				},
				body: JSON.stringify({ mcpId }),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`Download request failed: ${response.status} ${response.statusText}`);
			}

			const data = (await response.json()) as McpDownloadResponse;
			return data;
		} catch (err) {
			console.error('[McpMarketplaceService] Failed to download MCP details:', err);
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
