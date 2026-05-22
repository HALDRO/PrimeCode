/**
 * @file OpenCodeExecutor
 * @description Managed OpenCode runtime bridge with dynamic port, auth, and reattach support.
 *              Spawns `opencode serve --port=0` per workspace, persists runtime records in
 *              ~/.config/opencode/primecode.json for cross-window reattach, and guarantees
 *              owned runtime cleanup with explicit process-tree termination on restart/dispose.
 */

import { type ChildProcess, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import launch from 'cross-spawn';

import { logger } from '../../utils/logger';
import { normalizeDriveLetter } from '../../utils/path';
import {
	addRuntime,
	getAllRuntimes,
	getRuntimesForWorkspace,
	isProcessAlive,
	removeRuntime,
} from './primecodeConfig';
import type { CLIConfig, CLIExecutor } from './types';

// ─── Constants ───────────────────────────────────────────────────────────────

const AUTH_USERNAME = 'opencode';
const LOCAL_SERVER_HOST = '127.0.0.1';
const execFileAsync = promisify(execFile);

// ─── TTL Cache ───────────────────────────────────────────────────────────────

class TtlCache<T> {
	private data: T | null = null;
	private timestamp = 0;
	constructor(private readonly ttlMs: number) {}

	get(): T | null {
		if (this.data !== null && Date.now() - this.timestamp < this.ttlMs) return this.data;
		return null;
	}

	set(value: T): T {
		this.data = value;
		this.timestamp = Date.now();
		return value;
	}

	clear(): void {
		this.data = null;
	}
}

// ─── Process Kill ─────────────────────────────────────────────────────────────

/**
 * Kill a process tree asynchronously. On Windows uses `taskkill /T /F`.
 * On Unix it tries to signal the full process group first, then falls back to the parent PID.
 */
async function killProcessTree(pid: number | null, proc?: ChildProcess): Promise<void> {
	if (!pid) {
		if (proc && !proc.killed) {
			try {
				proc.kill('SIGTERM');
			} catch {}
		}
		return;
	}

	if (process.platform === 'win32') {
		try {
			await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
				windowsHide: true,
			});
			return;
		} catch {}
		if (proc && !proc.killed) {
			try {
				proc.kill();
			} catch {}
		}
		return;
	}

	try {
		process.kill(-pid, 'SIGTERM');
		return;
	} catch {}

	if (proc && !proc.killed) {
		try {
			proc.kill('SIGTERM');
			return;
		} catch {}
	}
	try {
		process.kill(pid, 'SIGTERM');
	} catch {}
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	private serverUrl: string | null = null;
	private directory: string | null = null;
	private sdkClient: OpencodeClient | null = null;
	private ensureServerPromise: Promise<void> | null = null;

	private readonly caches = {
		commands: new TtlCache<Array<{ name: string; description?: string }>>(5 * 60 * 1000),
		agents: new TtlCache<unknown>(5 * 60 * 1000),
		skills: new TtlCache<
			Array<{ name: string; description: string; location?: string; content?: string }>
		>(5 * 60 * 1000),
		mcp: new TtlCache<unknown>(30 * 1000),
	};

	private serverProc: ChildProcess | null = null;
	private serverPid: number | null = null;
	private isServerOwner = false;
	private serverStartedAt: number | null = null;
	private runtimeId: string | null = null;
	private authorizationHeader: string | null = null;

	// ─── Helpers ─────────────────────────────────────────────────────────

	private static normalizeDriveLetter(dir: string): string {
		return normalizeDriveLetter(dir);
	}

	private buildFetchHeaders(directory?: string, authorization?: string | null): Headers {
		const headers = new Headers();
		if (directory) {
			headers.set('x-opencode-directory', encodeURIComponent(directory));
		}
		if (authorization) {
			headers.set('authorization', authorization);
		}
		return headers;
	}

	public async request(path: string, init?: RequestInit): Promise<Response> {
		if (!this.serverUrl) throw new Error('OpenCode server is not initialized');
		const url = path.startsWith('http') ? path : new URL(path, this.serverUrl).toString();
		const headers = this.buildFetchHeaders(this.directory ?? undefined, this.authorizationHeader);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		return fetch(url, { ...init, headers });
	}

	private createRuntimeFetch(directory?: string, authorization?: string | null) {
		return (input: Request | URL | string, init?: RequestInit) => {
			const initCopy = { ...init };
			const headers = new Headers(input instanceof Request ? input.headers : initCopy.headers);
			const runtimeHeaders = this.buildFetchHeaders(directory, authorization);
			runtimeHeaders.forEach((value, key) => {
				if (!headers.has(key)) headers.set(key, value);
			});

			if (input instanceof Request) {
				runtimeHeaders.forEach((value, key) => {
					if (!input.headers.has(key)) input.headers.set(key, value);
				});
				return fetch(input);
			}

			initCopy.headers = headers;
			return fetch(input, initCopy);
		};
	}

	// ─── Health Check ────────────────────────────────────────────────────

	private async isOpenCodeServer(
		baseUrl: string,
		authorization = this.authorizationHeader,
	): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5_000);
		try {
			const res = await fetch(`${baseUrl}/global/health`, {
				method: 'GET',
				headers: this.buildFetchHeaders(undefined, authorization),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!res.ok) return false;
			const data = (await res.json()) as { healthy?: boolean };
			return data.healthy === true;
		} catch {
			clearTimeout(timeout);
			return false;
		}
	}

	// ─── Attach / Reconnect ──────────────────────────────────────────────

	/**
	 * Attach to an existing runtime from the registry.
	 * Used both during initial startup (tryReattach) and for reconnection after
	 * transient failures (tryReconnect). Unified to avoid code duplication.
	 */
	private attachToEntry(
		entry: {
			serverUrl: string;
			authorization: string;
			runtimeId: string;
			ownerPid: number;
			pid: number | null;
			createdAt: number;
		},
		directory: string,
	): void {
		this.serverUrl = entry.serverUrl;
		this.authorizationHeader = entry.authorization;
		this.runtimeId = entry.runtimeId;
		this.directory = directory;
		this.isServerOwner = entry.ownerPid === process.pid;
		this.serverPid = entry.pid;
		this.serverStartedAt = entry.createdAt;
		this.serverProc = null;
		this.initSdkClient();
	}

	private async tryReattach(config: CLIConfig): Promise<boolean> {
		const workspaceRoot = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
		const entries = getRuntimesForWorkspace(workspaceRoot);
		if (entries.length === 0) return false;

		for (const entry of entries) {
			if (await this.isOpenCodeServer(entry.serverUrl, entry.authorization)) {
				this.attachToEntry(entry, workspaceRoot);
				logger.info('[OpenCode] Reattached to managed local runtime', {
					serverUrl: this.serverUrl,
					runtimeId: this.runtimeId,
					pid: entry.pid,
					isOwner: this.isServerOwner,
				});
				void this.preloadMetadata();
				return true;
			}
		}

		return false;
	}

	async tryReconnect(workspaceRoot?: string): Promise<boolean> {
		const directory = workspaceRoot
			? OpenCodeExecutor.normalizeDriveLetter(workspaceRoot)
			: this.directory;
		if (!directory) return false;

		// Check if current connection is still alive
		if (this.serverUrl && (await this.isOpenCodeServer(this.serverUrl, this.authorizationHeader))) {
			return true;
		}

		// Try to find a live runtime in the registry
		const entries = getRuntimesForWorkspace(directory);
		for (const entry of entries) {
			if (await this.isOpenCodeServer(entry.serverUrl, entry.authorization)) {
				this.attachToEntry(entry, directory);
				logger.info('[OpenCode] Reconnected to managed runtime', { url: entry.serverUrl });
				return true;
			}
		}

		return false;
	}

	// ─── Orphan Cleanup ──────────────────────────────────────────────────

	private async cleanupOrphanRuntimes(): Promise<void> {
		const allEntries = getAllRuntimes();

		for (const entry of allEntries) {
			const serverAlive = await this.isOpenCodeServer(entry.serverUrl, entry.authorization);

			if (!serverAlive) {
				logger.info('[OpenCode] Removing dead runtime entry', {
					runtimeId: entry.runtimeId,
					pid: entry.pid,
				});
				if (entry.pid && isProcessAlive(entry.pid)) {
					await killProcessTree(entry.pid);
				}
				removeRuntime(entry.runtimeId);
				continue;
			}

			// Server alive but owner process dead — orphan, kill it
			if (!isProcessAlive(entry.ownerPid)) {
				logger.info('[OpenCode] Killing orphan runtime (owner dead)', {
					runtimeId: entry.runtimeId,
					pid: entry.pid,
					ownerPid: entry.ownerPid,
					workspaceRoot: entry.workspaceRoot,
				});
				if (entry.pid) {
					await killProcessTree(entry.pid);
				}
				removeRuntime(entry.runtimeId);
			}
		}
	}

	// ─── Server Lifecycle ────────────────────────────────────────────────

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;
		if (this.ensureServerPromise) {
			await this.ensureServerPromise;
			return;
		}

		this.ensureServerPromise = this.doEnsureServer(config);
		try {
			await this.ensureServerPromise;
		} finally {
			this.ensureServerPromise = null;
		}
	}

	private async doEnsureServer(config: CLIConfig): Promise<void> {
		if (config.serverUrl) {
			this.serverUrl = config.serverUrl;
			this.authorizationHeader = null;
			this.runtimeId = null;
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
			this.serverProc = null;
			this.initSdkClient();
			logger.info(`[OpenCode] Connected to configured server at ${this.serverUrl}`);
			return;
		}

		await this.cleanupOrphanRuntimes();
		if (await this.tryReattach(config)) return;
		await this.spawnServer(config.workspaceRoot, config);
	}

	private async spawnServer(workspaceRoot: string, config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;

		// Permissions are managed exclusively via the project config file.
		delete process.env.OPENCODE_PERMISSION;

		const password = randomUUID();
		const processEnv: Record<string, string | undefined> = {
			...process.env,
			...config.env,
			NODE_NO_WARNINGS: '1',
			NO_COLOR: '1',
			NPM_CONFIG_LOGLEVEL: 'error',
			OPENCODE_SERVER_USERNAME: AUTH_USERNAME,
			OPENCODE_SERVER_PASSWORD: password,
			OPENCODE_CONFIG_CONTENT:
				!process.env.OPENCODE_CONFIG_CONTENT && config.autoCompact !== false
					? JSON.stringify({ compaction: { auto: true } })
					: process.env.OPENCODE_CONFIG_CONTENT,
		};

		logger.info('[OpenCodeExecutor] Starting managed OpenCode runtime...');

		try {
			const { serverUrl, proc, pid } = await this.launchManagedServer(
				LOCAL_SERVER_HOST,
				config.serverTimeoutMs ?? 15_000,
				workspaceRoot,
				processEnv,
			);
			const runtimeId = randomUUID();
			const authorization = `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`).toString('base64')}`;
			const normalizedWorkspaceRoot = OpenCodeExecutor.normalizeDriveLetter(workspaceRoot);

			this.serverProc = proc;
			this.serverUrl = serverUrl;
			this.authorizationHeader = authorization;
			this.directory = normalizedWorkspaceRoot;
			this.runtimeId = runtimeId;
			this.serverPid = pid;
			this.isServerOwner = true;
			this.serverStartedAt = Date.now();

			addRuntime({
				runtimeId,
				serverUrl,
				authorization,
				workspaceRoot: normalizedWorkspaceRoot,
				createdAt: this.serverStartedAt,
				pid,
				ownerPid: process.pid,
			});

			this.initSdkClient();
			logger.info('[OpenCode] Managed runtime started', {
				serverUrl: this.serverUrl,
				runtimeId: this.runtimeId,
				pid,
			});
			void this.preloadMetadata();
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to start server:', error);
			throw error;
		}
	}

	private async launchManagedServer(
		hostname: string,
		timeoutMs: number,
		cwd: string,
		env: Record<string, string | undefined>,
	) {
		const proc = launch('opencode', ['serve', `--hostname=${hostname}`, '--port=0'], {
			cwd: cwd || undefined,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: process.platform !== 'win32',
		});

		const pid = typeof proc.pid === 'number' ? proc.pid : null;
		let output = '';
		const serverUrl = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				void killProcessTree(pid, proc);
				reject(new Error(`Timeout waiting for server to start after ${timeoutMs}ms`));
			}, timeoutMs);
			let resolved = false;

			const onData = (chunk: unknown) => {
				if (resolved) return;
				output += String(chunk);
				const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s\r\n]+)/);
				if (!match?.[1]) return;
				resolved = true;
				clearTimeout(timer);
				resolve(match[1]);
			};

			proc.stdout?.on('data', onData);
			proc.stderr?.on('data', onData);
			proc.on('error', (error: Error) => {
				clearTimeout(timer);
				reject(error);
			});
			proc.on('exit', (code: number | null) => {
				if (resolved) return;
				clearTimeout(timer);
				let message = `Server exited with code ${code}`;
				if (output.trim()) {
					message += `\nServer output: ${output}`;
				}
				reject(new Error(message));
			});
		});

		return { serverUrl, proc, pid };
	}

	// ─── Shutdown (unified for restart and dispose) ──────────────────────

	/**
	 * Graceful shutdown: POST /global/dispose to let the server clean up,
	 * then force-kill the process tree.
	 * Used by restartServer() where we have time for the REST call.
	 */
	private async shutdownGraceful(): Promise<void> {
		if (this.serverUrl) {
			try {
				await this.request('/global/dispose', {
					method: 'POST',
					signal: AbortSignal.timeout(3_000),
				});
			} catch (error) {
				logger.debug('[OpenCode] REST dispose failed, falling back to process kill', { error });
			}
		}
		await this.killOwnedProcess();
		this.clearState();
	}

	/**
	 * Immediate shutdown: kill the process tree without REST.
	 * Used by dispose() where VS Code gives minimal time for deactivate().
	 */
	private async shutdownImmediate(): Promise<void> {
		await this.killOwnedProcess();
		this.clearState();
	}

	private async killOwnedProcess(): Promise<void> {
		if (!this.isServerOwner) return;
		await killProcessTree(this.serverPid, this.serverProc ?? undefined);
		if (this.runtimeId) {
			removeRuntime(this.runtimeId);
		}
	}

	private clearState(): void {
		this.serverProc = null;
		this.serverPid = null;
		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
		this.isServerOwner = false;
		this.serverStartedAt = null;
		this.runtimeId = null;
		this.authorizationHeader = null;
	}

	async restartServer(config: CLIConfig): Promise<void> {
		await this.shutdownGraceful();
		await this.ensureServer(config);
	}

	async isServerHealthy(): Promise<boolean> {
		if (!this.serverUrl) return false;
		return this.isOpenCodeServer(this.serverUrl, this.authorizationHeader);
	}

	/**
	 * Called during VS Code deactivate(). Must be fast and synchronous where possible.
	 * No REST calls — just kill the process tree and clean up the registry.
	 */
	async dispose(): Promise<void> {
		await this.shutdownImmediate();
	}

	// ─── SDK Client ──────────────────────────────────────────────────────

	private initSdkClient(): void {
		if (!this.serverUrl) return;
		try {
			this.sdkClient = createOpencodeClient({
				baseUrl: this.serverUrl,
				headers: this.authorizationHeader ? { authorization: this.authorizationHeader } : undefined,
				...(this.directory ? { directory: this.directory } : {}),
				fetch: this.createRuntimeFetch(this.directory ?? undefined, this.authorizationHeader),
			});
			logger.info('[OpenCode] SDK client initialized');
		} catch (e) {
			logger.warn('[OpenCode] Failed to init SDK client, falling back to fetch:', e);
			this.sdkClient = null;
		}
	}

	private requireSdk(): OpencodeClient {
		if (!this.sdkClient) throw new Error('OpenCode SDK client not initialized');
		return this.sdkClient;
	}

	// ─── Metadata ────────────────────────────────────────────────────────

	private async preloadMetadata(): Promise<void> {
		if (!this.directory) return;
		logger.info('[OpenCode] Preloading metadata cache...');
		await Promise.allSettled([
			this.listCommands(this.directory),
			this.listAgents(this.directory),
			this.listSkills(this.directory),
			this.getMcpStatus(this.directory),
		]);
		logger.info('[OpenCode] Metadata cache preloaded');
	}

	public async listCommands(
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const cached = this.caches.commands.get();
		if (cached) return cached;
		try {
			if (!this.serverUrl) return [];
			const url = new URL('/command', this.serverUrl);
			url.searchParams.set('directory', directory);
			const response = await fetch(url, {
				headers: this.buildFetchHeaders(undefined, this.authorizationHeader),
			});
			if (!response.ok) return [];
			const data = (await response.json()) as Array<{ name?: string; description?: string }>;
			const commands = Array.isArray(data)
				? data
						.filter(
							(command): command is { name: string; description?: string } =>
								typeof command?.name === 'string' && command.name.trim().length > 0,
						)
						.map(command => ({
							name: command.name.trim(),
							...(typeof command.description === 'string'
								? { description: command.description }
								: {}),
						}))
				: [];
			return this.caches.commands.set(commands);
		} catch {
			return [];
		}
	}

	public async listAgents(directory: string): Promise<unknown> {
		const cached = this.caches.agents.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.agents({ directory });
			return this.caches.agents.set(data);
		} catch {
			return [];
		}
	}

	public async listSkills(
		directory: string,
	): Promise<Array<{ name: string; description: string; location?: string; content?: string }>> {
		const cached = this.caches.skills.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.skills({ directory });
			const skills = (data ?? []) as Array<{
				name: string;
				description: string;
				location?: string;
				content?: string;
			}>;
			return this.caches.skills.set(Array.isArray(skills) ? skills : []);
		} catch {
			return [];
		}
	}

	public async getMcpStatus(directory: string): Promise<unknown> {
		const cached = this.caches.mcp.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.mcp.status({ directory });
			return this.caches.mcp.set(data);
		} catch {
			return {};
		}
	}

	// ─── Public API ──────────────────────────────────────────────────────

	getAuthorizationHeader(): string | null {
		return this.authorizationHeader;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return this.serverUrl && this.directory
			? { baseUrl: this.serverUrl, directory: this.directory }
			: null;
	}

	getSdkClient(): OpencodeClient | null {
		return this.sdkClient;
	}

	clearSkillsCache(): void {
		this.caches.skills.clear();
	}

	clearCommandsCache(): void {
		this.caches.commands.clear();
	}

	clearAgentsCache(): void {
		this.caches.agents.clear();
	}

	clearMcpCache(): void {
		this.caches.mcp.clear();
	}

	getProvider(): 'opencode' {
		return 'opencode';
	}

	getConnectionDetails(): {
		serverUrl: string | null;
		isServerOwner: boolean;
		port: number | null;
		uptime: number | null;
		runtimeId: string | null;
	} {
		let port: number | null = null;
		if (this.serverUrl) {
			try {
				port = parseInt(new URL(this.serverUrl).port, 10) || null;
			} catch {}
		}
		return {
			serverUrl: this.serverUrl,
			isServerOwner: this.isServerOwner,
			port,
			uptime: this.serverStartedAt ? Math.max(0, Date.now() - this.serverStartedAt) : null,
			runtimeId: this.runtimeId,
		};
	}
}
