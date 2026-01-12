/**
 * @file McpManagementService
 * @description Orchestrates MCP configuration lifecycle for the extension.
 *              Keeps project-level `.agents/mcp.json` as the source of truth,
 *              pings servers for tools/resources, integrates marketplace install flow,
 *              and syncs derived configs to individual project targets (Claude/OpenCode/Cursor).
 */

import * as vscode from 'vscode';
import type { AgentsMcpServer, MCPServerConfig } from '../../types';
import { logger } from '../../utils/logger';
import { claudeConfigToUnifiedServer } from '../../utils/mcpAdapters';
import {
	AgentsConfigService,
	agentsServersToMcpConfigMap,
	agentsServerToMcpConfig,
	unifiedServerToAgents,
} from '../AgentsConfigService';
import { AgentsSyncService } from '../AgentsSyncService';
import { McpClientService } from './McpClientService.js';
import type { McpMarketplaceService } from './McpMarketplaceService';
import type { McpMetadataService } from './McpMetadataService';

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

type PostMessage = (msg: unknown) => void;
type OnConfigSaved = () => void;

export class McpManagementService {
	private readonly _agentsConfig: AgentsConfigService;
	private readonly _agentsSync: AgentsSyncService;
	private readonly _mcpClient: McpClientService;
	private _onConfigSaved: OnConfigSaved | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _mcpMarketplace: McpMarketplaceService,
		private readonly _mcpMetadata: McpMetadataService,
		private readonly _postMessage: PostMessage,
	) {
		this._agentsConfig = new AgentsConfigService();
		this._agentsSync = new AgentsSyncService(this._agentsConfig);
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

		const metadata = await this._mcpMetadata.loadAll();
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
		const unified = claudeConfigToUnifiedServer(config);
		if (!unified) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: 'Invalid MCP server configuration' },
			});
			return;
		}

		const agentsServer = unifiedServerToAgents(unified);
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
			const catalog = await this._mcpMarketplace.fetchCatalog(forceRefresh);
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
			const { McpHubService } = await import('./McpHubService.js');
			const hub = new McpHubService(this._mcpMarketplace, this._mcpMetadata);
			const result = await hub.downloadMcpForInstallation(mcpId);

			if (!result.success) {
				this._postMessage({
					type: 'mcpMarketplaceInstallResult',
					data: { name: mcpId, success: false, error: result.error },
				});
				return;
			}

			if (result.details) {
				const prompt = hub.generateInstallationPrompt(result.details);
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

			const current = await this._mcpMetadata.loadAll();
			if (!current[name]) {
				await this._mcpMetadata.set(name, {
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
			await this._mcpMetadata.delete(name);
			this._postMessage({ type: 'mcpServerDeleted', data: { name } });
			await this.loadMCPServers();
		} catch (error) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: error instanceof Error ? error.message : String(error) },
			});
		}
	}

	public async syncAgentsToProject(target: 'claude' | 'opencode'): Promise<void> {
		try {
			if (target === 'claude') {
				await this._agentsSync.syncToClaudeProject();
			} else {
				await this._agentsSync.syncToOpenCodeProject();
			}

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
}
