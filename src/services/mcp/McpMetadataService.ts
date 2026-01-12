/**
 * @file McpMetadataService
 * @description Stores UI-facing MCP metadata (display name, icon, source, tags) separately
 *              from provider configs. The canonical MCP configuration remains in unified-mcp.json
 *              (via AccessService). Metadata is optional and safely ignored when missing.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { InstalledMcpServerMetadata } from '../../types';

export class McpMetadataService {
	private static readonly MCP_DIR_NAME = 'mcp';
	private static readonly INSTALLED_META_FILENAME = 'installed-mcp-meta.json';

	constructor(private readonly _context: vscode.ExtensionContext) {}

	private _getMetaPath(storagePath: string): string {
		return path.join(
			storagePath,
			McpMetadataService.MCP_DIR_NAME,
			McpMetadataService.INSTALLED_META_FILENAME,
		);
	}

	private async _readJsonFile<T>(filePath: string): Promise<T | null> {
		try {
			const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			return JSON.parse(new TextDecoder().decode(content)) as T;
		} catch {
			return null;
		}
	}

	private async _writeJsonFile(filePath: string, data: unknown): Promise<void> {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			new TextEncoder().encode(JSON.stringify(data, null, 2)),
		);
	}

	private async _ensureDir(storagePath: string): Promise<void> {
		await vscode.workspace.fs.createDirectory(
			vscode.Uri.file(path.join(storagePath, McpMetadataService.MCP_DIR_NAME)),
		);
	}

	public async loadAll(): Promise<Record<string, InstalledMcpServerMetadata>> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return {};

		try {
			await this._ensureDir(storagePath);
			return (
				(await this._readJsonFile<Record<string, InstalledMcpServerMetadata>>(
					this._getMetaPath(storagePath),
				)) ?? {}
			);
		} catch {
			return {};
		}
	}

	public async set(name: string, meta: InstalledMcpServerMetadata): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		await this._ensureDir(storagePath);
		const all = await this.loadAll();
		all[name] = meta;
		await this._writeJsonFile(this._getMetaPath(storagePath), all);
	}

	public async delete(name: string): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		await this._ensureDir(storagePath);
		const all = await this.loadAll();
		delete all[name];
		await this._writeJsonFile(this._getMetaPath(storagePath), all);
	}
}
