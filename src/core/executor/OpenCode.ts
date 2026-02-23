/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based) using @opencode-ai/sdk.
 * Parses token stats from `message.updated` SSE events (properties.info.tokens: {input, output, cache.read})
 * and emits `session_updated` with delta-based tokenStats compatible with SessionHandler aggregation.
 */

import type { ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	EventMessagePartUpdated,
	EventMessageUpdated,
	EventSessionError,
	EventSessionStatus,
	Message,
	Part,
	Event as SdkEvent,
	SessionStatus as SdkSessionStatus,
	TextPart,
	ToolPart,
} from '@opencode-ai/sdk';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { Value } from '@sinclair/typebox/value';
import { parseModelId } from '../../common';
import { PERMISSION_CATEGORIES } from '../../common/permissions';
import { QuestionRequestSchema } from '../../common/schemas';
import { logger } from '../../utils/logger';
import { LogNormalizer } from './LogNormalizer';
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
			messageID?: string;
			text?: string;
			sessionID?: string;
	  }
	| {
			type: 'tool';
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

	/** Unified tool call lifecycle state — replaces separate seenToolCalls/taskToolsPendingInput/completedToolCalls Sets. */
	private readonly toolCallStates = new Map<string, { completed: boolean; hasInput: boolean }>();
	private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
	/** Maps messageID → agent name (e.g. 'plan', 'build') from assistant messages. */
	private readonly messageAgents = new Map<string, string>();
	private lastEmittedStatus = new Map<string, string>();

	/** All session IDs that are currently active (main + subagent children). */
	private readonly activeSessions = new Set<string>();
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
	private readonly _mcpCache = new TtlCache<unknown>(30 * 1000);

	// Keep track of the server process wrapper to close it properly if needed
	private serverInstance: { close(): void } | null = null;

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

	private getPortFilePath(workspaceRoot: string): string {
		const hash = crypto.createHash('md5').update(workspaceRoot).digest('hex');
		return path.join(os.tmpdir(), `primecode-opencode-port-${hash}.txt`);
	}

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;

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
			this.directory = config.workspaceRoot;
			this.initSdkClient();
			logger.info(`[OpenCode] Connected to existing server at ${this.serverUrl}`);
			return;
		}

		if (await this.tryConnectToExistingServer(config)) return;

		await this.spawnServer(config.workspaceRoot, config);
	}

	private async tryConnectToExistingServer(config: CLIConfig): Promise<boolean> {
		const portFile = this.getPortFilePath(config.workspaceRoot);
		try {
			if (!fs.existsSync(portFile)) return false;

			const content = await fs.promises.readFile(portFile, 'utf-8');
			const port = parseInt(content.trim(), 10);
			if (Number.isNaN(port) || port <= 0) return false;

			const portUrl = `http://127.0.0.1:${port}`;

			// Quick health check
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			try {
				await fetch(portUrl, { method: 'HEAD', signal: controller.signal });
				clearTimeout(timeout);

				logger.info(`[OpenCode] Discovered existing server on port ${port}`);
				this.serverUrl = portUrl;
				this.directory = config.workspaceRoot;
				this.initSdkClient();
				void this.preloadMetadata();
				return true;
			} catch (_e) {
				clearTimeout(timeout);
				logger.info(`[OpenCode] Stale port file (port ${port}). Starting new server.`);
				try {
					await fs.promises.unlink(portFile);
				} catch {}
				return false;
			}
		} catch (_error) {
			return false;
		}
	}

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

			// Dynamically import SDK to avoid load-time issues
			const { createOpencode } = await import('@opencode-ai/sdk');
			const opencode = await createOpencode({
				hostname: '127.0.0.1',
				port: 0,
				timeout: config.serverTimeoutMs ?? 15000,
			});

			// We only need the URL and close method
			this.serverInstance = { close: () => opencode.server.close() };
			this.serverUrl = opencode.server.url;
			this.directory = workspaceRoot;

			await this.savePortFile(workspaceRoot);
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

	private async savePortFile(workspaceRoot: string): Promise<void> {
		if (!this.serverUrl) return;
		try {
			const port = new URL(this.serverUrl).port;
			if (port) {
				const portFile = this.getPortFilePath(workspaceRoot);
				await fs.promises.writeFile(portFile, port);
			}
		} catch {}
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
		if (this.serverInstance) {
			try {
				this.serverInstance.close();
			} catch {}
			this.serverInstance = null;
		}
		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
		this.lastEmittedStatus.clear();
		this._commandsCache.clear();
		this._providersCache.clear();
		this._agentsCache.clear();
		this._mcpCache.clear();
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
				logger.warn('[OpenCode] Server connection lost during spawn, reconnecting...');
				this.resetServerState();
				await this.ensureServer(config);
				await this.createNewSession(prompt, config);
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
				logger.warn('[OpenCode] Server connection lost during followUp, reconnecting...');
				this.resetServerState();
				// Fallback to creating new session since we lost the old one
				await this.spawn(prompt, config);
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
			path: { id: sessionId },
			body: { messageID: messageId },
			query: { directory: config.workspaceRoot },
		});
	}

	async unrevertSession(sessionId: string, config: CLIConfig): Promise<void> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		logger.info('[OpenCode] Unreverting session', { sessionId });

		const client = this.requireSdk();
		await client.session.unrevert({
			path: { id: sessionId },
			query: { directory: config.workspaceRoot },
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
				logger.warn('[OpenCode] Server connection lost, reconnecting...');
				this.resetServerState();
				await this.ensureServer(config);
				if (!this.serverUrl) throw new Error('OpenCode server not running after reconnect');

				this.sessionId = await this.createSession(config.workspaceRoot);
				this.emit('event', { type: 'session_updated', data: { sessionId: this.sessionId } });

				this.startEventStream(this.serverUrl, config.workspaceRoot);
				await this.sendPrompt(config.workspaceRoot, this.sessionId, prompt, config);
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
	private async getSessionDisplayTitle(
		sessionId: string,
		directory: string,
	): Promise<string | undefined> {
		try {
			const client = this.requireSdk();
			const { data: messages } = await client.session.messages({
				path: { id: sessionId },
				query: { directory, limit: 3 },
			});

			if (!Array.isArray(messages)) return undefined;

			const userMsg = messages.find((m: SessionMessageEntry) => m.info?.role === 'user');
			if (!userMsg) return undefined;

			const { info } = userMsg;
			if (info.role === 'user' && info.summary?.title) {
				return info.summary.title;
			}

			const textPart = userMsg.parts.find(
				(p): p is TextPart => p.type === 'text' && !p.synthetic && !!p.text,
			);
			if (textPart?.text) {
				const cleaned = textPart.text.trim().split('\n')[0];
				return cleaned.length > 80 ? `${cleaned.substring(0, 77)}...` : cleaned;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	async listSessions(config: CLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>
	> {
		if (!this.serverUrl && config.workspaceRoot) {
			try {
				await this.ensureServer(config);
			} catch (error) {
				logger.warn('[OpenCode] listSessions: ensureServer failed', error);
				return [];
			}
		}
		if (!this.serverUrl) {
			logger.warn('[OpenCode] listSessions: no serverUrl, returning empty');
			return [];
		}

		try {
			const client = this.requireSdk();
			const { data: raw } = await client.session.list({
				query: { directory: config.workspaceRoot },
			});

			const sessions = Array.isArray(raw) ? raw : [];

			logger.info('[OpenCode] listSessions: API returned', {
				rawCount: sessions.length,
				directory: config.workspaceRoot,
			});

			const resolved = await Promise.all(
				sessions.map(async s => {
					const isChild = Boolean(s.parentID);
					let displayTitle: string | undefined;

					// Only resolve display titles for top-level sessions (expensive operation)
					if (!isChild) {
						const rawTitle = s.title || '';
						displayTitle = rawTitle;

						if (!rawTitle || OpenCodeExecutor.isDefaultTitle(rawTitle)) {
							const msgTitle = await this.getSessionDisplayTitle(s.id, config.workspaceRoot);
							displayTitle = msgTitle || '';
						}
						displayTitle = displayTitle || undefined;
					} else {
						displayTitle = s.title || undefined;
					}

					return {
						id: s.id,
						title: displayTitle,
						lastModified: s.time?.updated || s.time?.created || Date.now(),
						created: s.time?.created,
						parentID: s.parentID,
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
		if (!this.serverUrl && config.workspaceRoot) {
			try {
				await this.ensureServer(config);
			} catch {
				return [];
			}
		}
		if (!this.serverUrl) return [];

		try {
			const client = this.requireSdk();
			const { data: messages } = await client.session.messages({
				path: { id: sessionId },
				query: { directory: config.workspaceRoot },
			});

			if (!Array.isArray(messages)) return [];

			// Track last assistant message's full token snapshot + cumulative counters
			let lastInput = 0;
			let lastOutput = 0;
			let lastCacheRead = 0;
			let assistantCount = 0;
			let totalModelDuration = 0;
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
					assistantCount++;
					// Keep last assistant's full token snapshot (CLI gives absolute values)
					if (tokens.input > 0) lastInput = tokens.input;
					if (tokens.output > 0) lastOutput = tokens.output;
					if (tokens.cache.read > 0) lastCacheRead = tokens.cache.read;

					// Track model info from assistant messages for replay
					if (info.modelID) lastModelID = info.modelID;
					if (info.providerID) lastProviderID = info.providerID;

					// Sum individual model response times (matches live behavior)
					const created = info.time?.created;
					const completed = info.time?.completed;
					if (typeof created === 'number' && typeof completed === 'number' && completed > created) {
						totalModelDuration += completed - created;
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

					if (part.type === 'text' && part.text) {
						partEvents.push({
							type: 'message' as const,
							data: { content: part.text, partId: info.id, isDelta: false, timestamp },
							sessionId,
						});
					} else if (part.type === 'reasoning' && part.text) {
						// Extract thinking duration from SDK part's time.start/time.end
						const rawTime = (sdkPart as Record<string, unknown>).time as
							| { start?: number; end?: number }
							| undefined;
						const thinkingDurationMs =
							rawTime?.start && rawTime?.end && rawTime.end > rawTime.start
								? rawTime.end - rawTime.start
								: undefined;
						partEvents.push({
							type: 'thinking' as const,
							data: {
								content: part.text,
								partId: info.id,
								isDelta: false,
								timestamp,
								...(thinkingDurationMs ? { durationMs: thinkingDurationMs } : {}),
							},
							sessionId,
						});
					} else if (part.type === 'tool' && part.callID) {
						const { callID, tool: name = 'unknown', state } = part;
						const status = state?.status;
						const input = (state?.input ?? {}) as Record<string, unknown>;

						// Always emit tool_use for history
						const normalized = this.logNormalizer.normalizeToolUse(name, input, callID);
						partEvents.push({
							type: 'tool_use' as const,
							data: {
								tool: name,
								input,
								toolUseId: callID,
								timestamp,
							},
							normalizedEntry: normalized,
							sessionId,
						});

						// If completed or error, emit tool_result
						if (status === 'completed' || status === 'error') {
							partEvents.push({
								type: 'tool_result' as const,
								data: {
									tool: name,
									content: state?.output || '',
									is_error: status === 'error',
									tool_use_id: callID,
									timestamp,
									title: state?.title,
									metadata: state?.metadata,
									input: state?.input,
								},
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

			// Append last token snapshot as totalStats for history replay
			if (lastInput > 0 || lastOutput > 0 || lastCacheRead > 0) {
				events.push({
					type: 'session_updated' as const,
					data: {
						totalStats: {
							contextTokens: lastInput,
							outputTokens: lastOutput,
							totalTokens: lastInput + lastOutput,
							cacheReadTokens: lastCacheRead,
							requestCount: assistantCount,
							...(totalModelDuration > 0 ? { totalDuration: totalModelDuration } : {}),
						},
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
			this.listCommands(this.directory).catch(() => {}),
			this.listConfigProviders(this.directory).catch(() => {}),
			this.listAgents(this.directory).catch(() => {}),
			this.getMcpStatus(this.directory).catch(() => {}),
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
			const { data } = await client.command.list({ query: { directory } });
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
			const { data } = await client.config.providers({ query: { directory } });
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
			const { data } = await client.app.agents({ query: { directory } });
			return this._agentsCache.set(data);
		} catch {
			return [];
		}
	}

	public async getMcpStatus(directory: string): Promise<unknown> {
		const cached = this._mcpCache.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.mcp.status({ query: { directory } });
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
			path: { id: sessionId },
			body: { providerID: model.providerID, modelID: model.modelID },
			query: { directory },
		});
	}

	private async createSession(directory: string): Promise<string> {
		const client = this.requireSdk();
		const { data, error } = await client.session.create({ query: { directory } });
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
				path: { id: sessionId },
				query: { directory: config.workspaceRoot },
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
				path: { id: sessionId },
				body: { title },
				query: { directory: config.workspaceRoot },
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
		await client.session.abort({ path: { id: sessionId }, query: { directory } });
	}

	private async sendPermissionReply(
		_directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');
		// Use the NEW /permission/:requestID/reply endpoint (session-independent).
		// The legacy /session/:id/permissions/:permissionID endpoint requires a sessionId
		// which breaks for child session (subtask) permissions.
		const url = `${this.serverUrl}/permission/${encodeURIComponent(requestId)}/reply`;
		const body: Record<string, unknown> = { reply: payload.reply };
		if (payload.message) body.message = payload.message;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`Permission reply failed: ${res.status} ${text}`);
		}
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
			path: { id: sessionId },
			query: { directory },
			body: {
				parts,
				...(config.messageID ? { messageID: config.messageID } : {}),
				...modelOverride,
				...(config.agent ? { agent: config.agent } : {}),
			},
		});
	}

	// =========================================================================
	// Event Streaming
	// =========================================================================

	private startEventStream(_baseUrl: string, directory: string): void {
		if (this.eventStreamRunning) return;
		this.eventStreamRunning = true;
		this.eventAbort = new AbortController();
		const signal = this.eventAbort.signal;
		const client = this.requireSdk();

		void (async () => {
			try {
				const { stream } = await client.event.subscribe({
					query: { directory },
					signal,
					sseDefaultRetryDelay: 250,
					sseMaxRetryAttempts: 6,
					sseMaxRetryDelay: 1500,
					onSseError: error => {
						if (!signal.aborted) {
							logger.warn('[OpenCode] SSE stream error (SDK will retry):', error);
						}
					},
				});

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
		if (envelope.type === 'permission.asked') {
			const props = (envelope.properties ?? {}) as Record<string, unknown>;
			const sessionId = typeof props.sessionID === 'string' ? props.sessionID : undefined;
			this.handlePermissionAsked(props, sessionId);
			return;
		}

		const event = raw as SdkEvent;
		switch (event.type) {
			case 'message.updated': {
				const props = (event as EventMessageUpdated).properties;
				const sessionId = props.info.sessionID;
				this.handleMessageUpdated(props.info, sessionId);
				break;
			}
			case 'message.part.updated': {
				const props = (event as EventMessagePartUpdated).properties;
				const sessionId = props.part.sessionID;
				this.handlePartUpdated(props, sessionId);
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
		this.messageRoles.set(info.id, info.role);

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

			// Emit session_updated with token snapshot for context bar / session stats
			if (hasTokenDelta) {
				this.emit('event', {
					type: 'session_updated',
					data: {
						totalStats: {
							contextTokens: input,
							outputTokens: output,
							totalTokens: total,
							cacheReadTokens: cacheRead,
						},
						modelID,
						providerID,
					},
					sessionId,
				});
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
				// Emit requestCount + currentDuration for session-level stats
				this.emit('event', {
					type: 'session_updated',
					data: {
						totalStats: { requestCount: 1, ...(durationMs ? { currentDuration: durationMs } : {}) },
						modelID,
						providerID,
					},
					sessionId,
				});

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

				if (hasCompleted) {
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
		const parsed = Value.Cast(QuestionRequestSchema, props);

		this.emit('event', {
			type: 'question',
			data: {
				requestId: parsed.id,
				questions: parsed.questions,
				tool: parsed.tool,
			},
			sessionId,
		});
	}

	private handlePermissionAsked(props: Record<string, unknown>, sessionId?: string): void {
		const toolRecord = props.tool as Record<string, unknown> | undefined;

		this.emit('event', {
			type: 'permission',
			data: {
				id: props.id,
				permission: props.permission,
				patterns: props.patterns ?? [],
				toolCallId: typeof toolRecord?.callID === 'string' ? toolRecord.callID : undefined,
				toolInput: props.toolInput,
				metadata: props.metadata,
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
		const delta = props.delta;
		const sid = part.sessionID ?? sessionId;

		if (part.type === 'text') this.handleTextPart(part, sid, delta);
		else if (part.type === 'reasoning') this.handleReasoningPart(part, sid, delta);
		else if (part.type === 'tool') this.handleToolPart(part, sid);
	}

	private handleTextPart(part: OpenCodePart, sessionId?: string, delta?: string): void {
		if (part.type !== 'text') return;
		if (part.messageID && this.messageRoles.get(part.messageID) === 'user') return;

		// Resolve agent from the parent message (set in handleMessageUpdated)
		const agent = part.messageID ? this.messageAgents.get(part.messageID) : undefined;

		if (delta) {
			this.emit('event', {
				type: 'message',
				data: {
					content: delta,
					partId: part.messageID,
					isDelta: true,
					...(agent ? { agent } : {}),
				},
				sessionId,
			});
		} else if (part.text) {
			const entry = this.logNormalizer.normalizeMessage(part.text, 'assistant');
			const eventBase = {
				data: {
					content: part.text,
					partId: part.messageID,
					isDelta: false,
					...(agent ? { agent } : {}),
				},
				normalizedEntry: entry,
				sessionId,
			};
			this.emit('event', { type: 'message', ...eventBase });
			this.emit('event', { type: 'normalized_log', ...eventBase });
		}
	}

	private handleReasoningPart(part: OpenCodePart, sessionId?: string, delta?: string): void {
		if (part.type !== 'reasoning') return;
		if (delta) {
			this.emit('event', {
				type: 'thinking',
				data: { content: delta, partId: part.messageID, isDelta: true },
				sessionId,
			});
		} else if (part.text) {
			this.emit('event', {
				type: 'thinking',
				data: { content: part.text, partId: part.messageID, isDelta: false },
				sessionId,
			});
		}
	}

	/** Emit a tool_use event — shared helper to avoid duplication. */
	private emitToolUse(
		callID: string,
		name: string,
		state: { input?: unknown; title?: string; metadata?: unknown } | undefined,
		status: string | undefined,
		sessionId?: string,
	): void {
		const inputObj = (state?.input ?? {}) as Record<string, unknown>;
		const normalized = this.logNormalizer.normalizeToolUse(name, inputObj, callID);
		const evt = {
			data: {
				id: callID,
				name,
				input: state?.input,
				state: status,
				title: state?.title,
				metadata: state?.metadata,
			},
			normalizedEntry: normalized,
			sessionId,
		};
		this.emit('event', { type: 'tool_use', ...evt });
		this.emit('event', { type: 'normalized_log', ...evt });
	}

	private handleToolPart(part: OpenCodePart, sessionId?: string): void {
		if (part.type !== 'tool' || !part.callID) return;
		const { callID, tool: name = 'unknown', state } = part;
		const status = state?.status;

		// Skip question tool — it's handled separately via question.asked SSE event
		// and rendered as a dedicated QuestionCard, not as a generic tool card.
		if (name.toLowerCase() === 'question') return;

		const current = this.toolCallStates.get(callID);
		const isTask = name === 'task' || name === 'Task';
		const inputObj = (state?.input ?? {}) as Record<string, unknown>;
		const hasInputNow = Object.keys(inputObj).length > 0;

		if (status === 'pending' || status === 'running') {
			const isFirstSeen = !current;
			const taskAwaitingInput = isTask && current && !current.hasInput && hasInputNow;

			if (isFirstSeen || taskAwaitingInput) {
				// First emission OR task tool re-emit with input that was missing before.
				this.emitToolUse(callID, name, state, status, sessionId);
				this.toolCallStates.set(callID, { completed: false, hasInput: hasInputNow });
			} else if (status === 'running' && current && !current.completed) {
				// Intermediate update for a running tool — forward metadata (e.g. bash streaming output).
				const meta = state?.metadata as Record<string, unknown> | undefined;
				if (meta && Object.keys(meta).length > 0) {
					this.emit('event', {
						type: 'tool_streaming',
						data: {
							id: callID,
							name,
							streamingOutput: typeof meta.output === 'string' ? meta.output : undefined,
							metadata: meta,
						},
						sessionId,
					});
				}
			}
		}

		if ((status === 'completed' || status === 'error') && !current?.completed) {
			this.toolCallStates.set(callID, { completed: true, hasInput: hasInputNow });
			const isTask = name === 'task' || name === 'Task';
			const taskInput = isTask ? (state?.input as unknown) : undefined;
			const taskInputRecord =
				taskInput && typeof taskInput === 'object'
					? (taskInput as Record<string, unknown>)
					: undefined;
			const description =
				(isTask && taskInputRecord && typeof taskInputRecord.description === 'string'
					? taskInputRecord.description
					: undefined) ??
				(isTask && taskInputRecord && typeof taskInputRecord.prompt === 'string'
					? taskInputRecord.prompt
					: undefined) ??
				'';
			const outputText = typeof state?.output === 'string' ? state.output : '';

			const resultNormalized = isTask
				? this.logNormalizer.normalizeTaskResult(
						callID,
						description,
						outputText,
						status === 'error',
					)
				: this.logNormalizer.normalizeToolUse(
						name,
						(state?.input ?? {}) as Record<string, unknown>,
						callID,
					);
			this.emit('event', {
				type: 'tool_result',
				data: {
					tool_use_id: callID,
					name,
					content: state?.output ?? '',
					is_error: status === 'error',
					input: state?.input,
					title: state?.title,
					metadata: state?.metadata,
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
			} else if (part.type === 'text' && part.text) {
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
				messageID: raw.messageID,
				text: raw.text,
				sessionID: raw.sessionID,
			};
		}
		if (raw.type === 'reasoning') {
			return {
				type: 'reasoning',
				messageID: raw.messageID,
				text: raw.text,
				sessionID: raw.sessionID,
			};
		}
		if (raw.type === 'tool') {
			const toolPart = raw as ToolPart;
			return {
				type: 'tool',
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
	}

	/** Remove per-message metadata for a given session to prevent unbounded Map growth. */
	private cleanupSessionMessages(sessionId: string): void {
		// messageRoles/messageAgents/lastMessageTokens are keyed by messageID, not sessionID.
		// We don't have a session→messages index, so we rely on activeSessions tracking.
		// When a session is deleted, remove it from activeSessions so future SSE events
		// for this session are ignored and no new entries accumulate.
		this.activeSessions.delete(sessionId);
		this.pendingCompactIds.delete(sessionId);
		this.lastEmittedStatus.delete(sessionId);
	}

	async dispose(): Promise<void> {
		await this.abort();
		if (this.serverInstance) {
			try {
				this.serverInstance.close();
			} catch {}
			this.serverInstance = null;
		}
		this.serverUrl = null;
		this.directory = null;
		this.sessionId = null;
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
		if (!this.serverUrl) throw new Error('OpenCode server not running');
		const url = `${this.serverUrl}/question/${decision.requestId}/reply`;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ answers: decision.answers }),
		});
		if (!res.ok) throw new Error(`Question reply failed: ${res.status}`);
	}

	async rejectQuestion(requestId: string): Promise<void> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');
		const url = `${this.serverUrl}/question/${requestId}/reject`;
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});
		if (!res.ok) throw new Error(`Question reject failed: ${res.status}`);
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
}
