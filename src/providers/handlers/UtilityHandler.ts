/**
 * @file UtilityHandler
 * @description Handles miscellaneous commands that don't belong to any domain handler:
 *              proxyFetch, agent resource file openers, git stage, workspace file search.
 *              Extracted from ChatProvider to reduce its responsibilities.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WebviewCommand } from '../../common/protocol';
import { getWorkspacePath, searchWorkspaceFiles } from '../../services/fileSearch';
import type { ResourceType } from '../../services/ResourceService';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

// Resource type lookup — replaces ternary chain
const RESOURCE_TYPE_MAP: Record<string, ResourceType> = {
	openCommandFile: 'commands',
	openSkillFile: 'skills',
	openSubagentFile: 'subagents',
};

export class UtilityHandler implements WebviewMessageHandler {
	constructor(private readonly context: HandlerContext) {}

	public async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'proxyFetch':
				return this.handleProxyFetch(msg);
			case 'proxyFetchAbort':
				// TODO: implement AbortController support
				return;
			case 'openCommandFile':
			case 'openSkillFile':
			case 'openSubagentFile':
				return this.handleOpenResourceFile(msg);
			case 'acceptFile':
				return this.handleAcceptFile(msg);
			case 'acceptAllFiles':
				return this.handleAcceptAllFiles(msg);
			case 'getWorkspaceFiles':
				return this.handleGetWorkspaceFiles(msg);
		}
	}

	// ─── Proxy Fetch ────────────────────────────────────────────────────

	private async handleProxyFetch(msg: WebviewCommand): Promise<void> {
		if (msg.type !== 'proxyFetch') return;
		const { id, url, options } = msg;
		try {
			const response = await fetch(url, {
				method: options?.method,
				headers: options?.headers,
				body: options?.body,
			});
			const bodyText = await response.text();
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			this.context.bridge.send({
				type: 'proxyFetchResult',
				id,
				ok: response.ok,
				status: response.status,
				statusText: response.statusText,
				headers,
				bodyText,
			});
		} catch (error) {
			logger.error('[UtilityHandler] proxyFetch failed:', error);
			this.context.bridge.send({
				type: 'proxyFetchResult',
				id,
				ok: false,
				error: String(error),
			});
		}
	}

	// ─── Agent Resource Files ───────────────────────────────────────────

	private async handleOpenResourceFile(msg: WebviewCommand): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		const name = (msg as { name: string }).name;
		if (!root || !name) return;

		const resourceType = RESOURCE_TYPE_MAP[msg.type];
		if (!resourceType) return;

		const items = await this.context.services.resources.getAll(resourceType);
		const relativePath = items.find(i => i.name === name)?.path;
		if (!relativePath) {
			logger.warn(`[UtilityHandler] Resource not found: ${msg.type} name=${name}`);
			return;
		}

		// Path traversal guard: ensure resolved path stays within workspace root
		const fileUri = vscode.Uri.joinPath(root, relativePath);
		const rootFsPath = root.fsPath.replace(/\\/g, '/');
		const fileFsPath = fileUri.fsPath.replace(/\\/g, '/');
		if (!fileFsPath.startsWith(rootFsPath)) {
			logger.warn(`[UtilityHandler] Path traversal blocked: ${relativePath}`);
			return;
		}

		await vscode.window.showTextDocument(fileUri);
	}

	// ─── Git Stage ──────────────────────────────────────────────────────

	/** Check that a file path is within the workspace root (prevents path traversal). */
	private isPathWithinWorkspace(filePath: string): boolean {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) return false;
		const rootNorm = root.fsPath.replace(/\\/g, '/').toLowerCase();
		const fileNorm = vscode.Uri.file(filePath).fsPath.replace(/\\/g, '/').toLowerCase();
		return fileNorm.startsWith(rootNorm);
	}

	private async handleAcceptFile(msg: WebviewCommand): Promise<void> {
		const filePath = (msg as { filePath: string }).filePath;
		if (!this.isPathWithinWorkspace(filePath)) {
			logger.warn('[UtilityHandler] acceptFile path traversal blocked:', filePath);
			return;
		}
		try {
			const uri = vscode.Uri.file(filePath);
			await vscode.commands.executeCommand('git.stage', uri);
			logger.info('[UtilityHandler] Staged file', { filePath });
		} catch (err) {
			logger.error('[UtilityHandler] Failed to stage file', { filePath, err });
		}
	}

	private async handleAcceptAllFiles(msg: WebviewCommand): Promise<void> {
		const filePaths = (msg as { filePaths: string[] }).filePaths;
		const safePaths = filePaths.filter(fp => {
			if (!this.isPathWithinWorkspace(fp)) {
				logger.warn('[UtilityHandler] acceptAllFiles path traversal blocked:', fp);
				return false;
			}
			return true;
		});
		for (const fp of safePaths) {
			try {
				const uri = vscode.Uri.file(fp);
				await vscode.commands.executeCommand('git.stage', uri);
			} catch (err) {
				logger.error('[UtilityHandler] Failed to stage file', { filePath: fp, err });
			}
		}
		logger.info('[UtilityHandler] Staged all files', { count: safePaths.length });
	}

	// ─── Workspace Files ────────────────────────────────────────────────

	private async handleGetWorkspaceFiles(msg: WebviewCommand): Promise<void> {
		const wsPath = getWorkspacePath();
		if (!wsPath) return;
		const searchTerm = (msg as { searchTerm?: string }).searchTerm ?? '';
		const results = await searchWorkspaceFiles(searchTerm, wsPath, 50);
		const files = results.map(r => ({
			name: r.label,
			path: r.path,
			fsPath: path.join(wsPath, r.path),
		}));
		this.context.bridge.data('workspaceFiles', files);
	}
}
