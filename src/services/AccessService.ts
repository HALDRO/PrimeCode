/**
 * @file Access management service for Claude tool execution
 * @description Handles access requests, approvals, and persistence for Claude CLI tools.
 *              Manages MCP server configuration for Claude CLI (mcp-servers.json) combining:
 *              - Internal permissions server for tool approval workflow
 *              - User-defined MCP servers from project .agents/mcp.json
 *              Provides file-based access request/response communication.
 *              Integrates with ErrorService for centralized error handling.
 *              Supports hot-reload of MCP config via reloadMcpConfig() method.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AccessRequest, AccessStore } from '../types';
import { logger } from '../utils/logger';
import { errorService } from './ErrorService';

export class AccessService {
	private readonly _pendingAccessResolvers = new Map<string, (approved: boolean) => void>();
	private readonly _pendingRequests = new Map<string, AccessRequest>();
	private readonly _disposables: vscode.Disposable[] = [];
	private _accessRequestCallback: ((request: AccessRequest) => void) | undefined;
	/** Requests that arrived before the UI callback was registered */
	private readonly _queuedAccessRequests: AccessRequest[] = [];
	private static readonly MCP_DIR_NAME = 'mcp';
	private static readonly CLAUDE_MCP_FILENAME = 'mcp-servers.json';

	constructor(private readonly _context: vscode.ExtensionContext) {
		// Legacy watcher removed in favor of SDK callback flow
	}

	public setAccessRequestCallback(callback: (request: AccessRequest) => void): void {
		this._accessRequestCallback = callback;

		// Flush any queued requests that arrived before the callback existed.
		if (this._queuedAccessRequests.length > 0) {
			logger.debug(
				`[AccessService] Flushing ${this._queuedAccessRequests.length} queued access request(s)`,
			);
			for (const req of this._queuedAccessRequests.splice(0)) {
				try {
					this._accessRequestCallback(req);
				} catch (error) {
					logger.warn(
						'[AccessService] Access request callback failed while flushing queue:',
						error,
					);
					this.resolveAccessRequest(req.id, false);
				}
			}
		}
	}

	public resolveAccessRequest(id: string, approved: boolean): void {
		logger.debug(`[AccessService] resolveAccessRequest called: id=${id}, approved=${approved}`);
		const resolver = this._pendingAccessResolvers.get(id);
		if (resolver) {
			logger.info(`[AccessService] Resolving access request: id=${id}, approved=${approved}`);
			resolver(approved);
			this._pendingAccessResolvers.delete(id);
		} else {
			logger.warn(`[AccessService] No pending resolver found for id=${id}`);
		}
		this._pendingRequests.delete(id);
	}

	public getPendingRequest(id: string): AccessRequest | undefined {
		return this._pendingRequests.get(id);
	}

	public async getAccess(): Promise<AccessStore> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return { alwaysAllow: {} };

		const accessUri = vscode.Uri.file(path.join(storagePath, 'access-requests', 'access.json'));

		try {
			const content = await vscode.workspace.fs.readFile(accessUri);
			return JSON.parse(new TextDecoder().decode(content));
		} catch {
			return { alwaysAllow: {} };
		}
	}

	public async saveAlwaysAllowAccess(request: AccessRequest): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		try {
			const access = await this.getAccess();
			const toolName = request.tool;

			if (
				toolName === 'Bash' &&
				request.input?.command &&
				typeof request.input.command === 'string'
			) {
				const command = request.input.command.trim();
				const pattern = this.getCommandPattern(command);

				if (!access.alwaysAllow[toolName]) {
					access.alwaysAllow[toolName] = [];
				}

				if (Array.isArray(access.alwaysAllow[toolName])) {
					const list = access.alwaysAllow[toolName] as string[];
					if (!list.includes(pattern)) {
						list.push(pattern);
					}
				}
			} else {
				access.alwaysAllow[toolName] = true;
			}

			await this._saveAccess(access);
		} catch (error) {
			errorService.handle(
				error instanceof Error ? error : new Error(String(error)),
				'AccessService.saveAlwaysAllowAccess',
			);
		}
	}

	public async removeAccess(toolName: string, command: string | null): Promise<void> {
		const access = await this.getAccess();

		if (command === null) {
			delete access.alwaysAllow[toolName];
		} else if (Array.isArray(access.alwaysAllow[toolName])) {
			const currentAccess = access.alwaysAllow[toolName] as string[];
			access.alwaysAllow[toolName] = currentAccess.filter(cmd => cmd !== command);

			if ((access.alwaysAllow[toolName] as string[]).length === 0) {
				delete access.alwaysAllow[toolName];
			}
		}

		await this._saveAccess(access);
	}

	public async addAccess(toolName: string, command: string | null): Promise<void> {
		const access = await this.getAccess();

		if (!command) {
			access.alwaysAllow[toolName] = true;
		} else {
			if (!access.alwaysAllow[toolName] || access.alwaysAllow[toolName] === true) {
				access.alwaysAllow[toolName] = [];
			}

			const pattern = toolName === 'Bash' ? this.getCommandPattern(command) : command;
			const list = access.alwaysAllow[toolName] as string[];

			if (!list.includes(pattern)) {
				list.push(pattern);
			}
		}

		await this._saveAccess(access);
	}

	public getCommandPattern(command: string): string {
		const [baseCmd, subCmd] = command.trim().split(/\s+/);
		if (!baseCmd) return command;

		const wildcardPatterns = [
			'npm install',
			'npm i',
			'npm add',
			'npm remove',
			'npm uninstall',
			'npm update',
			'npm run',
			'yarn add',
			'yarn remove',
			'yarn install',
			'pnpm install',
			'pnpm add',
			'pnpm remove',
			'git add',
			'git commit',
			'git push',
			'git pull',
			'git checkout',
			'git branch',
			'git merge',
			'git clone',
			'git reset',
			'git rebase',
			'git tag',
			'docker run',
			'docker build',
			'docker exec',
			'docker logs',
			'docker stop',
			'docker start',
			'docker rm',
			'docker rmi',
			'docker pull',
			'docker push',
			'cargo build',
			'cargo run',
			'cargo test',
			'cargo install',
			'mvn compile',
			'mvn test',
			'mvn package',
			'gradle build',
			'gradle test',
			'pip install',
			'pip3 install',
			'composer install',
			'composer require',
			'bundle install',
			'gem install',
		];

		const simpleTools = [
			'make',
			'curl',
			'wget',
			'ssh',
			'scp',
			'rsync',
			'tar',
			'zip',
			'unzip',
			'node',
			'python',
			'python3',
		];

		const fullCmd = subCmd ? `${baseCmd} ${subCmd}` : baseCmd;

		if (wildcardPatterns.some(p => fullCmd === p)) {
			return `${fullCmd} *`;
		}

		if (simpleTools.includes(baseCmd) && !subCmd) {
			return `${baseCmd} *`;
		}

		return command;
	}

	public getMCPConfigPath(): string | undefined {
		const storagePath = this._context.storageUri?.fsPath;
		return storagePath
			? path.join(storagePath, AccessService.MCP_DIR_NAME, AccessService.CLAUDE_MCP_FILENAME)
			: undefined;
	}

	/**
	 * Reload MCP configuration by re-syncing mcp-servers.json.
	 * This re-reads .agents/mcp.json and updates the Claude CLI config file.
	 * Used by McpConfigWatcherService for hot-reload when .agents/mcp.json changes.
	 * Note: Claude CLI will pick up changes on next command execution.
	 */
	public async reloadMcpConfig(): Promise<{ success: boolean; error?: string }> {
		// No-op in new SDK flow as configuration is passed directly to SDK
		return { success: true };
	}

	public dispose(): void {
		// No watchers to dispose
		for (const d of this._disposables) {
			d.dispose();
		}
	}

	public async requestApproval(request: AccessRequest): Promise<boolean> {
		logger.debug(`[AccessService] requestApproval called: id=${request.id}, tool=${request.tool}`);
		this._pendingRequests.set(request.id, request);
		return new Promise<boolean>(resolve => {
			this._pendingAccessResolvers.set(request.id, resolve);
			logger.debug(
				`[AccessService] Resolver registered for id=${request.id}, hasCallback=${!!this._accessRequestCallback}`,
			);

			if (this._accessRequestCallback) {
				logger.info(`[AccessService] Sending access request to UI: id=${request.id}`);
				this._accessRequestCallback(request);
				return;
			}

			// Webview may not be ready yet. Queue the request and wait for callback registration.
			logger.warn(`[AccessService] No callback registered, queueing request: id=${request.id}`);
			this._queuedAccessRequests.push(request);

			// Safety: if UI never attaches (crash/unloaded), fail closed after timeout.
			setTimeout(() => {
				if (this._pendingAccessResolvers.has(request.id)) {
					logger.warn(
						`[AccessService] Access request timed out waiting for UI callback: ${request.id}`,
					);
					this.resolveAccessRequest(request.id, false);
				}
			}, 60_000);
		});
	}

	private async _saveAccess(access: AccessStore): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		if (!storagePath) return;

		const accessUri = vscode.Uri.file(path.join(storagePath, 'access-requests', 'access.json'));

		await vscode.workspace.fs.writeFile(
			accessUri,
			new TextEncoder().encode(JSON.stringify(access, null, 2)),
		);
	}
}
