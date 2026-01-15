/**
 * @file OpenCode Server Manager
 * @description Manages the complete lifecycle of the OpenCode server process.
 * Handles spawning, port discovery, health monitoring, and graceful shutdown.
 * On Windows, uses taskkill to terminate the entire process tree to prevent
 * orphaned opencode.exe processes when the extension is deactivated or reloaded.
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
		// Stop any existing server first (our tracked process)
		this.stopServer();

		// Kill any orphaned opencode serve processes from previous extension instances
		// This handles cases where debugger restart doesn't call deactivate()
		await OpenCodeServerManager.cleanUpOrphans();

		const port = await this._findFreePort();
		logger.info(`[OpenCodeServerManager] Using port: ${port}`);

		const { proc, urlPromise } = this._spawnServer(port, cwd);
		this._proc = proc;

		const url = await urlPromise;
		logger.info(`[OpenCodeServerManager] Server started at ${url}`);

		return { url };
	}

	/**
	 * Stop the server process gracefully.
	 * On Windows, uses taskkill /T /F to kill the entire process tree,
	 * preventing orphaned opencode.exe processes.
	 */
	public stopServer(): void {
		if (this._proc) {
			const pid = this._proc.pid;
			logger.info(`[OpenCodeServerManager] Stopping server (PID: ${pid})...`);

			try {
				if (process.platform === 'win32' && pid) {
					// Windows: kill entire process tree with taskkill
					// /T = terminate child processes, /F = force termination
					cp.execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
					logger.info(`[OpenCodeServerManager] Process tree killed via taskkill`);
				} else {
					// Unix: SIGTERM is usually sufficient, but use SIGKILL for reliability
					this._proc.kill('SIGKILL');
				}
			} catch (error) {
				// taskkill may fail if process already exited - that's fine
				logger.warn('[OpenCodeServerManager] Error killing process:', error);
				// Fallback: try regular kill
				try {
					this._proc.kill('SIGKILL');
				} catch {
					// Ignore - process likely already dead
				}
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

	/**
	 * Kill orphaned opencode serve processes from previous extension instances.
	 * This handles debugger restarts that don't trigger deactivate().
	 *
	 * Windows: uses wmic to find processes by command line pattern
	 * Unix: uses pgrep to find processes by command pattern
	 */
	public static async cleanUpOrphans(): Promise<void> {
		try {
			if (process.platform === 'win32') {
				await OpenCodeServerManager._killOrphanedServersWindows();
			} else {
				await OpenCodeServerManager._killOrphanedServersUnix();
			}
		} catch (error) {
			// Not critical - just log and continue
			logger.debug('[OpenCodeServerManager] Could not check for orphaned processes:', error);
		}
	}

	/**
	 * Windows implementation: uses wmic to find and taskkill to terminate
	 */
	private static async _killOrphanedServersWindows(): Promise<void> {
		// Use wmic to find opencode.exe processes with "serve" in command line
		const result = cp.execSync(
			"wmic process where \"name='opencode.exe' and commandline like '%serve%'\" get processid /format:csv",
			{ encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
		);

		// Parse PIDs from CSV output (format: Node,ProcessId)
		const pids = OpenCodeServerManager._parsePidsFromCsv(result);

		if (pids.length > 0) {
			logger.info(
				`[OpenCodeServerManager] Found ${pids.length} orphaned opencode serve process(es): ${pids.join(', ')}`,
			);

			for (const pid of pids) {
				try {
					cp.execSync(`taskkill /T /F /PID ${pid}`, { stdio: 'ignore' });
					logger.info(`[OpenCodeServerManager] Killed orphaned process ${pid}`);
				} catch {
					// Process may have already exited
				}
			}
		}
	}

	/**
	 * Unix implementation: uses pgrep to find and kill to terminate
	 */
	private static async _killOrphanedServersUnix(): Promise<void> {
		// Use pgrep to find opencode processes with "serve" argument
		// -f = match against full command line
		let result: string;
		try {
			result = cp.execSync('pgrep -f "opencode.*serve"', {
				encoding: 'utf8',
				stdio: ['pipe', 'pipe', 'ignore'],
			});
		} catch {
			// pgrep returns exit code 1 if no processes found - that's fine
			return;
		}

		const pids = result
			.trim()
			.split('\n')
			.filter(line => /^\d+$/.test(line.trim()))
			.map(line => Number.parseInt(line.trim(), 10));

		if (pids.length > 0) {
			logger.info(
				`[OpenCodeServerManager] Found ${pids.length} orphaned opencode serve process(es): ${pids.join(', ')}`,
			);

			for (const pid of pids) {
				try {
					// SIGKILL for reliable termination
					process.kill(pid, 'SIGKILL');
					logger.info(`[OpenCodeServerManager] Killed orphaned process ${pid}`);
				} catch {
					// Process may have already exited
				}
			}
		}
	}

	/**
	 * Parse PIDs from wmic CSV output (format: Node,ProcessId)
	 */
	private static _parsePidsFromCsv(csvOutput: string): number[] {
		const lines = csvOutput
			.trim()
			.split('\n')
			.filter(line => line.trim());
		const pids: number[] = [];

		for (const line of lines) {
			const parts = line.split(',');
			const pidStr = parts[parts.length - 1]?.trim();
			if (pidStr && /^\d+$/.test(pidStr)) {
				pids.push(Number.parseInt(pidStr, 10));
			}
		}

		return pids;
	}

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

		// On Windows, shell:true is required because opencode is a .cmd/.ps1 wrapper.
		// Orphaned processes are handled by _killOrphanedServers() on startup.
		const proc = cp.spawn('opencode', args, {
			cwd,
			shell: isWindows,
			windowsHide: true,
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
