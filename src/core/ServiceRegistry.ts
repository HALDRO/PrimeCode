import * as vscode from 'vscode';
import { AgentResourceService } from '../services/AgentResourceService';
import { AgentsConfigService } from '../services/AgentsConfigService';
import { AgentsSyncService } from '../services/AgentsSyncService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { OpenCodeClientService } from '../services/OpenCodeClientService';
import { RulesService } from '../services/RulesService';

export class ServiceRegistry implements vscode.Disposable {
	public readonly agentResources: AgentResourceService;
	public readonly agentsConfig: AgentsConfigService;
	public readonly agentsSync: AgentsSyncService;
	public readonly mcpConfigWatcher: McpConfigWatcherService;
	public readonly mcpManagement: McpManagementService;
	public readonly openCodeClient: OpenCodeClientService;
	public rules: RulesService | null = null; // RulesService depends on workspace root

	private disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.agentResources = new AgentResourceService();
		this.agentsConfig = new AgentsConfigService();

		this.agentsSync = new AgentsSyncService(this.agentsConfig);
		this.mcpConfigWatcher = new McpConfigWatcherService(this.agentsConfig, this.agentsSync);

		this.openCodeClient = new OpenCodeClientService();

		this.mcpManagement = new McpManagementService(
			context,
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
