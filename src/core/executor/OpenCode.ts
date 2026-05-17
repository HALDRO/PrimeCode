/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI using @opencode-ai/sdk.
 */

import { EventEmitter } from 'node:events';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';

import { PERMISSION_CATEGORIES } from '../../common/permissions';
import { logger } from '../../utils/logger';
import { normalizeDriveLetter } from '../../utils/path';
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
		return normalizeDriveLetter(dir);
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

		const localServerUrl = this.getLocalServerUrl();
		if (await this.isOpenCodeServer(localServerUrl)) {
			logger.info(`[OpenCode] Connected to local server at ${localServerUrl}`);
			this.serverUrl = localServerUrl;
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
			this.initSdkClient();
			void this.preloadMetadata();
			return;
		}

		// No configured or canonical local server found — spawn a fresh one.
		await this.spawnServer(config.workspaceRoot, config);
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
	 * The desktop app treats its local runtime as a single well-known sidecar.
	 * PrimeCode follows the same model here: use one stable local address
	 * instead of scanning the machine for arbitrary opencode processes or
	 * attaching to random fallback ports from previous runs.
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
				port: OpenCodeExecutor.LOCAL_SERVER_PORT,
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
	 * Attempt to rediscover a live OpenCode server on the canonical local URL.
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

		// Probe canonical port only. Avoid scanning arbitrary opencode processes.
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
