import type * as vscode from 'vscode';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class McpHandler implements WebviewMessageHandler {
	private disposables: vscode.Disposable[] = [];

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'loadMCPServers':
				await this.onLoadMcpServers();
				break;
			case 'fetchMcpMarketplaceCatalog':
				await this.onFetchMcpMarketplaceCatalog(msg);
				break;
			case 'installMcpFromMarketplace':
				await this.onInstallMcpFromMarketplace(msg);
				break;
			case 'saveMCPServer':
				await this.onSaveMcpServer(msg);
				break;
			case 'deleteMCPServer':
				await this.onDeleteMcpServer(msg);
				break;
			case 'openAgentsMcpConfig':
				await this.onOpenAgentsMcpConfig();
				break;
			case 'importMcpFromCLI':
				await this.onImportMcpFromCli();
				break;
			case 'syncAgentsToClaudeProject':
				await this.onSyncAgentsToProject('claude');
				break;
			case 'syncAgentsToOpenCodeProject':
				await this.onSyncAgentsToProject('opencode');
				break;
		}
	}

	private async onLoadMcpServers(): Promise<void> {
		await this.context.services.mcpManagement.loadMCPServers();
		await this.context.services.mcpManagement.pingMcpServers();
	}

	private async onFetchMcpMarketplaceCatalog(msg: WebviewMessage): Promise<void> {
		const forceRefresh = Boolean(
			(msg.data as { forceRefresh?: boolean } | undefined)?.forceRefresh,
		);
		await this.context.services.mcpManagement.fetchMcpMarketplaceCatalog(forceRefresh);
	}

	private async onInstallMcpFromMarketplace(msg: WebviewMessage): Promise<void> {
		const mcpId = typeof msg.mcpId === 'string' ? msg.mcpId : undefined;
		if (!mcpId) throw new Error('Missing mcpId');
		await this.context.services.mcpManagement.installMcpFromMarketplace(mcpId);
	}

	private async onSaveMcpServer(msg: WebviewMessage): Promise<void> {
		const name = typeof msg.name === 'string' ? msg.name : undefined;
		const config = msg.config as import('../../common').MCPServerConfig | undefined;
		if (!name || !config) throw new Error('Missing MCP server name/config');
		await this.context.services.mcpManagement.saveMCPServer(name, config);
	}

	private async onDeleteMcpServer(msg: WebviewMessage): Promise<void> {
		const name = typeof msg.name === 'string' ? msg.name : undefined;
		if (!name) throw new Error('Missing MCP server name');
		await this.context.services.mcpManagement.deleteMCPServer(name);
	}

	private async onOpenAgentsMcpConfig(): Promise<void> {
		await this.context.services.mcpManagement.openAgentsMcpConfig();
	}

	private async onImportMcpFromCli(): Promise<void> {
		await this.context.services.mcpManagement.importFromAllSources();
	}

	private async onSyncAgentsToProject(target: 'claude' | 'opencode'): Promise<void> {
		await this.context.services.mcpManagement.syncAgentsToProject(target);
	}

	dispose() {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
