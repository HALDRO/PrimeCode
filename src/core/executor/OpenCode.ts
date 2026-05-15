/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI using @opencode-ai/sdk.
 */

import { EventEmitter } from 'node:events';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';

import { PERMISSION_CATEGORIES } from '../../common/permissions';
import { logger } from '../../utils/logger';
import type { CLIConfig, CLIExecutor } from './types';

// =============================================================================
// TTL Cache Helper
// =============================================================================

/** Simple time-based cache with configurable TTL per instance. */
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

// =============================================================================
// Executor Implementation
// =============================================================================

export class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	private serverUrl: string | null = null;
	private directory: string | null = null;
	/** SDK client for typed API calls. Initialized after server is ready. */
	private sdkClient: OpencodeClient | null = null;

	private eventRestartTimer: ReturnType<typeof setTimeout> | null = null;

	/** Guards against concurrent ensureServer calls. */
	private ensureServerPromise: Promise<void> | null = null;

	private readonly _commandsCache = new TtlCache<Array<{ name: string; description?: string }>>(
		5 * 60 * 1000,
	);
	private readonly _agentsCache = new TtlCache<unknown>(5 * 60 * 1000);
	private readonly _skillsCache = new TtlCache<
		Array<{ name: string; description: string; location?: string; content?: string }>
	>(5 * 60 * 1000);
	private readonly _mcpCache = new TtlCache<unknown>(30 * 1000);

	// Keep track of the server process wrapper to close it properly if needed
	private serverInstance: { close(): void } | null = null;
	/** True if THIS process spawned the server (vs. connecting to one started by another window). */
	private isServerOwner = false;

	/** Give a just-starting server a brief chance to become healthy before killing processes. */
	private static readonly EXISTING_SERVER_GRACE_MS = 1500;
	/** Timestamp when this window started the currently owned server instance. */
	private serverStartedAt: number | null = null;
	private static readonly LOCAL_SERVER_HOST = '127.0.0.1';
	private static readonly LOCAL_SERVER_PORT = OpenCodeExecutor.resolveLocalServerPort();

	// =========================================================================
	// Server Management
	// =========================================================================

	private static resolveLocalServerPort(): number {
		const value = process.env.OPENCODE_PORT;
		const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
		return Number.isInteger(parsed) && parsed > 0 ? parsed : 4096;
	}

	/**
	 * Uppercase the Windows drive letter for consistent path comparison.
	 * VS Code `uri.fsPath` returns lowercase (`c:\...`), but the OpenCode server
	 * stores paths with uppercase (`C:\...`) via `realpathSync.native`.
	 * The server filters sessions by exact string match on `directory`.
	 */
	private static normalizeDriveLetter(dir: string): string {
		return dir.length >= 2 && dir[1] === ':' ? dir[0].toUpperCase() + dir.slice(1) : dir;
	}

	private getLocalServerUrl(): string {
		return `http://${OpenCodeExecutor.LOCAL_SERVER_HOST}:${OpenCodeExecutor.LOCAL_SERVER_PORT}`;
	}

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl) {
			return;
		}

		// Coalesce concurrent callers — only the first one actually starts the server.
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
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
			this.initSdkClient();
			logger.info(`[OpenCode] Connected to existing server at ${this.serverUrl}`);
			return;
		}

		if (await this.tryConnectToExistingServer(config)) return;
		if (await this.tryConnectToExistingServerWithGrace(config)) return;

		// No live server found — spawn a fresh one.
		await this.spawnServer(config.workspaceRoot, config);
	}

	/**
	 * When a user manually kills/reloads OpenCode, process discovery may briefly see
	 * a replacement server before `/global/health` is ready. Wait once and retry the
	 * same discovery path before deciding the processes are zombies and spawning again.
	 */
	private async tryConnectToExistingServerWithGrace(config: CLIConfig): Promise<boolean> {
		const ports = await this.discoverOpenCodePorts();
		if (ports.length === 0) return false;

		await new Promise(resolve => setTimeout(resolve, OpenCodeExecutor.EXISTING_SERVER_GRACE_MS));
		return this.tryConnectToExistingServer(config);
	}

	// =========================================================================
	// Process-based server discovery
	//
	// Instead of only probing a fixed port (4096), we discover ALL running
	// opencode processes, find which ports they listen on, and health-check
	// each one.  This handles:
	//   - Server on default port 4096
	//   - Server on random port (from previous port:0 spawn)
	//   - Zombie processes that hold a port but don't respond to health
	// =========================================================================

	/**
	 * Try to connect to any already-running OpenCode server.
	 * 1. Probe the canonical port first (fast path).
	 * 2. If that fails, discover opencode processes via OS, find their listen
	 *    ports, and health-check each one.
	 */
	private async tryConnectToExistingServer(config: CLIConfig): Promise<boolean> {
		// Fast path: try the canonical port (4096 or OPENCODE_PORT)
		const canonicalUrl = this.getLocalServerUrl();
		if (await this.isOpenCodeServer(canonicalUrl)) {
			logger.info(`[OpenCode] Connected to existing server at ${canonicalUrl}`);
			this.serverUrl = canonicalUrl;
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
			this.initSdkClient();
			void this.preloadMetadata();
			return true;
		}

		// Slow path: discover opencode processes and their listen ports
		const ports = await this.discoverOpenCodePorts();
		for (const port of ports) {
			if (port === OpenCodeExecutor.LOCAL_SERVER_PORT) continue; // already tried
			const url = `http://${OpenCodeExecutor.LOCAL_SERVER_HOST}:${port}`;
			if (await this.isOpenCodeServer(url)) {
				logger.info(
					`[OpenCode] Connected to existing server at ${url} (discovered via process scan)`,
				);
				this.serverUrl = url;
				this.isServerOwner = false;
				this.serverStartedAt = null;
				this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
				this.initSdkClient();
				void this.preloadMetadata();
				return true;
			}
		}

		return false;
	}

	/**
	 * Discover listen ports of running `opencode` processes.
	 * Uses OS-specific commands (runs in ~50-100ms).
	 */
	private async discoverOpenCodePorts(): Promise<number[]> {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		try {
			const isWindows = process.platform === 'win32';

			if (isWindows) {
				const pids = new Set(await this.getWindowsOpencodePids());
				if (pids.size === 0) return [];

				// Step 2: find which ports those PIDs are listening on
				const { stdout: netstatOut } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
					timeout: 5000,
				});
				const ports: number[] = [];
				for (const line of netstatOut.split('\n')) {
					if (!line.includes('LISTENING')) continue;
					const parts = line.trim().split(/\s+/);
					// Format: TCP  127.0.0.1:PORT  0.0.0.0:0  LISTENING  PID
					const pid = parts[parts.length - 1];
					if (!pids.has(pid)) continue;
					const addrPort = parts[1];
					const portStr = addrPort?.split(':').pop();
					if (portStr) {
						const port = Number.parseInt(portStr, 10);
						if (port > 0) ports.push(port);
					}
				}
				logger.info('[OpenCode] Discovered opencode processes', { pids: [...pids], ports });
				return ports;
			}

			// Linux / macOS: use `ss` or `lsof`
			try {
				// Try ss first (Linux)
				const { stdout } = await execFileAsync('ss', ['-tlnp'], { timeout: 5000 });
				const ports: number[] = [];
				for (const line of stdout.split('\n')) {
					if (!line.includes('opencode')) continue;
					const match = line.match(/:(\d+)\s/);
					if (match) ports.push(Number.parseInt(match[1], 10));
				}
				if (ports.length > 0) {
					logger.info('[OpenCode] Discovered opencode ports via ss', { ports });
					return ports;
				}
			} catch {
				// ss not available, try lsof (macOS)
			}

			try {
				const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
					timeout: 5000,
				});
				const ports: number[] = [];
				for (const line of stdout.split('\n')) {
					if (!line.includes('opencode')) continue;
					const match = line.match(/:(\d+)\s/);
					if (match) ports.push(Number.parseInt(match[1], 10));
				}
				logger.info('[OpenCode] Discovered opencode ports via lsof', { ports });
				return ports;
			} catch {
				// lsof not available either
			}

			return [];
		} catch (error) {
			logger.warn('[OpenCode] Failed to discover opencode processes', { error: String(error) });
			return [];
		}
	}

	/**
	 * Kill zombie opencode processes — REMOVED.
	 * This was destructive and could kill servers used by other VS Code windows.
	 * The server now relies on tryConnectToExistingServer discovery instead.
	 */

	private async getWindowsOpencodePids(): Promise<string[]> {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		try {
			const { stdout } = await execFileAsync(
				'tasklist',
				['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV', '/NH'],
				{ timeout: 5000 },
			);
			return [...stdout.matchAll(/"opencode\.exe","(\d+)"/gi)].map(match => match[1]);
		} catch {
			return [];
		}
	}

	/**
	 * Check if a real OpenCode server is running at the given URL.
	 * Uses the official `GET /global/health` endpoint which returns
	 * `{ healthy: true, version: string }`.
	 */
	private async isOpenCodeServer(baseUrl: string): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 20_000);
		try {
			const res = await fetch(`${baseUrl}/global/health`, {
				method: 'GET',
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

	/**
	 * Spawn a new OpenCode server process via the SDK.
	 *
	 * We pass `port: 0` so the CLI uses its built-in fallback logic:
	 *   tryServe(4096) ?? tryServe(0)
	 * This means it first tries the canonical port 4096, and if that's
	 * occupied it picks a random free port.  The SDK parses the actual URL
	 * from stdout, so we always get the correct address.
	 *
	 * Before reaching this point, tryConnectToExistingServer() has already
	 * scanned all running opencode processes and their ports.  If none
	 * responded to health checks, killZombieOpenCodeProcesses() has cleaned
	 * them up, so port 4096 should be free for the new server.
	 */
	private async spawnServer(workspaceRoot: string, config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;

		const autoApprove = config.autoApprove ?? false;
		const permissionsEnv = this.buildPermissionsEnv(autoApprove, config.env, config.policies);

		const processEnv = {
			...process.env,
			...config.env,
			NODE_NO_WARNINGS: '1',
			NO_COLOR: '1',
			NPM_CONFIG_LOGLEVEL: 'error',
			OPENCODE_PERMISSION: permissionsEnv,
			OPENCODE_CONFIG_CONTENT:
				!process.env.OPENCODE_CONFIG_CONTENT && config.autoCompact !== false
					? JSON.stringify({ compaction: { auto: true } })
					: process.env.OPENCODE_CONFIG_CONTENT,
		};

		logger.info('[OpenCodeExecutor] Starting OpenCode server via SDK...');
		const prevCwd = process.cwd();
		let changedCwd = false;

		try {
			if (workspaceRoot) {
				try {
					process.chdir(workspaceRoot);
					changedCwd = true;
				} catch (e) {
					logger.warn(`[OpenCode] Could not chdir to ${workspaceRoot}:`, e);
				}
			}

			Object.assign(process.env, processEnv);

			const { createOpencode } = await import('@opencode-ai/sdk/v2');
			const opencode = await createOpencode({
				hostname: OpenCodeExecutor.LOCAL_SERVER_HOST,
				port: 0,
				timeout: config.serverTimeoutMs ?? 15000,
			});

			this.serverInstance = { close: () => opencode.server.close() };
			this.serverUrl = opencode.server.url;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(workspaceRoot);
			this.isServerOwner = true;
			this.serverStartedAt = Date.now();

			this.initSdkClient();
			logger.info(`[OpenCode] Server started at ${this.serverUrl}`);
			void this.preloadMetadata();
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to start server:', error);
			throw error;
		} finally {
			if (changedCwd) {
				try {
					process.chdir(prevCwd);
				} catch {}
			}
		}
	}

	private buildPermissionsEnv(
		autoApprove: boolean,
		env?: Record<string, string>,
		policies?: Partial<Record<string, string>>,
	): string {
		if (env?.OPENCODE_PERMISSION) {
			try {
				const existing = JSON.parse(env.OPENCODE_PERMISSION);
				return JSON.stringify({ ...existing, question: 'allow' });
			} catch {}
		}

		// If autoApprove is on, allow everything unconditionally.
		if (autoApprove) {
			const result: Record<string, string> = { question: 'allow' };
			for (const cat of PERMISSION_CATEGORIES) result[cat] = 'allow';
			return JSON.stringify(result);
		}

		// Pass each UI policy directly to OpenCode as-is.
		// "deny" → "deny" (server rejects immediately, no round-trip).
		// "allow" → "allow" (server auto-approves).
		// "ask" or unset → "ask" (server sends permission.asked event).
		const result: Record<string, string> = { question: 'allow' };
		for (const cat of PERMISSION_CATEGORIES) {
			const val = policies?.[cat];
			if (val === 'allow' || val === 'deny') {
				result[cat] = val;
			} else {
				result[cat] = 'ask';
			}
		}
		return JSON.stringify(result);
	}

	/**
	 * Initialize the SDK client after server URL is known.
	 * Uses createOpencodeClient from @opencode-ai/sdk with directory header support.
	 */
	private initSdkClient(): void {
		if (!this.serverUrl) return;
		try {
			this.sdkClient = createOpencodeClient({
				baseUrl: this.serverUrl,
				...(this.directory ? { directory: this.directory } : {}),
			});
			logger.info('[OpenCode] SDK client initialized');
		} catch (e) {
			logger.warn('[OpenCode] Failed to init SDK client, falling back to fetch:', e);
			this.sdkClient = null;
		}
	}

	private clearScheduledEventRestart(): void {
		if (this.eventRestartTimer) {
			clearTimeout(this.eventRestartTimer);
			this.eventRestartTimer = null;
		}
	}

	/** Returns the SDK client or throws if not initialized. */
	private requireSdk(): OpencodeClient {
		if (!this.sdkClient) throw new Error('OpenCode SDK client not initialized');
		return this.sdkClient;
	}

	// =========================================================================
	// Metadata & Commands
	// =========================================================================

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

	// =========================================================================
	// API Helpers (Fetch Only)
	// =========================================================================

	public async listCommands(
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const cached = this._commandsCache.get();
		if (cached) return cached;
		try {
			if (!this.serverUrl) return [];
			const url = new URL('/command', this.serverUrl);
			url.searchParams.set('directory', directory);
			const response = await fetch(url);
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
			return this._commandsCache.set(commands);
		} catch {
			return [];
		}
	}

	public async listAgents(directory: string): Promise<unknown> {
		const cached = this._agentsCache.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.agents({ directory });
			return this._agentsCache.set(data);
		} catch {
			return [];
		}
	}

	/**
	 * Fetch skills from the OpenCode server via SDK v2.
	 */
	public async listSkills(
		directory: string,
	): Promise<Array<{ name: string; description: string; location?: string; content?: string }>> {
		const cached = this._skillsCache.get();
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
			return this._skillsCache.set(Array.isArray(skills) ? skills : []);
		} catch {
			return [];
		}
	}

	public async getMcpStatus(directory: string): Promise<unknown> {
		const cached = this._mcpCache.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.mcp.status({ directory });
			return this._mcpCache.set(data);
		} catch {
			return {};
		}
	}

	async dispose(): Promise<void> {
		this.clearScheduledEventRestart();
		if (this.serverInstance) {
			try {
				this.serverInstance.close();
			} catch {}
			this.serverInstance = null;
		}
		this.isServerOwner = false;

		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return this.serverUrl && this.directory
			? { baseUrl: this.serverUrl, directory: this.directory }
			: null;
	}

	getSdkClient(): OpencodeClient | null {
		return this.sdkClient;
	}

	/** Invalidate the skills cache so the next listSkills() call fetches fresh data. */
	clearSkillsCache(): void {
		this._skillsCache.clear();
	}

	/** Invalidate the commands cache so the next listCommands()/fetchCliCommands() call fetches fresh data. */
	clearCommandsCache(): void {
		this._commandsCache.clear();
	}

	/** Invalidate the agents cache so the next listAgents() call fetches fresh data. */
	clearAgentsCache(): void {
		this._agentsCache.clear();
	}

	/** Invalidate the MCP status cache so the next getMcpStatus() call fetches fresh data. */
	clearMcpCache(): void {
		this._mcpCache.clear();
	}

	/** Returns the provider type. Always 'opencode'. */
	getProvider(): 'opencode' {
		return 'opencode';
	}

	/**
	 * Attempt to rediscover a live OpenCode server via process scan.
	 * Does NOT spawn a new server — only reconnects to an existing one.
	 * Returns true if a live server was found and the client was reinitialized.
	 */
	async tryReconnect(workspaceRoot?: string): Promise<boolean> {
		const directory = workspaceRoot
			? OpenCodeExecutor.normalizeDriveLetter(workspaceRoot)
			: this.directory;
		if (!directory) return false;

		// First check if the current URL is actually alive (transient failure recovery)
		if (this.serverUrl && (await this.isOpenCodeServer(this.serverUrl))) {
			return true;
		}

		// Probe canonical port
		const canonicalUrl = this.getLocalServerUrl();
		if (await this.isOpenCodeServer(canonicalUrl)) {
			this.serverUrl = canonicalUrl;
			this.directory = directory;
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.initSdkClient();
			logger.info('[OpenCode] Reconnected to server at canonical port', { url: canonicalUrl });
			return true;
		}

		// Process scan for non-canonical ports
		const ports = await this.discoverOpenCodePorts();
		for (const port of ports) {
			if (port === OpenCodeExecutor.LOCAL_SERVER_PORT) continue;
			const url = `http://${OpenCodeExecutor.LOCAL_SERVER_HOST}:${port}`;
			if (await this.isOpenCodeServer(url)) {
				this.serverUrl = url;
				this.directory = directory;
				this.isServerOwner = false;
				this.serverStartedAt = null;
				this.initSdkClient();
				logger.info('[OpenCode] Reconnected to server via process scan', { url, port });
				return true;
			}
		}

		return false;
	}

	/**
	 * Returns connection details for the status UI.
	 */
	getConnectionDetails(): {
		serverUrl: string | null;
		isServerOwner: boolean;
		port: number | null;
		uptime: number | null;
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
			uptime:
				this.isServerOwner && this.serverStartedAt
					? Math.max(0, Date.now() - this.serverStartedAt)
					: null,
		};
	}
}
