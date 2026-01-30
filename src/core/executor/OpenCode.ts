/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based).
 */

import type { ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type OpencodeClient = import('@opencode-ai/sdk').OpencodeClient;

import { logger } from '../../utils/logger';
import { LogNormalizer } from './LogNormalizer';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

// Extend CLIConfig to include autoApprove
declare module './types' {
	interface CLIConfig {
		autoApprove?: boolean;
	}
}

type _OpencodeSdkEnvelope = {
	type: string;
	properties?: unknown;
};

type OpenCodePermissionAsked = {
	id?: string;
	permission?: string;
	patterns?: string[];
	metadata?: unknown;
	tool?: { callID?: string };
	toolInput?: unknown;
};

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
	| { type: 'other'; raw: unknown };

// Define types that might be missing in the SDK definitions we have
interface ExtendedOpencodeClient {
	command: {
		list(params: {
			query: { directory: string };
		}): Promise<{ error?: unknown; data?: Array<{ name: string; description?: string }> }>;
	};
	config: {
		providers(params: {
			query: { directory: string };
		}): Promise<{ error?: unknown; data?: unknown }>;
	} & OpencodeClient['config'];
	agent: {
		list(params: { query: { directory: string } }): Promise<{ error?: unknown; data?: unknown }>;
	} & OpencodeClient['app']; // 'app' in SDK seems to hold agents? useOpenCode uses client.app.agents() but here we map to REST likely
	mcp: {
		list(params: { query: { directory: string } }): Promise<{ error?: unknown; data?: unknown }>;
	};
	permission: {
		reply(params: {
			path: { id: string };
			query: { directory: string };
			body: { reply: 'once' | 'always' | 'reject'; message?: string };
		}): Promise<{ error?: unknown }>;
	};
	session: OpencodeClient['session'] & {
		summarize(params: {
			path: { id: string };
			query: { directory: string };
			body: { providerID: string; modelID: string; auto: boolean };
		}): Promise<{ error?: unknown }>;
	};
}

interface OpencodeInstance {
	client: OpencodeClient & ExtendedOpencodeClient;
	server: {
		url: string;
		close(): void;
	};
}

export class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	// maintained for interface compatibility but managed by SDK instance
	private opencode: OpencodeInstance | null = null;
	private serverUrl: string | null = null;
	private sessionId: string | null = null;
	private directory: string | null = null;
	private logNormalizer = new LogNormalizer();

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

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;

	private lastEventId: string | null = null;
	private reconnectAttempt = 0;

	private seenToolCalls = new Set<string>();
	private completedToolCalls = new Set<string>();

	private messageRoles = new Map<string, 'user' | 'assistant'>();

	private getPortFilePath(workspaceRoot: string): string {
		const hash = crypto.createHash('md5').update(workspaceRoot).digest('hex');
		return path.join(os.tmpdir(), `primecode-opencode-port-${hash}.txt`);
	}

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.opencode && this.serverUrl) {
			return;
		}

		if (config.serverUrl) {
			this.serverUrl = config.serverUrl;
			this.directory = config.workspaceRoot;
			logger.info(`[OpenCode] Connected to existing server at ${this.serverUrl}`);
			return;
		}

		// Port File Discovery: Check if a server is already running for this workspace
		const portFile = this.getPortFilePath(config.workspaceRoot);
		try {
			if (fs.existsSync(portFile)) {
				const content = await fs.promises.readFile(portFile, 'utf-8');
				const port = parseInt(content.trim(), 10);

				if (!Number.isNaN(port) && port > 0) {
					const portUrl = `http://127.0.0.1:${port}`;

					// Health check to verify server is alive
					try {
						const controller = new AbortController();
						const timeout = setTimeout(() => controller.abort(), 3000);
						// OpenCode root often returns 404, but connection refused means it's dead
						// /health or /version might be better if available, but root is enough to check TCP
						await fetch(portUrl, {
							method: 'HEAD',
							signal: controller.signal,
						});
						clearTimeout(timeout);

						// If fetch didn't throw (even if 404), the port is open and listening
						logger.info(`[OpenCode] Discovered existing server on port ${port}`);
						this.serverUrl = portUrl;
						this.directory = config.workspaceRoot;

						// Ensure we have a client instance, even if dummy, to satisfy null checks elsewhere
						// although most logic uses this.serverUrl.
						if (!this.opencode) {
							// Create a minimal mock instance so checks for this.opencode pass
							this.opencode = {
								client: {} as unknown as OpencodeInstance['client'],
								server: { url: portUrl, close: () => {} },
							};
						}
						return;
					} catch (e) {
						// Connection refused or timeout -> Server likely dead
						const msg = e instanceof Error ? e.message : String(e);
						logger.info(
							`[OpenCode] Stale port file found (port ${port}): ${msg}. Starting new server.`,
						);
						// Clean up stale file
						try {
							await fs.promises.unlink(portFile);
						} catch {}
					}
				}
			}
		} catch (error) {
			logger.warn('[OpenCode] Error checking port file:', error);
		}

		await this.ensureOpenCodeServer(config.workspaceRoot, config);
	}

	private buildPermissionsEnv(autoApprove: boolean, env?: Record<string, string>): string {
		if (env?.OPENCODE_PERMISSION) {
			try {
				const existing = JSON.parse(env.OPENCODE_PERMISSION);
				return JSON.stringify({ ...existing, question: 'deny' });
			} catch {
				// ignore invalid json
			}
		}

		if (autoApprove) {
			return JSON.stringify({ question: 'deny' });
		}
		return JSON.stringify({
			edit: 'ask',
			bash: 'ask',
			webfetch: 'ask',
			doom_loop: 'ask',
			external_directory: 'ask',
			question: 'deny',
		});
	}

	private async ensureOpenCodeServer(workspaceRoot: string, config: CLIConfig): Promise<void> {
		if (this.opencode && this.serverUrl) {
			return;
		}

		const autoApprove = config.autoApprove ?? false;
		const permissionsEnv = this.buildPermissionsEnv(autoApprove, config.env);

		// Prepare environment variables
		const processEnv: NodeJS.ProcessEnv & {
			OPENCODE_PERMISSION?: string;
			OPENCODE_CONFIG_CONTENT?: string;
		} = {
			...process.env,
			...config.env,
			NODE_NO_WARNINGS: '1',
			NO_COLOR: '1',
			NPM_CONFIG_LOGLEVEL: 'error',
			OPENCODE_PERMISSION: permissionsEnv,
		};

		// Inject auto-compaction if not present and enabled
		if (!processEnv.OPENCODE_CONFIG_CONTENT) {
			const autoCompact = config.autoCompact ?? true;
			if (autoCompact) {
				processEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
					compaction: { auto: true },
				});
			}
		}

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

			// Save current cwd to restore later if needed, though we don't change process.cwd() here directly
			// The SDK might spawn a process.
			// The SDK createOpencode doesn't take 'env' directly in the typed options usually,
			// but we can try to set process.env before calling it or assume it inherits.
			// However, looking at the SDK, it spawns 'npx opencode-ai serve'.
			// We'll set the environment variables on the current process temporarily or
			// rely on the fact that spawned processes inherit process.env.

			// We merge our config env into process.env for the spawn
			Object.assign(process.env, processEnv);

			const { createOpencode } = await import('@opencode-ai/sdk');
			this.opencode = (await createOpencode({
				hostname: '127.0.0.1',
				port: 0,
				timeout: config.serverTimeoutMs ?? 15000,
			})) as unknown as OpencodeInstance;

			// Restore env? Usually better to leave it contaminated or manage it carefully.
			// For now, we leave it as the extension process env might need these for other spawns.
			// Or we can restore:
			// process.env = originalEnv;
			// But 'process.env' assignment is not safe in Node.
			// Let's iterate and delete keys if we want to be clean, but for now it's fine.

			this.serverUrl = this.opencode.server.url;
			this.directory = workspaceRoot;

			// Extract port and save to port file for discovery
			try {
				const url = new URL(this.serverUrl);
				const port = url.port;
				if (port) {
					const portFile = this.getPortFilePath(workspaceRoot);
					await fs.promises.writeFile(portFile, port);
					logger.info(`[OpenCode] Saved server port ${port} to ${portFile}`);
				}
			} catch (e) {
				logger.warn('[OpenCode] Failed to save port file:', e);
			}

			logger.info(`[OpenCode] Server started at ${this.serverUrl}`);

			// We don't have direct access to stdout/stderr stream from SDK instance usually,
			// unless we attach to the underlying process if exposed.
			// For now, we lose the direct stdout logging unless SDK exposes it.
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to start server:', error);
			this.emit('event', {
				type: 'error',
				data: { message: error instanceof Error ? error.message : String(error) },
			});
			throw error;
		} finally {
			if (changedCwd) {
				try {
					process.chdir(prevCwd);
				} catch (e) {
					logger.warn(`[OpenCode] Failed to restore CWD:`, e);
				}
			}
		}
	}

	async executeCommand(
		command: string,
		_args: string[], // OpenCode commands are usually single strings like "status" or "models/anthropic"
		config: CLIConfig,
	): Promise<void> {
		if (!this.serverUrl) {
			await this.ensureServer(config);
		}
		if (!this.serverUrl || !this.directory) {
			throw new Error('OpenCode server not ready');
		}

		// Map slash commands to OpenCode SDK calls
		const cmd = command.replace(/^\//, '');

		// First try to check if it's a dynamic command supported by the server
		// Reference: available_slash_commands/discover_slash_commands
		// We can list commands and see if it exists, or just try to execute specific ones we know.
		// Since executeCommand interface is generic, we can try to find if it matches known SDK commands.

		// For now we keep hardcoded handling for critical ones, but fall back or check list.
		// Reference implementation "run_slash_command" effectively handles discovery.
		// Here we implement specific handlers for known commands that map to SDK endpoints.

		switch (cmd) {
			case 'compact':
			case 'summarize': {
				if (!this.sessionId) {
					throw new Error('No active session to compact');
				}

				// Resolve model from configuration for summarization
				const modelSpec = this.parseModel(config.model);
				if (!modelSpec) {
					this.emit('event', {
						type: 'tool_result',
						data: {
							tool_use_id: 'system',
							name: 'compact',
							content: 'Error: No model configured for compaction.',
							is_error: true,
						},
					});
					break;
				}

				try {
					await this.sessionSummarize(this.directory, this.sessionId, modelSpec);
					this.emit('event', {
						type: 'tool_result',
						data: {
							tool_use_id: 'system',
							name: 'compact',
							content: 'Session compacted successfully.',
						},
					});
				} catch (error) {
					this.emit('event', {
						type: 'tool_result',
						data: {
							tool_use_id: 'system',
							name: 'compact',
							content: `Error compacting session: ${error instanceof Error ? error.message : String(error)}`,
							is_error: true,
						},
					});
				}
				break;
			}
			case 'commands': {
				const commands = await this.listCommands(this.directory);
				this.emit('event', {
					type: 'tool_result',
					data: {
						tool_use_id: 'system',
						name: 'commands',
						content: JSON.stringify(commands, null, 2),
					},
				});
				break;
			}
			case 'models': {
				const providers = await this.listConfigProviders(this.directory);
				this.emit('event', {
					type: 'tool_result',
					data: {
						tool_use_id: 'system',
						name: 'models',
						content: JSON.stringify(providers, null, 2),
					},
				});
				break;
			}
			case 'agents': {
				const agents = await this.listAgents(this.directory);
				this.emit('event', {
					type: 'tool_result',
					data: {
						tool_use_id: 'system',
						name: 'agents',
						content: JSON.stringify(agents, null, 2),
					},
				});
				break;
			}
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
			default: {
				// Dynamic command handling
				// Check if the command exists in the server
				const commands = await this.listCommands(this.directory);
				const targetCmd = commands.find(c => c.name === cmd);

				if (targetCmd) {
					// NOTE: To properly support arbitrary slash commands from the SDK, we would need
					// a generic "run_slash_command" endpoint or mechanism in the OpenCode server/SDK logic
					// which currently maps specific commands (like /compact) to tailored implementations.
					// For now, we acknowledge it exists but explain limitation to the user.
					logger.warn(`OpenCode command '${cmd}' found but generic execution not implemented.`);
					this.emit('event', {
						type: 'tool_result',
						data: {
							tool_use_id: 'system',
							name: cmd,
							content: `Command '/${cmd}' is recognized but generic execution is not yet supported in this client version.`,
						},
					});
				} else {
					logger.warn(`Unknown OpenCode command: ${command}`);
					this.emit('event', {
						type: 'error',
						data: { message: `Unknown command: ${command}` },
					});
				}
				break;
			}
		}
	}

	private async listCommands(
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		if (!this.opencode) return [];
		try {
			const result = await this.opencode.client.command.list({
				query: { directory },
			});
			if (result.error) throw result.error;
			return result.data || [];
		} catch (error) {
			logger.warn('[OpenCode] Failed to list commands via SDK, falling back to fetch', error);
			if (!this.serverUrl) return [];
			// Fallback to manual fetch if SDK fails (e.g. method missing)
			const resp = await fetch(
				`${this.serverUrl}/command?directory=${encodeURIComponent(directory)}`,
				{
					headers: this.buildOpenCodeHeaders(directory),
				},
			);
			if (!resp.ok) return [];
			return (await resp.json()) as Array<{ name: string; description?: string }>;
		}
	}

	private async listConfigProviders(directory: string): Promise<unknown> {
		if (!this.opencode) return {};
		try {
			const result = await this.opencode.client.config.providers({
				query: { directory },
			});
			if (result.error) throw result.error;
			return result.data || {};
		} catch (error) {
			logger.warn('[OpenCode] Failed to list providers via SDK, falling back to fetch', error);
			if (!this.serverUrl) return {};
			const resp = await fetch(
				`${this.serverUrl}/config/providers?directory=${encodeURIComponent(directory)}`,
				{
					headers: this.buildOpenCodeHeaders(directory),
				},
			);
			if (!resp.ok) return {};
			return await resp.json();
		}
	}

	private async listAgents(directory: string): Promise<unknown> {
		if (!this.opencode) return [];
		try {
			const result = await this.opencode.client.agent.list({
				query: { directory },
			});
			if (result.error) throw result.error;
			return result.data || [];
		} catch (error) {
			logger.warn('[OpenCode] Failed to list agents via SDK, falling back to fetch', error);
			if (!this.serverUrl) return [];
			const resp = await fetch(
				`${this.serverUrl}/agent?directory=${encodeURIComponent(directory)}`,
				{
					headers: this.buildOpenCodeHeaders(directory),
				},
			);
			if (!resp.ok) return [];
			return await resp.json();
		}
	}

	private async getMcpStatus(directory: string): Promise<unknown> {
		if (!this.opencode) return {};
		try {
			const result = await this.opencode.client.mcp.list({
				query: { directory },
			});
			if (result.error) throw result.error;
			return result.data || {};
		} catch (error) {
			logger.warn('[OpenCode] Failed to get MCP status via SDK, falling back to fetch', error);
			if (!this.serverUrl) return {};
			const resp = await fetch(`${this.serverUrl}/mcp?directory=${encodeURIComponent(directory)}`, {
				headers: this.buildOpenCodeHeaders(directory),
			});
			if (!resp.ok) return {};
			return await resp.json();
		}
	}

	private async sessionSummarize(
		directory: string,
		sessionId: string,
		model: { providerID: string; modelID: string },
	): Promise<void> {
		if (!this.opencode) throw new Error('OpenCode client not initialized');

		const req = {
			providerID: model.providerID,
			modelID: model.modelID,
			auto: false,
		};

		const result = await this.opencode.client.session.summarize({
			path: { id: sessionId },
			query: { directory },
			body: req,
		});

		if (result.error) {
			throw new Error(`OpenCode summarize failed: ${JSON.stringify(result.error)}`);
		}
	}

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		logger.info('[OpenCodeExecutor] spawn called', {
			prompt: prompt.slice(0, 50),
			model: config.model,
		});

		await this.ensureServer(config);
		await this.createNewSession(prompt, config);
		return null as unknown as ChildProcess;
	}

	async spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.opencode || !this.serverUrl) {
			throw new Error('OpenCode server not running');
		}

		const forkedSessionId = await this.forkSession(config.workspaceRoot, sessionId);
		this.sessionId = forkedSessionId;
		this.emit('event', { type: 'session_updated', data: { sessionId: forkedSessionId } });

		this.startEventStream(this.serverUrl, config.workspaceRoot);
		await this.sendPrompt(config.workspaceRoot, forkedSessionId, prompt, config);
		return null as unknown as ChildProcess;
	}

	async spawnReview(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		logger.info('[OpenCodeExecutor] spawnReview called');
		await this.ensureServer(config);
		return await this.createNewSession(prompt, config);
	}

	async createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.opencode || !this.serverUrl) {
			throw new Error('OpenCode server not running');
		}

		logger.info('[OpenCodeExecutor] Creating new session on existing server...');
		this.sessionId = await this.createSession(config.workspaceRoot);
		logger.info(`[OpenCodeExecutor] New session created: ${this.sessionId}`);
		this.emit('event', { type: 'session_updated', data: { sessionId: this.sessionId } });

		this.startEventStream(this.serverUrl, config.workspaceRoot);
		await this.sendPrompt(config.workspaceRoot, this.sessionId, prompt, config);
		logger.info('[OpenCodeExecutor] Prompt sent to new session');
		return null as unknown as ChildProcess;
	}

	private buildOpenCodeHeaders(directory: string): Record<string, string> {
		// When using SDK, we might not need the password header if we rely on the client.
		// However, for manual fetch calls (like SSE), we do need headers.
		// createOpencode likely configures the client with necessary auth.
		// For manual fetch, we should see if SDK exposes auth headers or if we need to pass what we know.
		// If SDK spawns with a generated password that we don't know, we might have trouble with manual fetch.
		// Wait, createOpencode doesn't return the password. It returns a pre-configured client.
		// BUT the 'server' object usually exposes URL. Does it expose the password or headers?
		// Checking the SDK types via inference or assumption:
		// If SDK manages the server, it probably handles auth internally for its client.
		// For our manual `fetch` calls (SSE), we have a problem if we don't know the password.
		// The `OpencodeInstance` likely exposes the password or we can use the `client` to make requests.
		// ISSUE: SSE logic uses `fetch` and `headers`.
		// If I cannot get the password from `createOpencode`, I cannot use manual fetch for SSE unless I use the SDK's way of streaming.
		// Let's assume for now that I can get headers or the server doesn't enforce auth for localhost if spawned this way?
		// No, `opencode-ai serve` generates a password usually.
		// If `createOpencode` returns `client`, maybe `client` has `headers` property?
		// Or `server` object has `password`?
		// Ref: The `opencode-gui-main` uses `createOpencode`.
		// In `OpenCodeViewProvider.ts`, it accesses `this._openCodeService.getServerUrl()`.
		// It uses `fetch` for proxying.
		// `_handleProxyFetch` uses `fetch` but doesn't seem to add Authorization header from a stored password.
		// Maybe `createOpencode` starts the server WITHOUT password by default if not passed?
		// The reference implementation `OpenCodeService.ts` does `createOpencode({ ... })`. It does NOT pass a password.
		// So likely it starts without password or with a known default/no-auth for local.

		const headers: Record<string, string> = {
			'x-opencode-directory': directory,
		};
		// If we find we need auth, we'll need to check how SDK handles it.
		// For now, assuming no-auth or SDK handles it transparently for its client,
		// and manual fetch works without auth if started via SDK (maybe?).
		return headers;
	}

	private async createSession(directory: string): Promise<string> {
		if (!this.opencode) throw new Error('OpenCode client not initialized');

		const result = await this.opencode.client.session.create({
			query: { directory },
			body: {},
		});

		if (result.error) {
			throw new Error(`OpenCode create session failed: ${JSON.stringify(result.error)}`);
		}

		if (!result.data?.id) {
			throw new Error('OpenCode create session: missing id');
		}
		return result.data.id;
	}

	private async sendAbort(directory: string, sessionId: string): Promise<void> {
		if (!this.opencode) return;

		try {
			await this.opencode.client.session.abort({
				path: { id: sessionId },
				query: { directory },
			});
		} catch (error) {
			logger.debug('[OpenCode] abort failed:', error);
		}
	}

	private async sendPermissionReply(
		directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		if (!this.opencode) throw new Error('OpenCode client not initialized');

		// Method name inferred from useOpenCode.ts (postSessionIdPermissionsPermissionId) or likely alias
		// If SDK has better naming, we'd use it. For now assuming standard resource nesting if available,
		// or raw fetch if we can't find it.
		// Actually, useOpenCode.ts uses: client.postSessionIdPermissionsPermissionId
		// That's ugly generated code. Let's see if we can use a cleaner path if available,
		// or fallback to fetch for this one specific weird endpoint to be safe,
		// OR try to map it to what we think it is.
		// Given the uncertainty of the exact method name on the client object,
		// and the fact that it's a critical permission path, I'll stick to fetch for this one
		// UNLESS I'm sure.
		// BUT I can try to access it dynamically.

		try {
			const result = await this.opencode.client.permission.reply({
				path: { id: requestId },
				query: { directory },
				body: payload,
			});
			if (result.error) throw result.error;
		} catch (error) {
			// Fallback to fetch if the above SDK method doesn't exist
			if (!this.serverUrl) throw new Error('OpenCode server not running');

			logger.warn(
				'[OpenCode] Failed to send permission reply via SDK, falling back to fetch',
				error,
			);

			const resp = await fetch(
				`${this.serverUrl}/permission/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(directory)}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json', ...this.buildOpenCodeHeaders(directory) },
					body: JSON.stringify(payload),
				},
			);

			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(
					`OpenCode permission reply failed: ${resp.status} ${resp.statusText}: ${text}`,
				);
			}
		}
	}

	private async forkSession(directory: string, sessionId: string): Promise<string> {
		if (!this.opencode) throw new Error('OpenCode client not initialized');

		const result = await this.opencode.client.session.fork({
			path: { id: sessionId },
			query: { directory },
			body: {},
		});

		if (result.error) {
			throw new Error(`OpenCode fork session failed: ${JSON.stringify(result.error)}`);
		}

		if (!result.data?.id) {
			throw new Error('OpenCode fork session: missing id');
		}
		return result.data.id;
	}

	private parseModel(model?: string): { providerID: string; modelID: string } | undefined {
		if (!model) return undefined;
		const trimmed = model.trim();
		if (!trimmed) return undefined;

		const [providerID, modelID] = trimmed.split('/', 2);
		if (!providerID) return undefined;

		// OpenCode accepts provider-only model IDs as { providerID, modelID: "" }.
		return { providerID, modelID: modelID ?? '' };
	}

	private async sendPrompt(
		directory: string,
		sessionId: string,
		prompt: string,
		config: CLIConfig,
	): Promise<void> {
		if (!this.opencode) throw new Error('OpenCode client not initialized');

		const parts = [{ type: 'text' as const, text: prompt }];
		const modelSpec = this.parseModel(config.model);

		const body = {
			parts,
			...(modelSpec ? { model: modelSpec } : {}),
			...(config.agent ? { agent: config.agent } : {}),
		};

		const result = await this.opencode.client.session.prompt({
			path: { id: sessionId },
			query: { directory },
			body,
		});

		if (result.error) {
			throw new Error(`OpenCode message failed: ${JSON.stringify(result.error)}`);
		}
	}

	private async connectEventStream(
		baseUrl: string,
		directory: string,
		signal: AbortSignal,
		lastEventId?: string,
	): Promise<Response> {
		const headers: Record<string, string> = {
			Accept: 'text/event-stream',
			...this.buildOpenCodeHeaders(directory),
		};
		if (lastEventId?.trim()) {
			headers['Last-Event-ID'] = lastEventId.trim();
		}

		const resp = await fetch(`${baseUrl}/event?directory=${encodeURIComponent(directory)}`, {
			method: 'GET',
			headers,
			signal,
		});

		if (!resp.ok || !resp.body) {
			const text = await resp.text().catch(() => '');
			const detail = text ? `: ${text.slice(0, 400)}` : '';
			throw new Error(`OpenCode event stream failed: ${resp.status} ${resp.statusText}${detail}`);
		}

		return resp;
	}

	private startEventStream(baseUrl: string, directory: string): void {
		if (this.eventStreamRunning) {
			return;
		}
		this.eventStreamRunning = true;

		this.eventAbort = new AbortController();
		const signal = this.eventAbort.signal;

		const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
		const backoffMs = (baseMs: number, attempt: number): number => {
			const a = Math.max(1, Math.floor(attempt));
			return Math.min(1500, baseMs * 2 ** (a - 1));
		};

		void (async () => {
			let baseRetryDelayMs = 250;
			const maxAttempts = 6;

			try {
				this.reconnectAttempt = 0;

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
						if ((error as { name?: string }).name === 'AbortError' || signal.aborted) {
							return;
						}

						this.reconnectAttempt += 1;
						if (this.reconnectAttempt >= maxAttempts) {
							throw error;
						}

						await sleep(backoffMs(baseRetryDelayMs, this.reconnectAttempt));
						continue;
					}

					for await (const evt of this.iterSseEvents(resp.body as ReadableStream<Uint8Array>)) {
						if (signal.aborted) break;

						if (evt.id?.trim()) {
							this.lastEventId = evt.id.trim();
						}
						if (typeof evt.retry === 'number' && Number.isFinite(evt.retry) && evt.retry > 0) {
							baseRetryDelayMs = evt.retry;
						}

						this.handleSdkEvent(evt.data);
					}

					if (signal.aborted) {
						break;
					}

					this.reconnectAttempt += 1;
					if (this.reconnectAttempt >= maxAttempts) {
						throw new Error('OpenCode event stream disconnected');
					}
					await sleep(backoffMs(baseRetryDelayMs, this.reconnectAttempt));
				}
			} catch (error) {
				if ((error as { name?: string }).name === 'AbortError') {
					return;
				}
				logger.error('[OpenCode] Event stream error:', error);
				this.emit('event', {
					type: 'error',
					data: { message: error instanceof Error ? error.message : String(error) },
				});
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
		const decoder = new TextDecoder('utf-8');

		let buffer = '';
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			while (true) {
				const idx = buffer.indexOf('\n\n');
				if (idx === -1) break;
				const rawEvent = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				let id: string | undefined;
				let retry: number | undefined;
				const dataLines: string[] = [];

				for (const line of rawEvent.split(/\r?\n/)) {
					const trimmed = line.trimEnd();
					if (!trimmed) continue;
					if (trimmed.startsWith('id:')) {
						id = trimmed.slice('id:'.length).trimStart();
						continue;
					}
					if (trimmed.startsWith('retry:')) {
						const n = Number(trimmed.slice('retry:'.length).trimStart());
						if (Number.isFinite(n) && n > 0) {
							retry = n;
						}
						continue;
					}
					if (trimmed.startsWith('data:')) {
						dataLines.push(trimmed.slice('data:'.length).trimStart());
					}
				}

				if (dataLines.length === 0) continue;
				const dataText = dataLines.join('\n').trim();
				if (!dataText) continue;

				try {
					yield { id, retry, data: JSON.parse(dataText) as unknown };
				} catch {
					// Ignore malformed events.
				}
			}
		}
	}

	private handleSdkEvent(raw: unknown): void {
		const envelope = raw as _OpencodeSdkEnvelope;
		if (!envelope || typeof envelope.type !== 'string') {
			return;
		}

		const eventType = envelope.type;
		const props = (envelope.properties ?? {}) as Record<string, unknown>;

		const extractSessionId = (): string | undefined => {
			const direct = props.sessionID;
			if (typeof direct === 'string') return direct;
			const directAlt = props.sessionId;
			if (typeof directAlt === 'string') return directAlt;

			if (eventType === 'message.updated') {
				const info = props.info;
				if (info && typeof info === 'object') {
					const record = info as Record<string, unknown>;
					const sid = record.sessionID ?? record.sessionId;
					if (typeof sid === 'string') return sid;
				}
			}

			if (eventType === 'message.part.updated') {
				const part = props.part;
				if (part && typeof part === 'object') {
					const record = part as Record<string, unknown>;
					const sid = record.sessionID ?? record.sessionId;
					if (typeof sid === 'string') return sid;
				}
			}

			return undefined;
		};

		const sessionId = extractSessionId();
		// Allow events from any session to flow through.
		// We pass the sessionId to the event so the provider can route it.

		switch (eventType) {
			case 'message.updated': {
				const info = props.info as Record<string, unknown> | undefined;
				if (info) {
					const messageId = typeof info.id === 'string' ? info.id : undefined;
					const role = typeof info.role === 'string' ? info.role : undefined;
					if (messageId && (role === 'user' || role === 'assistant')) {
						this.messageRoles.set(messageId, role);
					}
				}
				break;
			}

			case 'message.part.updated': {
				const partValue = props.part as Record<string, unknown> | undefined;
				const part = this.normalizePart(partValue);
				const delta = typeof props.delta === 'string' ? props.delta : undefined;
				this.handlePartUpdated(part, sessionId, delta);
				break;
			}

			case 'permission.asked': {
				const p = props as OpenCodePermissionAsked;
				this.emit('event', {
					type: 'permission',
					data: {
						id: p.id,
						permission: p.permission,
						patterns: p.patterns ?? [],
						toolCallId: p.tool?.callID,
						toolInput: p.toolInput,
						metadata: p.metadata,
					},
					sessionId,
				});
				break;
			}

			case 'session.status': {
				const statusRaw = props.status as Record<string, unknown> | undefined;
				const status = this.normalizeSessionStatus(statusRaw);
				this.emit('event', { type: 'session_updated', data: { status }, sessionId });
				break;
			}

			case 'session.error': {
				const errorRecord = props.error as Record<string, unknown> | undefined;
				const errorData = (errorRecord?.data as Record<string, unknown> | undefined) ?? undefined;
				const message =
					(typeof errorData?.message === 'string' ? (errorData.message as string) : undefined) ??
					(typeof errorRecord?.message === 'string'
						? (errorRecord.message as string)
						: undefined) ??
					'OpenCode session error';
				this.emit('event', { type: 'error', data: { message }, sessionId });
				break;
			}

			case 'session.idle': {
				this.emit('event', { type: 'finished', data: { reason: 'idle' }, sessionId });
				break;
			}

			default:
				break;
		}
	}

	private normalizeSessionStatus(raw?: Record<string, unknown>): OpenCodeSessionStatus {
		const t = raw?.type;
		if (t === 'idle') return { type: 'idle' };
		if (t === 'busy') return { type: 'busy' };
		if (t === 'retry') {
			return {
				type: 'retry',
				attempt: typeof raw?.attempt === 'number' ? raw.attempt : undefined,
				message: typeof raw?.message === 'string' ? raw.message : undefined,
				next: typeof raw?.next === 'number' ? raw.next : undefined,
			};
		}
		return { type: 'other', raw };
	}

	private normalizePart(raw: Record<string, unknown> | undefined): OpenCodePart {
		if (!raw) return { type: 'other', raw: null };

		const t = raw.type;
		if (t === 'text' || t === 'reasoning') {
			return {
				type: t,
				messageID: typeof raw.messageID === 'string' ? raw.messageID : undefined,
				text: typeof raw.text === 'string' ? raw.text : undefined,
				sessionID: typeof raw.sessionID === 'string' ? raw.sessionID : undefined,
			};
		}

		if (t === 'tool') {
			const stateRaw = (raw.state as Record<string, unknown> | undefined) ?? undefined;
			const statusRaw = stateRaw?.status;
			const status =
				statusRaw === 'pending' ||
				statusRaw === 'running' ||
				statusRaw === 'completed' ||
				statusRaw === 'error'
					? statusRaw
					: undefined;

			return {
				type: 'tool',
				messageID: typeof raw.messageID === 'string' ? raw.messageID : undefined,
				callID: typeof raw.callID === 'string' ? raw.callID : undefined,
				tool: typeof raw.tool === 'string' ? raw.tool : undefined,
				sessionID: typeof raw.sessionID === 'string' ? raw.sessionID : undefined,
				state: {
					status,
					input: stateRaw?.input,
					output: typeof stateRaw?.output === 'string' ? (stateRaw.output as string) : undefined,
					title: typeof stateRaw?.title === 'string' ? (stateRaw.title as string) : undefined,
					metadata: stateRaw?.metadata,
				},
			};
		}

		return { type: 'other', raw };
	}

	private handlePartUpdated(part: OpenCodePart, sessionId?: string, delta?: string): void {
		if (part.type === 'text') {
			// Skip user messages - they're already added by webview
			const messageId = part.messageID;
			if (messageId && this.messageRoles.get(messageId) === 'user') {
				return;
			}

			// If delta is present, it's an incremental update
			if (delta) {
				this.emit('event', {
					type: 'message',
					data: {
						content: delta,
						partId: part.messageID,
						isDelta: true,
					},
				});
			}
			// If no delta but has text, it's either initial message or final complete text
			// We only emit it if it's not empty (to avoid redundant updates)
			else if (part.text && part.text.length > 0) {
				const content = part.text;
				const entry = this.logNormalizer.normalizeMessage(content, 'assistant');
				this.emit('event', {
					type: 'message',
					data: {
						content,
						partId: part.messageID,
						isDelta: false,
					},
					normalizedEntry: entry,
					sessionId: part.sessionID ?? sessionId,
				});
				this.emit('event', {
					type: 'normalized_log',
					data: entry,
					normalizedEntry: entry,
					sessionId: part.sessionID ?? sessionId,
				});
			}
			return;
		}

		if (part.type === 'reasoning') {
			// If delta is present, it's an incremental update
			if (delta) {
				this.emit('event', {
					type: 'thinking',
					data: {
						content: delta,
						partId: part.messageID,
						isDelta: true,
					},
					sessionId: part.sessionID ?? sessionId,
				});
			}
			// If no delta but has text, it's either initial message or final complete text
			else if (part.text && part.text.length > 0) {
				this.emit('event', {
					type: 'thinking',
					data: {
						content: part.text,
						partId: part.messageID,
						isDelta: false,
					},
					sessionId: part.sessionID ?? sessionId,
				});
			}
			return;
		}

		if (part.type === 'tool') {
			const callId = part.callID;
			if (!callId) return;

			const status = part.state?.status;
			const toolName = typeof part.tool === 'string' ? part.tool : 'unknown';
			const input = part.state?.input;

			if ((status === 'pending' || status === 'running') && !this.seenToolCalls.has(callId)) {
				this.seenToolCalls.add(callId);

				const normalized = this.logNormalizer.normalizeToolUse(
					toolName,
					(input as Record<string, unknown>) || {},
					callId,
				);

				this.emit('event', {
					type: 'tool_use',
					data: {
						id: callId,
						name: toolName,
						input,
						state: status,
						title: part.state?.title,
						metadata: part.state?.metadata,
					},
					normalizedEntry: normalized,
					sessionId: part.sessionID ?? sessionId,
				});
				this.emit('event', {
					type: 'normalized_log',
					data: normalized,
					normalizedEntry: normalized,
					sessionId: part.sessionID ?? sessionId,
				});
			}

			if ((status === 'completed' || status === 'error') && !this.completedToolCalls.has(callId)) {
				this.completedToolCalls.add(callId);
				this.emit('event', {
					type: 'tool_result',
					data: {
						tool_use_id: callId,
						name: toolName,
						content: part.state?.output ?? '',
						is_error: status === 'error',
						input,
						title: part.state?.title,
						metadata: part.state?.metadata,
					},
					sessionId: part.sessionID ?? sessionId,
				});
			}
		}
	}

	parseStream(_chunk: Buffer): CLIEvent[] {
		// OpenCode uses SSE (/event) not stdout streaming.
		return [];
	}

	async abort(): Promise<void> {
		const directory = this.directory;
		const sessionId = this.sessionId;

		if (directory && sessionId) {
			try {
				await this.sendAbort(directory, sessionId);
			} catch (error) {
				logger.debug('[OpenCode] abort failed:', error);
			}
		}

		try {
			this.eventAbort?.abort();
		} catch {
			// ignore
		}
	}

	async kill(): Promise<void> {
		// Only abort the current operation, do NOT kill the server process
		// unless explicitly requested or during cleanup.
		// For now, we assume kill() in CLIRunner is a "hard stop" of the session/process.
		// But for OpenCode, the server should persist.
		// So we just reset session state.

		await this.abort();

		// Do NOT close the server here.
		// The server should only be closed if we are disposing the entire extension
		// or switching providers.
		// But CLIRunner calls this on dispose?
		// And handleSettingsChange?

		// If we want to support "Restart Server", we need a separate method or flag.
		// For standard "Stop" or "Clear Session", we just clear session state.

		this.sessionId = null;
		this.eventStreamRunning = false;
		this.eventAbort = null;
		this.seenToolCalls.clear();
		this.completedToolCalls.clear();
	}

	async dispose(): Promise<void> {
		// Only abort the current operation.
		// We DO NOT close the server here to allow it to persist across window reloads.
		// This enables the "Port File Discovery" mechanism to reconnect to the existing server.
		// If the user wants to kill the server, they can kill the process manually or we need a specific command.
		await this.abort();

		// Note: The 'opencode' instance is left active.
		// If the extension host process dies, the OS or Node.js might kill the child process
		// depending on how it was spawned (attached vs detached).
		// However, observations show opencode processes tend to persist (zombies).
		// We rely on this persistence for reuse.

		this.opencode = null;
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
		const directory = this.directory;
		if (!directory) {
			throw new Error('OpenCode server not running');
		}

		const requestId = decision.requestId;
		if (!requestId) {
			throw new Error('OpenCode: missing requestId');
		}

		const response: 'once' | 'always' | 'reject' =
			decision.response ??
			(decision.approved ? (decision.alwaysAllow ? 'always' : 'once') : 'reject');

		await this.sendPermissionReply(directory, requestId, {
			reply: response,
			message: response === 'reject' ? 'User denied this request' : undefined,
		});
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		const baseUrl = this.serverUrl;
		const directory = this.directory;
		if (!baseUrl || !directory) return null;
		return { baseUrl, directory };
	}
}
