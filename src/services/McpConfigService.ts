/**
 * @file McpConfigService
 * @description Manages project-level MCP server configuration.
 *              Reads `opencode.json` from the workspace root.
 *              Project writes are centralized in OpenCodeConfigService.
 *              Includes runtime schema validation for config files.
 */

import * as path from 'node:path';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import { type McpConfig, McpConfigSchema, type McpServer } from '../common';
import { PATHS } from '../common/constants';
import { logger } from '../utils/logger';
import { parseProjectConfigText, resolveProjectConfigPath } from './opencode/OpenCodeConfigService';

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

	// Override-only entry (just { enabled: boolean }) — used to toggle servers
	// defined elsewhere in the config chain without rewriting their full config.
	if (config.enabled !== undefined && !config.command && !config.url) {
		return { enabled: config.enabled };
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
	public async getProjectMcpConfigPath(): Promise<string | undefined> {
		if (!this._workspaceRoot) return undefined;
		return resolveProjectConfigPath(this._workspaceRoot);
	}

	// =========================================================================
	// File Operations
	// =========================================================================

	/**
	 * Read JSON file safely with optional schema validation
	 */
	private async _readJsonFile<T>(filePath: string, schema?: TSchema): Promise<T | null> {
		try {
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			const data = parseProjectConfigText(new TextDecoder().decode(bytes), filePath);

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
		const configPath = await this.getProjectMcpConfigPath();
		if (!configPath) return null;
		return this._readJsonFile<McpConfig>(configPath, McpConfigSchema);
	}

	/**
	 * Check if opencode.json exists in project
	 */
	public async hasProjectConfig(): Promise<boolean> {
		const configPath = await this.getProjectMcpConfigPath();
		if (!configPath) return false;
		return this._fileExists(configPath);
	}
}
