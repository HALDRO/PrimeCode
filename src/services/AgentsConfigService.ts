/**
 * @file AgentsConfigService
 * @description Manages project-level `.agents/` configuration for MCP servers.
 *              Reads/writes `.agents/mcp.json` from the workspace root and provides
 *              conversion utilities to a unified MCP registry format used by the extension.
 *              Emits change events when project config is saved through this service.
 *              Includes runtime schema validation for config files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import { PATHS } from '../shared/constants';
import {
	type AgentsMcpConfig,
	AgentsMcpConfigSchema,
	type AgentsMcpServer,
	type UnifiedMcpRegistry,
	type UnifiedMcpServer,
} from '../types';
import { logger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

const MCP_CONFIG_FILE = 'mcp.json';
const SCHEMA_URL = 'https://agents.dev/schemas/mcp.json';
const CONFIG_VERSION = 1;

// =============================================================================
// Conversion Utilities
// =============================================================================

/**
 * Convert AgentsMcpServer to UnifiedMcpServer format
 */
export function agentsServerToUnified(server: AgentsMcpServer): UnifiedMcpServer {
	if (server.type === 'stdio' && server.command) {
		return {
			enabled: server.enabled ?? true,
			timeoutMs: server.timeout,
			transport: {
				type: 'stdio',
				command: server.command,
				env: server.env,
				cwd: server.cwd,
			},
		};
	}

	if ((server.type === 'http' || server.type === 'sse') && server.url) {
		return {
			enabled: server.enabled ?? true,
			timeoutMs: server.timeout,
			transport: {
				type: server.type,
				url: server.url,
				headers: server.headers,
			},
		};
	}

	// Fallback for malformed config
	return {
		enabled: false,
		transport: { type: 'stdio', command: ['echo', 'invalid'] },
	};
}

/**
 * Convert UnifiedMcpServer to AgentsMcpServer format
 */
export function unifiedServerToAgents(server: UnifiedMcpServer): AgentsMcpServer {
	const transport = server.transport;

	if (transport.type === 'stdio') {
		return {
			type: 'stdio',
			command: transport.command,
			env: transport.env,
			cwd: transport.cwd,
			enabled: server.enabled,
			timeout: server.timeoutMs,
		};
	}

	return {
		type: transport.type,
		url: transport.url,
		headers: transport.headers,
		enabled: server.enabled,
		timeout: server.timeoutMs,
	};
}

/**
 * Convert AgentsMcpServer to MCPServerConfig format (for webview/ping)
 */
export function agentsServerToMcpConfig(
	server: AgentsMcpServer,
): import('../types').MCPServerConfig | null {
	if (server.type === 'stdio' && server.command) {
		const [command, ...args] = server.command;
		return {
			type: 'stdio',
			command,
			args,
			env: server.env,
			cwd: server.cwd,
			enabled: server.enabled,
			timeoutMs: server.timeout,
		};
	}

	if ((server.type === 'http' || server.type === 'sse') && server.url) {
		return {
			type: server.type,
			url: server.url,
			headers: server.headers,
			enabled: server.enabled,
			timeoutMs: server.timeout,
		};
	}

	return null;
}

/**
 * Convert record of AgentsMcpServer to MCPServersMap
 */
export function agentsServersToMcpConfigMap(
	servers: Record<string, AgentsMcpServer>,
): Record<string, import('../types').MCPServerConfig> {
	const result: Record<string, import('../types').MCPServerConfig> = {};
	for (const [name, server] of Object.entries(servers)) {
		const config = agentsServerToMcpConfig(server);
		if (config) {
			result[name] = config;
		}
	}
	return result;
}

/**
 * Convert full AgentsMcpConfig to UnifiedMcpRegistry
 */
export function agentsConfigToUnifiedRegistry(config: AgentsMcpConfig): UnifiedMcpRegistry {
	const registry: UnifiedMcpRegistry = {};
	for (const [name, server] of Object.entries(config.servers)) {
		registry[name] = agentsServerToUnified(server);
	}
	return registry;
}

/**
 * Convert UnifiedMcpRegistry to AgentsMcpConfig
 */
export function unifiedRegistryToAgentsConfig(registry: UnifiedMcpRegistry): AgentsMcpConfig {
	const servers: Record<string, AgentsMcpServer> = {};
	for (const [name, server] of Object.entries(registry)) {
		servers[name] = unifiedServerToAgents(server);
	}
	return {
		$schema: SCHEMA_URL,
		version: CONFIG_VERSION,
		servers,
	};
}

// =============================================================================
// AgentsConfigService Class
// =============================================================================

export class AgentsConfigService {
	private _workspaceRoot: string | undefined;
	private _onConfigChanged = new vscode.EventEmitter<AgentsMcpConfig>();

	public readonly onConfigChanged = this._onConfigChanged.event;

	constructor() {
		this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// =========================================================================
	// Path Helpers
	// =========================================================================

	/**
	 * Get path to project-level .agents directory
	 */
	public getProjectAgentsDir(): string | undefined {
		if (!this._workspaceRoot) return undefined;
		return path.join(this._workspaceRoot, PATHS.AGENTS_DIR);
	}

	/**
	 * Get path to project-level mcp.json
	 */
	public getProjectMcpConfigPath(): string | undefined {
		const agentsDir = this.getProjectAgentsDir();
		if (!agentsDir) return undefined;
		return path.join(agentsDir, MCP_CONFIG_FILE);
	}

	// =========================================================================
	// File Operations
	// =========================================================================

	/**
	 * Ensure .agents directory exists
	 */
	private async _ensureDir(dirPath: string): Promise<void> {
		try {
			await fs.mkdir(dirPath, { recursive: true });
		} catch (error) {
			logger.error(`[AgentsConfigService] Failed to create directory ${dirPath}:`, error);
		}
	}

	/**
	 * Read JSON file safely with optional schema validation
	 */
	// biome-ignore lint/suspicious/noExplicitAny: TSchema import issues
	private async _readJsonFile<T>(filePath: string, schema?: any): Promise<T | null> {
		try {
			const content = await fs.readFile(filePath, 'utf8');
			const data = JSON.parse(content);

			// Runtime validation if schema is provided
			if (schema && !Value.Check(schema as TSchema, data)) {
				logger.error(`[AgentsConfigService] Config validation failed for ${filePath}`);
				const errors = [...Value.Errors(schema, data)];
				for (const error of errors) {
					logger.debug(`[AgentsConfigService] Validation error at ${error.path}: ${error.message}`);
				}
				// Return null if validation fails to prevent using corrupted config
				return null;
			}

			return data as T;
		} catch (error) {
			// Don't log error for missing file (common case)
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn(`[AgentsConfigService] Failed to read/parse ${filePath}:`, error);
			}
			return null;
		}
	}

	/**
	 * Write JSON file with pretty formatting (atomic write handled by caller or simple write here)
	 * Note: AgentsSyncService handles atomic writes for its operations. here we use simple write
	 * but we could upgrade to atomic if concurrent writes become an issue.
	 */
	private async _writeJsonFile(filePath: string, data: unknown): Promise<void> {
		const dir = path.dirname(filePath);
		await this._ensureDir(dir);
		await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
	}

	/**
	 * Check if file exists
	 */
	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Config Operations
	// =========================================================================

	/**
	 * Load project-level MCP config from .agents/mcp.json
	 */
	public async loadProjectConfig(): Promise<AgentsMcpConfig | null> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return null;
		return this._readJsonFile<AgentsMcpConfig>(configPath, AgentsMcpConfigSchema);
	}

	/**
	 * Save project-level MCP config to .agents/mcp.json
	 */
	public async saveProjectConfig(config: AgentsMcpConfig): Promise<void> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) {
			logger.warn('[AgentsConfigService] No workspace root, cannot save project config');
			return;
		}

		config.$schema = SCHEMA_URL;
		config.version = CONFIG_VERSION;

		await this._writeJsonFile(configPath, config);
		this._onConfigChanged.fire(config);
		logger.info('[AgentsConfigService] Saved project MCP config');
	}

	/**
	 * Add or update a server in project config
	 */
	public async saveServer(name: string, server: AgentsMcpServer): Promise<void> {
		const config = (await this.loadProjectConfig()) ?? {
			$schema: SCHEMA_URL,
			version: CONFIG_VERSION,
			servers: {},
		};

		config.servers[name] = server;
		await this.saveProjectConfig(config);
	}

	/**
	 * Delete a server from project config
	 */
	public async deleteServer(name: string): Promise<void> {
		const config = await this.loadProjectConfig();
		if (!config) return;

		delete config.servers[name];
		await this.saveProjectConfig(config);
	}

	/**
	 * Check if .agents/mcp.json exists in project
	 */
	public async hasProjectConfig(): Promise<boolean> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return false;
		return this._fileExists(configPath);
	}

	/**
	 * Ensure .agents/mcp.json exists, creating with default template if needed
	 * Returns the path to the config file
	 */
	public async ensureProjectConfig(): Promise<string | undefined> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return undefined;

		const exists = await this._fileExists(configPath);
		if (!exists) {
			// Create default config with helpful comments
			const defaultConfig: AgentsMcpConfig = {
				$schema: 'https://agents.dev/schemas/mcp.json',
				version: 1,
				servers: {},
			};
			await this.saveProjectConfig(defaultConfig);
		}

		return configPath;
	}

	// =========================================================================
	// Unified Registry Conversion
	// =========================================================================

	/**
	 * Load config as UnifiedMcpRegistry (for compatibility with existing code)
	 */
	public async loadAsUnifiedRegistry(): Promise<UnifiedMcpRegistry> {
		const config = await this.loadProjectConfig();
		if (!config) return {};
		return agentsConfigToUnifiedRegistry(config);
	}

	/**
	 * Save UnifiedMcpRegistry as .agents/mcp.json
	 */
	public async saveFromUnifiedRegistry(registry: UnifiedMcpRegistry): Promise<void> {
		const config = unifiedRegistryToAgentsConfig(registry);
		await this.saveProjectConfig(config);
	}
}
