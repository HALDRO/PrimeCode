/**
 * @file Settings
 * @description Unified settings manager for PrimeCode.
 * Combines agents config + MCP config + VS Code settings.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface PrimeCodeSettings {
	provider: 'opencode';
	model?: string;
	autoApprove: boolean;
	yoloMode: boolean;
	'access.autoApprove': boolean;
	'access.yoloMode': boolean;
	mcpServers: Record<string, unknown>;

	'proxy.baseUrl': string;
	'proxy.apiKey': string;
	'proxy.enabledModels': string[];
	'proxy.useSingleModel'?: boolean;
	'proxy.haikuModel'?: string;
	'proxy.sonnetModel'?: string;
	'proxy.opusModel'?: string;
	'proxy.subagentModel'?: string;

	'opencode.autoStart'?: boolean;
	'opencode.serverTimeout'?: number;
	'opencode.serverUrl'?: string;
	'opencode.agent'?: string;
	'opencode.enabledModels': string[];

	'providers.disabled': string[];

	'promptImprove.model'?: string;
	'promptImprove.template'?: string;
}

interface AgentsConfig {
	commands: unknown[];
	skills: unknown[];
	subagents: unknown[];
	rules: unknown[];
}

interface McpConfig {
	mcpServers: Record<string, unknown>;
}

// =============================================================================
// Settings Manager Interface
// =============================================================================

export interface ISettings {
	get<T>(key: keyof PrimeCodeSettings): T | undefined;
	set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void>;
	update<T>(key: keyof PrimeCodeSettings, value: T): Promise<void>;
	getAll(): PrimeCodeSettings;
	refresh(): void;
	getWorkspaceRoot(): string | undefined;
}

// =============================================================================
// Settings Manager Implementation
// =============================================================================

export class Settings implements ISettings {
	private config: vscode.WorkspaceConfiguration;
	private workspaceRoot: string | undefined;

	constructor() {
		this.config = vscode.workspace.getConfiguration('primeCode');
		this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// =============================================================================
	// VS Code Settings
	// =============================================================================

	get<T>(key: keyof PrimeCodeSettings): T | undefined {
		return this.config.get<T>(key);
	}

	async update<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		// Always write to Global settings to avoid polluting project-specific .vscode/settings.json
		await this.config.update(key, value, vscode.ConfigurationTarget.Global);
		// Refresh cached config to reflect the update immediately
		this.config = vscode.workspace.getConfiguration('primeCode');
	}

	async set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		await this.update(key, value);
	}

	getAll(): PrimeCodeSettings {
		return {
			provider: 'opencode',
			model: this.get('model'),
			autoApprove: this.get('access.autoApprove') || this.get('autoApprove') || false,
			yoloMode: this.get('access.yoloMode') || this.get('yoloMode') || false,
			'access.autoApprove': this.get('access.autoApprove') || false,
			'access.yoloMode': this.get('access.yoloMode') || false,
			mcpServers: this.get('mcpServers') || {},

			'proxy.baseUrl': this.get('proxy.baseUrl') || 'http://localhost:11434',
			'proxy.apiKey': this.get('proxy.apiKey') || '',
			'proxy.enabledModels': this.get('proxy.enabledModels') || [],
			'proxy.useSingleModel': this.get('proxy.useSingleModel'),
			'proxy.haikuModel': this.get('proxy.haikuModel'),
			'proxy.sonnetModel': this.get('proxy.sonnetModel'),
			'proxy.opusModel': this.get('proxy.opusModel'),
			'proxy.subagentModel': this.get('proxy.subagentModel'),

			'opencode.autoStart': this.get('opencode.autoStart'),
			'opencode.serverTimeout': this.get('opencode.serverTimeout'),
			'opencode.serverUrl': this.get('opencode.serverUrl'),
			'opencode.agent': this.get('opencode.agent'),
			'opencode.enabledModels': this.get('opencode.enabledModels') || [],

			'providers.disabled': this.get('providers.disabled') || [],

			'promptImprove.model': this.get('promptImprove.model'),
			'promptImprove.template': this.get('promptImprove.template'),
		};
	}

	// =============================================================================
	// Agents Config (.opencode/config.json)
	// =============================================================================

	getAgentsConfigPath(): string {
		if (!this.workspaceRoot) {
			throw new Error('No workspace root');
		}
		return path.join(this.workspaceRoot, '.agents', 'config.json');
	}

	async getAgentsConfig(): Promise<AgentsConfig> {
		const configPath = this.getAgentsConfigPath();

		if (!fs.existsSync(configPath)) {
			return { commands: [], skills: [], subagents: [], rules: [] };
		}

		try {
			const content = await fs.promises.readFile(configPath, 'utf-8');
			return JSON.parse(content);
		} catch (error) {
			logger.error('[Settings] Failed to read agents config:', error);
			return { commands: [], skills: [], subagents: [], rules: [] };
		}
	}

	async saveAgentsConfig(config: AgentsConfig): Promise<void> {
		const configPath = this.getAgentsConfigPath();

		try {
			await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
			await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
		} catch (error) {
			logger.error('[Settings] Failed to save agents config:', error);
			throw error;
		}
	}

	// =============================================================================
	// MCP Config (.mcp.json or .opencode/mcp.json)
	// =============================================================================

	getMcpConfigPath(): string {
		if (!this.workspaceRoot) {
			throw new Error('No workspace root');
		}

		return path.join(this.workspaceRoot, '.opencode', 'mcp.json');
	}

	async getMcpConfig(): Promise<McpConfig> {
		const configPath = this.getMcpConfigPath();

		if (!fs.existsSync(configPath)) {
			return { mcpServers: {} };
		}

		try {
			const content = await fs.promises.readFile(configPath, 'utf-8');
			return JSON.parse(content);
		} catch (error) {
			logger.error('[Settings] Failed to read MCP config:', error);
			return { mcpServers: {} };
		}
	}

	async saveMcpConfig(config: McpConfig): Promise<void> {
		const configPath = this.getMcpConfigPath();

		try {
			await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
			await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2));
		} catch (error) {
			logger.error('[Settings] Failed to save MCP config:', error);
			throw error;
		}
	}

	// =============================================================================
	// Watch for Changes
	// =============================================================================

	watch(callback: () => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('primeCode')) {
				callback();
			}
		});
	}

	// =============================================================================
	// Helpers
	// =============================================================================

	getWorkspaceRoot(): string | undefined {
		return this.workspaceRoot;
	}

	refresh(): void {
		this.config = vscode.workspace.getConfiguration('primeCode');
		this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}
}
