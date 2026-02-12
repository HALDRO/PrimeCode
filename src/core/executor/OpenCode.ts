/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based) using pure fetch API.
 * Parses token stats from `message.updated` SSE events (properties.info.tokens: {input, output, cache.read})
 * and emits `session_updated` with delta-based tokenStats compatible with SessionHandler aggregation.
 */

import type { ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

type OpenCodeSessionStatus =
	| { type: 'idle' }
	| { type: 'busy' }
	| { type: 'retry'; attempt?: number; message?: string; next?: number }
	| { type: 'other'; raw?: unknown };

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
	private readonly logNormalizer = new LogNormalizer();

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;
	private lastEventId: string | null = null;
	private reconnectAttempt = 0;

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
		this.lastEmittedStatus.clear();
		this._cache = {};
	}

	private async fetchApi<T>(
		endpoint: string,
		directory: string,
		options?: RequestInit,
	): Promise<T> {
		if (!this.serverUrl) throw new Error('OpenCode server not running');
		const url = new URL(`${this.serverUrl}${endpoint}`);
		if (directory) url.searchParams.append('directory', directory);

		// If tests set executor.directory and forgot to pass directory arg, fall back.
		if (!directory && this.directory) url.searchParams.append('directory', this.directory);

		const resp = await fetch(url.toString(), options);
		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(`API Error ${endpoint}: ${resp.status} ${resp.statusText} - ${text}`);
		}

		// Empty body: return empty array for list endpoints, empty object otherwise.
		if (!text) return [] as unknown as T;
		return JSON.parse(text) as T;
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

		// OpenCode supports native revert semantics:
		// POST /session/:id/revert { messageID }
		// This effectively "cuts" the session state to before/at that message (depending on server semantics).
		logger.info('[OpenCode] Reverting session history to message', {
			sessionId,
			messageId,
		});

		try {
			await this.fetchApi(`/session/${sessionId}/revert`, config.workspaceRoot, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messageID: messageId }),
			});
		} catch (e) {
			// Non-fatal: don't block the send path, but warn so we notice conflicts.
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
			const messages = await this.fetchApi<
				Array<{
					info?: { role?: string; summary?: { title?: string } };
					parts?: Array<{ type?: string; text?: string; synthetic?: boolean }>;
				}>
			>(`/session/${sessionId}/message?limit=3`, directory);

			if (!Array.isArray(messages)) return undefined;

			// Find first user message
			const userMsg = messages.find(m => m.info?.role === 'user');
			if (!userMsg) return undefined;

			// Try message-level summary title first
			if (userMsg.info?.summary?.title) {
				return userMsg.info.summary.title;
			}

			// Fall back to first non-synthetic text part, truncated
			const textPart = userMsg.parts?.find(p => p.type === 'text' && !p.synthetic && p.text);
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
			// Use roots=true to filter out child/subagent sessions server-side
			const raw = await this.fetchApi<
				Array<{
					id: string;
					title?: string;
					parentID?: string;
					time?: { updated?: number; created?: number };
				}>
			>('/session?roots=true', config.workspaceRoot);

			// Guard: ensure response is actually an array
			const sessions = Array.isArray(raw) ? raw : [];

			logger.info('[OpenCode] listSessions: API returned', {
				rawCount: sessions.length,
				directory: config.workspaceRoot,
			});

			// Resolve titles for sessions that still have the default "New session - <timestamp>" title.
			// For these, fetch the first user message to get a meaningful display title.
			const resolved = await Promise.all(
				sessions.map(async s => {
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
			const messages = await this.fetchApi<
				Array<{
					info?: {
						role?: string;
						id?: string;
						tokens?: { input?: number; output?: number; cache?: { read?: number } };
					};
					parts?: unknown[];
					time?: { created?: number; completed?: number };
				}>
			>(`/session/${sessionId}/message`, config.workspaceRoot);

			// Aggregate token totals across all assistant messages for history restore
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let assistantCount = 0;

			const events = messages.flatMap(msg => {
				const role = msg.info?.role;
				const timestamp = msg.time?.created
					? new Date(msg.time.created).toISOString()
					: new Date().toISOString();

				// Aggregate tokens from assistant messages
				if (role === 'assistant' && msg.info?.tokens) {
					const t = msg.info.tokens;
					totalInput += typeof t.input === 'number' ? t.input : 0;
					totalOutput += typeof t.output === 'number' ? t.output : 0;
					totalCacheRead += typeof t.cache?.read === 'number' ? t.cache.read : 0;
					assistantCount++;
				}

				return (msg.parts || []).flatMap(rawPart => {
					const part = this.normalizePart(rawPart as Record<string, unknown> | undefined);
					const partEvents: CLIEvent[] = [];

					if (part.type === 'text' && part.text) {
						if (role === 'assistant') {
							partEvents.push({
								type: 'message' as const,
								data: { content: part.text, partId: msg.info?.id, isDelta: false },
								sessionId,
							});
						} else {
							partEvents.push({
								type: 'normalized_log' as const,
								data: { role: 'user', content: part.text, timestamp, messageId: msg.info?.id },
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
							data: { content: part.text, partId: msg.info?.id, isDelta: false },
							sessionId,
						});
					} else if (part.type === 'tool' && part.callID) {
						const { callID, tool: name = 'unknown', state } = part;
						const status = state?.status;
						const input = (state?.input as Record<string, unknown>) || {};

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
			// Try GET /command first, might fail if not supported
			const data = await this.fetchApi<Array<{ name: string; description?: string }>>(
				'/command',
				directory,
			);
			this._cache.commands = { data, time: Date.now() };
			return data;
		} catch {
			return [];
		}
	}

	private async listConfigProviders(directory: string): Promise<unknown> {
		if (this._cache.providers && Date.now() - this._cache.providers.time < this.CACHE_TTL)
			return this._cache.providers.data;
		try {
			const data = await this.fetchApi<unknown>('/config/providers', directory);
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
			const data = await this.fetchApi<unknown>('/mode', directory);
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
			// Use /config as proxy for MCP status
			const data = await this.fetchApi<unknown>('/config', directory);
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
		await this.fetchApi(`/session/${sessionId}/summarize`, directory, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ providerID: model.providerID, modelID: model.modelID, auto: false }),
		});
	}

	private async createSession(directory: string): Promise<string> {
		const data = await this.fetchApi<{ id: string }>('/session', directory, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		if (!data.id) throw new Error('OpenCode create session: missing id');
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
			await this.fetchApi(`/session/${sessionId}`, config.workspaceRoot, { method: 'DELETE' });
			logger.info(`[OpenCodeExecutor] Session deleted: ${sessionId}`);
			return true;
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to delete session:', error);
			return false;
		}
	}

	async renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean> {
		try {
			await this.fetchApi(`/session/${sessionId}`, config.workspaceRoot, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title }),
			});
			logger.info(`[OpenCodeExecutor] Session renamed: ${sessionId} -> "${title}"`);
			return true;
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to rename session:', error);
			return false;
		}
	}

	private async sendAbort(directory: string, sessionId: string): Promise<void> {
		await this.fetchApi(`/session/${sessionId}/abort`, directory, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
	}

	private async sendPermissionReply(
		directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		await this.fetchApi(`/permission/${encodeURIComponent(requestId)}/reply`, directory, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
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

		// OpenCode model override is optional. If we don't have a valid provider/model,
		// omit the `model` field entirely so the server falls back to its configured default.
		const modelOverride = modelProviderId
			? {
					model: {
						providerID: modelProviderId,
						modelID: modelSpec?.modelID || '',
					},
				}
			: {};

		const body = {
			parts: [{ type: 'text' as const, text: prompt }],
			...(config.messageID ? { messageID: config.messageID } : {}),
			...modelOverride,
			...(config.agent ? { agent: config.agent } : {}),
		};

		await this.fetchApi(`/session/${sessionId}/message`, directory, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
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

	private async connectEventStream(
		baseUrl: string,
		directory: string,
		signal: AbortSignal,
		lastEventId?: string,
	): Promise<Response> {
		const headers: Record<string, string> = { Accept: 'text/event-stream' };
		if (lastEventId?.trim()) headers['Last-Event-ID'] = lastEventId.trim();

		const resp = await fetch(`${baseUrl}/event?directory=${encodeURIComponent(directory)}`, {
			method: 'GET',
			headers,
			signal,
		});

		if (!resp.ok || !resp.body) throw new Error(`OpenCode event stream failed: ${resp.status}`);
		return resp;
	}

	private startEventStream(baseUrl: string, directory: string): void {
		if (this.eventStreamRunning) return;
		this.eventStreamRunning = true;
		this.eventAbort = new AbortController();
		const signal = this.eventAbort.signal;
		const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
		const backoffMs = (base: number, att: number) =>
			Math.min(1500, base * 2 ** Math.max(0, att - 1));

		void (async () => {
			let baseRetryDelayMs = 250;
			const maxAttempts = 6;
			this.reconnectAttempt = 0;

			try {
				while (!signal.aborted) {
					let resp: Response;
					try {
						resp = await this.connectEventStream(
							baseUrl,
							directory,
							signal,
							this.lastEventId ?? undefined,
						);
						this.reconnectAttempt = 0;
					} catch (error) {
						if (signal.aborted) return;
						this.reconnectAttempt++;
						if (this.reconnectAttempt >= maxAttempts) throw error;
						await sleep(backoffMs(baseRetryDelayMs, this.reconnectAttempt));
						continue;
					}

					try {
						for await (const evt of this.iterSseEvents(resp.body as ReadableStream<Uint8Array>)) {
							if (signal.aborted) break;
							if (evt.id?.trim()) this.lastEventId = evt.id.trim();
							if (evt.retry && evt.retry > 0) baseRetryDelayMs = evt.retry;
							this.handleSdkEvent(evt.data);
						}
					} catch (_e) {
						if (signal.aborted) return;
					}

					if (signal.aborted) break;
					this.reconnectAttempt++;
					if (this.reconnectAttempt >= maxAttempts) throw new Error('Stream disconnected');
					await sleep(backoffMs(baseRetryDelayMs, this.reconnectAttempt));
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

	private async *iterSseEvents(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<{ id?: string; retry?: number; data: unknown }, void, unknown> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });

				while (true) {
					const idx = buffer.indexOf('\n\n');
					if (idx === -1) break;
					const chunk = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);

					let id: string | undefined;
					let retry: number | undefined;
					const dataLines: string[] = [];

					for (const line of chunk.split(/\r?\n/)) {
						if (line.startsWith('id:')) id = line.slice(3).trim();
						else if (line.startsWith('retry:')) retry = Number(line.slice(6).trim());
						else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
					}

					if (dataLines.length > 0) {
						try {
							yield { id, retry, data: JSON.parse(dataLines.join('\n')) };
						} catch {}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private handleSdkEvent(raw: unknown): void {
		const envelope = raw as { type: string; properties?: unknown };
		if (!envelope || typeof envelope.type !== 'string') return;

		const eventType = envelope.type;
		const props = (envelope.properties ?? {}) as Record<string, unknown>;
		const sessionId = this.extractSessionId(props, eventType);

		switch (eventType) {
			case 'message.updated':
				this.handleMessageUpdated(props, sessionId);
				break;
			case 'message.part.updated':
				this.handlePartUpdated(props, sessionId);
				break;
			case 'permission.asked':
				this.handlePermissionAsked(props, sessionId);
				break;
			case 'session.status':
				this.handleSessionStatus(props, sessionId);
				// Track active sessions: busy = add, idle-like = remove
				if (sessionId) {
					const status = this.normalizeSessionStatus(
						props.status as Record<string, unknown> | undefined,
					);
					if (status.type === 'busy') {
						this.activeSessions.add(sessionId);
					} else if (status.type === 'idle') {
						this.activeSessions.delete(sessionId);
					}
				}
				break;
			case 'session.error':
				this.handleSessionError(props, sessionId);
				break;
			case 'session.idle':
				if (sessionId) this.activeSessions.delete(sessionId);
				this.emit('event', { type: 'finished', data: { reason: 'idle' }, sessionId });
				break;
		}
	}

	private extractSessionId(props: Record<string, unknown>, eventType: string): string | undefined {
		if (typeof props.sessionID === 'string') return props.sessionID;
		if (typeof props.sessionId === 'string') return props.sessionId;
		if (['message.updated', 'message.part.updated'].includes(eventType)) {
			const sub = (props.info || props.part) as Record<string, unknown>;
			if (sub) {
				if (typeof sub.sessionID === 'string') return sub.sessionID;
				if (typeof sub.sessionId === 'string') return sub.sessionId;
			}
		}
		return undefined;
	}

	private handleMessageUpdated(props: Record<string, unknown>, sessionId?: string): void {
		const info = props.info as Record<string, unknown> | undefined;
		if (!info) return;

		const messageId = typeof info.id === 'string' ? info.id : undefined;
		const role = typeof info.role === 'string' ? info.role : undefined;

		if (messageId && (role === 'user' || role === 'assistant')) {
			this.messageRoles.set(messageId, role);
		}

		// Extract token stats from assistant messages (OpenCode SSE format)
		if (role === 'assistant' && messageId) {
			const tokens = info.tokens as Record<string, unknown> | undefined;
			if (tokens) {
				const input = typeof tokens.input === 'number' ? tokens.input : 0;
				const output = typeof tokens.output === 'number' ? tokens.output : 0;
				const cache = tokens.cache as Record<string, unknown> | undefined;
				const cacheRead = typeof cache?.read === 'number' ? cache.read : 0;

				// Compute deltas from last known values (message.updated sends cumulative)
				const prev = this.lastMessageTokens.get(messageId) ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
				};
				const deltaInput = Math.max(0, input - prev.input);
				const deltaOutput = Math.max(0, output - prev.output);
				const deltaCacheRead = Math.max(0, cacheRead - prev.cacheRead);

				this.lastMessageTokens.set(messageId, { input, output, cacheRead });

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
			}
		}

		// Fallback: if assistant message has a completed timestamp, emit finished with totalStats
		const timeRecord = info.time as Record<string, unknown> | undefined;
		if (role === 'assistant' && timeRecord && typeof timeRecord.completed === 'number') {
			const started = typeof timeRecord.created === 'number' ? timeRecord.created : 0;
			const completed = timeRecord.completed as number;
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

	private handleSessionStatus(props: Record<string, unknown>, sessionId?: string): void {
		const status = this.normalizeSessionStatus(props.status as Record<string, unknown> | undefined);
		const statusKey = sessionId || '__global__';
		if (this.lastEmittedStatus.get(statusKey) === status.type) return;

		this.lastEmittedStatus.set(statusKey, status.type);
		this.emit('event', { type: 'session_updated', data: { status }, sessionId });
	}

	private handleSessionError(props: Record<string, unknown>, sessionId?: string): void {
		const errorRecord = props.error as Record<string, unknown> | undefined;
		const errorData = errorRecord?.data as Record<string, unknown> | undefined;
		const message =
			(typeof errorData?.message === 'string' ? errorData.message : undefined) ??
			(typeof errorRecord?.message === 'string' ? errorRecord.message : undefined) ??
			'OpenCode session error';
		this.emit('event', { type: 'error', data: { message }, sessionId });
	}

	private handlePartUpdated(props: Record<string, unknown>, sessionId?: string): void {
		const part = this.normalizePart(props.part as Record<string, unknown> | undefined);
		const delta = typeof props.delta === 'string' ? props.delta : undefined;
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
				(state?.input as Record<string, unknown>) || {},
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
				(state?.input as Record<string, unknown>) || {},
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

	private normalizeSessionStatus(raw?: Record<string, unknown>): OpenCodeSessionStatus {
		const statusType = raw?.type;
		if (statusType === 'retry') {
			return {
				type: 'retry',
				attempt: typeof raw?.attempt === 'number' ? raw.attempt : undefined,
				message: typeof raw?.message === 'string' ? raw.message : undefined,
				next: typeof raw?.next === 'number' ? raw.next : undefined,
			};
		}
		if (statusType === 'idle' || statusType === 'busy') return { type: statusType };
		return { type: 'other', raw };
	}

	private normalizePart(raw: Record<string, unknown> | undefined): OpenCodePart {
		if (!raw) return { type: 'other', raw: null };
		const partType = raw.type;

		if (partType === 'text' || partType === 'reasoning') {
			return {
				type: partType,
				messageID: typeof raw.messageID === 'string' ? raw.messageID : undefined,
				text: typeof raw.text === 'string' ? raw.text : undefined,
				sessionID: typeof raw.sessionID === 'string' ? raw.sessionID : undefined,
			};
		}
		if (partType === 'tool') {
			const state = (raw.state ?? {}) as Record<string, unknown>;
			const statusVal = state.status;
			const validStatuses = ['pending', 'running', 'completed', 'error'] as const;
			type ToolStatus = (typeof validStatuses)[number];

			return {
				type: 'tool',
				messageID: typeof raw.messageID === 'string' ? raw.messageID : undefined,
				callID: typeof raw.callID === 'string' ? raw.callID : undefined,
				tool: typeof raw.tool === 'string' ? raw.tool : undefined,
				sessionID: typeof raw.sessionID === 'string' ? raw.sessionID : undefined,
				state: {
					status: validStatuses.includes(statusVal as ToolStatus)
						? (statusVal as ToolStatus)
						: undefined,
					input: state.input,
					output: typeof state.output === 'string' ? state.output : undefined,
					title: typeof state.title === 'string' ? state.title : undefined,
					metadata: state.metadata,
				},
			};
		}
		return { type: 'other', raw };
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
}
