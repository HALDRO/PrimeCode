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
				await this.onLoadMcpServers();
				break;
			case 'saveMCPServer':
				await this.onSaveMcpServer(msg);
				break;
			case 'deleteMCPServer':
				await this.onDeleteMcpServer(msg);
				break;
			case 'openMcpConfig':
				await this.onOpenMcpConfig();
				break;
		}
	}

	private async onLoadMcpServers(): Promise<void> {
		// 1. Load servers from opencode.json config
		await this.context.services.mcpManagement.loadMCPServers();

		// 2. Fetch real MCP status from OpenCode REST API (primary source of truth)
		//    This reflects the actual runtime state of MCP servers managed by OpenCode.
		await this.fetchOpenCodeMcpStatus();

		// 3. Also do independent pings as fallback (for servers not yet known to OpenCode)
		this.context.services.mcpManagement.pingMcpServers().catch(err => {
			logger.debug('[McpHandler] Background ping failed:', err);
		});
	}

	/**
	 * Fetch MCP status from the OpenCode REST API and post it to the webview.
	 * The API returns `Record<string, { status, error? }>` for each configured server.
	 * This is the authoritative source — OpenCode manages the actual MCP connections.
	 */
	private async fetchOpenCodeMcpStatus(): Promise<void> {
		try {
			const cli = this.context.cli;
			const directory =
				(cli as unknown as { directory?: string }).directory ||
				this.context.settings.getWorkspaceRoot();

			if (!directory) return;

			const mcpData = await cli.getMcpStatus(directory);
			if (!mcpData || typeof mcpData !== 'object') return;

			// Convert OpenCode MCP status format to our protocol format.
			// OpenCode returns: Record<string, { status: "connected"|"disabled"|"failed"|"needs_auth"|"needs_client_registration", error?: string }>
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

				// Also build mcpStatus for the settings panel
				mcpStatusForUI[name] = { status, error };
			}

			// Post both message types so both settings panel and chat can use the data
			this.context.bridge.data('opencodeMcpStatus', opencodeMcpStatus);
			this.context.bridge.data('mcpStatus', mcpStatusForUI);
		} catch (err) {
			logger.debug('[McpHandler] Failed to fetch OpenCode MCP status:', err);
		}
	}

	private async onSaveMcpServer(msg: CommandOf<'saveMCPServer'>): Promise<void> {
		await this.context.services.mcpManagement.saveMCPServer(msg.name, msg.config);
	}

	private async onDeleteMcpServer(msg: CommandOf<'deleteMCPServer'>): Promise<void> {
		await this.context.services.mcpManagement.deleteMCPServer(msg.name);
	}

	private async onOpenMcpConfig(): Promise<void> {
		await this.context.services.mcpManagement.openMcpConfig();
	}

	dispose() {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
