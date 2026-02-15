import * as vscode from 'vscode';
import { AgentResourceService } from '../services/AgentResourceService';
import { AgentsConfigService } from '../services/AgentsConfigService';
import { AgentsSyncService } from '../services/AgentsSyncService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { McpMarketplaceService } from '../services/mcp/McpMarketplaceService';
import { McpMetadataService } from '../services/mcp/McpMetadataService';
import { OpenCodeClientService } from '../services/OpenCodeClientService';
import { RulesService } from '../services/RulesService';

export class ServiceRegistry implements vscode.Disposable {
	public readonly agentResources: AgentResourceService;
	public readonly agentsConfig: AgentsConfigService;
	public readonly agentsSync: AgentsSyncService;
	public readonly mcpConfigWatcher: McpConfigWatcherService;
	public readonly mcpManagement: McpManagementService;
	public readonly mcpMarketplace: McpMarketplaceService;
	public readonly mcpMetadata: McpMetadataService;
	public readonly openCodeClient: OpenCodeClientService;
	public rules: RulesService | null = null; // RulesService depends on workspace root

	private disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.agentResources = new AgentResourceService();
		this.agentsConfig = new AgentsConfigService();

		this.agentsSync = new AgentsSyncService(this.agentsConfig);
		this.mcpConfigWatcher = new McpConfigWatcherService(this.agentsConfig, this.agentsSync);

		this.mcpMarketplace = new McpMarketplaceService(context);
		this.mcpMetadata = new McpMetadataService(context);

		// McpManagementService requires a callback to post messages to the view.
		// Since we want to decouple services from the view, we can use an event emitter here
		// or pass a dummy callback that gets updated later.
		// For now, we'll keep the view-dependency out of the registry construction if possible,
		// but McpManagementService seems designed to talk to UI.
		// Let's defer McpManagementService initialization or refactor it to use events?
		// Refactoring McpManagementService is risky.
		// Alternative: Pass a delegate that we can wire up later.

		this.openCodeClient = new OpenCodeClientService();

		// Handle McpManagementService specially:
		// It takes (context, marketplace, metadata, postMessage).
		// We'll create it here with a stub for postMessage, and handlers will wire it up.
		this.mcpManagement = new McpManagementService(
			context,
			this.mcpMarketplace,
			this.mcpMetadata,
			msg => this._onMcpMessage.fire(msg),
			this.agentsConfig,
			this.agentsSync,
		);

		// Initialize workspace-scoped services if workspace is already open
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			this.setWorkspaceRoot(workspaceRoot);
		}

		// Start watchers
		this.mcpConfigWatcher.start();
		this.disposables.push(this.mcpConfigWatcher);
	}

	private _onMcpMessage = new vscode.EventEmitter<unknown>();
	public readonly onMcpMessage = this._onMcpMessage.event;

	public setWorkspaceRoot(root: string) {
		this.agentResources.setWorkspaceRoot(root);
		this.rules = new RulesService(root);

		// Restart MCP config watcher if it wasn't started (workspace was missing at init)
		this.mcpConfigWatcher.start();
	}

	dispose() {
		this._onMcpMessage.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
