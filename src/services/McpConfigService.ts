/**
 * @file McpConfigService
 * @description Manages project-level MCP server configuration.
 *              Reads/writes `opencode.json` from the workspace root.
 *              Emits change events when project config is saved through this service.
 *              Includes runtime schema validation for config files.
 */

import * as path from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import { type McpConfig, McpConfigSchema, type McpServer } from '../common';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';

// =============================================================================
// Constants
// =============================================================================

const MCP_CONFIG_FILE = PATHS.OPENCODE_CONFIG;

// =============================================================================
// Conversion Utilities
// =============================================================================

/**
 * Convert McpServer (disk format, OpenCode canonical) to MCPServerConfig (webview/ping format).
 */
export function mcpServerToConfig(server: McpServer): import('../common').MCPServerConfig | null {
	if (server.type === 'local' || (!server.type && server.command)) {
		if (!server.command || server.command.length === 0) return null;
		const [command, ...args] = server.command;
		return {
			type: 'local',
			command,
			args,
			env: server.environment,
			enabled: server.enabled,
			timeoutMs: server.timeout,
		};
	}

	if (server.type === 'remote' || (!server.type && server.url)) {
		if (!server.url) return null;
		return {
			type: 'remote',
			url: server.url,
			headers: server.headers,
			enabled: server.enabled,
			timeoutMs: server.timeout,
		};
	}

	// Override-only entry (just { enabled: boolean }) — pass through
	if (server.enabled !== undefined && !server.type && !server.command && !server.url) {
		return { enabled: server.enabled };
	}

	return null;
}

/**
 * Convert MCPServerConfig (webview/UI format) to McpServer (disk format, OpenCode canonical).
 */
export function configToMcpServer(config: import('../common').MCPServerConfig): McpServer | null {
	if (config.type === 'local' || (!config.type && config.command)) {
		if (!config.command) return null;
		return {
			type: 'local',
			command: [config.command, ...(config.args ?? [])],
			environment: config.env,
			enabled: config.enabled,
			timeout: config.timeoutMs,
		};
	}

	if (config.type === 'remote' || (!config.type && config.url)) {
		if (!config.url) return null;
		return {
			type: 'remote',
			url: config.url,
			headers: config.headers,
			enabled: config.enabled,
			timeout: config.timeoutMs,
		};
	}

	return null;
}

/**
 * Convert record of McpServer to MCPServersMap
 */
export function mcpServersToConfigMap(
	servers: Record<string, McpServer>,
): Record<string, import('../common').MCPServerConfig> {
	const result: Record<string, import('../common').MCPServerConfig> = {};
	for (const [name, server] of Object.entries(servers)) {
		const config = mcpServerToConfig(server);
		if (config) {
			result[name] = config;
		}
	}
	return result;
}

// =============================================================================
// McpConfigService Class
// =============================================================================

export class McpConfigService {
	private _workspaceRoot: string | undefined;
	private _onConfigChanged = new vscode.EventEmitter<McpConfig>();

	public readonly onConfigChanged = this._onConfigChanged.event;

	constructor() {
		this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// =========================================================================
	// Path Helpers
	// =========================================================================

	/**
	 * Get path to project-level .opencode directory
	 */
	public getProjectOpenCodeDir(): string | undefined {
		if (!this._workspaceRoot) return undefined;
		return path.join(this._workspaceRoot, PATHS.OPENCODE_DIR);
	}

	/**
	 * Get path to project-level opencode.json
	 */
	public getProjectMcpConfigPath(): string | undefined {
		if (!this._workspaceRoot) return undefined;
		return path.join(this._workspaceRoot, MCP_CONFIG_FILE);
	}

	// =========================================================================
	// File Operations
	// =========================================================================

	/**
	 * Ensure .opencode directory exists
	 */
	private async _ensureDir(dirPath: string): Promise<void> {
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirPath));
		} catch (error) {
			logger.error(`[McpConfigService] Failed to create directory ${dirPath}:`, error);
		}
	}

	/**
	 * Read JSON file safely with optional schema validation
	 */
	private async _readJsonFile<T>(filePath: string, schema?: TSchema): Promise<T | null> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			const data = JSON.parse(new TextDecoder().decode(bytes));

			// Runtime validation if schema is provided
			if (schema && !Value.Check(schema as TSchema, data)) {
				logger.error(`[McpConfigService] Config validation failed for ${filePath}`);
				const errors = [...Value.Errors(schema, data)];
				for (const error of errors) {
					logger.debug(`[McpConfigService] Validation error at ${error.path}: ${error.message}`);
				}
				return null;
			}

			return data as T;
		} catch (error) {
			if ((error as vscode.FileSystemError).code !== 'FileNotFound') {
				logger.warn(`[McpConfigService] Failed to read/parse ${filePath}:`, error);
			}
			return null;
		}
	}

	/**
	 * Write JSON file with atomic write pattern (tmp + rename).
	 * Prevents config corruption if the process crashes mid-write.
	 */
	private async _writeJsonFile(filePath: string, data: unknown): Promise<void> {
		const dir = path.dirname(filePath);
		await this._ensureDir(dir);
		const content = new TextEncoder().encode(JSON.stringify(data, null, 2));
		const targetUri = vscode.Uri.file(filePath);
		const tmpUri = vscode.Uri.file(`${filePath}.tmp`);
		try {
			await vscode.workspace.fs.writeFile(tmpUri, content);
			await vscode.workspace.fs.rename(tmpUri, targetUri, { overwrite: true });
		} catch (error) {
			// Cleanup tmp file on failure, fall back to direct write
			try {
				await vscode.workspace.fs.delete(tmpUri);
			} catch {
				/* tmp may not exist */
			}
			logger.warn('[McpConfigService] Atomic write failed, falling back to direct write:', error);
			await vscode.workspace.fs.writeFile(targetUri, content);
		}
	}

	/**
	 * Check if file exists
	 */
	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
			return true;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Config Operations
	// =========================================================================

	/**
	 * Load project-level MCP config from opencode.json
	 */
	public async loadProjectConfig(): Promise<McpConfig | null> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return null;
		return this._readJsonFile<McpConfig>(configPath, McpConfigSchema);
	}

	/**
	 * Save project-level MCP config to opencode.json
	 */
	public async saveProjectConfig(config: McpConfig): Promise<void> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) {
			logger.warn('[McpConfigService] No workspace root, cannot save project config');
			return;
		}

		await this._writeJsonFile(configPath, config);
		this._onConfigChanged.fire(config);
		logger.info('[McpConfigService] Saved project MCP config');
	}

	/**
	 * Add or update a server in project config.
	 * If the existing file is corrupted (invalid JSON/schema), we attempt to
	 * read the raw JSON without schema validation so we don't silently discard
	 * the user's other servers.
	 */
	public async saveServer(name: string, server: McpServer): Promise<void> {
		let config = await this.loadProjectConfig();

		if (!config) {
			// Schema validation failed or file is missing — try raw read
			const configPath = this.getProjectMcpConfigPath();
			if (configPath) {
				const raw = await this._readJsonFile<McpConfig>(configPath);
				if (raw) {
					logger.warn(
						'[McpConfigService] Config failed schema validation, using raw JSON to preserve data',
					);
					config = raw;
				}
			}
		}

		config ??= { mcp: {} };
		const mcp = config.mcp ?? {};
		mcp[name] = server;
		await this.saveProjectConfig({ mcp });
	}

	/**
	 * Delete a server from project config.
	 * Refuses to operate on a corrupted config to prevent data loss.
	 */
	public async deleteServer(name: string): Promise<void> {
		const config = await this.loadProjectConfig();
		if (!config?.mcp) {
			logger.warn('[McpConfigService] Cannot delete server: config is missing or corrupted');
			return;
		}

		delete config.mcp[name];
		await this.saveProjectConfig(config);
	}

	/**
	 * Check if opencode.json exists in project
	 */
	public async hasProjectConfig(): Promise<boolean> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return false;
		return this._fileExists(configPath);
	}

	/**
	 * Ensure opencode.json exists, creating with default template if needed
	 * Returns the path to the config file
	 */
	public async ensureProjectConfig(): Promise<string | undefined> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return undefined;

		const exists = await this._fileExists(configPath);
		if (!exists) {
			const defaultConfig: McpConfig = { mcp: {} };
			await this.saveProjectConfig(defaultConfig);
		}

		return configPath;
	}

	// =========================================================================
	// Plugins Operations
	// =========================================================================

	/**
	 * Get list of plugins from opencode.json
	 * Plugins are stored in the `plugin` field as string[]
	 */
	public async getPlugins(): Promise<string[]> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) return [];

		const config = await this._readJsonFile<Record<string, unknown>>(configPath);
		if (!config) return [];

		const plugins = config.plugin;
		return Array.isArray(plugins) ? plugins.filter((p): p is string => typeof p === 'string') : [];
	}

	/**
	 * Add a plugin to opencode.json
	 */
	public async addPlugin(plugin: string): Promise<void> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) {
			logger.warn('[McpConfigService] No workspace root, cannot add plugin');
			return;
		}

		let config = await this._readJsonFile<Record<string, unknown>>(configPath);
		if (!config) config = {};

		const plugins = Array.isArray(config.plugin)
			? (config.plugin as string[]).filter((p): p is string => typeof p === 'string')
			: [];

		if (!plugins.includes(plugin)) {
			plugins.push(plugin);
			config.plugin = plugins;
			await this._writeJsonFile(configPath, config);
			logger.info(`[McpConfigService] Added plugin: ${plugin}`);
		}
	}

	/**
	 * Remove a plugin from opencode.json
	 */
	public async removePlugin(plugin: string): Promise<void> {
		const configPath = this.getProjectMcpConfigPath();
		if (!configPath) {
			logger.warn('[McpConfigService] No workspace root, cannot remove plugin');
			return;
		}

		const config = await this._readJsonFile<Record<string, unknown>>(configPath);
		if (!config) return;

		const plugins = Array.isArray(config.plugin)
			? (config.plugin as string[]).filter((p): p is string => typeof p === 'string')
			: [];

		config.plugin = plugins.filter(p => p !== plugin);
		await this._writeJsonFile(configPath, config);
		logger.info(`[McpConfigService] Removed plugin: ${plugin}`);
	}
}
