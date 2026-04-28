/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based) using @opencode-ai/sdk.
 * Parses token stats from `message.updated` SSE events (properties.info.tokens: {input, output, cache.read})
 * and emits `session_updated` with delta-based tokenStats compatible with SessionHandler aggregation.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type { Message, Part, TextPart } from '@opencode-ai/sdk/v2/client';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';

import { parseModelId } from '../../common';
import { PERMISSION_CATEGORIES } from '../../common/permissions';
import { logger } from '../../utils/logger';
import { buildPromptParts } from '../promptParts';
import type { CLIConfig, CLIExecutor } from './types';

// =============================================================================
// Types & Interfaces
// =============================================================================

/** Single entry from `client.session.messages()` response. */
type SessionMessageEntry = { info: Message; parts: Part[] };

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
	private sessionId: string | null = null;
	private directory: string | null = null;
	/** SDK client for typed API calls. Initialized after server is ready. */
	private sdkClient: OpencodeClient | null = null;

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;
	private eventRestartTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Bridge reference for sending SDK events directly to the webview.
	 * Set by ChatProvider after construction via `setBridge()`.
	 */
	private bridge: import('../../transport/OutboundBridge').OutboundBridge | null = null;

	/** Set the bridge reference for direct SDK event forwarding. */
	public setBridge(bridge: import('../../transport/OutboundBridge').OutboundBridge): void {
		this.bridge = bridge;
	}

	/** All session IDs that are currently active (main + subagent children). */
	private readonly activeSessions = new Set<string>();
	/** Sessions explicitly deleted/closed — SSE events for these are skipped to save CPU. */
	private readonly deletedSessions = new Set<string>();

	/** Guards against concurrent ensureServer calls. */
	private ensureServerPromise: Promise<void> | null = null;

	private readonly _commandsCache = new TtlCache<Array<{ name: string; description?: string }>>(
		5 * 60 * 1000,
	);
	private readonly _providersCache = new TtlCache<unknown>(5 * 60 * 1000);
	private readonly _agentsCache = new TtlCache<unknown>(5 * 60 * 1000);
	private readonly _skillsCache = new TtlCache<
		Array<{ name: string; description: string; location?: string; content?: string }>
	>(5 * 60 * 1000);
	private readonly _mcpCache = new TtlCache<unknown>(30 * 1000);

	// Keep track of the server process wrapper to close it properly if needed
	private serverInstance: { close(): void } | null = null;
	/** True if THIS process spawned the server (vs. connecting to one started by another window). */
	private isServerOwner = false;

	private static readonly DELETE_MESSAGE_BATCH_SIZE = 5;
	/** Give a just-starting server a brief chance to become healthy before killing processes. */
	private static readonly EXISTING_SERVER_GRACE_MS = 1500;
	/** Stashed config from the last successful ensureServer — needed for reconnect. */
	private lastConfig: CLIConfig | null = null;
	/** Timestamp when this window started the currently owned server instance. */
	private serverStartedAt: number | null = null;
	private static readonly LOCAL_SERVER_HOST = '127.0.0.1';
	private static readonly LOCAL_SERVER_PORT = OpenCodeExecutor.resolveLocalServerPort();

	getCapabilities(): ReadonlyArray<'SessionFork' | 'SetupHelper'> {
		return ['SessionFork'];
	}

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
			this.lastConfig = config;
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
			this.lastConfig = config;
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

		// No live server found — kill any zombie opencode processes holding ports,
		// then spawn a fresh one.
		await this.killZombieOpenCodeProcesses();
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
	 * Kill zombie opencode processes that are holding ports but not responding
	 * to health checks.  Best-effort — if we can't kill them, we proceed anyway
	 * and let the CLI's tryServe(4096) ?? tryServe(0) handle port conflicts.
	 */
	private async killZombieOpenCodeProcesses(): Promise<void> {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execFileAsync = promisify(execFile);

		try {
			if (process.platform === 'win32') {
				const pids = await this.getWindowsOpencodePids();
				for (const pid of pids) {
					try {
						await execFileAsync('taskkill', ['/PID', pid, '/F'], { timeout: 5000 });
						logger.info(`[OpenCode] Killed zombie opencode process PID ${pid}`);
					} catch {
						logger.warn(`[OpenCode] Failed to kill opencode PID ${pid}`);
					}
				}
			} else {
				try {
					await execFileAsync('pkill', ['-f', 'opencode.*serve'], { timeout: 5000 });
					logger.info('[OpenCode] Killed zombie opencode serve processes');
				} catch {
					// pkill returns non-zero if no processes matched — that's fine
				}
			}
		} catch (error) {
			logger.warn('[OpenCode] Failed to kill zombie processes', { error: String(error) });
		}
	}

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

	private isServerDownError(error: unknown): boolean {
		if (error instanceof Error) {
			const cause = (error as { cause?: { code?: string } }).cause;
			if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET') return true;
			if (error.message.includes('fetch failed')) return true;
		}
		return false;
	}

	private resetServerState(): void {
		logger.info('[OpenCode] Resetting server state for reconnection...');
		this.clearScheduledEventRestart();

		if (this.serverInstance) {
			try {
				this.serverInstance.close();
			} catch {}
			this.serverInstance = null;
		}
		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
		this.isServerOwner = false;
		this.serverStartedAt = null;
		this._commandsCache.clear();
		this._providersCache.clear();
		this._agentsCache.clear();
		this._skillsCache.clear();
		this._mcpCache.clear();
	}

	// =========================================================================
	// Health Monitor & Auto-Reconnect
	// =========================================================================

	private clearScheduledEventRestart(): void {
		if (this.eventRestartTimer) {
			clearTimeout(this.eventRestartTimer);
			this.eventRestartTimer = null;
		}
	}

	private scheduleEventStreamRestart(directory: string, delayMs = 2000): void {
		if (this.eventRestartTimer) return;
		this.eventRestartTimer = setTimeout(() => {
			this.eventRestartTimer = null;
			if (this.serverUrl && !this.eventStreamRunning) {
				this.startEventStream(this.serverUrl, directory);
			}
		}, delayMs);
	}

	/** Returns the SDK client or throws if not initialized. */
	private requireSdk(): OpencodeClient {
		if (!this.sdkClient) throw new Error('OpenCode SDK client not initialized');
		return this.sdkClient;
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		await this.ensureServer(config);
		try {
			await this.createNewSession(prompt, config);
		} catch (error) {
			if (this.isServerDownError(error)) {
				logger.warn('[OpenCode] Server connection lost during spawn');
				throw new Error(
					'OpenCode server connection lost. Use the restart button in the header to reconnect.',
				);
			} else {
				throw error;
			}
		}
		return null as unknown as ChildProcess;
	}

	async spawnFollowUp(
		prompt: string,
		sessionId: string,
		config: CLIConfig,
		attachments?: Parameters<CLIExecutor['spawnFollowUp']>[3],
	): Promise<ChildProcess> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		try {
			// Continue the existing session (no fork) - just send a message
			this.sessionId = sessionId;
			this.startEventStream(this.serverUrl, config.workspaceRoot);
			await this.sendPrompt(config.workspaceRoot, sessionId, prompt, config, attachments);
		} catch (error) {
			if (this.isServerDownError(error)) {
				logger.warn('[OpenCode] Server connection lost during followUp');
				throw new Error(
					'OpenCode server connection lost. Use the restart button in the header to reconnect.',
				);
			} else {
				throw error;
			}
		}
		return null as unknown as ChildProcess;
	}

	async truncateSession(sessionId: string, messageId: string, config: CLIConfig): Promise<void> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		logger.info('[OpenCode] Reverting session history to message', { sessionId, messageId });

		const client = this.requireSdk();
		await client.session.revert({
			sessionID: sessionId,
			messageID: messageId,
			directory: config.workspaceRoot,
		});
	}

	async deleteSessionMessagesFrom(
		sessionId: string,
		messageId: string,
		config: CLIConfig,
	): Promise<string[]> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		logger.info('[OpenCode] Deleting session messages from point without revert', {
			sessionId,
			messageId,
		});

		const client = this.requireSdk();
		const { data: messages, error: listError } = await client.session.messages({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});
		if (listError || !messages) {
			throw new Error(`Failed to list session messages: ${JSON.stringify(listError ?? null)}`);
		}

		const startIndex = messages.findIndex(entry => entry.info.id === messageId);
		if (startIndex === -1) {
			throw new Error(`Failed to find message ${messageId} in session ${sessionId}`);
		}

		const toDelete = messages
			.slice(startIndex)
			.map(entry => entry.info.id)
			.reverse();

		for (const _id of toDelete) {
		}

		for (
			let index = 0;
			index < toDelete.length;
			index += OpenCodeExecutor.DELETE_MESSAGE_BATCH_SIZE
		) {
			const chunk = toDelete.slice(index, index + OpenCodeExecutor.DELETE_MESSAGE_BATCH_SIZE);
			const results = await Promise.allSettled(
				chunk.map(async id => {
					const response = await fetch(`${this.serverUrl}/session/${sessionId}/message/${id}`, {
						method: 'DELETE',
						headers: {
							'x-opencode-directory': config.workspaceRoot,
						},
					});
					if (!response.ok) {
						throw new Error(
							`Failed to delete session message ${id}: ${response.status} ${response.statusText}`,
						);
					}
				}),
			);

			const firstError = results.find(
				(result): result is PromiseRejectedResult => result.status === 'rejected',
			);
			if (firstError) {
				throw firstError.reason instanceof Error
					? firstError.reason
					: new Error(String(firstError.reason));
			}
		}

		return [...toDelete].reverse();
	}

	async unrevertSession(sessionId: string, config: CLIConfig): Promise<void> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		logger.info('[OpenCode] Unreverting session', { sessionId });

		const client = this.requireSdk();
		await client.session.unrevert({
			sessionID: sessionId,
			directory: config.workspaceRoot,
		});
	}

	async createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		logger.info('[OpenCodeExecutor] Creating new session on existing server...');
		try {
			this.sessionId = await this.createSession(config.workspaceRoot);
			logger.info(`[OpenCodeExecutor] New session created: ${this.sessionId}`);

			this.startEventStream(this.serverUrl, config.workspaceRoot);
			await this.sendPrompt(config.workspaceRoot, this.sessionId, prompt, config);
		} catch (error) {
			if (this.isServerDownError(error)) {
				logger.warn('[OpenCode] Server connection lost while creating session');
				throw new Error(
					'OpenCode server connection lost. Use the restart button in the header to reconnect.',
				);
			} else {
				throw error;
			}
		}
		return null as unknown as ChildProcess;
	}

	/**
	 * Checks if a session title is the auto-generated default ("New session - <ISO>" or "Child session - <ISO>").
	 * Matches the official OpenCode `isDefaultTitle()` logic.
	 */
	private static isDefaultTitle(title: string): boolean {
		return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
			title,
		);
	}

	/**
	 * Fetches the first user message's summary title for a session.
	 * OpenCode stores LLM-generated titles on the session directly via ensureTitle(),
	 * but if that hasn't run yet, we fall back to the first user message text.
	 */
	/**
	 * Fetches the first user message's summary title for a session and reports
	 * whether the session contains any messages at all.
	 *
	 * Returns `{ title, hasMessages }`:
	 * - `hasMessages = false` only when the API returned an empty message list.
	 * - `title` may be `undefined` even when messages exist (e.g. no text part).
	 * - On API errors we assume messages exist (`hasMessages = true`) to avoid
	 *   accidentally hiding sessions.
	 */
	private async getSessionDisplayTitle(
		sessionId: string,
		directory: string,
	): Promise<{ title: string | undefined; hasMessages: boolean }> {
		try {
			const client = this.requireSdk();
			const { data: messages } = await client.session.messages({
				sessionID: sessionId,
				directory,
				limit: 3,
			});

			if (!Array.isArray(messages) || messages.length === 0) {
				return { title: undefined, hasMessages: false };
			}

			const userMsg = messages.find((m: SessionMessageEntry) => m.info?.role === 'user');
			if (!userMsg) {
				// Messages exist but none are from the user — still not empty.
				return { title: undefined, hasMessages: true };
			}

			const { info } = userMsg;
			if (info.role === 'user' && info.summary?.title) {
				return { title: info.summary.title, hasMessages: true };
			}

			const textPart = userMsg.parts.find(
				(p): p is TextPart => p.type === 'text' && !p.synthetic && !!p.text,
			);
			if (textPart?.text) {
				const cleaned = textPart.text.trim().split('\n')[0];
				const title = cleaned.length > 80 ? `${cleaned.substring(0, 77)}...` : cleaned;
				return { title, hasMessages: true };
			}

			// User message exists but has no extractable text (e.g. only attachments).
			return { title: undefined, hasMessages: true };
		} catch {
			// On error, assume messages exist to avoid hiding valid sessions.
			return { title: undefined, hasMessages: true };
		}
	}

	async listSessions(config: CLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
			/** true when the session has at least one user message. */
			hasMessages?: boolean;
			/** Server-side revert state — source of truth for whether the session is reverted. */
			revert?: { messageID: string; partID?: string };
		}>
	> {
		if (!this.serverUrl) {
			if (!config.workspaceRoot) return [];
			try {
				await this.ensureServer(config);
			} catch (error) {
				logger.warn('[OpenCode] listSessions: ensureServer failed', error);
				return [];
			}
			if (!this.serverUrl) return [];
		}

		try {
			const client = this.requireSdk();
			// Return the full session graph here, including child sessions.
			// Restore/runtime flows need access to subtasks so nested task cards can
			// hydrate their own transcripts. Call sites that only care about top-level
			// chats must filter `!parentID` explicitly.
			//
			// On Windows, VS Code returns uri.fsPath with a lowercase drive letter
			// (e.g. "c:\..."), while the OpenCode server stores sessions with an
			// uppercase drive letter (e.g. "C:\...") via realpathSync.native.
			// The SDK interceptor injects the client's directory into every GET
			// request, and the server filters by exact string match — so sessions
			// created with a different drive letter case become invisible.
			//
			// To work around this, we issue a second request with the alternate
			// drive letter case and merge the results, deduplicating by session ID.
			const { data: raw } = await client.session.list({});
			const sessions = Array.isArray(raw) ? raw : [];

			// Fetch sessions stored under the alternate drive letter case (Windows)
			if (this.directory && this.directory.length >= 2 && this.directory[1] === ':') {
				const curDrive = this.directory[0];
				const altDrive =
					curDrive === curDrive.toUpperCase() ? curDrive.toLowerCase() : curDrive.toUpperCase();
				const altDirectory = altDrive + this.directory.slice(1);

				try {
					const { data: altRaw } = await client.session.list({
						directory: altDirectory,
					});
					const altSessions = Array.isArray(altRaw) ? altRaw : [];
					if (altSessions.length > 0) {
						// Merge and deduplicate by session ID
						const seen = new Set(sessions.map(s => s.id));
						for (const s of altSessions) {
							if (!seen.has(s.id)) {
								sessions.push(s);
								seen.add(s.id);
							}
						}
						// Re-sort by time_updated descending
						sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
					}
				} catch {
					// Alternate drive letter fetch failed — not critical, continue
				}
			}

			logger.info('[OpenCode] listSessions: API returned', {
				rawCount: sessions.length,
			});

			const resolved = await Promise.all(
				sessions.map(async s => {
					const isChild = Boolean(s.parentID);
					let displayTitle: string | undefined;

					// Only resolve display titles for top-level sessions (expensive operation)
					let hasMessages = true;
					if (!isChild) {
						const rawTitle = s.title || '';

						if (!rawTitle || OpenCodeExecutor.isDefaultTitle(rawTitle)) {
							// Try to get a meaningful title from the first user message.
							const result = await this.getSessionDisplayTitle(s.id, config.workspaceRoot);
							displayTitle = result.title || rawTitle || undefined;
							hasMessages = result.hasMessages;
						} else {
							displayTitle = rawTitle;
						}
					} else {
						displayTitle = s.title || undefined;
					}

					return {
						id: s.id,
						title: displayTitle,
						lastModified: s.time?.updated || s.time?.created || Date.now(),
						created: s.time?.created,
						parentID: s.parentID,
						hasMessages,
						revert: s.revert
							? { messageID: s.revert.messageID, partID: s.revert.partID }
							: undefined,
					};
				}),
			);

			return resolved;
		} catch (error) {
			logger.warn('[OpenCode] listSessions: API call failed', error);
			return [];
		}
	}

	// =========================================================================
	// Metadata & Commands
	// =========================================================================

	private async preloadMetadata(): Promise<void> {
		if (!this.directory) return;
		logger.info('[OpenCode] Preloading metadata cache...');
		await Promise.allSettled([
			this.listCommands(this.directory),
			this.listConfigProviders(this.directory),
			this.listAgents(this.directory),
			this.listSkills(this.directory),
			this.getMcpStatus(this.directory),
		]);
		logger.info('[OpenCode] Metadata cache preloaded');
	}

	async executeCommand(
		command: string,
		_args: string[],
		config: CLIConfig,
		sessionId?: string,
	): Promise<void> {
		if (!this.serverUrl) await this.ensureServer(config);
		if (!this.directory) throw new Error('OpenCode server not ready');

		const directory = this.directory;
		const cmd = command.replace(/^\//, '');

		switch (cmd) {
			case 'compact':
			case 'summarize':
				await this.handleCompactCommand(config, sessionId);
				break;
			case 'commands':
				await this.handleListCommand('commands', () => this.listCommands(directory));
				break;
			case 'models':
				await this.handleListCommand('models', () => this.listConfigProviders(directory));
				break;
			case 'agents':
				await this.handleListCommand('agents', () => this.listAgents(directory));
				break;
			case 'status': {
				const mcp = await this.getMcpStatus(this.directory);
				logger.info('[OpenCode] Status:', { mcp });
				break;
			}
			default:
				await this.handleDynamicCommand(cmd);
				break;
		}
	}

	private async handleCompactCommand(config: CLIConfig, targetSessionId?: string): Promise<void> {
		const sid = targetSessionId || this.sessionId;
		if (!sid || !this.directory) throw new Error('No active session to compact');

		const parsed = parseModelId(config.model ?? '');
		if (!parsed) {
			logger.warn('[OpenCode] No model configured for compaction', { sessionId: sid });
			return;
		}

		// Ensure SSE stream is running — summarize triggers async server-side
		// processing that emits message.part.updated, session.compacted, etc.
		if (this.serverUrl) {
			this.startEventStream(this.serverUrl, config.workspaceRoot);
		}

		try {
			await this.sessionSummarize(this.directory, sid, {
				providerID: parsed.providerId,
				modelID: parsed.modelId,
			});
		} catch (error) {
			logger.error(`[OpenCode] Error compacting session: ${String(error)}`);
		}
	}

	private async handleListCommand(_name: string, fetcher: () => Promise<unknown>): Promise<void> {
		await fetcher();
		// Results are delivered to webview via SDK events, not CLI event emit.
	}

	private async handleDynamicCommand(cmd: string): Promise<void> {
		if (!this.directory) return;
		logger.warn(`Unknown OpenCode command: ${cmd}`);
	}

	// =========================================================================
	// API Helpers (Fetch Only)
	// =========================================================================

	private async listCommands(
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const cached = this._commandsCache.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.command.list({ directory });
			const commands = (data ?? []) as Array<{ name: string; description?: string }>;
			return this._commandsCache.set(commands);
		} catch {
			return [];
		}
	}

	private async listConfigProviders(directory: string): Promise<unknown> {
		const cached = this._providersCache.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.config.providers({ directory });
			return this._providersCache.set(data);
		} catch {
			return {};
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

	private async sessionSummarize(
		directory: string,
		sessionId: string,
		model: { providerID: string; modelID: string },
	): Promise<void> {
		const client = this.requireSdk();
		await client.session.summarize({
			sessionID: sessionId,
			providerID: model.providerID,
			modelID: model.modelID,
			directory,
		});
	}

	private async createSession(directory: string): Promise<string> {
		const client = this.requireSdk();
		const { data, error } = await client.session.create({ directory });
		if (error || !data?.id) throw new Error(`OpenCode create session: ${error ?? 'missing id'}`);
		return data.id;
	}

	/**
	 * Creates an empty session without sending a message.
	 * Used when user clicks "+" to create a new chat.
	 */
	async createEmptySession(config: CLIConfig): Promise<string> {
		await this.ensureServer(config);
		const sessionId = await this.createSession(config.workspaceRoot);
		this.sessionId = sessionId;
		logger.info(`[OpenCodeExecutor] Empty session created: ${sessionId}`);
		return sessionId;
	}

	async deleteSession(sessionId: string, config: CLIConfig): Promise<boolean> {
		try {
			const client = this.requireSdk();
			await client.session.delete({
				sessionID: sessionId,
				directory: config.workspaceRoot,
			});
			// Clean up per-session metadata to prevent unbounded Map growth
			this.cleanupSessionMessages(sessionId);
			logger.info(`[OpenCodeExecutor] Session deleted: ${sessionId}`);
			return true;
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to delete session:', error);
			return false;
		}
	}

	async renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean> {
		try {
			const client = this.requireSdk();
			await client.session.update({
				sessionID: sessionId,
				title,
				directory: config.workspaceRoot,
			});
			logger.info(`[OpenCodeExecutor] Session renamed: ${sessionId} -> "${title}"`);
			return true;
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to rename session:', error);
			return false;
		}
	}

	private async sendAbort(directory: string, sessionId: string): Promise<void> {
		const client = this.requireSdk();
		await client.session.abort({ sessionID: sessionId, directory });
	}

	private async sendPermissionReply(
		_directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		const client = this.requireSdk();
		const { error } = await client.permission.reply({
			requestID: requestId,
			reply: payload.reply,
			...(payload.message ? { message: payload.message } : {}),
		});
		if (error) throw new Error(`Permission reply failed: ${JSON.stringify(error)}`);
	}

	private async sendPrompt(
		directory: string,
		sessionId: string,
		prompt: string,
		config: CLIConfig,
		attachments?: Parameters<CLIExecutor['spawnFollowUp']>[3],
	): Promise<void> {
		const parsed = parseModelId(config.model ?? '');
		const modelProviderId = parsed?.providerId || '';

		const modelOverride = modelProviderId
			? { model: { providerID: modelProviderId, modelID: parsed?.modelId || '' } }
			: {};

		const parts = buildPromptParts({ text: prompt, attachments });

		const client = this.requireSdk();
		await client.session.promptAsync({
			sessionID: sessionId,
			directory,
			parts,
			...(config.messageID ? { messageID: config.messageID } : {}),
			...modelOverride,
			...(config.agent ? { agent: config.agent } : {}),
			...(config.variant ? { variant: config.variant } : {}),
		});
	}

	// =========================================================================
	// Event Streaming
	// =========================================================================

	private startEventStream(_baseUrl: string, directory: string): void {
		if (this.eventStreamRunning) return;
		this.clearScheduledEventRestart();
		this.eventStreamRunning = true;
		this.eventAbort = new AbortController();
		const signal = this.eventAbort.signal;
		const client = this.requireSdk();

		void (async () => {
			try {
				const { stream } = await client.event.subscribe(
					{
						directory,
					},
					{
						signal,
						sseDefaultRetryDelay: 250,
						sseMaxRetryAttempts: 6,
						sseMaxRetryDelay: 1500,
						onSseError: (error: unknown) => {
							if (!signal.aborted) {
								logger.warn('[OpenCode] SSE stream error (SDK will retry):', error);
							}
						},
					},
				);

				for await (const event of stream) {
					if (signal.aborted) break;
					this.handleSdkEvent(event);
				}
			} catch (error) {
				if (!signal.aborted) {
					logger.error('[OpenCode] Event stream error:', error);
				}
			} finally {
				this.eventStreamRunning = false;
				this.eventAbort = null;

				// Auto-restart SSE if the stream died but the server is still supposed to be up.
				// This only restores the event stream; server restarts stay manual.
				if (!signal.aborted && this.serverUrl && this.directory) {
					logger.info('[OpenCode] SSE stream ended unexpectedly, scheduling restart...');
					this.scheduleEventStreamRestart(this.directory);
				}
			}
		})();
	}

	/**
	 * Permission auto-approve callback. Set by ChatProvider via `setPermissionInterceptor()`.
	 * Returns true if the permission was auto-approved (don't forward to webview).
	 */
	private permissionInterceptor:
		| ((sessionId: string, props: Record<string, unknown>) => boolean)
		| null = null;

	/** Set the permission interceptor for auto-approve logic. */
	public setPermissionInterceptor(
		interceptor: (sessionId: string, props: Record<string, unknown>) => boolean,
	): void {
		this.permissionInterceptor = interceptor;
	}

	private handleSdkEvent(raw: unknown): void {
		const envelope = raw as { type: string; properties?: unknown };
		if (!envelope || typeof envelope.type !== 'string') return;

		const props = (envelope.properties ?? {}) as Record<string, unknown>;
		const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;

		// Skip deleted sessions
		if (sessionId && this.deletedSessions.has(sessionId)) return;

		// Track active sessions for abort
		if (envelope.type === 'session.status') {
			const status = props.status as { type?: string } | undefined;
			if (sessionId && status?.type === 'busy') {
				this.activeSessions.add(sessionId);
			} else if (sessionId && status?.type === 'idle') {
				this.activeSessions.delete(sessionId);
			}
		}
		if (envelope.type === 'session.idle' && sessionId) {
			this.activeSessions.delete(sessionId);
		}

		// Permission interceptor: auto-approve before forwarding to webview
		if (this.bridge) {
			if (envelope.type === 'permission.asked' && this.permissionInterceptor && sessionId) {
				if (!this.permissionInterceptor(sessionId, props)) {
					this.bridge.sendSdkEvent(envelope);
				}
				// If auto-approved, don't forward to webview
			} else {
				this.bridge.sendSdkEvent(envelope);
			}
		}

		this.emit('sdk_event', envelope);
	}

	async abortSession(sessionId: string): Promise<void> {
		if (!this.directory) return;
		await this.sendAbort(this.directory, sessionId).catch(e =>
			logger.warn(`[OpenCode] Failed to abort session ${sessionId}:`, e),
		);
		this.activeSessions.delete(sessionId);
	}

	async abort(): Promise<void> {
		if (this.directory) {
			// Abort ALL tracked sessions (main + subagent children) in parallel
			const sessionsToAbort = new Set<string>(this.activeSessions);
			if (this.sessionId) sessionsToAbort.add(this.sessionId);

			const dir = this.directory;
			await Promise.allSettled(
				[...sessionsToAbort].map(sid =>
					this.sendAbort(dir, sid).catch(e =>
						logger.warn(`[OpenCode] Failed to abort session ${sid}:`, e),
					),
				),
			);
			this.activeSessions.clear();
		}
		try {
			this.eventAbort?.abort();
		} catch {}
	}

	async kill(): Promise<void> {
		await this.abort();
		this.clearScheduledEventRestart();
		this.sessionId = null;
		this.eventStreamRunning = false;
		this.eventAbort = null;
		this.activeSessions.clear();
		this.deletedSessions.clear();
	}

	/** Remove per-session metadata to prevent unbounded growth. */
	private cleanupSessionMessages(sessionId: string): void {
		this.activeSessions.delete(sessionId);
		this.deletedSessions.add(sessionId);
	}

	async dispose(): Promise<void> {
		await this.kill();
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

	async respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void> {
		if (!this.directory) throw new Error('OpenCode server not running');
		const reply =
			decision.response ??
			(decision.approved ? (decision.alwaysAllow ? 'always' : 'once') : 'reject');
		await this.sendPermissionReply(this.directory, decision.requestId, {
			reply,
			message: reply === 'reject' ? 'User denied this request' : undefined,
		});
	}

	async respondToQuestion(decision: { requestId: string; answers: string[][] }): Promise<void> {
		const client = this.requireSdk();
		const { error } = await client.question.reply({
			requestID: decision.requestId,
			answers: decision.answers,
		});
		if (error) throw new Error(`Question reply failed: ${JSON.stringify(error)}`);
	}

	async rejectQuestion(requestId: string): Promise<void> {
		const client = this.requireSdk();
		const { error } = await client.question.reject({ requestID: requestId });
		if (error) throw new Error(`Question reject failed: ${JSON.stringify(error)}`);
	}

	getSessionId(): string | null {
		return this.sessionId;
	}
	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return this.serverUrl && this.directory
			? { baseUrl: this.serverUrl, directory: this.directory }
			: null;
	}

	isSessionActive(sessionId: string): boolean {
		return this.activeSessions.has(sessionId);
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

	// Aliases previously provided by CLIRunner facade
	/** Alias for ensureServer — used by ChatProvider. */
	async start(config: CLIConfig): Promise<void> {
		return this.ensureServer(config);
	}

	/** Alias for getAdminInfo — used by handlers. */
	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null {
		return this.getAdminInfo();
	}

	/** Returns the provider type. Always 'opencode'. */
	getProvider(): 'opencode' {
		return 'opencode';
	}

	// =========================================================================
	// Connection Status & Restart
	// =========================================================================

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

	/**
	 * Fully restart the OpenCode server process.
	 * Kills the existing server, resets state,
	 * then re-starts using the last known config.
	 * Returns true on success, false if no config is available.
	 */
	async restartServer(): Promise<boolean> {
		if (!this.lastConfig) {
			logger.warn('[OpenCode] Cannot restart: no previous config available');
			return false;
		}

		if (!this.isServerOwner) {
			logger.warn('[OpenCode] Cannot restart shared server from a non-owner window');
			return false;
		}

		logger.info('[OpenCode] Restarting server...');

		// Stop SSE before resetting state
		try {
			this.eventAbort?.abort();
		} catch {}
		this.clearScheduledEventRestart();
		this.eventStreamRunning = false;
		this.eventAbort = null;

		// Reset server state (kills process if owner)
		this.resetServerState();

		const config = this.lastConfig;

		try {
			await this.ensureServer(config);

			if (this.serverUrl) {
				this.startEventStream(this.serverUrl, config.workspaceRoot);
				logger.info('[OpenCode] Server restarted successfully');
				return true;
			}
		} catch (error) {
			logger.error('[OpenCode] Server restart failed:', error);
		}

		return false;
	}
}
