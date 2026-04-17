/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based) using @opencode-ai/sdk.
 * Parses token stats from `message.updated` SSE events (properties.info.tokens: {input, output, cache.read})
 * and emits `session_updated` with delta-based tokenStats compatible with SessionHandler aggregation.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import type {
	EventMessagePartDelta,
	EventMessagePartUpdated,
	EventMessageUpdated,
	EventSessionError,
	EventSessionStatus,
	Message,
	Part,
	Event as SdkEvent,
	SessionStatus as SdkSessionStatus,
	Session,
	TextPart,
	ToolPart,
} from '@opencode-ai/sdk/v2/client';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';

import { asRecord, getStringField, parseModelId } from '../../common';
import { PERMISSION_CATEGORIES } from '../../common/permissions';
import {
	mapPermissionRuntimePayloadToRequest,
	mapQuestionRuntimePayloadToRequest,
	parseSessionTodoItem,
} from '../../common/schemas';
import { logger } from '../../utils/logger';
import { LogNormalizer } from './LogNormalizer';
import { mapSdkMessageToRecord, mapSdkPartToPayload } from './OpenCodeEventMapper';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

// =============================================================================
// Types & Interfaces
// =============================================================================

/** Single entry from `client.session.messages()` response. */
type SessionMessageEntry = { info: Message; parts: Part[] };

type AssistantInfo = Extract<Message, { role: 'assistant' }>;

/**
 * Extended session status that includes an 'other' fallback for unknown status types.
 * Mirrors SDK `SessionStatus` but adds graceful degradation.
 */
type OpenCodeSessionStatus = SdkSessionStatus | { type: 'other'; raw?: unknown };

/**
 * Normalized part type used internally.
 * SDK `Part` is the source of truth, but we keep a simplified view for event handling.
 */
type OpenCodePart =
	| {
			type: 'text' | 'reasoning';
			id?: string;
			messageID?: string;
			text?: string;
			sessionID?: string;
			synthetic?: boolean;
	  }
	| {
			type: 'tool';
			id?: string;
			messageID?: string;
			callID?: string;
			tool?: string;
			sessionID?: string;
			state?: {
				status?: 'pending' | 'running' | 'completed' | 'error';
				input?: unknown;
				output?: string;
				title?: string;
				metadata?: unknown;
			};
	  }
	| {
			type: 'file';
			messageID?: string;
			sessionID?: string;
			mime: string;
			url: string;
			filename?: string;
			source?: {
				type: 'file' | 'symbol';
				path: string;
				text: { value: string; start: number; end: number };
				range?: {
					start: { line: number; character: number };
					end: { line: number; character: number };
				};
				name?: string;
			};
	  }
	| {
			type: 'compaction';
			messageID?: string;
			sessionID?: string;
			auto?: boolean;
	  }
	| { type: 'other'; raw: unknown; sessionID?: string };

function isAssistantMessage(info: Message): info is AssistantInfo {
	return info.role === 'assistant';
}

function getTokenTotal(tokens: AssistantInfo['tokens']): number {
	const runtimeTotal = Reflect.get(tokens as object, 'total');
	return typeof runtimeTotal === 'number' ? runtimeTotal : tokens.input + tokens.output;
}

function isTaskToolName(name: string): boolean {
	return name === 'task' || name === 'Task';
}

function getTaskDescription(input: unknown): string {
	const record = asRecord(input);
	return getStringField(record, 'description') || getStringField(record, 'prompt');
}

function getMetadataSessionId(metadata: unknown): string | undefined {
	return getStringField(metadata, 'sessionId') || undefined;
}

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
	private readonly logNormalizer = new LogNormalizer();

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;
	private eventRestartTimer: ReturnType<typeof setTimeout> | null = null;

	/** Unified tool call lifecycle state — replaces separate seenToolCalls/taskToolsPendingInput/completedToolCalls Sets. */
	private readonly toolCallStates = new Map<string, { completed: boolean; hasInput: boolean }>();
	private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
	/** Maps messageID → agent name (e.g. 'plan', 'build') from assistant messages. */
	private readonly messageAgents = new Map<string, string>();
	/** Message IDs that already emitted a 'finished' event — prevents duplicate emissions when SDK re-sends message.updated with the same completed timestamp. */
	private readonly finishedMessageIds = new Set<string>();
	private lastEmittedStatus = new Map<string, string>();

	/** All session IDs that are currently active (main + subagent children). */
	private readonly activeSessions = new Set<string>();
	/** Reverse index: sessionID → Set<messageID>. Enables per-session cleanup of message-keyed Maps. */
	private readonly sessionMessages = new Map<string, Set<string>>();
	/** Sessions explicitly deleted/closed — SSE events for these are skipped to save CPU. */
	private readonly deletedSessions = new Set<string>();
	/** Maps sessionID → pending compact tool_use ID, so SSE handler can emit matching tool_result. */
	private readonly pendingCompactIds = new Map<string, string>();

	/** Guards against concurrent ensureServer calls. */
	private ensureServerPromise: Promise<void> | null = null;

	// Token stats tracking: snapshot of last known tokens per assistant message (for session_updated delta detection)
	private readonly lastMessageTokens = new Map<
		string,
		{ input: number; output: number; cacheRead: number }
	>();
	// Per-turn (keyed by userMessageId) accumulated duration and last total snapshot.
	// Token total is a snapshot (last value wins), but duration must be summed across steps.
	private readonly turnAccum = new Map<string, { total: number; durationMs: number }>();

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

	constructor() {
		super();
		this.logNormalizer.on('entry', entry => {
			if (entry.entryType.type === 'ErrorMessage') {
				this.emit('event', { type: 'error', data: { message: entry.content } });
			}
		});
	}

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
			this.emit('event', { type: 'error', data: { message: String(error) } });
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
		this.lastEmittedStatus.clear();
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
	): Promise<void> {
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
			this.emit('event', { type: 'session_updated', data: { sessionId: this.sessionId } });

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
			// Pass roots=true so the server filters out child sessions (subtasks)
			// at the SQL level BEFORE applying the limit. Without this, child
			// sessions consume most of the 100-row limit, leaving very few
			// top-level conversations visible in the history dropdown.
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
			const { data: raw } = await client.session.list({ roots: true });
			const sessions = Array.isArray(raw) ? raw : [];

			// Fetch sessions stored under the alternate drive letter case (Windows)
			if (this.directory && this.directory.length >= 2 && this.directory[1] === ':') {
				const curDrive = this.directory[0];
				const altDrive =
					curDrive === curDrive.toUpperCase() ? curDrive.toLowerCase() : curDrive.toUpperCase();
				const altDirectory = altDrive + this.directory.slice(1);

				try {
					const { data: altRaw } = await client.session.list({
						roots: true,
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

	async getHistory(sessionId: string, config: CLIConfig): Promise<CLIEvent[]> {
		if (!this.serverUrl) {
			if (!config.workspaceRoot) return [];
			try {
				await this.ensureServer(config);
			} catch {
				return [];
			}
			if (!this.serverUrl) return [];
		}

		try {
			const client = this.requireSdk();
			const { data: messages } = await client.session.messages({
				sessionID: sessionId,
				directory: config.workspaceRoot,
			});

			if (!Array.isArray(messages)) return [];

			// Track cumulative counters and latest model/provider info.
			let _assistantCount = 0;
			let _totalModelDuration = 0;
			let lastModelID: string | undefined;
			let lastProviderID: string | undefined;

			// Track per-turn token snapshots keyed by parent user message ID.
			// `total` from CLI is the context window snapshot — last value per turn wins.
			// Duration is summed across steps within a turn.
			const turnSnapshots = new Map<
				string,
				{ total: number; input: number; output: number; cacheRead: number; durationMs: number }
			>();
			// Track current user message ID for assistant messages without parentID
			let currentUserMessageId: string | undefined;
			// Track pending compaction tool_use ID so the next compaction assistant emits tool_result
			let pendingCompactToolId: string | undefined;

			const events = messages.flatMap((msg: SessionMessageEntry) => {
				const { info, parts } = msg;
				const role = info.role;
				const timestamp = info.time?.created
					? new Date(info.time.created).toISOString()
					: new Date().toISOString();

				// Aggregate tokens and duration from assistant messages
				if (info.role === 'assistant') {
					const { tokens } = info;
					_assistantCount++;

					// Track model info from assistant messages for replay
					if (info.modelID) lastModelID = info.modelID;
					if (info.providerID) lastProviderID = info.providerID;

					// Sum individual model response times (matches live behavior)
					const created = info.time?.created;
					const completed = info.time?.completed;
					if (typeof created === 'number' && typeof completed === 'number' && completed > created) {
						_totalModelDuration += completed - created;
					}

					// Collect snapshot for this turn (last value wins; delta computed on frontend)
					const turnKey = info.parentID || currentUserMessageId;
					if (turnKey && (tokens.input > 0 || tokens.output > 0)) {
						const total = getTokenTotal(tokens);
						// Compute per-assistant-message duration
						let msgDuration = 0;
						const msgCreated = info.time?.created;
						const msgCompleted = info.time?.completed;
						if (
							typeof msgCreated === 'number' &&
							typeof msgCompleted === 'number' &&
							msgCompleted > msgCreated
						) {
							msgDuration = msgCompleted - msgCreated;
						}
						// Update snapshot: total is last-wins, duration is summed
						const existing = turnSnapshots.get(turnKey);
						turnSnapshots.set(turnKey, {
							total, // snapshot — last value wins (context window size)
							input: tokens.input,
							output: tokens.output,
							cacheRead: tokens.cache.read,
							durationMs: (existing?.durationMs ?? 0) + msgDuration,
						});
					}

					// Handle compaction assistant messages — absorb into tool_result
					const assistantInfo = info as Record<string, unknown>;
					if (assistantInfo.mode === 'compaction' && pendingCompactToolId) {
						// Extract text from parts for the summary content
						const textParts = parts
							.map(p => this.normalizePart(p))
							.filter(
								(p): p is { type: 'text'; text: string } =>
									p.type === 'text' && Boolean((p as { text?: string }).text),
							)
							.map(p => (p as { text: string }).text);
						if (textParts.length > 0) {
							// Emit tool_result with the summary text, then clear pending
							const toolId = pendingCompactToolId;
							pendingCompactToolId = undefined;
							return [
								{
									type: 'tool_result' as const,
									data: {
										tool_use_id: toolId,
										name: 'Summarize Conversation',
										tool: 'Summarize Conversation',
										content: textParts.join('\n'),
										is_error: false,
									},
									sessionId,
								},
							];
						}
						// Empty compaction assistant (aborted) — skip entirely
						return [];
					}
				}

				// For user messages, collect file parts to reconstruct attachments
				if (role === 'user') {
					currentUserMessageId = info.id;
					const { content, attachments, isCompaction } = this.extractUserMessageParts(parts);

					// Compaction user messages — emit tool_use only, tool_result comes from next assistant
					if (isCompaction) {
						const compactId = `compact-hist-${info.id}`;
						// If there's already a pending compaction (retry), don't emit another tool_use
						// Just update the pending ID so the next assistant's text goes to the right tool_result
						if (pendingCompactToolId) {
							pendingCompactToolId = compactId;
							return [];
						}
						pendingCompactToolId = compactId;
						return [
							{
								type: 'tool_use' as const,
								data: {
									id: compactId,
									name: 'Summarize Conversation',
									tool: 'Summarize Conversation',
									toolUseId: compactId,
									input: {},
									state: 'completed',
									timestamp,
								},
								sessionId,
							},
						];
					}

					return [
						{
							type: 'normalized_log' as const,
							data: {
								role: 'user',
								content,
								timestamp,
								messageId: info.id,
								...(info.summary
									? {
											summary: {
												title: info.summary.title,
												diffs: Array.isArray(info.summary.diffs)
													? info.summary.diffs.map(diff => ({
															file: diff.file,
															additions: diff.additions,
															deletions: diff.deletions,
															status: diff.status,
														}))
													: [],
											},
										}
									: {}),
								...(attachments ? { attachments } : {}),
							},
							normalizedEntry: {
								entryType: 'UserMessage' as const,
								content: content || '',
								timestamp,
							},
							sessionId,
						},
					];
				}

				return parts.flatMap((sdkPart: Part) => {
					const part = this.normalizePart(sdkPart);
					const partEvents: CLIEvent[] = [];

					if (part.type === 'tool' && part.callID) {
						const { callID, tool: name = 'unknown', state } = part;
						const status = state?.status;
						const input = (state?.input ?? {}) as Record<string, unknown>;
						const stateTime = Reflect.get((state ?? {}) as object, 'time');
						const toolTime =
							stateTime && typeof stateTime === 'object'
								? (stateTime as { start?: number; end?: number })
								: undefined;
						const toolStartTs =
							typeof toolTime?.start === 'number'
								? new Date(toolTime.start).toISOString()
								: timestamp;
						const toolEndTs =
							typeof toolTime?.end === 'number'
								? new Date(toolTime.end).toISOString()
								: typeof info.time?.completed === 'number'
									? new Date(info.time.completed).toISOString()
									: timestamp;

						// Always emit tool_use for history
						const normalized = this.logNormalizer.normalizeToolUse(name, input, callID);
						partEvents.push({
							type: 'tool_use' as const,
							data: {
								tool: name,
								input,
								toolUseId: callID,
								timestamp: toolStartTs,
							},
							normalizedEntry: normalized,
							sessionId,
						});

						// If completed or error, emit tool_result
						if (status === 'completed' || status === 'error') {
							const isTask = isTaskToolName(name);
							const taskDescription = isTask ? getTaskDescription(input) : '';
							const outputText = typeof state?.output === 'string' ? state.output : '';
							const resultNormalized = isTask
								? this.logNormalizer.normalizeTaskResult(
										callID,
										taskDescription,
										outputText,
										status === 'error',
									)
								: undefined;
							partEvents.push({
								type: 'tool_result' as const,
								data: {
									tool: name,
									content: state?.output || '',
									is_error: status === 'error',
									tool_use_id: callID,
									timestamp: toolEndTs,
									title: state?.title,
									metadata: state?.metadata,
									input: state?.input,
								},
								...(resultNormalized ? { normalizedEntry: resultNormalized } : {}),
								sessionId,
							});
						}
					}

					return partEvents;
				});
			});

			// Emit turn_tokens with snapshot totals per user turn.
			// `total` from CLI is the context window size — that's what we show per user message.
			// Duration is summed across steps within a turn. Total is last-wins snapshot.
			for (const [turnKey, snap] of turnSnapshots) {
				events.push({
					type: 'turn_tokens' as const,
					data: {
						inputTokens: snap.input,
						outputTokens: snap.output,
						totalTokens: snap.total,
						cacheReadTokens: snap.cacheRead,
						...(snap.durationMs > 0 ? { durationMs: snap.durationMs } : {}),
						userMessageId: turnKey,
					},
					sessionId,
				});
			}

			if (lastModelID) {
				events.push({
					type: 'session_updated' as const,
					data: {
						modelID: lastModelID,
						providerID: lastProviderID,
					},
					sessionId,
				});
			}

			return events;
		} catch (_error) {
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
				this.emit('event', {
					type: 'tool_result',
					data: {
						tool_use_id: 'system',
						name: 'status',
						content: JSON.stringify({ mcp }, null, 2),
					},
				});
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
			this.emitToolResult('compact', 'Error: No model configured for compaction.', true, sid);
			return;
		}

		// Emit tool_use immediately in "running" state so the user sees a spinner card
		const compactId = `compact-${Date.now()}`;
		this.pendingCompactIds.set(sid, compactId);
		this.emit('event', {
			type: 'tool_use' as const,
			data: {
				id: compactId,
				name: 'Summarize Conversation',
				tool: 'Summarize Conversation',
				toolUseId: compactId,
				input: {},
				state: 'running',
				timestamp: new Date().toISOString(),
			},
			sessionId: sid,
		});

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
			// The session.compacted SSE event will emit tool_result when done.
		} catch (error) {
			this.pendingCompactIds.delete(sid);
			this.emitToolResult('compact', `Error compacting session: ${String(error)}`, true, sid);
		}
	}

	private async handleListCommand(name: string, fetcher: () => Promise<unknown>): Promise<void> {
		const data = await fetcher();
		this.emitToolResult(name, JSON.stringify(data, null, 2));
	}

	private emitToolResult(name: string, content: string, isError = false, sessionId?: string): void {
		this.emit('event', {
			type: 'tool_result',
			data: { tool_use_id: 'system', name, content, is_error: isError },
			sessionId: sessionId || this.sessionId || undefined,
		});
	}

	private async handleDynamicCommand(cmd: string): Promise<void> {
		if (!this.directory) return;
		// Generic execution logic could go here
		logger.warn(`Unknown OpenCode command: ${cmd}`);
		this.emit('event', { type: 'error', data: { message: `Unknown command: ${cmd}` } });
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

		// Build prompt parts: text + file attachments
		const parts: Array<
			| { type: 'text'; text: string }
			| { type: 'file'; mime: string; url: string; filename?: string }
		> = [{ type: 'text' as const, text: prompt }];

		if (attachments) {
			// Attach workspace files as file parts
			for (const filePath of attachments.files ?? []) {
				const fileUrl = filePath.startsWith('file://')
					? filePath
					: `file://${filePath.replace(/\\/g, '/')}`;
				const fileName = filePath.split(/[\\/]/).pop() || filePath;
				parts.push({ type: 'file' as const, mime: 'text/plain', url: fileUrl, filename: fileName });
			}

			// Attach code snippets as file parts with line ranges
			for (const snippet of attachments.codeSnippets ?? []) {
				const snippetUrl = new URL(
					snippet.filePath.startsWith('file://')
						? snippet.filePath
						: `file://${snippet.filePath.replace(/\\/g, '/')}`,
				);
				if (snippet.startLine) snippetUrl.searchParams.set('start', String(snippet.startLine));
				if (snippet.endLine) snippetUrl.searchParams.set('end', String(snippet.endLine));
				const fileName = snippet.filePath.split(/[\\/]/).pop() || snippet.filePath;
				parts.push({
					type: 'file' as const,
					mime: 'text/plain',
					url: snippetUrl.toString(),
					filename: fileName,
				});
			}

			// Attach images as file parts with data URLs
			// Always use dataUrl (base64) — LLM providers cannot read file:// URLs
			for (const img of attachments.images ?? []) {
				const mime = img.dataUrl.match(/^data:([^;]+)/)?.[1] || 'image/png';
				parts.push({ type: 'file' as const, mime, url: img.dataUrl, filename: img.name });
			}
		}

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
					this.emit('event', { type: 'error', data: { message: String(error) } });
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

	private handleSdkEvent(raw: unknown): void {
		const envelope = raw as { type: string; properties?: unknown };
		if (!envelope || typeof envelope.type !== 'string') return;

		// Handle events not in SDK Event union before narrowing
		if (envelope.type === 'question.asked') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			this.handleQuestionAsked(props, sessionId);
			return;
		}
		if (envelope.type === 'question.replied' || envelope.type === 'question.rejected') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			this.emit('event', {
				type: 'question_replied',
				data: {
					sessionID: sessionId || '',
					requestID: typeof props.requestID === 'string' ? props.requestID : '',
					answers: Array.isArray(props.answers) ? (props.answers as string[][]) : undefined,
					rejected: envelope.type === 'question.rejected',
				},
				sessionId,
			});
			return;
		}
		if (envelope.type === 'permission.asked') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			this.handlePermissionAsked(props, sessionId);
			return;
		}
		if (envelope.type === 'permission.replied') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			this.emit('event', {
				type: 'permission_replied',
				data: {
					sessionID: sessionId || '',
					requestID: typeof props.requestID === 'string' ? props.requestID : '',
					reply:
						typeof props.reply === 'string'
							? (props.reply as 'once' | 'always' | 'reject')
							: undefined,
				},
				sessionId,
			});
			return;
		}
		if (envelope.type === 'todo.updated') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			const todosRaw = Array.isArray(props.todos) ? props.todos : [];
			this.emit('event', {
				type: 'todo',
				data: {
					sessionID: sessionId || '',
					todos: todosRaw.flatMap(value => {
						const todo = parseSessionTodoItem(value);
						return todo ? [todo] : [];
					}),
				},
				sessionId,
			});
			return;
		}
		if (envelope.type === 'message.part.delta') {
			const props = (envelope as EventMessagePartDelta).properties;
			if (props.sessionID && this.deletedSessions.has(props.sessionID)) return;
			this.handlePartDelta(props);
			return;
		}

		const event = raw as SdkEvent;

		// Skip all events for sessions that have been deleted/closed.
		// The SSE stream is global, so stale events may arrive after cleanup.
		const eventSessionId =
			(
				event as {
					properties?: {
						info?: { sessionID?: string };
						part?: { sessionID?: string };
						sessionID?: string;
					};
				}
			).properties?.info?.sessionID ??
			(event as { properties?: { part?: { sessionID?: string } } }).properties?.part?.sessionID ??
			(event as { properties?: { sessionID?: string } }).properties?.sessionID;
		if (eventSessionId && this.deletedSessions.has(eventSessionId)) return;

		switch (event.type) {
			case 'session.created': {
				const props = (envelope as { type: string; properties: { info: Session } }).properties;
				const info = props.info;
				this.emit('event', {
					type: 'session_created',
					data: {
						sessionID: info.id,
						parentID: info.parentID ?? undefined,
						title: info.title ?? undefined,
					},
					sessionId: info.id,
				});
				break;
			}
			case 'message.updated': {
				const props = (event as EventMessageUpdated).properties;
				const sessionId = props.info.sessionID;
				this.handleMessageUpdated(props.info, sessionId);
				break;
			}
			case 'message.removed': {
				const props = (
					event as {
						type: 'message.removed';
						properties: { sessionID: string; messageID: string };
					}
				).properties;
				this.emit('event', {
					type: 'message_record_removed',
					data: {
						sessionID: props.sessionID,
						messageID: props.messageID,
					},
					sessionId: props.sessionID,
				});
				break;
			}
			case 'message.part.updated': {
				const props = (event as EventMessagePartUpdated).properties;
				const sessionId = props.part.sessionID;
				this.handlePartUpdated(props, sessionId);
				break;
			}
			case 'message.part.removed': {
				const props = (
					event as {
						type: 'message.part.removed';
						properties: { sessionID: string; messageID: string; partID: string };
					}
				).properties;
				this.emit('event', {
					type: 'message_part_removed',
					data: {
						sessionID: props.sessionID,
						messageID: props.messageID,
						partID: props.partID,
					},
					sessionId: props.sessionID,
				});
				break;
			}
			case 'session.status': {
				const props = (envelope as EventSessionStatus).properties;
				const sessionId = props.sessionID;
				this.handleSessionStatus(props.status, sessionId);
				if (sessionId) {
					if (props.status.type === 'busy') {
						this.activeSessions.add(sessionId);
					} else if (props.status.type === 'idle') {
						this.activeSessions.delete(sessionId);
					}
				}
				break;
			}
			case 'session.error': {
				const props = (envelope as EventSessionError).properties;
				const sessionId = props.sessionID;
				this.handleSessionError(props.error, sessionId);
				break;
			}
			case 'session.idle': {
				const props = (envelope as { type: string; properties: { sessionID: string } }).properties;
				if (props.sessionID) this.activeSessions.delete(props.sessionID);
				this.emit('event', {
					type: 'finished',
					data: { reason: 'idle' },
					sessionId: props.sessionID,
				});
				break;
			}
			case 'session.diff': {
				const props = (
					envelope as {
						type: string;
						properties: {
							sessionID: string;
							diff: Array<{ file: string; additions: number; deletions: number; status?: string }>;
						};
					}
				).properties;
				this.emit('event', {
					type: 'session_diff' as const,
					data: {
						sessionID: props.sessionID,
						diff: (props.diff || []).map(d => ({
							file: d.file,
							additions: d.additions || 0,
							deletions: d.deletions || 0,
							status: d.status as 'added' | 'deleted' | 'modified' | undefined,
						})),
					},
					sessionId: props.sessionID,
				});
				break;
			}
			case 'session.compacted': {
				// Compaction completed — emit tool_result to complete the running tool card
				const props = (envelope as { type: string; properties: { sessionID: string } }).properties;
				const sid = props.sessionID;
				logger.info('[OpenCode] Session compacted', { sessionId: sid });

				// Use the pending compact ID if we initiated it, otherwise create a new pair
				const pendingId = this.pendingCompactIds.get(sid);
				if (pendingId) {
					// We already emitted tool_use in running state — just emit tool_result
					this.pendingCompactIds.delete(sid);
					this.emit('event', {
						type: 'tool_result' as const,
						data: {
							tool_use_id: pendingId,
							name: 'Summarize Conversation',
							tool: 'Summarize Conversation',
							content: 'Session context compacted successfully.',
							is_error: false,
						},
						sessionId: sid,
					});
				} else {
					// Auto-compaction from server (not user-initiated) — emit both tool_use + tool_result
					const compactId = `compact-${Date.now()}`;
					this.emit('event', {
						type: 'tool_use' as const,
						data: {
							id: compactId,
							name: 'Summarize Conversation',
							tool: 'Summarize Conversation',
							toolUseId: compactId,
							input: {},
							state: 'completed',
							timestamp: new Date().toISOString(),
						},
						sessionId: sid,
					});
					this.emit('event', {
						type: 'tool_result' as const,
						data: {
							tool_use_id: compactId,
							name: 'Summarize Conversation',
							tool: 'Summarize Conversation',
							content: 'Session context compacted successfully.',
							is_error: false,
						},
						sessionId: sid,
					});
				}
				break;
			}
		}
	}

	private handleMessageUpdated(info: Message, sessionId?: string): void {
		const mappedRecord = mapSdkMessageToRecord(info, {
			agent: isAssistantMessage(info) ? this.messageAgents.get(info.id) : undefined,
		});
		this.emit('event', {
			type: 'message_record',
			data: {
				id: info.id,
				sessionID: info.sessionID,
				role: info.role,
				parentID: mappedRecord.parentId,
				createdAt: info.time?.created,
				completedAt: mappedRecord.completedAt,
				modelID: mappedRecord.modelId,
				providerID: mappedRecord.providerId,
				agent: mappedRecord.agent,
				tokens: mappedRecord.tokens,
				cost: mappedRecord.cost,
			},
			sessionId,
		});

		this.messageRoles.set(info.id, info.role);

		// Track message→session mapping for per-session cleanup
		if (sessionId) {
			let msgs = this.sessionMessages.get(sessionId);
			if (!msgs) {
				msgs = new Set();
				this.sessionMessages.set(sessionId, msgs);
			}
			msgs.add(info.id);
		}

		// Store agent/mode from assistant messages for later use in part events
		if (isAssistantMessage(info)) {
			// SDK Message type doesn't expose `mode`, but the runtime object carries it.
			const mode = (info as Message & { mode?: string }).mode;
			if (mode && mode !== 'compaction') {
				this.messageAgents.set(info.id, mode);
			}
			const { tokens } = info;
			const userMessageId = info.parentID;
			const input = tokens.input;
			const output = tokens.output;
			const total = getTokenTotal(tokens);
			const cacheRead = tokens.cache.read;

			// Detect token changes for session_updated emission (context bar, etc.)
			const prev = this.lastMessageTokens.get(info.id) ?? { input: 0, output: 0, cacheRead: 0 };
			const hasTokenDelta =
				input !== prev.input || output !== prev.output || cacheRead !== prev.cacheRead;
			this.lastMessageTokens.set(info.id, { input, output, cacheRead });

			const modelID = info.modelID || undefined;
			const providerID = info.providerID || undefined;

			// Emit session_updated only for model/provider changes.
			if (hasTokenDelta) {
				if (modelID) {
					this.emit('event', { type: 'session_updated', data: { modelID, providerID }, sessionId });
				}
			} else if (modelID) {
				this.emit('event', { type: 'session_updated', data: { modelID, providerID }, sessionId });
			}

			// On step completion: emit turn_tokens with the SNAPSHOT total (not deltas).
			// `total` from CLI is the context window size — that's what we show per user message.
			// Duration is summed across steps within a turn.
			const completed = info.time.completed;
			const hasCompleted = typeof completed === 'number';
			const started = info.time.created;
			const durationMs = hasCompleted && started > 0 ? completed - started : undefined;
			const finish = (info as Record<string, unknown>).finish as string | undefined;
			const isStepDone = hasCompleted || !!finish;

			if (isStepDone) {
				// Accumulate duration per user turn, but total is always a snapshot (last wins).
				// Skip zero-total steps (empty/aborted messages) to avoid overwriting real data.
				if (userMessageId) {
					const prev = this.turnAccum.get(userMessageId) ?? { total: 0, durationMs: 0 };
					this.turnAccum.set(userMessageId, {
						total: total > 0 ? total : prev.total, // keep previous if current is 0
						durationMs: prev.durationMs + (durationMs ?? 0),
					});
				}

				// Emit turn_tokens with snapshot total + accumulated duration
				if (total > 0) {
					const accum = userMessageId ? this.turnAccum.get(userMessageId) : undefined;
					this.emit('event', {
						type: 'turn_tokens',
						data: {
							inputTokens: input,
							outputTokens: output,
							totalTokens: total,
							cacheReadTokens: cacheRead,
							...(userMessageId ? { userMessageId } : {}),
							...(accum ? { durationMs: accum.durationMs } : durationMs ? { durationMs } : {}),
						},
						sessionId,
					});
				}

				if (hasCompleted && !this.finishedMessageIds.has(info.id)) {
					this.finishedMessageIds.add(info.id);
					this.emit('event', {
						type: 'finished',
						data: { reason: 'message_completed' },
						sessionId,
					});
				}
			}
		}
	}

	/**
	 * Handle question.asked SSE events from OpenCode's Question tool.
	 * Validates raw SSE props against QuestionRequestSchema (single parse),
	 * then emits typed data that flows through all layers without re-mapping.
	 */
	private handleQuestionAsked(props: Record<string, unknown>, sessionId?: string): void {
		const parsed = mapQuestionRuntimePayloadToRequest(props, sessionId ?? '');
		if (!parsed) return;

		this.emit('event', {
			type: 'question',
			data: {
				id: parsed.id,
				requestId: parsed.id,
				sessionID: sessionId,
				questions: parsed.questions,
				tool: parsed.tool,
			},
			sessionId,
		});
	}

	private handlePermissionAsked(props: Record<string, unknown>, sessionId?: string): void {
		const parsed = mapPermissionRuntimePayloadToRequest(props, sessionId ?? '');
		if (!parsed) return;

		this.emit('event', {
			type: 'permission',
			data: {
				id: parsed.id,
				requestId: parsed.id,
				permission: parsed.permission,
				patterns: parsed.patterns,
				toolCallId: parsed.tool?.callID,
				toolUseId: parsed.tool?.callID,
				tool: parsed.permission,
				toolInput: parsed.metadata,
				metadata: parsed.metadata,
			},
			sessionId,
		});
	}

	private handleSessionStatus(status: SdkSessionStatus, sessionId?: string): void {
		const normalized = this.normalizeSessionStatus(status);
		const statusKey = sessionId || '__global__';
		if (this.lastEmittedStatus.get(statusKey) === normalized.type) return;

		this.lastEmittedStatus.set(statusKey, normalized.type);
		this.emit('event', { type: 'session_updated', data: { status: normalized }, sessionId });
	}

	private handleSessionError(
		error: EventSessionError['properties']['error'],
		sessionId?: string,
	): void {
		let message = 'OpenCode session error';
		if (error) {
			const data = error.data as { message?: string };
			message = data?.message ?? message;
		}
		this.emit('event', { type: 'error', data: { message }, sessionId });
	}

	private handlePartUpdated(
		props: EventMessagePartUpdated['properties'],
		sessionId?: string,
	): void {
		const part = this.normalizePart(props.part);
		const sid = part.sessionID ?? sessionId;
		const partMessageId = 'messageID' in part ? part.messageID : undefined;
		const partId = typeof props.part.id === 'string' ? props.part.id : partMessageId;

		if (partMessageId && partId) {
			const payloadPart = mapSdkPartToPayload(props.part, partMessageId, sid || '');
			this.emit('event', {
				type: 'message_part',
				data: {
					id: payloadPart.id,
					messageID: payloadPart.messageId,
					sessionID: payloadPart.sessionId,
					type: payloadPart.type,
					text: payloadPart.text,
					callID: payloadPart.callId,
					tool: payloadPart.toolName,
					state: payloadPart.state,
					createdAt: payloadPart.createdAt,
					completedAt: payloadPart.completedAt,
					mime: payloadPart.mime,
					url: payloadPart.url,
					filename: payloadPart.filename,
					synthetic: payloadPart.synthetic,
					auto: payloadPart.auto,
				},
				sessionId: sid,
			});
		}

		if (part.type === 'tool') this.handleToolPart(part, sid);
	}

	/**
	 * Handle `message.part.delta` SSE events — lightweight incremental text/reasoning
	 * chunks emitted by the server for every streaming token (no DB write on server side).
	 * This is the primary path for real-time streaming; `message.part.updated` only fires
	 * at part boundaries (start/end) with full snapshots.
	 */
	private handlePartDelta(props: EventMessagePartDelta['properties']): void {
		const { sessionID, messageID, field, delta } = props;
		if (!delta) return;
		if (messageID && props.partID) {
			this.emit('event', {
				type: 'message_part_delta',
				data: {
					messageID,
					partID: props.partID,
					field,
					delta,
					sessionID,
				},
				sessionId: sessionID,
			});
		}

		// Skip deltas for user messages
		if (messageID && this.messageRoles.get(messageID) === 'user') return;
	}

	/** Emit a tool_use event — shared helper to avoid duplication. */
	private emitToolUse(
		callID: string,
		name: string,
		state: { input?: unknown; title?: string; metadata?: unknown } | undefined,
		status: string | undefined,
		messageID?: string,
		partId?: string,
		sessionId?: string,
	): void {
		const inputObj = asRecord(state?.input);
		const normalized = this.logNormalizer.normalizeToolUse(name, inputObj, callID);
		const evt = {
			data: {
				id: callID,
				...(messageID ? { messageID } : {}),
				name,
				input: state?.input,
				state: status,
				title: state?.title,
				metadata: state?.metadata,
				...(partId ? { partId } : {}),
			},
			normalizedEntry: normalized,
			sessionId,
		};
		this.emit('event', { type: 'tool_use', ...evt });
		this.emit('event', { type: 'normalized_log', ...evt });
	}

	private handleToolPart(part: OpenCodePart, sessionId?: string): void {
		if (part.type !== 'tool' || !part.callID) return;
		const { callID, tool: name = 'unknown', state, messageID, id: partId } = part;
		const status = state?.status;

		// Skip question tool — it's handled separately via question.asked SSE event
		// and rendered as a dedicated QuestionCard, not as a generic tool card.
		if (name.toLowerCase() === 'question') return;

		const current = this.toolCallStates.get(callID);
		const inputObj = (state?.input ?? {}) as Record<string, unknown>;
		const hasInputNow = Object.keys(inputObj).length > 0;

		if (status === 'pending' || status === 'running') {
			const isFirstSeen = !current;
			const awaitingInput = current && !current.hasInput && hasInputNow;

			if (isFirstSeen || awaitingInput) {
				// First emission OR re-emit when input arrives (was missing on initial pending).
				this.emitToolUse(callID, name, state, status, messageID, partId, sessionId);
				this.toolCallStates.set(callID, { completed: false, hasInput: hasInputNow });
			} else if (status === 'running' && current && !current.completed) {
				// Intermediate update for a running tool.
				const meta = asRecord(state?.metadata);
				const isTask = isTaskToolName(name);

				// For task tools: when metadata.sessionId appears (OpenCode CLI calls
				// ctx.metadata() after Session.create()), re-emit as tool_use so
				// ChatProvider can extract the child session ID and link it.
				if (isTask && getMetadataSessionId(meta)) {
					this.emitToolUse(callID, name, state, status, messageID, partId, sessionId);
					this.toolCallStates.set(callID, { completed: false, hasInput: hasInputNow });
				} else if (meta && Object.keys(meta).length > 0) {
					// Non-task tools: forward metadata as streaming update (e.g. bash output).
					this.emit('event', {
						type: 'tool_streaming',
						data: {
							id: callID,
							...(messageID ? { messageID } : {}),
							name,
							streamingOutput: typeof meta.output === 'string' ? meta.output : undefined,
							metadata: meta,
							...(partId ? { partId } : {}),
						},
						sessionId,
					});
				}
			}
		}

		if ((status === 'completed' || status === 'error') && !current?.completed) {
			this.toolCallStates.set(callID, { completed: true, hasInput: hasInputNow });
			const isTask = isTaskToolName(name);
			const description = isTask ? getTaskDescription(state?.input) : '';
			const outputText = typeof state?.output === 'string' ? state.output : '';

			const resultNormalized = isTask
				? this.logNormalizer.normalizeTaskResult(
						callID,
						description,
						outputText,
						status === 'error',
					)
				: this.logNormalizer.normalizeToolUse(name, asRecord(state?.input), callID);
			this.emit('event', {
				type: 'tool_result',
				data: {
					tool_use_id: callID,
					...(messageID ? { messageID } : {}),
					name,
					content: state?.output ?? '',
					is_error: status === 'error',
					input: state?.input,
					title: state?.title,
					metadata: state?.metadata,
					...(partId ? { partId } : {}),
				},
				normalizedEntry: resultNormalized,
				sessionId,
			});
		}
	}

	private extractUserMessageParts(parts: Part[]): {
		content: string;
		isCompaction?: boolean;
		attachments?: {
			files?: string[];
			codeSnippets?: Array<{
				filePath: string;
				startLine: number;
				endLine: number;
				content: string;
			}>;
			images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
		};
	} {
		const textParts: string[] = [];
		const files: string[] = [];
		const codeSnippets: Array<{
			filePath: string;
			startLine: number;
			endLine: number;
			content: string;
		}> = [];
		const images: Array<{ id: string; name: string; dataUrl: string; path?: string }> = [];
		let hasCompaction = false;

		for (const sdkPart of parts) {
			const part = this.normalizePart(sdkPart);
			if (part.type === 'compaction') {
				hasCompaction = true;
			} else if (part.type === 'text' && part.text && !part.synthetic) {
				textParts.push(part.text);
			} else if (part.type === 'file') {
				if (part.mime.startsWith('image/')) {
					images.push({
						id: `img-${Math.random().toString(36).slice(2, 9)}`,
						name: part.filename || 'image',
						dataUrl: part.url,
						path: part.source?.path,
					});
				} else if (part.source) {
					const src = part.source;
					if (src.type === 'symbol' || (src.text.start > 0 && src.text.end > 0)) {
						codeSnippets.push({
							filePath: src.path,
							startLine: src.text.start,
							endLine: src.text.end,
							content: src.text.value,
						});
					} else {
						files.push(src.path);
					}
				} else {
					// Fallback: no source, extract path from URL
					try {
						const parsed = new URL(part.url);
						files.push(decodeURIComponent(parsed.pathname).replace(/^\//, ''));
					} catch {
						const fp = part.url.startsWith('file://') ? part.url.replace('file://', '') : part.url;
						files.push(decodeURIComponent(fp));
					}
				}
			}
		}

		const content = textParts.join('\n');
		const hasAttachments = files.length > 0 || codeSnippets.length > 0 || images.length > 0;

		// If this is a compaction message, return special marker
		if (hasCompaction) {
			return { content: '', isCompaction: true };
		}

		return {
			content,
			...(hasAttachments
				? {
						attachments: {
							...(files.length > 0 ? { files } : {}),
							...(codeSnippets.length > 0 ? { codeSnippets } : {}),
							...(images.length > 0 ? { images } : {}),
						},
					}
				: {}),
		};
	}

	private normalizeSessionStatus(raw?: SdkSessionStatus): OpenCodeSessionStatus {
		if (!raw) return { type: 'other' };
		if (raw.type === 'retry' || raw.type === 'idle' || raw.type === 'busy') return raw;
		return { type: 'other', raw };
	}

	private normalizePart(raw: Part | undefined): OpenCodePart {
		if (!raw) return { type: 'other', raw: null };

		if (raw.type === 'text') {
			return {
				type: 'text',
				id: raw.id,
				messageID: raw.messageID,
				text: raw.text,
				sessionID: raw.sessionID,
				synthetic: (raw as { synthetic?: boolean }).synthetic,
			};
		}
		if (raw.type === 'reasoning') {
			return {
				type: 'reasoning',
				id: raw.id,
				messageID: raw.messageID,
				text: raw.text,
				sessionID: raw.sessionID,
			};
		}
		if (raw.type === 'tool') {
			const toolPart = raw as ToolPart;
			return {
				type: 'tool',
				id: toolPart.id,
				messageID: toolPart.messageID,
				callID: toolPart.callID,
				tool: toolPart.tool,
				sessionID: toolPart.sessionID,
				state: {
					status: toolPart.state.status,
					input: 'input' in toolPart.state ? toolPart.state.input : undefined,
					output: toolPart.state.status === 'completed' ? toolPart.state.output : undefined,
					title:
						'title' in toolPart.state ? (toolPart.state.title as string | undefined) : undefined,
					metadata: 'metadata' in toolPart.state ? toolPart.state.metadata : undefined,
				},
			};
		}
		if (raw.type === 'file') {
			const filePart = raw as {
				messageID: string;
				sessionID: string;
				type: 'file';
				mime: string;
				url: string;
				filename?: string;
				source?: {
					type: 'file' | 'symbol';
					path: string;
					text: { value: string; start: number; end: number };
					range?: {
						start: { line: number; character: number };
						end: { line: number; character: number };
					};
					name?: string;
				};
			};
			return {
				type: 'file',
				messageID: filePart.messageID,
				sessionID: filePart.sessionID,
				mime: filePart.mime,
				url: filePart.url,
				filename: filePart.filename,
				source: filePart.source,
			};
		}
		if (raw.type === 'compaction') {
			const compactionPart = raw as {
				messageID: string;
				sessionID: string;
				type: 'compaction';
				auto: boolean;
			};
			return {
				type: 'compaction',
				messageID: compactionPart.messageID,
				sessionID: compactionPart.sessionID,
				auto: compactionPart.auto,
			};
		}
		return { type: 'other', raw, sessionID: 'sessionID' in raw ? raw.sessionID : undefined };
	}

	parseStream(_chunk: Buffer): CLIEvent[] {
		return [];
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
		this.toolCallStates.clear();
		this.messageRoles.clear();
		this.messageAgents.clear();
		this.pendingCompactIds.clear();
		this.lastEmittedStatus.clear();
		this.lastMessageTokens.clear();
		this.turnAccum.clear();
		this.activeSessions.clear();
		this.sessionMessages.clear();
		this.deletedSessions.clear();
		this.finishedMessageIds.clear();
	}

	/** Remove per-message metadata for a given session to prevent unbounded Map growth. */
	private cleanupSessionMessages(sessionId: string): void {
		this.activeSessions.delete(sessionId);
		this.pendingCompactIds.delete(sessionId);
		this.lastEmittedStatus.delete(sessionId);
		// Mark as deleted so future SSE events for this session are skipped early.
		this.deletedSessions.add(sessionId);

		// Clean all message-keyed Maps using the session→messages index.
		const messageIds = this.sessionMessages.get(sessionId);
		if (messageIds) {
			for (const msgId of messageIds) {
				this.toolCallStates.delete(msgId);
				this.messageRoles.delete(msgId);
				this.messageAgents.delete(msgId);
				this.lastMessageTokens.delete(msgId);
				this.turnAccum.delete(msgId);
				this.finishedMessageIds.delete(msgId);
			}
			this.sessionMessages.delete(sessionId);
		}
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
			this.emit('event', {
				type: 'error',
				data: {
					message:
						'Cannot restart OpenCode from this window because it is attached to a server started elsewhere. Restart from the owner window or reload the owning VS Code instance.',
				},
			});
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
			this.emit('event', {
				type: 'error',
				data: { message: `Failed to restart OpenCode server: ${String(error)}` },
			});
		}

		return false;
	}
}
