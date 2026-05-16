import * as vscode from 'vscode';
import { McpConfigService } from '../services/McpConfigService';
import { McpConfigWatcherService } from '../services/McpConfigWatcherService';
import { ModelsDevService } from '../services/ModelsDevService';
import { McpManagementService } from '../services/mcp/McpManagementService';
import { OpenCodeClientService } from '../services/OpenCodeClientService';
import { AgentResourceService } from '../services/opencode/AgentResourceService';
import { OpenCodeConfigService } from '../services/opencode/OpenCodeConfigService';
import { ResourceService } from '../services/ResourceService';
import { ResourceWatcherService } from '../services/ResourceWatcherService';
import { RulesService } from '../services/RulesService';
import { normalizeDriveLetter } from '../utils/path';

export class ServiceRegistry implements vscode.Disposable {
	public readonly resources: ResourceService;
	public readonly resourceWatcher: ResourceWatcherService;
	public readonly mcpConfig: McpConfigService;
	public readonly mcpConfigWatcher: McpConfigWatcherService;
	public readonly mcpManagement: McpManagementService;
	public readonly openCodeClient: OpenCodeClientService;
	public readonly openCodeConfig: OpenCodeConfigService;
	public readonly agentResources: AgentResourceService;
	public readonly modelsDev: ModelsDevService;
	public rules: RulesService | null = null; // RulesService depends on workspace root

	private disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext) {
		this.resources = new ResourceService();
		this.resourceWatcher = new ResourceWatcherService();
		this.mcpConfig = new McpConfigService();
		this.openCodeConfig = new OpenCodeConfigService();
		this.mcpConfigWatcher = new McpConfigWatcherService();
		this.agentResources = new AgentResourceService(this.resources, this.openCodeConfig);

		this.openCodeClient = new OpenCodeClientService();
		this.modelsDev = new ModelsDevService();

		this.mcpManagement = new McpManagementService(
			context,
			msg => this._onMcpMessage.fire(msg),
			this.mcpConfig,
			this.openCodeConfig,
		);

		// Connect UI-save suppression: when McpManagement writes config,
		// notify the watcher so it doesn't trigger a redundant reload.
		this.mcpManagement.setOnConfigSaved(contentHash => {
			this.mcpConfigWatcher.notifyUiSave(contentHash);
		});

		// Initialize workspace-scoped services if workspace is already open
		const rawRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const workspaceRoot = rawRoot ? normalizeDriveLetter(rawRoot) : undefined;
		if (workspaceRoot) {
			this.setWorkspaceRoot(workspaceRoot);
		}

		this.disposables.push(this.mcpConfigWatcher, this.resourceWatcher);
	}

	private _onMcpMessage = new vscode.EventEmitter<unknown>();
	public readonly onMcpMessage = this._onMcpMessage.event;

	public setWorkspaceRoot(root: string) {
		this.resources.setWorkspaceRoot(root);
		this.openCodeConfig.setWorkspaceRoot(root);
		this.rules = new RulesService(root);
		this.openCodeClient.setWorkspaceRoot?.(root);
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
