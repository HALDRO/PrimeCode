/**
 * @file McpManagementService
 * @description Orchestrates MCP configuration lifecycle for the extension.
 *              Reads/writes MCP config directly from `opencode.json` as the source of truth,
 *              pings servers for tools/resources.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { InstalledMcpServerMetadata, MCPServerConfig, McpServer } from '../../common';
import { logger } from '../../utils/logger';
import {
	configToMcpServer,
	type McpConfigService,
	mcpServersToConfigMap,
	mcpServerToConfig,
} from '../McpConfigService';
import { McpClientService } from './McpClientService.js';

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
const METADATA_DIR_NAME = 'mcp';
const METADATA_FILENAME = 'installed-mcp-meta.json';

type PostMessage = (msg: unknown) => void;
type OnConfigSaved = () => void;

export class McpManagementService {
	private readonly _agentsConfig: McpConfigService;
	private readonly _mcpClient: McpClientService;
	private _onConfigSaved: OnConfigSaved | undefined;

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _postMessage: PostMessage,
		agentsConfig: McpConfigService,
	) {
		this._agentsConfig = agentsConfig;
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

		const servers = agentsConfig?.mcp ? mcpServersToConfigMap(agentsConfig.mcp) : {};

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
			const servers = agentsConfig?.mcp ? mcpServersToConfigMap(agentsConfig.mcp) : {};

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
		const mcpServer = configToMcpServer(config);
		if (!mcpServer) {
			this._postMessage({
				type: 'mcpServerError',
				data: { error: 'Invalid MCP server configuration' },
			});
			return;
		}

		await this.saveMCPServerToConfig(name, mcpServer);
	}

	public async deleteMCPServer(name: string): Promise<void> {
		const agentsConfig = await this._agentsConfig.loadProjectConfig();
		if (!agentsConfig?.mcp?.[name]) {
			this._postMessage({ type: 'mcpServerDeleted', data: { name } });
			return;
		}

		await this._deleteMCPServerFromConfig(name);
	}

	public async checkAgentsConfig(): Promise<void> {
		const hasProject = await this._agentsConfig.hasProjectConfig();
		this._postMessage({
			type: 'mcpConfigStatus',
			data: {
				hasProjectConfig: hasProject,
				projectPath: this._agentsConfig.getProjectMcpConfigPath(),
			},
		});
	}

	public async openMcpConfig(): Promise<void> {
		try {
			const configPath = await this._agentsConfig.ensureProjectConfig();
			if (configPath) {
				const uri = vscode.Uri.file(configPath);
				await vscode.window.showTextDocument(uri);
			}
		} catch (error) {
			logger.error('[McpManagementService] Failed to open opencode.json:', error);
		}
	}

	public async saveMCPServerToConfig(name: string, server: McpServer): Promise<void> {
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

	private async _deleteMCPServerFromConfig(name: string): Promise<void> {
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

	private _getMcpStatusCache(): McpStatusCache | undefined {
		return this._context.globalState.get<McpStatusCache>(MCP_STATUS_CACHE_KEY);
	}

	private async _setMcpStatusCache(status: McpStatusCache): Promise<void> {
		const existing = this._getMcpStatusCache() || {};
		const merged = { ...existing, ...status };
		await this._context.globalState.update(MCP_STATUS_CACHE_KEY, merged);
	}

	private async _pingSingleServer(name: string, server: McpServer): Promise<void> {
		if (server.enabled === false) return;

		try {
			const config = mcpServerToConfig(server);
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
	// Metadata
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
