import type * as vscode from 'vscode';
import type { CommandOf, OpenCodeMcpStatus, WebviewCommand } from '../../common/protocol';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class McpHandler implements WebviewMessageHandler {
	private disposables: vscode.Disposable[] = [];

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'loadMCPServers':
				logger.info('[McpHandler] User loaded MCP servers');
				await this.onLoadMcpServers();
				break;
			case 'saveMCPServer':
				logger.info('[McpHandler] User saved MCP server', { name: msg.name });
				await this.onSaveMcpServer(msg);
				break;
			case 'setMCPServerEnabled':
				logger.info('[McpHandler] User toggled MCP server', {
					name: msg.name,
					enabled: msg.enabled,
				});
				await this.onSetMcpServerEnabled(msg);
				break;
			case 'deleteMCPServer':
				logger.info('[McpHandler] User deleted MCP server', { name: msg.name });
				await this.onDeleteMcpServer(msg);
				break;
			case 'openMcpConfig':
				logger.info('[McpHandler] User opened MCP config');
				await this.onOpenMcpConfig(msg);
				break;
		}
	}

	private async onLoadMcpServers(): Promise<void> {
		// 1. Load servers from opencode.json config (for UI display)
		await this.context.services.mcpManagement.loadMCPServers();

		// 2. Fetch real MCP status + tools/resources from OpenCode REST API (primary source of truth)
		//    This reflects the actual runtime state of MCP servers managed by OpenCode.
		await this.fetchOpenCodeMcpStatus();
	}

	/**
	 * Fetch MCP status from the OpenCode REST API and post it to the webview.
	 * The API returns `Record<string, { status, error? }>` for each configured server.
	 * Additionally fetches MCP resources from the experimental API to provide
	 * tools/resources data without creating duplicate MCP connections.
	 */
	private async fetchOpenCodeMcpStatus(): Promise<void> {
		try {
			const cli = this.context.cli;
			const admin = cli.getAdminInfo();
			const directory =
				(cli as unknown as { directory?: string }).directory ||
				this.context.settings.getWorkspaceRoot();

			if (!directory || !admin?.baseUrl) return;

			const mcpData = await cli.getMcpStatus(directory);
			if (!mcpData || typeof mcpData !== 'object') return;

			// Fetch MCP resources from experimental API (tools are namespaced as "server:tool")
			const mcpResources = await this.fetchMcpResources(admin.baseUrl, directory);
			const mcpToolIds = await this.fetchMcpToolIds(admin.baseUrl, directory);

			// Group tools by server name (format: "servername_toolname")
			const toolsByServer = new Map<string, Array<{ name: string; description?: string }>>();
			for (const toolId of mcpToolIds) {
				const underscoreIdx = toolId.indexOf('_');
				if (underscoreIdx < 0) continue;
				const serverName = toolId.slice(0, underscoreIdx);
				const toolName = toolId.slice(underscoreIdx + 1);
				if (!toolsByServer.has(serverName)) {
					toolsByServer.set(serverName, []);
				}
				toolsByServer.get(serverName)?.push({ name: toolName });
			}

			// Group resources by client name
			const resourcesByServer = new Map<
				string,
				Array<{ uri: string; name: string; description?: string }>
			>();
			for (const resource of mcpResources) {
				const client = resource.client;
				if (!client) continue;
				if (!resourcesByServer.has(client)) {
					resourcesByServer.set(client, []);
				}
				resourcesByServer.get(client)?.push({
					uri: resource.uri,
					name: resource.name,
					description: resource.description,
				});
			}

			// Build combined status with tools and resources
			const opencodeMcpStatus: Record<string, OpenCodeMcpStatus> = {};
			const mcpStatusForUI: Record<
				string,
				{
					status: string;
					error?: string;
					tools?: Array<{ name: string; description?: string }>;
					resources?: Array<{ uri: string; name: string; description?: string }>;
				}
			> = {};

			for (const [name, value] of Object.entries(mcpData as Record<string, unknown>)) {
				if (!value || typeof value !== 'object') continue;
				const entry = value as Record<string, unknown>;
				const status = String(entry.status || 'failed');
				const error = entry.error ? String(entry.error) : undefined;

				// Build OpenCodeMcpStatus for the dedicated message
				if (status === 'connected') {
					opencodeMcpStatus[name] = { status: 'connected' };
				} else if (status === 'disabled') {
					opencodeMcpStatus[name] = { status: 'disabled' };
				} else if (status === 'needs_auth') {
					opencodeMcpStatus[name] = { status: 'needs_auth' };
				} else if (status === 'needs_client_registration') {
					opencodeMcpStatus[name] = { status: 'needs_client_registration', error: error || '' };
				} else {
					opencodeMcpStatus[name] = { status: 'failed', error: error || 'Unknown error' };
				}

				// Sanitize server name the same way OpenCode does (replace non-alphanumeric with _)
				const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_');

				// Build mcpStatus with tools/resources for the settings panel
				mcpStatusForUI[name] = {
					status,
					error,
					tools: toolsByServer.get(sanitizedName) ?? toolsByServer.get(name),
					resources: resourcesByServer.get(name),
				};
			}

			await this.context.services.mcpManagement.syncRuntimeServers(mcpStatusForUI);

			// Post both message types so both settings panel and chat can use the data
			this.context.bridge.data('opencodeMcpStatus', opencodeMcpStatus);
			this.context.bridge.data('mcpStatus', mcpStatusForUI);
		} catch (err) {
			logger.debug('[McpHandler] Failed to fetch OpenCode MCP status:', err);
		}
	}

	/**
	 * Fetch MCP tool IDs from the experimental API.
	 * Returns tool IDs in format "servername_toolname".
	 */
	private async fetchMcpToolIds(_baseUrl: string, directory: string): Promise<string[]> {
		try {
			const response = await this.context.cli.request?.(
				`/experimental/tool/ids?directory=${encodeURIComponent(directory)}`,
			);
			if (!response.ok) return [];
			const data = (await response.json()) as string[];
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	/**
	 * Fetch MCP resources from the experimental API.
	 * Returns resources with their owning client name.
	 */
	private async fetchMcpResources(
		_baseUrl: string,
		directory: string,
	): Promise<Array<{ name: string; uri: string; description?: string; client: string }>> {
		try {
			const response = await this.context.cli.request?.(
				`/experimental/resource?directory=${encodeURIComponent(directory)}`,
			);
			if (!response.ok) return [];
			const data = (await response.json()) as Record<
				string,
				{ name: string; uri: string; description?: string; client: string }
			>;
			if (!data || typeof data !== 'object') return [];
			return Object.values(data);
		} catch {
			return [];
		}
	}

	private async onSaveMcpServer(msg: CommandOf<'saveMCPServer'>): Promise<void> {
		await this.context.services.mcpManagement.saveMCPServer(msg.name, msg.config);
		// Hot-add the server to OpenCode runtime without full instance dispose
		await this.hotAddMcpServer(msg.name);
	}

	private async onSetMcpServerEnabled(msg: CommandOf<'setMCPServerEnabled'>): Promise<void> {
		try {
			const result = await this.context.services.openCodeConfig.patchProjectConfig(config => {
				const mcp = ensureRecord(config, 'mcp');
				const entry = ensureRecord(mcp, msg.name);
				entry.enabled = msg.enabled;
				return config;
			});
			this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
			this.context.cli.clearMcpCache?.();

			// Use targeted connect/disconnect instead of full instance dispose
			await this.toggleMcpServerConnection(msg.name, msg.enabled);
			await this.onLoadMcpServers();
		} catch (error) {
			this.context.bridge.data('mcpServerError', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Hot-add an MCP server to the OpenCode runtime via POST /mcp.
	 * This avoids a full instance dispose and only registers the new server.
	 */
	private async hotAddMcpServer(name: string): Promise<void> {
		const cli = this.context.cli;
		const admin = cli.getAdminInfo();
		if (!admin?.baseUrl || !admin.directory) return;

		// Read the server config from opencode.json to send to the runtime
		const agentsConfig = await this.context.services.mcpConfig.loadProjectConfig();
		const serverConfig = agentsConfig?.mcp?.[name];
		if (!serverConfig) return;

		try {
			const response = await this.context.cli.request?.('/mcp', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, config: serverConfig }),
			});
			if (!response.ok) {
				logger.warn('[McpHandler] POST /mcp failed', { name, status: response.status });
			}
		} catch (err) {
			logger.warn('[McpHandler] Failed to hot-add MCP server to runtime', { name, err });
		}
	}

	/**
	 * Connect or disconnect an MCP server in the OpenCode runtime
	 * via POST /mcp/:name/connect or POST /mcp/:name/disconnect.
	 */
	private async toggleMcpServerConnection(name: string, enabled: boolean): Promise<void> {
		const cli = this.context.cli;
		const admin = cli.getAdminInfo();
		if (!admin?.baseUrl || !admin.directory) return;

		const action = enabled ? 'connect' : 'disconnect';
		try {
			const response = await this.context.cli.request?.(
				`/mcp/${encodeURIComponent(name)}/${action}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
				},
			);
			if (!response.ok) {
				logger.warn(`[McpHandler] POST /mcp/${name}/${action} failed`, {
					status: response.status,
				});
			}
		} catch (err) {
			logger.warn(`[McpHandler] Failed to ${action} MCP server`, { name, err });
		}
	}

	private async onDeleteMcpServer(msg: CommandOf<'deleteMCPServer'>): Promise<void> {
		await this.context.services.mcpManagement.deleteMCPServer(msg.name);
	}

	private async onOpenMcpConfig(msg: CommandOf<'openMcpConfig'>): Promise<void> {
		await this.context.services.mcpManagement.openMcpConfig(msg.scope);
	}

	dispose() {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = parent[key];
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	const next: Record<string, unknown> = {};
	parent[key] = next;
	return next;
}
