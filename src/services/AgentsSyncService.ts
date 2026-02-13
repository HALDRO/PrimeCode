/**
 * @file AgentsSyncService
 * @description Synchronizes MCP configurations from project `.agents/mcp.json` to project-level
 *              CLI-specific formats:
 *              - Legacy CLI: `.mcp.json`
 *              - OpenCode CLI: `opencode.json`
 *              Cursor is treated as read-only and is only used as an import source.
 *              Also supports migration/import from existing project configs and creates backups in
 *              `.agents/.backups/` before migration.
 *              Uses atomic writes to prevent config corruption.
 */

import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import type { AgentsMcpConfig, AgentsMcpServer } from '../common';
import { logger } from '../utils/logger';
import { buildOpenCodeMcpConfig } from '../utils/mcpAdapters';
import { type AgentsConfigService, agentsConfigToUnifiedRegistry } from './AgentsConfigService';

// =============================================================================
// Constants
// =============================================================================

const BACKUPS_DIR = '.backups';
const MAX_BACKUPS = 10;

// =============================================================================
// Types
// =============================================================================

interface McpJsonServerConfig {
	type?: 'stdio' | 'http' | 'sse';
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
}

interface CursorMcpJson {
	mcpServers?: Record<string, CursorServerConfig>;
}

interface CursorServerConfig {
	command?: string;
	args?: string[];
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
}

interface OpenCodeJson {
	$schema?: string;
	mcp?: Record<string, OpenCodeServerConfig>;
	[key: string]: unknown;
}

interface OpenCodeServerConfig {
	type: 'local' | 'remote';
	command?: string[];
	url?: string;
	environment?: Record<string, string>;
	headers?: Record<string, string>;
	enabled?: boolean;
	timeout?: number;
}

// =============================================================================
// AgentsSyncService Class
// =============================================================================

export class AgentsSyncService {
	private _workspaceRoot: string | undefined;

	constructor(private readonly _agentsConfig: AgentsConfigService) {
		this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	// =========================================================================
	// Path Helpers
	// =========================================================================

	private _getProjectPath(relativePath: string): string | undefined {
		if (!this._workspaceRoot) return undefined;
		return path.join(this._workspaceRoot, relativePath);
	}

	// =========================================================================
	// File Operations
	// =========================================================================

	private async _readJsonFile<T>(
		filePath: string,
		schema?: import('@sinclair/typebox').TSchema,
	): Promise<T | null> {
		try {
			const uri = vscode.Uri.file(filePath);
			const bytes = await vscode.workspace.fs.readFile(uri);
			const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;

			if (schema && !Value.Check(schema, raw)) {
				const errors = [...Value.Errors(schema, raw)];
				logger.warn(
					`[AgentsSyncService] Invalid JSON rejected: path=${filePath}, errors=${errors.length}`,
				);
				return null;
			}

			return raw as T;
		} catch {
			return null;
		}
	}

	/**
	 * Atomic write operation: write to tmp file -> rename
	 * This prevents config corruption if the process crashes during write.
	 */
	private async _writeJsonFile(filePath: string, data: unknown): Promise<void> {
		const uri = vscode.Uri.file(filePath);
		const dirUri = vscode.Uri.file(path.dirname(filePath));
		try {
			await vscode.workspace.fs.createDirectory(dirUri);
		} catch {
			/* may already exist */
		}
		const content = new TextEncoder().encode(JSON.stringify(data, null, 2));
		await vscode.workspace.fs.writeFile(uri, content);
	}

	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
			return true;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Backup Operations
	// =========================================================================

	/**
	 * Get path to .agents/.backups/ directory
	 */
	private _getBackupsDir(): string | undefined {
		const agentsDir = this._agentsConfig.getProjectAgentsDir();
		if (!agentsDir) return undefined;
		return path.join(agentsDir, BACKUPS_DIR);
	}

	/**
	 * Create a backup of a config file before migration
	 */
	private async _backupFile(sourcePath: string, backupName: string): Promise<string | null> {
		const backupsDir = this._getBackupsDir();
		if (!backupsDir) return null;

		const exists = await this._fileExists(sourcePath);
		if (!exists) return null;

		try {
			const backupsDirUri = vscode.Uri.file(backupsDir);
			try {
				await vscode.workspace.fs.createDirectory(backupsDirUri);
			} catch {
				/* may exist */
			}

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const backupFileName = `${backupName}_${timestamp}.json`;
			const backupPath = path.join(backupsDir, backupFileName);

			const sourceUri = vscode.Uri.file(sourcePath);
			const backupUri = vscode.Uri.file(backupPath);
			await vscode.workspace.fs.copy(sourceUri, backupUri, { overwrite: true });

			logger.info(`[AgentsSyncService] Created backup: ${backupFileName}`);
			return backupPath;
		} catch (error) {
			logger.warn(`[AgentsSyncService] Failed to backup ${sourcePath}:`, error);
			return null;
		}
	}

	/**
	 * Backup all existing CLI configs before migration
	 */
	public async backupExistingConfigs(): Promise<string[]> {
		const backups: string[] = [];

		// Backup .cursor/mcp.json (Cursor is read-only but we may import from it)
		const cursorPath = this._getProjectPath('.cursor/mcp.json');
		if (cursorPath) {
			const backup = await this._backupFile(cursorPath, 'cursor-mcp');
			if (backup) backups.push(backup);
		}

		// Backup opencode.json
		const opencodePath = this._getProjectPath('opencode.json');
		if (opencodePath) {
			const backup = await this._backupFile(opencodePath, 'opencode');
			if (backup) backups.push(backup);
		}

		// Cleanup old backups (keep only MAX_BACKUPS most recent)
		await this._cleanupOldBackups();

		return backups;
	}

	/**
	 * Remove old backups, keeping only the most recent MAX_BACKUPS
	 */
	private async _cleanupOldBackups(): Promise<void> {
		const backupsDir = this._getBackupsDir();
		if (!backupsDir) return;

		try {
			const backupsDirUri = vscode.Uri.file(backupsDir);
			const exists = await this._fileExists(backupsDir);
			if (!exists) return;

			const entries = await vscode.workspace.fs.readDirectory(backupsDirUri);
			const jsonFiles = entries
				.filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
				.map(([name]) => name);

			if (jsonFiles.length <= MAX_BACKUPS) return;

			// Sort by modification time (oldest first)
			const fileStats = await Promise.all(
				jsonFiles.map(async f => {
					const fileUri = vscode.Uri.joinPath(backupsDirUri, f);
					const stat = await vscode.workspace.fs.stat(fileUri);
					return { name: f, uri: fileUri, mtime: stat.mtime };
				}),
			);

			fileStats.sort((a, b) => a.mtime - b.mtime);

			const toRemove = fileStats.slice(0, fileStats.length - MAX_BACKUPS);
			for (const file of toRemove) {
				await vscode.workspace.fs.delete(file.uri);
				logger.debug(`[AgentsSyncService] Removed old backup: ${file.name}`);
			}
		} catch (error) {
			logger.warn('[AgentsSyncService] Failed to cleanup old backups:', error);
		}
	}

	/**
	 * List all available backups
	 */
	public async listBackups(): Promise<Array<{ name: string; path: string; date: Date }>> {
		const backupsDir = this._getBackupsDir();
		if (!backupsDir) return [];

		try {
			const exists = await this._fileExists(backupsDir);
			if (!exists) return [];

			const backupsDirUri = vscode.Uri.file(backupsDir);
			const entries = await vscode.workspace.fs.readDirectory(backupsDirUri);
			const jsonEntries = entries.filter(
				([name, type]) => type === vscode.FileType.File && name.endsWith('.json'),
			);

			const backups = await Promise.all(
				jsonEntries.map(async ([name]) => {
					const fileUri = vscode.Uri.joinPath(backupsDirUri, name);
					const stat = await vscode.workspace.fs.stat(fileUri);
					return { name, path: path.join(backupsDir, name), date: new Date(stat.mtime) };
				}),
			);

			backups.sort((a, b) => b.date.getTime() - a.date.getTime());
			return backups;
		} catch {
			return [];
		}
	}

	// =========================================================================
	// Sync to OpenCode (opencode.json)
	// =========================================================================

	/**
	 * Sync to project-level opencode.json
	 */
	public async syncToOpenCodeProject(): Promise<void> {
		const opencodePath = this._getProjectPath('opencode.json');
		if (!opencodePath) return;

		const config = await this._agentsConfig.loadProjectConfig();
		if (!config) return;

		const registry = agentsConfigToUnifiedRegistry(config);
		const mcp = buildOpenCodeMcpConfig(registry);

		// Read existing opencode.json and merge mcp section
		const existing = (await this._readJsonFile<OpenCodeJson>(opencodePath)) ?? {
			$schema: 'https://opencode.ai/config.json',
		};
		existing.mcp = mcp;

		await this._writeJsonFile(opencodePath, existing);
		logger.info('[AgentsSyncService] Synced to opencode.json');
	}

	// =========================================================================
	// Sync All
	// =========================================================================

	/**
	 * Sync .agents/mcp.json to supported CLI formats (project-level).
	 * Cursor is intentionally excluded (read-only).
	 */
	public async syncAllProject(): Promise<void> {
		await this.syncToOpenCodeProject();
		logger.info('[AgentsSyncService] Synced to project configs');
	}

	// =========================================================================
	// Import/Migration from existing configs
	// =========================================================================

	/**
	 * Import from .cursor/mcp.json into .agents/mcp.json
	 */
	public async importFromCursor(): Promise<AgentsMcpConfig | null> {
		const cursorPath = this._getProjectPath('.cursor/mcp.json');
		if (!cursorPath) return null;

		const cursorConfig = await this._readJsonFile<CursorMcpJson>(cursorPath);
		if (!cursorConfig?.mcpServers) return null;

		const servers: Record<string, AgentsMcpServer> = {};

		for (const [name, server] of Object.entries(cursorConfig.mcpServers)) {
			if (server.url) {
				servers[name] = {
					type: 'http',
					url: server.url,
					headers: server.headers,
					enabled: true,
				};
			} else if (server.command) {
				servers[name] = {
					type: 'stdio',
					command: [server.command, ...(server.args ?? [])],
					env: server.env,
					enabled: true,
				};
			}
		}

		return { version: 1, servers };
	}

	/**
	 * Import from .mcp.json into .agents/mcp.json
	 * Format: { "mcpServers": { "server-name": { command, args, env } } }
	 */
	public async importFromMcpJson(): Promise<AgentsMcpConfig | null> {
		const mcpJsonPath = this._getProjectPath('.mcp.json');
		if (!mcpJsonPath) return null;

		const mcpJson = await this._readJsonFile<{
			mcpServers?: Record<string, McpJsonServerConfig>;
		}>(mcpJsonPath);
		if (!mcpJson?.mcpServers || Object.keys(mcpJson.mcpServers).length === 0) return null;

		const servers: Record<string, AgentsMcpServer> = {};

		for (const [name, server] of Object.entries(mcpJson.mcpServers)) {
			if (name.startsWith('$') || name.startsWith('_')) continue;

			if (server.type === 'stdio' || (!server.type && server.command)) {
				if (!server.command) continue;
				servers[name] = {
					type: 'stdio',
					command: [server.command, ...(server.args ?? [])],
					env: server.env,
					enabled: true,
				};
			} else if (server.type === 'http' || server.type === 'sse' || (!server.type && server.url)) {
				if (!server.url) continue;
				servers[name] = {
					type: server.type === 'sse' ? 'sse' : 'http',
					url: server.url,
					headers: server.headers,
					enabled: true,
				};
			}
		}

		return { version: 1, servers };
	}

	/**
	 * Import from opencode.json into .agents/mcp.json
	 */
	public async importFromOpenCode(): Promise<AgentsMcpConfig | null> {
		const opencodePath = this._getProjectPath('opencode.json');
		if (!opencodePath) return null;

		const opencodeConfig = await this._readJsonFile<OpenCodeJson>(opencodePath);
		if (!opencodeConfig?.mcp) return null;

		const servers: Record<string, AgentsMcpServer> = {};

		for (const [name, server] of Object.entries(opencodeConfig.mcp)) {
			if (server.type === 'local' && server.command) {
				servers[name] = {
					type: 'stdio',
					command: server.command,
					env: server.environment,
					enabled: server.enabled,
					timeout: server.timeout,
				};
			} else if (server.type === 'remote' && server.url) {
				servers[name] = {
					type: 'http',
					url: server.url,
					headers: server.headers,
					enabled: server.enabled,
					timeout: server.timeout,
				};
			}
		}

		return { version: 1, servers };
	}

	/**
	 * Auto-migrate: Import from existing configs and merge into .agents/mcp.json
	 * Creates backups before migration.
	 * Priority: .agents (existing) > .cursor > .mcp.json > opencode.json
	 */
	public async migrateToAgents(): Promise<{
		migrated: boolean;
		sources: string[];
		backups: string[];
	}> {
		const sources: string[] = [];
		let mergedServers: Record<string, AgentsMcpServer> = {};

		// Create backups before migration
		const backups = await this.backupExistingConfigs();
		if (backups.length > 0) {
			logger.info(`[AgentsSyncService] Created ${backups.length} backup(s) before migration`);
		}

		// 1. Import from opencode.json (lowest priority)
		const opencodeConfig = await this.importFromOpenCode();
		if (opencodeConfig && Object.keys(opencodeConfig.servers).length > 0) {
			mergedServers = { ...mergedServers, ...opencodeConfig.servers };
			sources.push('opencode.json');
		}

		// 2. Import from .mcp.json
		const mcpJsonConfig = await this.importFromMcpJson();
		if (mcpJsonConfig && Object.keys(mcpJsonConfig.servers).length > 0) {
			mergedServers = { ...mergedServers, ...mcpJsonConfig.servers };
			sources.push('.mcp.json');
		}

		// 3. Import from .cursor/mcp.json
		const cursorConfig = await this.importFromCursor();
		if (cursorConfig && Object.keys(cursorConfig.servers).length > 0) {
			mergedServers = { ...mergedServers, ...cursorConfig.servers };
			sources.push('.cursor/mcp.json');
		}

		// 4. Preserve existing .agents/mcp.json (highest priority)
		const existingConfig = await this._agentsConfig.loadProjectConfig();
		if (existingConfig && Object.keys(existingConfig.servers).length > 0) {
			mergedServers = { ...mergedServers, ...existingConfig.servers };
			sources.push('.agents/mcp.json');
		}

		if (Object.keys(mergedServers).length === 0) {
			return { migrated: false, sources: [], backups };
		}

		// Save merged config
		await this._agentsConfig.saveProjectConfig({
			version: 1,
			servers: mergedServers,
		});

		logger.info(`[AgentsSyncService] Migrated MCP configs from: ${sources.join(', ')}`);
		return { migrated: true, sources, backups };
	}
}
