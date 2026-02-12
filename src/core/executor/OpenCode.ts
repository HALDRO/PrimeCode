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

import { logger } from '../../utils/logger';
import { LogNormalizer } from './LogNormalizer';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

// =============================================================================
// Types & Interfaces
// =============================================================================

declare module './types' {
	interface CLIConfig {
		autoApprove?: boolean;
	}
}

/** Single entry from `client.session.messages()` response. */
type SessionMessageEntry = { info: Message; parts: Part[] };

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
	| { type: 'other'; raw: unknown; sessionID?: string };

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

	private readonly seenToolCalls = new Set<string>();
	private readonly completedToolCalls = new Set<string>();
	private readonly messageRoles = new Map<string, 'user' | 'assistant'>();
	private lastEmittedStatus = new Map<string, string>();

	/** All session IDs that are currently active (main + subagent children). */
	private readonly activeSessions = new Set<string>();

	// Token stats tracking for message.updated events (per-message cumulative → delta)
	private readonly lastMessageTokens = new Map<
		string,
		{ input: number; output: number; cacheRead: number }
	>();

	private readonly CACHE_TTL = 5 * 60 * 1000;
	private _cache: {
		commands?: { data: Array<{ name: string; description?: string }>; time: number };
		providers?: { data: unknown; time: number };
		modes?: { data: unknown; time: number };
		mcp?: { data: unknown; time: number };
	} = {};

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
		const permissionsEnv = this.buildPermissionsEnv(autoApprove, config.env);

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

	private buildPermissionsEnv(autoApprove: boolean, env?: Record<string, string>): string {
		if (env?.OPENCODE_PERMISSION) {
			try {
				const existing = JSON.parse(env.OPENCODE_PERMISSION);
				return JSON.stringify({ ...existing, question: 'deny' });
			} catch {}
		}
		if (autoApprove) return JSON.stringify({ question: 'deny' });

		return JSON.stringify({
			edit: 'ask',
			bash: 'ask',
			webfetch: 'ask',
			doom_loop: 'ask',
			external_directory: 'ask',
			question: 'deny',
		});
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
		this._cache = {};
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

	async spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');

		try {
			// Continue the existing session (no fork) - just send a message
			this.sessionId = sessionId;
			this.startEventStream(this.serverUrl, config.workspaceRoot);
			await this.sendPrompt(config.workspaceRoot, sessionId, prompt, config);
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

		try {
			const client = this.requireSdk();
			await client.session.revert({
				path: { id: sessionId },
				body: { messageID: messageId },
				query: { directory: config.workspaceRoot },
			});
		} catch (e) {
			logger.warn('[OpenCode] Revert endpoint failed (non-fatal)', e);
		}
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

	async listSessions(
		config: CLIConfig,
	): Promise<Array<{ id: string; title?: string; lastModified?: number; parentID?: string }>> {
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
				sessions
					.filter(s => !s.parentID)
					.map(async s => {
						const rawTitle = s.title || '';
						let displayTitle = rawTitle;

						if (!rawTitle || OpenCodeExecutor.isDefaultTitle(rawTitle)) {
							const msgTitle = await this.getSessionDisplayTitle(s.id, config.workspaceRoot);
							displayTitle = msgTitle || '';
						}

						return {
							id: s.id,
							title: displayTitle || undefined,
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

			// Aggregate token totals across all assistant messages for history restore
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let assistantCount = 0;

			const events = messages.flatMap((msg: SessionMessageEntry) => {
				const { info, parts } = msg;
				const role = info.role;
				const timestamp = info.time?.created
					? new Date(info.time.created).toISOString()
					: new Date().toISOString();

				// Aggregate tokens from assistant messages
				if (info.role === 'assistant') {
					const { tokens } = info;
					totalInput += tokens.input;
					totalOutput += tokens.output;
					totalCacheRead += tokens.cache.read;
					assistantCount++;
				}

				return parts.flatMap((sdkPart: Part) => {
					const part = this.normalizePart(sdkPart);
					const partEvents: CLIEvent[] = [];

					if (part.type === 'text' && part.text) {
						if (role === 'assistant') {
							partEvents.push({
								type: 'message' as const,
								data: { content: part.text, partId: info.id, isDelta: false },
								sessionId,
							});
						} else {
							partEvents.push({
								type: 'normalized_log' as const,
								data: { role: 'user', content: part.text, timestamp, messageId: info.id },
								normalizedEntry: {
									entryType: 'UserMessage' as const,
									content: part.text || '',
									timestamp,
								},
								sessionId,
							});
						}
					} else if (part.type === 'reasoning' && part.text) {
						partEvents.push({
							type: 'thinking' as const,
							data: { content: part.text, partId: info.id, isDelta: false },
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
									isError: status === 'error',
									toolUseId: callID,
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

			// Append aggregated token stats so they can be restored during history replay
			if (totalInput > 0 || totalOutput > 0 || totalCacheRead > 0) {
				events.push({
					type: 'session_updated' as const,
					data: {
						tokenStats: {
							currentInputTokens: totalInput,
							currentOutputTokens: totalOutput,
							cacheReadTokens: totalCacheRead,
							cacheCreationTokens: 0,
							reasoningTokens: 0,
							totalTokensInput: totalInput,
							totalTokensOutput: totalOutput,
							totalReasoningTokens: 0,
						},
						totalStats: {
							requestCount: assistantCount,
						},
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

	async executeCommand(command: string, _args: string[], config: CLIConfig): Promise<void> {
		if (!this.serverUrl) await this.ensureServer(config);
		if (!this.directory) throw new Error('OpenCode server not ready');

		const directory = this.directory;
		const cmd = command.replace(/^\//, '');

		switch (cmd) {
			case 'compact':
			case 'summarize':
				await this.handleCompactCommand(config);
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

	private async handleCompactCommand(config: CLIConfig): Promise<void> {
		if (!this.sessionId || !this.directory) throw new Error('No active session to compact');

		const modelSpec = this.parseModel(config.model);
		if (!modelSpec) {
			this.emitToolResult('compact', 'Error: No model configured for compaction.', true);
			return;
		}

		try {
			await this.sessionSummarize(this.directory, this.sessionId, modelSpec);
			this.emitToolResult('compact', 'Session compacted successfully.');
		} catch (error) {
			this.emitToolResult('compact', `Error compacting session: ${String(error)}`, true);
		}
	}

	private async handleListCommand(name: string, fetcher: () => Promise<unknown>): Promise<void> {
		const data = await fetcher();
		this.emitToolResult(name, JSON.stringify(data, null, 2));
	}

	private emitToolResult(name: string, content: string, isError = false): void {
		this.emit('event', {
			type: 'tool_result',
			data: { tool_use_id: 'system', name, content, is_error: isError },
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
		if (this._cache.commands && Date.now() - this._cache.commands.time < this.CACHE_TTL)
			return this._cache.commands.data;
		try {
			const client = this.requireSdk();
			const { data } = await client.command.list({ query: { directory } });
			const commands = (data ?? []) as Array<{ name: string; description?: string }>;
			this._cache.commands = { data: commands, time: Date.now() };
			return commands;
		} catch {
			return [];
		}
	}

	private async listConfigProviders(directory: string): Promise<unknown> {
		if (this._cache.providers && Date.now() - this._cache.providers.time < this.CACHE_TTL)
			return this._cache.providers.data;
		try {
			const client = this.requireSdk();
			const { data } = await client.config.providers({ query: { directory } });
			this._cache.providers = { data, time: Date.now() };
			return data;
		} catch {
			return {};
		}
	}

	private async listAgents(directory: string): Promise<unknown> {
		if (this._cache.modes && Date.now() - this._cache.modes.time < this.CACHE_TTL)
			return this._cache.modes.data;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.agents({ query: { directory } });
			this._cache.modes = { data, time: Date.now() };
			return data;
		} catch {
			return [];
		}
	}

	private async getMcpStatus(directory: string): Promise<unknown> {
		if (this._cache.mcp && Date.now() - this._cache.mcp.time < 30 * 1000)
			return this._cache.mcp.data;
		try {
			const client = this.requireSdk();
			const { data } = await client.mcp.status({ query: { directory } });
			this._cache.mcp = { data, time: Date.now() };
			return data;
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
		directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		if (!this.sessionId) throw new Error('No active session for permission reply');
		const client = this.requireSdk();
		await client.postSessionIdPermissionsPermissionId({
			path: { id: this.sessionId, permissionID: requestId },
			body: { response: payload.reply },
			query: { directory },
		});
	}

	private async sendPrompt(
		directory: string,
		sessionId: string,
		prompt: string,
		config: CLIConfig,
	): Promise<void> {
		const modelSpec = this.parseModel(config.model);
		const modelProviderId = modelSpec?.providerID || '';

		const modelOverride = modelProviderId
			? { model: { providerID: modelProviderId, modelID: modelSpec?.modelID || '' } }
			: {};

		const client = this.requireSdk();
		await client.session.promptAsync({
			path: { id: sessionId },
			query: { directory },
			body: {
				parts: [{ type: 'text' as const, text: prompt }],
				...(config.messageID ? { messageID: config.messageID } : {}),
				...modelOverride,
				...(config.agent ? { agent: config.agent } : {}),
			},
		});
	}

	private parseModel(model?: string): { providerID: string; modelID: string } | undefined {
		if (!model || !model.trim()) return undefined;
		const trimmed = model.trim();
		const slash = trimmed.indexOf('/');
		if (slash <= 0 || slash === trimmed.length - 1) return undefined;

		const providerID = trimmed.slice(0, slash).trim();
		const modelID = trimmed.slice(slash + 1).trim();
		if (!providerID || !modelID) return undefined;

		return { providerID, modelID };
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
		}
	}

	private handleMessageUpdated(info: Message, sessionId?: string): void {
		this.messageRoles.set(info.id, info.role);

		// Extract token stats from assistant messages (OpenCode SSE format)
		if (info.role === 'assistant') {
			const { tokens } = info;
			const input = tokens.input;
			const output = tokens.output;
			const cacheRead = tokens.cache.read;

			// Compute deltas from last known values (message.updated sends cumulative)
			const prev = this.lastMessageTokens.get(info.id) ?? {
				input: 0,
				output: 0,
				cacheRead: 0,
			};
			const deltaInput = Math.max(0, input - prev.input);
			const deltaOutput = Math.max(0, output - prev.output);
			const deltaCacheRead = Math.max(0, cacheRead - prev.cacheRead);

			this.lastMessageTokens.set(info.id, { input, output, cacheRead });

			// Only emit if there's actual token delta
			if (deltaInput > 0 || deltaOutput > 0 || deltaCacheRead > 0) {
				this.emit('event', {
					type: 'session_updated',
					data: {
						tokenStats: {
							currentInputTokens: deltaInput,
							currentOutputTokens: deltaOutput,
							cacheReadTokens: deltaCacheRead,
							cacheCreationTokens: 0,
							reasoningTokens: 0,
							totalTokensInput: input,
							totalTokensOutput: output,
							totalReasoningTokens: 0,
						},
					},
					sessionId,
				});
			}

			// If assistant message has a completed timestamp, emit finished with totalStats
			const completed = info.time.completed;
			if (typeof completed === 'number') {
				const started = info.time.created;
				const durationMs = started > 0 ? completed - started : undefined;

				this.emit('event', {
					type: 'session_updated',
					data: {
						totalStats: {
							requestCount: 1,
							currentDuration: durationMs,
							totalDuration: durationMs,
						},
					},
					sessionId,
				});

				this.emit('event', {
					type: 'finished',
					data: { reason: 'message_completed' },
					sessionId,
				});
			}
		}
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

		if (delta) {
			this.emit('event', {
				type: 'message',
				data: { content: delta, partId: part.messageID, isDelta: true },
				sessionId,
			});
		} else if (part.text) {
			const entry = this.logNormalizer.normalizeMessage(part.text, 'assistant');
			const eventBase = {
				data: { content: part.text, partId: part.messageID, isDelta: false },
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

	private handleToolPart(part: OpenCodePart, sessionId?: string): void {
		if (part.type !== 'tool' || !part.callID) return;
		const { callID, tool: name = 'unknown', state } = part;
		const status = state?.status;

		if ((status === 'pending' || status === 'running') && !this.seenToolCalls.has(callID)) {
			this.seenToolCalls.add(callID);
			const normalized = this.logNormalizer.normalizeToolUse(
				name,
				(state?.input ?? {}) as Record<string, unknown>,
				callID,
			);
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

		if ((status === 'completed' || status === 'error') && !this.completedToolCalls.has(callID)) {
			this.completedToolCalls.add(callID);
			const resultNormalized = this.logNormalizer.normalizeToolUse(
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
		return { type: 'other', raw, sessionID: 'sessionID' in raw ? raw.sessionID : undefined };
	}

	parseStream(_chunk: Buffer): CLIEvent[] {
		return [];
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
		this.seenToolCalls.clear();
		this.completedToolCalls.clear();
		this.lastEmittedStatus.clear();
		this.lastMessageTokens.clear();
		this.activeSessions.clear();
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

	getSessionId(): string | null {
		return this.sessionId;
	}
	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return this.serverUrl && this.directory
			? { baseUrl: this.serverUrl, directory: this.directory }
			: null;
	}

	getSdkClient(): OpencodeClient | null {
		return this.sdkClient;
	}
}
