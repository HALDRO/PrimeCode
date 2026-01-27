/**
 * @file OpenCodeExecutor
 * @description Executor implementation for OpenCode CLI (SSE-based).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logger } from '../../utils/logger';
import { killProcessTree } from '../../utils/process';
import { LogNormalizer } from './LogNormalizer';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

type OpenCodeSdkEnvelope = {
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

export class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	private process: ChildProcess | null = null;
	private serverPassword: string | null = null;
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

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl && this.process) {
			return;
		}

		await this.ensureOpenCodeServer(config.workspaceRoot, config);
	}

	private generateServerPassword(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let password = '';
		for (let i = 0; i < 32; i++) {
			password += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return password;
	}

	private buildPermissionsEnv(autoApprove: boolean, env?: Record<string, string>): string {
		// If already set in env, add "question": "deny" if missing, but generally respect it.
		// For now, we'll just build the default like the reference does.
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
		if (this.serverUrl && this.process) {
			return;
		}

		this.serverPassword = this.generateServerPassword();
		const permissionsEnv = this.buildPermissionsEnv(false, config.env);

		const processEnv: NodeJS.ProcessEnv & {
			OPENCODE_SERVER_PASSWORD?: string;
			OPENCODE_PERMISSION?: string;
			OPENCODE_CONFIG_CONTENT?: string;
		} = {
			...process.env,
			...config.env,
			NODE_NO_WARNINGS: '1',
			NO_COLOR: '1',
			NPM_CONFIG_LOGLEVEL: 'error',
			OPENCODE_SERVER_PASSWORD: this.serverPassword,
			OPENCODE_PERMISSION: permissionsEnv,
		};

		// Inject auto-compaction if not present and enabled (default true)
		if (!processEnv.OPENCODE_CONFIG_CONTENT) {
			const autoCompact = config.autoCompact ?? true; // Default to true matching reference
			if (autoCompact) {
				processEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({
					compaction: { auto: true },
				});
			}
		}

		this.process = spawn(
			'npx',
			['-y', 'opencode-ai@1.1.25', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
			{
				cwd: workspaceRoot,
				env: processEnv,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
				shell: true,
				detached: false,
			},
		);

		this.process.on('error', error => {
			logger.error('[OpenCodeExecutor] Process error:', error);
			this.emit('event', { type: 'error', data: { message: error.message } });
		});

		if (!this.process.stdout) {
			throw new Error('OpenCode process stdout is null');
		}

		logger.info('[OpenCodeExecutor] Waiting for server URL...');
		const timeoutMs = config.serverTimeoutMs ?? 180_000;
		this.serverUrl = await this.waitForServerUrl(this.process.stdout, timeoutMs);
		this.directory = workspaceRoot;
		logger.info(`[OpenCode] Server started at ${this.serverUrl}`);

		this.process.stdout.on('data', chunk => {
			logger.debug(`[OpenCode stdout] ${chunk.toString()}`);
		});

		this.process.stderr?.on('data', chunk => {
			const text = chunk.toString();
			logger.debug(`[OpenCode stderr] ${text}`);
			this.logNormalizer.processStderr(text);
		});

		this.process.on('close', code => {
			logger.info('[OpenCodeExecutor] Process closed', { code });
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.serverUrl = null;
			this.directory = null;
			this.sessionId = null;
			this.serverPassword = null;
		});
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
					await this.sessionSummarize(this.serverUrl, this.directory, this.sessionId, modelSpec);
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
				const commands = await this.listCommands(this.serverUrl, this.directory);
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
				const providers = await this.listConfigProviders(this.serverUrl, this.directory);
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
				const agents = await this.listAgents(this.serverUrl, this.directory);
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
				const mcp = await this.getMcpStatus(this.serverUrl, this.directory);
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
				const commands = await this.listCommands(this.serverUrl, this.directory);
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
		baseUrl: string,
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const resp = await fetch(`${baseUrl}/command?directory=${encodeURIComponent(directory)}`, {
			headers: this.buildOpenCodeHeaders(directory),
		});
		if (!resp.ok) return [];
		return (await resp.json()) as Array<{ name: string; description?: string }>;
	}

	private async listConfigProviders(baseUrl: string, directory: string): Promise<unknown> {
		const resp = await fetch(
			`${baseUrl}/config/providers?directory=${encodeURIComponent(directory)}`,
			{
				headers: this.buildOpenCodeHeaders(directory),
			},
		);
		if (!resp.ok) return {};
		return await resp.json();
	}

	private async listAgents(baseUrl: string, directory: string): Promise<unknown> {
		const resp = await fetch(`${baseUrl}/agent?directory=${encodeURIComponent(directory)}`, {
			headers: this.buildOpenCodeHeaders(directory),
		});
		if (!resp.ok) return [];
		return await resp.json();
	}

	private async getMcpStatus(baseUrl: string, directory: string): Promise<unknown> {
		const resp = await fetch(`${baseUrl}/mcp?directory=${encodeURIComponent(directory)}`, {
			headers: this.buildOpenCodeHeaders(directory),
		});
		if (!resp.ok) return {};
		return await resp.json();
	}

	private async sessionSummarize(
		baseUrl: string,
		directory: string,
		sessionId: string,
		model: { providerID: string; modelID: string },
	): Promise<void> {
		const req = {
			providerID: model.providerID,
			modelID: model.modelID,
			auto: false,
		};

		const resp = await fetch(
			`${baseUrl}/session/${encodeURIComponent(sessionId)}/summarize?directory=${encodeURIComponent(directory)}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...this.buildOpenCodeHeaders(directory),
				},
				body: JSON.stringify(req),
			},
		);

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`OpenCode summarize failed: ${resp.status} ${resp.statusText}: ${text}`);
		}
	}

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		logger.info('[OpenCodeExecutor] spawn called', {
			prompt: prompt.slice(0, 50),
			model: config.model,
		});

		await this.ensureServer(config);
		return await this.createNewSession(prompt, config);
	}

	async spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.serverUrl) {
			throw new Error('OpenCode server not running');
		}
		if (!this.process) {
			throw new Error('OpenCode process is null');
		}

		const forkedSessionId = await this.forkSession(this.serverUrl, config.workspaceRoot, sessionId);
		this.sessionId = forkedSessionId;
		this.emit('event', { type: 'session_updated', data: { sessionId: forkedSessionId } });

		this.startEventStream(this.serverUrl, config.workspaceRoot);
		await this.sendPrompt(this.serverUrl, config.workspaceRoot, forkedSessionId, prompt, config);
		return this.process;
	}

	async spawnReview(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.serverUrl) {
			await this.ensureServer(config);
		}
		if (!this.serverUrl || !this.process) {
			throw new Error('OpenCode server not running');
		}

		// Reference: build_review_prompt.
		// For now we just prepend context if not already done by caller.
		// The caller usually constructs the prompt with diffs.
		// We treat this as a standard session creation but semantically distinct.
		// Ideally we would inspect 'context' (RepoReviewContext) but we receive a string prompt here.

		logger.info('[OpenCodeExecutor] spawnReview called');
		return await this.createNewSession(prompt, config);
	}

	async createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		if (!this.serverUrl || !this.process) {
			throw new Error('OpenCode server not running');
		}

		logger.info('[OpenCodeExecutor] Creating new session on existing server...');
		this.sessionId = await this.createSession(this.serverUrl, config.workspaceRoot);
		logger.info(`[OpenCodeExecutor] New session created: ${this.sessionId}`);
		this.emit('event', { type: 'session_updated', data: { sessionId: this.sessionId } });

		this.startEventStream(this.serverUrl, config.workspaceRoot);
		await this.sendPrompt(this.serverUrl, config.workspaceRoot, this.sessionId, prompt, config);
		logger.info('[OpenCodeExecutor] Prompt sent to new session');
		return this.process;
	}

	private async waitForServerUrl(
		stdout: NodeJS.ReadableStream,
		timeoutOverrideMs?: number,
	): Promise<string> {
		const timeoutMs =
			typeof timeoutOverrideMs === 'number' && Number.isFinite(timeoutOverrideMs)
				? timeoutOverrideMs
				: 180_000;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Timed out waiting for OpenCode server URL')),
				timeoutMs,
			);

			stdout.on('data', chunk => {
				const text = chunk.toString();
				logger.debug(`[OpenCode stdout] ${text}`);
				for (const line of text.split(/\r?\n/)) {
					const trimmed = line.trim();
					const prefix = 'opencode server listening on ';
					if (trimmed.startsWith(prefix)) {
						clearTimeout(timeout);
						resolve(trimmed.slice(prefix.length).trim());
						return;
					}
				}
			});
		});
	}

	private buildOpenCodeHeaders(directory: string): Record<string, string> {
		const headers: Record<string, string> = {
			'x-opencode-directory': directory,
		};
		if (this.serverPassword) {
			const encoded = Buffer.from(`opencode:${this.serverPassword}`).toString('base64');
			headers.Authorization = `Basic ${encoded}`;
		}
		return headers;
	}

	private async createSession(baseUrl: string, directory: string): Promise<string> {
		const resp = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(directory)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...this.buildOpenCodeHeaders(directory) },
			body: JSON.stringify({}),
		});

		if (!resp.ok) {
			throw new Error(`OpenCode create session failed: ${resp.status} ${resp.statusText}`);
		}

		const data = (await resp.json()) as { id?: string };
		if (!data.id) {
			throw new Error('OpenCode create session: missing id');
		}
		return data.id;
	}

	private async sendAbort(baseUrl: string, directory: string, sessionId: string): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 800);
		try {
			await fetch(
				`${baseUrl}/session/${encodeURIComponent(sessionId)}/abort?directory=${encodeURIComponent(directory)}`,
				{
					method: 'POST',
					signal: controller.signal,
					headers: this.buildOpenCodeHeaders(directory),
				},
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	private async sendPermissionReply(
		baseUrl: string,
		directory: string,
		requestId: string,
		payload: { reply: 'once' | 'always' | 'reject'; message?: string },
	): Promise<void> {
		const resp = await fetch(
			`${baseUrl}/permission/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(directory)}`,
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

	private async forkSession(
		baseUrl: string,
		directory: string,
		sessionId: string,
	): Promise<string> {
		const resp = await fetch(
			`${baseUrl}/session/${encodeURIComponent(sessionId)}/fork?directory=${encodeURIComponent(directory)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...this.buildOpenCodeHeaders(directory) },
				body: JSON.stringify({}),
			},
		);

		if (!resp.ok) {
			throw new Error(`OpenCode fork session failed: ${resp.status} ${resp.statusText}`);
		}

		const data = (await resp.json()) as { id?: string };
		if (!data.id) {
			throw new Error('OpenCode fork session: missing id');
		}
		return data.id;
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
		baseUrl: string,
		directory: string,
		sessionId: string,
		prompt: string,
		config: CLIConfig,
	): Promise<void> {
		const reqBody: Record<string, unknown> = {
			parts: [{ type: 'text', text: prompt }],
		};

		const modelSpec = this.parseModel(config.model);
		if (modelSpec) {
			reqBody.model = modelSpec;
		}
		if (config.agent) {
			reqBody.agent = config.agent;
		}

		const resp = await fetch(
			`${baseUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...this.buildOpenCodeHeaders(directory) },
				body: JSON.stringify(reqBody),
			},
		);

		const text = await resp.text();
		if (!resp.ok) {
			throw new Error(`OpenCode message failed: ${resp.status} ${resp.statusText}: ${text}`);
		}

		// Success response (SDK): { info, parts }
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (parsed.info && parsed.parts) {
				return;
			}
			// Error response (SDK): { name, data }
			if (typeof parsed.name === 'string') {
				const msg =
					((parsed.data as Record<string, unknown> | undefined)?.message as string | undefined) ??
					text;
				throw new Error(`OpenCode message error: ${parsed.name}: ${msg}`);
			}
		} catch {
			// If parsing fails, treat as successful.
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
		const expectedSessionId = this.sessionId ?? '';
		const envelope = raw as OpenCodeSdkEnvelope;
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
		if (expectedSessionId) {
			// Be conservative: if we cannot attribute an event to the expected session, ignore it.
			if (typeof sessionId !== 'string' || sessionId !== expectedSessionId) {
				return;
			}
		}

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
				this.handlePartUpdated(part, delta);
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
				});
				break;
			}

			case 'session.status': {
				const statusRaw = props.status as Record<string, unknown> | undefined;
				const status = this.normalizeSessionStatus(statusRaw);
				this.emit('event', { type: 'session_updated', data: { status } });
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
				this.emit('event', { type: 'error', data: { message } });
				break;
			}

			case 'session.idle': {
				this.emit('event', { type: 'finished', data: { reason: 'idle' } });
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

	private handlePartUpdated(part: OpenCodePart, delta?: string): void {
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
				});
				this.emit('event', {
					type: 'normalized_log',
					data: entry,
					normalizedEntry: entry,
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
				});
				this.emit('event', {
					type: 'normalized_log',
					data: normalized,
					normalizedEntry: normalized,
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
				});
			}
		}
	}

	parseStream(_chunk: Buffer): CLIEvent[] {
		// OpenCode uses SSE (/event) not stdout streaming.
		return [];
	}

	async kill(): Promise<void> {
		const baseUrl = this.serverUrl;
		const directory = this.directory;
		const sessionId = this.sessionId;

		// Best-effort abort current session to stop server-side processing.
		if (baseUrl && directory && sessionId) {
			try {
				await this.sendAbort(baseUrl, directory, sessionId);
			} catch (error) {
				logger.debug('[OpenCode] abort failed:', error);
			}
		}

		try {
			this.eventAbort?.abort();
		} catch {
			// ignore
		}

		if (this.process?.pid) {
			await killProcessTree(this.process.pid);
			this.process = null;
		}
		this.serverUrl = null;
		this.directory = null;
		this.sessionId = null;
		this.serverPassword = null;
		this.eventStreamRunning = false;
		this.eventAbort = null;
		this.seenToolCalls.clear();
		this.completedToolCalls.clear();
	}

	async respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void> {
		const baseUrl = this.serverUrl;
		const directory = this.directory;
		if (!baseUrl || !directory) {
			throw new Error('OpenCode server not running');
		}

		const requestId = decision.requestId;
		if (!requestId) {
			throw new Error('OpenCode: missing requestId');
		}

		const response: 'once' | 'always' | 'reject' =
			decision.response ??
			(decision.approved ? (decision.alwaysAllow ? 'always' : 'once') : 'reject');

		await this.sendPermissionReply(baseUrl, directory, requestId, {
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
