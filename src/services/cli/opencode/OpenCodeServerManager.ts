/**
 * @file OpenCode Server Manager
 * @description Manages the complete lifecycle of the OpenCode server process.
 * Handles spawning, port discovery, health monitoring, and graceful shutdown.
 * Encapsulates all process management to maintain single responsibility.
 */

import * as cp from 'node:child_process';
import * as net from 'node:net';
import { logger } from '../../../utils/logger';

/** Server start result */
export interface ServerStartResult {
	url: string;
}

export class OpenCodeServerManager {
	private static readonly SERVER_TIMEOUT_MS = 15000;

	private _proc: cp.ChildProcess | null = null;

	/**
	 * Check if server process is running
	 */
	public get isRunning(): boolean {
		return this._proc !== null && !this._proc.killed;
	}

	/**
	 * Get the server process (for advanced use cases)
	 */
	public get process(): cp.ChildProcess | null {
		return this._proc;
	}

	/**
	 * Start OpenCode server on a free port
	 */
	public async startServer(cwd: string): Promise<ServerStartResult> {
		// Stop any existing server first
		this.stopServer();

		const port = await this._findFreePort();
		logger.info(`[OpenCodeServerManager] Using port: ${port}`);

		const { proc, urlPromise } = this._spawnServer(port, cwd);
		this._proc = proc;

		const url = await urlPromise;
		logger.info(`[OpenCodeServerManager] Server started at ${url}`);

		return { url };
	}

	/**
	 * Stop the server process gracefully
	 */
	public stopServer(): void {
		if (this._proc) {
			logger.info('[OpenCodeServerManager] Stopping server...');
			try {
				this._proc.kill();
			} catch (error) {
				logger.warn('[OpenCodeServerManager] Error killing process:', error);
			}
			this._proc = null;
		}
	}

	/**
	 * Dispose resources (alias for stopServer for consistency)
	 */
	public dispose(): void {
		this.stopServer();
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private async _findFreePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = net.createServer();
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address();
				if (addr && typeof addr === 'object') {
					const port = addr.port;
					server.close(() => resolve(port));
				} else {
					server.close(() => reject(new Error('Failed to get port')));
				}
			});
			server.on('error', reject);
		});
	}

	private _spawnServer(
		port: number,
		cwd: string,
	): { proc: cp.ChildProcess; urlPromise: Promise<string> } {
		const args = ['serve', `--hostname=127.0.0.1`, `--port=${port}`];
		const isWindows = process.platform === 'win32';

		logger.info(`[OpenCodeServerManager] Spawning: opencode ${args.join(' ')} (cwd: ${cwd})`);

		const proc = cp.spawn('opencode', args, {
			cwd,
			shell: isWindows,
			env: {
				...process.env,
				OPENCODE_CLIENT: 'vscode-extension',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const urlPromise = new Promise<string>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(
					new Error(`Server startup timed out after ${OpenCodeServerManager.SERVER_TIMEOUT_MS}ms`),
				);
			}, OpenCodeServerManager.SERVER_TIMEOUT_MS);

			let output = '';

			const handleOutput = (chunk: Buffer) => {
				const text = chunk.toString();
				output += text;
				logger.debug(`[OpenCodeServerManager] stdout: ${text.trim()}`);

				if (output.includes('opencode server listening')) {
					const match = output.match(/on\s+(https?:\/\/[^\s]+)/);
					if (match) {
						clearTimeout(timeoutId);
						resolve(match[1]);
					}
				}
			};

			proc.stdout?.on('data', handleOutput);
			proc.stderr?.on('data', (chunk: Buffer) => {
				const text = chunk.toString();
				output += text;
				logger.debug(`[OpenCodeServerManager] stderr: ${text.trim()}`);
			});

			proc.on('error', error => {
				clearTimeout(timeoutId);
				reject(error);
			});

			proc.on('exit', code => {
				clearTimeout(timeoutId);
				if (code !== 0) {
					reject(new Error(`Server exited with code ${code}\nOutput: ${output}`));
				}
			});
		});

		return { proc, urlPromise };
	}
}
