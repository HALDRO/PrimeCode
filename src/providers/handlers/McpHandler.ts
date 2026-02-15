import type * as vscode from 'vscode';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class McpHandler implements WebviewMessageHandler {
	private disposables: vscode.Disposable[] = [];

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewCommand): Promise<void> {
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
			case 'openMcpConfig':
				await this.onOpenMcpConfig();
				break;
		}
	}

	private async onLoadMcpServers(): Promise<void> {
		await this.context.services.mcpManagement.loadMCPServers();
		await this.context.services.mcpManagement.pingMcpServers();
	}

	private async onFetchMcpMarketplaceCatalog(
		msg: CommandOf<'fetchMcpMarketplaceCatalog'>,
	): Promise<void> {
		await this.context.services.mcpManagement.fetchMcpMarketplaceCatalog(msg.forceRefresh);
	}

	private async onInstallMcpFromMarketplace(
		msg: CommandOf<'installMcpFromMarketplace'>,
	): Promise<void> {
		await this.context.services.mcpManagement.installMcpFromMarketplace(msg.mcpId);
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
