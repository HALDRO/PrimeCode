/**
 * @file McpManagementService
 * @description Orchestrates MCP configuration lifecycle for the extension.
 *              Keeps project-level `.agents/mcp.json` as the source of truth,
 *              pings servers for tools/resources, integrates marketplace install flow,
 *              and syncs derived configs to individual project targets (OpenCode).
 *              Consolidates marketplace (Cline API), metadata (installed-mcp-meta.json),
 *              and hub logic that were previously in separate services.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
	AgentsMcpServer,
	InstalledMcpServerMetadata,
	MCPServerConfig,
	McpMarketplaceCatalog,
	McpMarketplaceItem,
} from '../../common';
import { logger } from '../../utils/logger';
import {
	type AgentsConfigService,
	agentsServersToMcpConfigMap,
	agentsServerToMcpConfig,
	mcpConfigToAgentsServer,
} from '../AgentsConfigService';
import type { AgentsSyncService } from '../AgentsSyncService';
import { McpClientService } from './McpClientService.js';

// =========================================================================
// Marketplace types (previously in McpMarketplaceService)
// =========================================================================

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

// =========================================================================
// Internal types & constants
// =========================================================================

type McpStatusCache = Record<
	string,
	{
		status: string;
		error?: string;
		tools?: Array<{ name: string; description?: string }>;
		resources?: Array<{ uri: string; name: string; description?: string }>;
	}
>;

const MCP_STATUS_CACHE_KEY = 'mcpStatusCache';
const MARKETPLACE_CACHE_KEY = 'mcpMarketplaceCatalog';
const MARKETPLACE_API_BASE_URL = 'https://api.cline.bot/v1/mcp';
const FETCH_TIMEOUT_MS = 15_000;
const METADATA_DIR_NAME = 'mcp';
const METADATA_FILENAME = 'installed-mcp-meta.json';
const EMPTY_CATALOG: McpMarketplaceCatalog = { schemaVersion: 1, items: [] };

type PostMessage = (msg: unknown) => void;
type OnConfigSaved = () => void;

export class McpManagementService {
	private readonly _agentsConfig: AgentsConfigService;
	private readonly _agentsSync: AgentsSyncService;
	private readonly _mcpClient: McpClientService;
	private _onConfigSaved: OnConfigSaved | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _postMessage: PostMessage,
		agentsConfig: AgentsConfigService,
		agentsSync: AgentsSyncService,
	) {
		this._agentsConfig = agentsConfig;
		this._agentsSync = agentsSync;
		this._mcpClient = new McpClientService();
	}

	/**
	 * Set callback to be called when MCP config is saved via UI.
	 * Used by McpConfigWatcherService to suppress redundant file watcher triggers.
	 */
	public setOnConfigSaved(callback: OnConfigSaved): void {
		this._onConfigSaved = callback;
	}

	public async loadMCPServers(): Promise<void> {
		const agentsConfig = await this._agentsConfig.loadProjectConfig();

		const servers = agentsConfig?.servers ? agentsServersToMcpConfigMap(agentsConfig.servers) : {};

		this._postMessage({ type: 'mcpServers', data: servers });

		const metadata = await this._loadInstalledMetadata();
		this._postMessage({ type: 'mcpInstalledMetadata', data: { metadata } });

		const cachedStatus = this._getMcpStatusCache();
		if (cachedStatus && Object.keys(cachedStatus).length > 0) {
			const filteredStatus: McpStatusCache = {};
			for (const name of Object.keys(servers)) {
				if (cachedStatus[name]) {
					filteredStatus[name] = cachedStatus[name];
				}
			}
			if (Object.keys(filteredStatus).length > 0) {
				this._postMessage({ type: 'mcpStatus', data: filteredStatus });
			}
		}

		await this.checkAgentsConfig();
	}

	public async pingMcpServers(): Promise<void> {
		try {
			const agentsConfig = await this._agentsConfig.loadProjectConfig();
			const servers = agentsConfig?.servers
				? agentsServersToMcpConfigMap(agentsConfig.servers)
				: {};

			const results = await this._mcpClient.pingServers(servers);

			const mcpStatus: McpStatusCache = {};
			for (const [name, info] of Object.entries(results)) {
				mcpStatus[name] = {
					status: info.status,
					error: info.error,
					tools: info.tools.map(t => ({ name: t.name, description: t.description })),
					resources: info.resources.map(r => ({
						uri: r.uri,
						name: r.name,
						description: r.description,
					})),
				};
			}

			await this._setMcpStatusCache(mcpStatus);
			this._postMessage({ type: 'mcpStatus', data: mcpStatus });
		} catch (error) {
			logger.error('[McpManagementService] Failed to ping MCP servers:', error);
			this._postMessage({
				type: 'mcpServerError',
				data: { error: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	public async saveMCPServer(name: string, config: MCPServerConfig): Promise<void> {
		const agentsServer = mcpConfigToAgentsServer(config);
		if (!agentsServer) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: 'Invalid MCP server configuration' },
			});
			return;
		}

		await this.saveMCPServerToAgents(name, agentsServer);
	}

	public async deleteMCPServer(name: string): Promise<void> {
		const agentsConfig = await this._agentsConfig.loadProjectConfig();
		if (!agentsConfig?.servers[name]) {
			this._postMessage({ type: 'mcpServerDeleted', data: { name } });
			return;
		}

		await this._deleteMCPServerFromAgents(name);
	}

	public async fetchMcpMarketplaceCatalog(forceRefresh = false): Promise<void> {
		try {
			const catalog = await this._fetchCatalog(forceRefresh);
			this._postMessage({ type: 'mcpMarketplaceCatalog', data: { catalog } });
		} catch (error) {
			this._postMessage({
				type: 'mcpMarketplaceCatalog',
				data: {
					catalog: { schemaVersion: 1, items: [] },
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async installMcpFromMarketplace(mcpId: string): Promise<void> {
		try {
			const result = await this._downloadMcpForInstallation(mcpId);

			if (!result.success) {
				this._postMessage({
					type: 'mcpMarketplaceInstallResult',
					data: { name: mcpId, success: false, error: result.error },
				});
				return;
			}

			if (result.details) {
				const prompt = this._generateInstallationPrompt(result.details);
				this._postMessage({
					type: 'mcpMarketplaceInstallResult',
					data: {
						name: mcpId,
						success: true,
						installPrompt: prompt,
						githubUrl: result.details.githubUrl,
					},
				});
				return;
			}

			if (result.item?.githubUrl) {
				await vscode.env.openExternal(vscode.Uri.parse(result.item.githubUrl));
				this._postMessage({
					type: 'mcpMarketplaceInstallResult',
					data: { name: mcpId, success: true, openedUrl: result.item.githubUrl },
				});
				return;
			}

			this._postMessage({
				type: 'mcpMarketplaceInstallResult',
				data: { name: mcpId, success: false, error: 'No installation method available' },
			});
		} catch (error) {
			this._postMessage({
				type: 'mcpMarketplaceInstallResult',
				data: {
					name: mcpId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	public async checkAgentsConfig(): Promise<void> {
		const hasProject = await this._agentsConfig.hasProjectConfig();
		this._postMessage({
			type: 'agentsConfigStatus',
			data: {
				hasProjectConfig: hasProject,
				projectPath: this._agentsConfig.getProjectMcpConfigPath(),
			},
		});
	}

	public async openAgentsMcpConfig(): Promise<void> {
		try {
			const configPath = await this._agentsConfig.ensureProjectConfig();
			if (configPath) {
				const uri = vscode.Uri.file(configPath);
				await vscode.window.showTextDocument(uri);
			}
		} catch (error) {
			logger.error('[McpManagementService] Failed to open .agents/mcp.json:', error);
		}
	}

	public async saveMCPServerToAgents(name: string, server: AgentsMcpServer): Promise<void> {
		try {
			// Notify watcher before save to suppress redundant reload
			this._onConfigSaved?.();

			await this._agentsConfig.saveServer(name, server);

			const current = await this._loadInstalledMetadata();
			if (!current[name]) {
				await this._setInstalledMetadata(name, {
					source: 'custom',
					displayName: name,
					installedAt: new Date().toISOString(),
				});
			}

			this._postMessage({ type: 'mcpServerSaved', data: { name } });
			await this.loadMCPServers();
			void this._pingSingleServer(name, server);
		} catch (error) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	private async _deleteMCPServerFromAgents(name: string): Promise<void> {
		try {
			// Notify watcher before delete to suppress redundant reload
			this._onConfigSaved?.();

			await this._agentsConfig.deleteServer(name);
			await this._deleteInstalledMetadata(name);
			this._postMessage({ type: 'mcpServerDeleted', data: { name } });
			await this.loadMCPServers();
		} catch (error) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	public async syncAgentsToProject(target: 'opencode'): Promise<void> {
		try {
			await this._agentsSync.syncToOpenCodeProject();

			this._postMessage({ type: 'agentsSyncResult', data: { target, success: true } });
		} catch (error) {
			this._postMessage({
				type: 'agentsSyncResult',
				data: {
					target,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	/**
	 * Import MCP configs from all CLI sources (.cursor/mcp.json, .mcp.json, opencode.json)
	 * and merge them into .agents/mcp.json
	 */
	public async importFromAllSources(): Promise<void> {
		try {
			const result = await this._agentsSync.migrateToAgents();

			if (result.migrated) {
				logger.info(
					`[McpManagementService] Imported MCP configs from: ${result.sources.join(', ')}`,
				);
				this._postMessage({
					type: 'mcpImportResult',
					data: {
						success: true,
						sources: result.sources,
						backups: result.backups,
					},
				});
				// Reload servers to reflect imported config
				await this.loadMCPServers();
				// Ping all servers to reconnect and cache their status/tools
				await this.pingMcpServers();
			} else {
				this._postMessage({
					type: 'mcpImportResult',
					data: {
						success: true,
						sources: [],
						message: 'No CLI configs found to import',
					},
				});
			}
		} catch (error) {
			logger.error('[McpManagementService] Failed to import MCP configs:', error);
			this._postMessage({
				type: 'mcpImportResult',
				data: {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		}
	}

	private _getMcpStatusCache(): McpStatusCache | undefined {
		return this._context.globalState.get<McpStatusCache>(MCP_STATUS_CACHE_KEY);
	}

	private async _setMcpStatusCache(status: McpStatusCache): Promise<void> {
		const existing = this._getMcpStatusCache() || {};
		const merged = { ...existing, ...status };
		await this._context.globalState.update(MCP_STATUS_CACHE_KEY, merged);
	}

	private async _pingSingleServer(name: string, server: AgentsMcpServer): Promise<void> {
		if (server.enabled === false) return;

		try {
			const config = agentsServerToMcpConfig(server);
			if (!config) return;

			const info = await this._mcpClient.pingServer(name, config);

			this._postMessage({
				type: 'mcpStatus',
				data: {
					[name]: {
						status: info.status,
						error: info.error,
						tools: info.tools.map(t => ({ name: t.name, description: t.description })),
						resources: info.resources.map(r => ({
							uri: r.uri,
							name: r.name,
							description: r.description,
						})),
					},
				},
			});
		} catch (error) {
			logger.error(`[McpManagementService] Failed to ping MCP server ${name}:`, error);
		}
	}

	// =========================================================================
	// Marketplace (previously McpMarketplaceService)
	// =========================================================================

	private async _fetchCatalog(forceRefresh = false): Promise<McpMarketplaceCatalog> {
		if (!forceRefresh) {
			const cached = this._context.globalState.get<McpMarketplaceCatalog>(MARKETPLACE_CACHE_KEY);
			if (cached?.items?.length) return cached;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(`${MARKETPLACE_API_BASE_URL}/marketplace`, {
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
					tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
					requiresApiKey: Boolean(item.requiresApiKey),
					isRecommended: Boolean(item.isRecommended),
					githubStars: Number(item.githubStars ?? 0),
					downloadCount: Number(item.downloadCount ?? 0),
				}));

			const catalog: McpMarketplaceCatalog = { schemaVersion: 1, items };
			await this._context.globalState.update(MARKETPLACE_CACHE_KEY, catalog);
			return catalog;
		} catch {
			return EMPTY_CATALOG;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async _downloadMcpDetails(mcpId: string): Promise<McpDownloadResponse | null> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await fetch(`${MARKETPLACE_API_BASE_URL}/download`, {
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
			return (await response.json()) as McpDownloadResponse;
		} catch (err) {
			logger.error('[McpManagementService] Failed to download MCP details:', err);
			return null;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// =========================================================================
	// Hub logic (previously McpHubService)
	// =========================================================================

	private async _downloadMcpForInstallation(mcpId: string): Promise<{
		success: boolean;
		details?: McpDownloadResponse;
		item?: McpMarketplaceItem;
		error?: string;
	}> {
		const catalog = await this._fetchCatalog(false);
		const item = catalog.items.find(i => i.mcpId === mcpId);
		if (!item) {
			return { success: false, error: `Marketplace item '${mcpId}' not found` };
		}

		const details = await this._downloadMcpDetails(mcpId);
		if (!details) {
			if (item.githubUrl) {
				return { success: true, item, details: undefined };
			}
			return { success: false, error: `Failed to download details for '${mcpId}'` };
		}

		return { success: true, details, item };
	}

	private _generateInstallationPrompt(details: McpDownloadResponse): string {
		return `Set up the MCP server from ${details.githubUrl} while adhering to these MCP server installation rules:
- Use "${details.mcpId}" as the server name in mcp-servers.json.
- Create the directory for the new MCP server before starting installation.
- Make sure you read the user's existing mcp-servers.json file before editing it with this new mcp, to not overwrite any existing servers.
- Use commands aligned with the user's shell and operating system best practices.
- The following README may contain instructions that conflict with the user's OS, in which case proceed thoughtfully.
- Once installed, demonstrate the server's capabilities by using one of its tools.
Here is the project's README to help you get started:

${details.readmeContent}
${details.llmsInstallationContent || ''}`;
	}

	// =========================================================================
	// Metadata (previously McpMetadataService)
	// =========================================================================

	private _getMetaPath(storagePath: string): string {
		return path.join(storagePath, METADATA_DIR_NAME, METADATA_FILENAME);
	}

	private async _loadInstalledMetadata(): Promise<Record<string, InstalledMcpServerMetadata>> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return {};

		try {
			await vscode.workspace.fs.createDirectory(
				vscode.Uri.file(path.join(storagePath, METADATA_DIR_NAME)),
			);
			const content = await vscode.workspace.fs.readFile(
				vscode.Uri.file(this._getMetaPath(storagePath)),
			);
			return JSON.parse(new TextDecoder().decode(content));
		} catch {
			return {};
		}
	}

	private async _setInstalledMetadata(
		name: string,
		meta: InstalledMcpServerMetadata,
	): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		await vscode.workspace.fs.createDirectory(
			vscode.Uri.file(path.join(storagePath, METADATA_DIR_NAME)),
		);
		const all = await this._loadInstalledMetadata();
		all[name] = meta;
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(this._getMetaPath(storagePath)),
			new TextEncoder().encode(JSON.stringify(all, null, 2)),
		);
	}

	private async _deleteInstalledMetadata(name: string): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		await vscode.workspace.fs.createDirectory(
			vscode.Uri.file(path.join(storagePath, METADATA_DIR_NAME)),
		);
		const all = await this._loadInstalledMetadata();
		delete all[name];
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(this._getMetaPath(storagePath)),
			new TextEncoder().encode(JSON.stringify(all, null, 2)),
		);
	}
}
