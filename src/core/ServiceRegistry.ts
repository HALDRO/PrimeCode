import * as vscode from 'vscode';
import { McpConfigService } from '../services/McpConfigService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { ModelsDevService } from '../services/ModelsDevService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { OpenCodeClientService } from '../services/OpenCodeClientService';
import { ResourceService } from '../services/ResourceService';
import { ResourceWatcherService } from '../services/ResourceWatcherService';
import { RulesService } from '../services/RulesService';

export class ServiceRegistry implements vscode.Disposable {
	public readonly resources: ResourceService;
	public readonly resourceWatcher: ResourceWatcherService;
	public readonly mcpConfig: McpConfigService;
	public readonly mcpConfigWatcher: McpConfigWatcherService;
	public readonly mcpManagement: McpManagementService;
	public readonly openCodeClient: OpenCodeClientService;
	public readonly modelsDev: ModelsDevService;
	public rules: RulesService | null = null; // RulesService depends on workspace root

	private disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.resources = new ResourceService();
		this.resourceWatcher = new ResourceWatcherService(this.resources);
		this.mcpConfig = new McpConfigService();

		this.mcpConfigWatcher = new McpConfigWatcherService(this.mcpConfig);

		this.openCodeClient = new OpenCodeClientService();
		this.modelsDev = new ModelsDevService();

		this.mcpManagement = new McpManagementService(
			context,
			msg => this._onMcpMessage.fire(msg),
			this.mcpConfig,
		);

		// Initialize workspace-scoped services if workspace is already open
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			this.setWorkspaceRoot(workspaceRoot);
		}

		// Start watchers
		this.mcpConfigWatcher.start();
		this.resourceWatcher.start();
		this.disposables.push(this.mcpConfigWatcher, this.resourceWatcher);
	}

	private _onMcpMessage = new vscode.EventEmitter<unknown>();
	public readonly onMcpMessage = this._onMcpMessage.event;

	public setWorkspaceRoot(root: string) {
		this.resources.setWorkspaceRoot(root);
		this.rules = new RulesService(root);

		// Restart watchers if they weren't started (workspace was missing at init)
		this.mcpConfigWatcher.start();
		this.resourceWatcher.start();
	}

	dispose() {
		this._onMcpMessage.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		// Dispose services that may hold connections or timers
		if ('dispose' in this.mcpManagement && typeof this.mcpManagement.dispose === 'function') {
			this.mcpManagement.dispose();
		}
	}
}
