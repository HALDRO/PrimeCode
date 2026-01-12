/**
 * @file AgentsSyncService
 * @description Synchronizes MCP configurations from project `.agents/mcp.json` to project-level
 *              CLI-specific formats:
 *              - Claude CLI: `.mcp.json`
 *              - OpenCode CLI: `opencode.json`
 *              Cursor is treated as read-only and is only used as an import source.
 *              Also supports migration/import from existing project configs and creates backups in
 *              `.agents/.backups/` before migration.
 *              Uses atomic writes to prevent config corruption.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import * as vscode from 'vscode';
import type { AgentsMcpConfig, AgentsMcpServer } from '../types';
import { logger } from '../utils/logger';
import {
	buildClaudeMcpServersJson,
	buildOpenCodeMcpConfig,
	claudeConfigToUnifiedServer,
} from '../utils/mcpAdapters';
import { type AgentsConfigService, agentsConfigToUnifiedRegistry } from './AgentsConfigService';

// =============================================================================
// Constants
// =============================================================================

const BACKUPS_DIR = '.backups';
const MAX_BACKUPS = 10;

// =============================================================================
// Types
// =============================================================================

interface ClaudeServerConfig {
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
			const content = await fs.readFile(filePath, 'utf8');
			const raw = JSON.parse(content) as unknown;

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
		const dir = path.dirname(filePath);
		const tempPath = `${filePath}.tmp.${Date.now()}`;

		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
			await fs.rename(tempPath, filePath);
		} catch (error) {
			// Try to cleanup temp file if rename failed
			try {
				await fs.unlink(tempPath);
			} catch {
				// Ignore cleanup error
			}
			throw error;
		}
	}

	private async _fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
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
			await fs.mkdir(backupsDir, { recursive: true });

			// Create timestamped backup filename
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			const backupFileName = `${backupName}_${timestamp}.json`;
			const backupPath = path.join(backupsDir, backupFileName);

			// Copy file to backup
			const content = await fs.readFile(sourcePath, 'utf8');
			await fs.writeFile(backupPath, content, 'utf8');

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

		// Backup .mcp.json (Claude)
		const claudePath = this._getProjectPath('.mcp.json');
		if (claudePath) {
			const backup = await this._backupFile(claudePath, 'claude-mcp');
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
			const exists = await this._fileExists(backupsDir);
			if (!exists) return;

			const files = await fs.readdir(backupsDir);
			const jsonFiles = files.filter(f => f.endsWith('.json'));

			if (jsonFiles.length <= MAX_BACKUPS) return;

			// Sort by modification time (oldest first)
			const fileStats = await Promise.all(
				jsonFiles.map(async f => {
					const filePath = path.join(backupsDir, f);
					const stat = await fs.stat(filePath);
					return { name: f, path: filePath, mtime: stat.mtime.getTime() };
				}),
			);

			fileStats.sort((a, b) => a.mtime - b.mtime);

			// Remove oldest files
			const toRemove = fileStats.slice(0, fileStats.length - MAX_BACKUPS);
			for (const file of toRemove) {
				await fs.unlink(file.path);
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

			const files = await fs.readdir(backupsDir);
			const jsonFiles = files.filter(f => f.endsWith('.json'));

			const backups = await Promise.all(
				jsonFiles.map(async f => {
					const filePath = path.join(backupsDir, f);
					const stat = await fs.stat(filePath);
					return { name: f, path: filePath, date: stat.mtime };
				}),
			);

			// Sort by date (newest first)
			backups.sort((a, b) => b.date.getTime() - a.date.getTime());
			return backups;
		} catch {
			return [];
		}
	}

	// =========================================================================
	// Sync to Claude CLI (.mcp.json)
	// =========================================================================

	/**
	 * Sync to project-level .mcp.json (Claude CLI format)
	 * Format: { "mcpServers": { "server-name": { command, args, env } } }
	 */
	public async syncToClaudeProject(): Promise<void> {
		const mcpJsonPath = this._getProjectPath('.mcp.json');
		if (!mcpJsonPath) return;

		const config = await this._agentsConfig.loadProjectConfig();
		if (!config) return;

		const registry = agentsConfigToUnifiedRegistry(config);
		const claudeJson = buildClaudeMcpServersJson(registry);

		await this._writeJsonFile(mcpJsonPath, claudeJson);
		logger.info('[AgentsSyncService] Synced to .mcp.json');
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
		await Promise.all([this.syncToClaudeProject(), this.syncToOpenCodeProject()]);
		logger.info('[AgentsSyncService] Synced to all project configs');
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
	 * Import from .mcp.json (Claude) into .agents/mcp.json
	 * Format: { "mcpServers": { "server-name": { command, args, env } } }
	 */
	public async importFromClaude(): Promise<AgentsMcpConfig | null> {
		const claudePath = this._getProjectPath('.mcp.json');
		if (!claudePath) return null;

		// .mcp.json format: { "mcpServers": { "server-name": {...} } }
		const claudeConfig = await this._readJsonFile<{
			mcpServers?: Record<string, ClaudeServerConfig>;
		}>(claudePath);
		if (!claudeConfig?.mcpServers || Object.keys(claudeConfig.mcpServers).length === 0) return null;

		const servers: Record<string, AgentsMcpServer> = {};

		for (const [name, server] of Object.entries(claudeConfig.mcpServers)) {
			// Skip non-server entries (like $schema or comments)
			if (name.startsWith('$') || name.startsWith('_')) continue;

			const unified = claudeConfigToUnifiedServer({
				type: server.type,
				command: server.command,
				args: server.args,
				url: server.url,
				env: server.env,
				headers: server.headers,
			});

			if (unified) {
				const transport = unified.transport;
				if (transport.type === 'stdio') {
					servers[name] = {
						type: 'stdio',
						command: transport.command,
						env: transport.env,
						cwd: transport.cwd,
						enabled: unified.enabled,
						timeout: unified.timeoutMs,
					};
				} else {
					servers[name] = {
						type: transport.type,
						url: transport.url,
						headers: transport.headers,
						enabled: unified.enabled,
						timeout: unified.timeoutMs,
					};
				}
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

		// 2. Import from .mcp.json (Claude)
		const claudeConfig = await this.importFromClaude();
		if (claudeConfig && Object.keys(claudeConfig.servers).length > 0) {
			mergedServers = { ...mergedServers, ...claudeConfig.servers };
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
