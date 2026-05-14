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
import { logger } from '../../utils/logger';
import { normalizeComparablePath } from '../../utils/path';
import type { HandlerContext, WebviewMessageHandler } from './types';

const GITHUB_REPO = 'HALDRO/PrimeCode';

/** Default timeout for proxy fetch requests (ms). */
const PROXY_FETCH_TIMEOUT_MS = 30_000;

export class UtilityHandler implements WebviewMessageHandler {
	/** Active AbortControllers keyed by request ID for cancellation support. */
	private readonly activeRequests = new Map<string, AbortController>();

	constructor(private readonly context: HandlerContext) {}

	public async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'proxyFetch':
				return this.handleProxyFetch(msg);
			case 'proxyFetchAbort':
				return this.handleProxyFetchAbort(msg);
			case 'openCommandFile':
			case 'openSkillFile':
			case 'openPluginFile':
			case 'openSubagentFile':
				logger.info(`[UtilityHandler] User opened resource file`, {
					type: msg.type,
					filePath: (msg as { filePath?: string }).filePath,
				});
				return this.handleOpenResourceFile(msg);
			case 'acceptFile':
				logger.info(`[UtilityHandler] User accepted file`, {
					filePath: (msg as { filePath?: string }).filePath,
				});
				return this.handleAcceptFile(msg);
			case 'acceptAllFiles':
				logger.info(`[UtilityHandler] User accepted all files`, {
					count: (msg as { filePaths?: string[] }).filePaths?.length,
				});
				return this.handleAcceptAllFiles(msg);
			case 'getWorkspaceFiles':
				return this.handleGetWorkspaceFiles(msg);
			case 'checkExtensionVersion':
				return this.handleCheckExtensionVersion();
			case 'restartOpenCode':
				logger.info('[UtilityHandler] User restarted OpenCode');
				return this.handleRestartOpenCode();
			case 'reloadExtension':
				logger.info('[UtilityHandler] User reloaded extension');
				return this.handleReloadExtension();
			case 'getConnectionDetails':
				return this.handleGetConnectionDetails();
		}
	}

	// ─── Proxy Fetch ────────────────────────────────────────────────────

	private async handleProxyFetch(msg: WebviewCommand): Promise<void> {
		if (msg.type !== 'proxyFetch') return;
		const { id, url, options } = msg;
		const isEventStreamRequest = url.includes('/event');
		const isTrackedOpencodeRequest =
			url.includes('/session/') ||
			url.includes('/event') ||
			url.includes('/permission') ||
			url.includes('/question');

		const controller = new AbortController();
		this.activeRequests.set(id, controller);

		const timer = isEventStreamRequest
			? null
			: setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);

		try {
			const response = await fetch(url, {
				method: options?.method,
				headers: options?.headers,
				body: options?.body,
				signal: controller.signal,
			});
			if (timer) clearTimeout(timer);
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});

			if (isEventStreamRequest) {
				this.context.bridge.send({
					type: 'proxyFetchResult',
					id,
					ok: response.ok,
					status: response.status,
					statusText: response.statusText,
					headers,
					isStream: true,
				});

				if (!response.ok || !response.body) {
					this.context.bridge.send({
						type: 'proxyFetchStreamEnd',
						id,
					});
					return;
				}

				const reader = response.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value || value.length === 0) continue;
					this.context.bridge.send({
						type: 'proxyFetchStreamChunk',
						id,
						chunk: value,
					});
				}
				this.context.bridge.send({
					type: 'proxyFetchStreamEnd',
					id,
				});
				return;
			}
			const bodyText = await response.text();
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
			if (timer) clearTimeout(timer);
			const errorMessage = this.serializeProxyFetchError(error);
			if ((error as Error).name === 'AbortError') {
				logger.debug('[UtilityHandler] proxyFetch timed out or aborted', { id, url });
			} else {
				logger.error('[UtilityHandler] proxyFetch failed:', { id, url, error: errorMessage });
			}
			this.context.bridge.send({
				type: 'proxyFetchResult',
				id,
				ok: false,
				error: errorMessage,
			});
			if (isEventStreamRequest) {
				this.context.bridge.send({
					type: 'proxyFetchStreamError',
					id,
					error: errorMessage,
				});
			}
			if (isTrackedOpencodeRequest) {
				logger.error('[UtilityHandler] proxyFetch tracked request failed', {
					id,
					url,
					error: errorMessage,
				});
			}
		} finally {
			this.activeRequests.delete(id);
		}
	}

	private handleProxyFetchAbort(msg: WebviewCommand): void {
		const id = (msg as { id?: string }).id;
		if (!id) return;
		const controller = this.activeRequests.get(id);
		if (controller) {
			controller.abort();
			this.activeRequests.delete(id);
		}
	}

	/**
	 * Serialize fetch errors including nested cause chain (ECONNREFUSED, etc.).
	 * Standard `String(error)` loses the cause, producing empty `{}` in logs.
	 */
	private serializeProxyFetchError(error: unknown): string {
		if (!(error instanceof Error)) return String(error);
		const parts: string[] = [error.message || error.name];
		let current: unknown = (error as { cause?: unknown }).cause;
		while (current instanceof Error) {
			const code = (current as { code?: string }).code;
			const detail = code ? `${current.message} [${code}]` : current.message;
			parts.push(detail);
			current = (current as { cause?: unknown }).cause;
		}
		return parts.join(' → ');
	}

	// ─── Agent Resource Files ───────────────────────────────────────────

	private async handleOpenResourceFile(msg: WebviewCommand): Promise<void> {
		const filePath = (msg as { filePath?: string }).filePath?.trim();
		if (!filePath) {
			logger.warn(`[UtilityHandler] Missing resource path: ${msg.type}`);
			return;
		}

		const fileUri = this.resolveResourceUri(filePath);
		await vscode.window.showTextDocument(fileUri);
	}

	private resolveResourceUri(resourcePath: string): vscode.Uri {
		if (/^file:\/\//i.test(resourcePath)) {
			return vscode.Uri.parse(resourcePath);
		}

		if (path.isAbsolute(resourcePath)) {
			return vscode.Uri.file(resourcePath);
		}

		const workspaceRoot = this.context.settings.getWorkspaceRoot();
		if (!workspaceRoot) {
			return vscode.Uri.file(resourcePath);
		}

		return vscode.Uri.file(path.join(workspaceRoot, resourcePath));
	}

	// ─── Git Stage ──────────────────────────────────────────────────────

	/** Check that a file path is within the workspace root (prevents path traversal). */
	private isPathWithinWorkspace(filePath: string): boolean {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!root) return false;
		const rootNorm = normalizeComparablePath(root.fsPath);
		const fileNorm = normalizeComparablePath(vscode.Uri.file(filePath).fsPath);
		// Ensure trailing separator so "/project-evil" doesn't match "/project"
		return fileNorm === rootNorm || fileNorm.startsWith(`${rootNorm}/`);
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

	// ─── Extension Version Check ────────────────────────────────────────

	private async handleCheckExtensionVersion(): Promise<void> {
		const currentVersion: string =
			this.context.extensionContext.extension.packageJSON?.version ?? '0.0.0';

		// Send "checking" state immediately
		this.context.bridge.data('extensionVersion', {
			current: currentVersion,
			latest: null,
			updateAvailable: false,
			releaseUrl: null,
			isChecking: true,
		});

		try {
			const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
				headers: { Accept: 'application/vnd.github.v3+json' },
			});

			if (!res.ok) {
				throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
			}

			const release = (await res.json()) as { tag_name: string; html_url: string };
			const latestVersion = release.tag_name.replace(/^v/, '');
			const updateAvailable = this.isNewerVersion(currentVersion, latestVersion);

			this.context.bridge.data('extensionVersion', {
				current: currentVersion,
				latest: latestVersion,
				updateAvailable,
				releaseUrl: updateAvailable ? release.html_url : null,
				isChecking: false,
			});
		} catch (error) {
			logger.warn('[UtilityHandler] Version check failed:', error);
			this.context.bridge.data('extensionVersion', {
				current: currentVersion,
				latest: null,
				updateAvailable: false,
				releaseUrl: null,
				isChecking: false,
				error: String(error),
			});
		}
	}

	/** Simple semver comparison: returns true if latest > current */
	private isNewerVersion(current: string, latest: string): boolean {
		const c = current.split('.').map(Number);
		const l = latest.split('.').map(Number);
		for (let i = 0; i < 3; i++) {
			if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
			if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
		}
		return false;
	}

	// ─── Connection Status ─────────────────────────────────────────────

	private async handleRestartOpenCode(): Promise<void> {
		logger.info('[UtilityHandler] Reloading OpenCode runtime via instance.dispose()...');
		await this.context.reloadOpenCodeRuntime?.('manual-reload');
		await this.context.refreshAfterServerRestart?.();
	}

	private handleReloadExtension(): void {
		logger.info('[UtilityHandler] Reloading extension window...');
		void vscode.commands.executeCommand('workbench.action.reloadWindow');
	}

	private async handleGetConnectionDetails(): Promise<void> {
		const details = this.context.cli.getConnectionDetails();

		this.context.bridge.data('connectionDetails', {
			serverUrl: details.serverUrl,
			isServerOwner: details.isServerOwner,
			uptime: details.uptime,
			port: details.port,
		});
	}
}
