/**
 * @file DiagnosticsHandler
 * @description Handles CLI diagnostics: version checking, path detection, and status reporting.
 * Uses Dependency Injection pattern for postMessage to maintain consistency with other handlers.
 */

import * as cp from 'node:child_process';
import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import type { SessionManager } from '../../services/SessionManager';

// =============================================================================
// Types
// =============================================================================

export interface DiagnosticsHandlerDeps {
	postMessage: (msg: unknown) => void;
}

interface CommandResult {
	success: boolean;
	stdout: string;
	stderr: string;
}

interface CLIDiagnosticsData {
	installed: boolean;
	version: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	path: string | null;
	error: string | null;
	lastChecked: number;
	isChecking: boolean;
}

interface OpenCodeStatusData {
	installed: boolean;
	version: string | null;
	model?: string;
	serverUrl?: string;
	error?: string;
}

// =============================================================================
// DiagnosticsHandler Class
// =============================================================================

export class DiagnosticsHandler {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _deps: DiagnosticsHandlerDeps,
	) {}

	public async checkCLIDiagnostics(): Promise<void> {
		try {
			const versionResult = await this._executeCommand('claude', ['--version']);
			const installed = versionResult.success;
			const version = installed ? this._parseVersion(versionResult.stdout) : null;
			const cliPath = installed ? await this._findClaudePath() : null;

			let latestVersion: string | null = null;
			try {
				const npmResult = await this._executeCommand('npm', [
					'view',
					'@anthropic-ai/claude-code',
					'version',
				]);
				if (npmResult.success) {
					latestVersion = npmResult.stdout.trim();
				}
			} catch {
				// Ignore npm check failure
			}

			const updateAvailable =
				installed && version && latestVersion
					? this._compareVersions(version, latestVersion) < 0
					: false;

			const diagnostics: CLIDiagnosticsData = {
				installed,
				version,
				latestVersion,
				updateAvailable,
				path: cliPath,
				error: installed ? null : versionResult.stderr || 'Claude CLI not found',
				lastChecked: Date.now(),
				isChecking: false,
			};

			this._deps.postMessage({ type: 'cliDiagnostics', data: diagnostics });
		} catch (error) {
			const diagnostics: CLIDiagnosticsData = {
				installed: false,
				version: null,
				latestVersion: null,
				updateAvailable: false,
				path: null,
				error: error instanceof Error ? error.message : 'Failed to check CLI',
				lastChecked: Date.now(),
				isChecking: false,
			};
			this._deps.postMessage({ type: 'cliDiagnostics', data: diagnostics });
		}
	}

	public async checkOpenCodeStatus(): Promise<void> {
		try {
			const versionResult = await this._executeCommand('opencode', ['--version']);
			const installed = versionResult.success;
			const version = installed ? versionResult.stdout.trim() : null;

			let model: string | undefined;
			let serverUrl: string | undefined;

			if (installed && CLIServiceFactory.isOpenCode()) {
				try {
					let service = this._sessionManager.getActiveSession()?.cliService;
					if (!service) {
						service = await CLIServiceFactory.getService();
					}

					if (service.isReady()) {
						serverUrl = 'Connected';
						if (service.getConfig) {
							const config = await service.getConfig();
							model = config?.model;
						}
					}
				} catch {
					// Service not ready
				}
			}

			const status: OpenCodeStatusData = { installed, version, model, serverUrl };
			this._deps.postMessage({ type: 'openCodeStatus', data: status });
		} catch (error) {
			const status: OpenCodeStatusData = {
				installed: false,
				version: null,
				error: error instanceof Error ? error.message : 'Failed to check OpenCode',
			};
			this._deps.postMessage({ type: 'openCodeStatus', data: status });
		}
	}

	public async executeCommand(
		command: string,
		args: string[],
		timeoutMs = 10000,
	): Promise<CommandResult> {
		return this._executeCommand(command, args, timeoutMs);
	}

	private _executeCommand(
		command: string,
		args: string[],
		timeoutMs = 10000,
	): Promise<CommandResult> {
		return new Promise(resolve => {
			const childProcess = cp.spawn(command, args, {
				shell: process.platform === 'win32',
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			let stdout = '';
			let stderr = '';
			let resolved = false;

			const timeout = setTimeout(() => {
				if (!resolved) {
					resolved = true;
					childProcess.kill();
					resolve({ success: false, stdout: '', stderr: 'Command timed out' });
				}
			}, timeoutMs);

			childProcess.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			childProcess.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			childProcess.on('close', (code: number | null) => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					resolve({ success: code === 0, stdout, stderr });
				}
			});

			childProcess.on('error', (error: Error) => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeout);
					resolve({ success: false, stdout: '', stderr: error.message });
				}
			});
		});
	}

	private _parseVersion(output: string): string | null {
		const match = output.match(/v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/);
		return match ? match[1] : null;
	}

	private async _findClaudePath(): Promise<string | null> {
		const command = process.platform === 'win32' ? 'where' : 'which';
		const result = await this._executeCommand(command, ['claude']);
		return result.success ? result.stdout.trim().split('\n')[0] : null;
	}

	private _compareVersions(v1: string, v2: string): number {
		const parts1 = v1.split('.').map(p => Number.parseInt(p, 10) || 0);
		const parts2 = v2.split('.').map(p => Number.parseInt(p, 10) || 0);

		const maxLength = Math.max(parts1.length, parts2.length);
		for (let i = 0; i < maxLength; i++) {
			const p1 = parts1[i] || 0;
			const p2 = parts2[i] || 0;
			if (p1 < p2) return -1;
			if (p1 > p2) return 1;
		}
		return 0;
	}
}
