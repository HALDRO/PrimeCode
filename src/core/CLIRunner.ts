/**
 * @file CLIRunner
 * @description Unified CLI executor for Claude and OpenCode.
 * Inspired by Vibe Kanban's trait-based architecture.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { apiTokensToStats, type TokenStats, type TokenUsageAPI } from '../common';
import { logger } from '../utils/logger';

async function killProcessTree(pid: number): Promise<void> {
	if (process.platform === 'win32') {
		await new Promise<void>((resolve, reject) => {
			const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
				windowsHide: true,
			});
			child.on('error', reject);
			child.on('close', () => resolve());
		});
		return;
	}

	// On Unix, if the process was spawned with `detached: true`, it becomes a process group leader.
	// Killing the negative PID kills the entire group (best-effort).
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// ignore
		}
	}

	// Best-effort escalation to SIGKILL after a short delay.
	await new Promise<void>(resolve => setTimeout(resolve, 600));
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// ignore
		}
	}
}

// =============================================================================
// Types
// =============================================================================

export interface CLIConfig {
	provider: 'claude' | 'opencode';
	model?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	/** Additional env vars for the spawned CLI process. */
	env?: Record<string, string>;
	/** Optional server startup timeout override (milliseconds). */
	serverTimeoutMs?: number;
}

export interface CLIEvent {
	type:
		| 'message'
		| 'tool_use'
		| 'tool_result'
		| 'thinking'
		| 'error'
		| 'finished'
		| 'permission'
		| 'session_updated';
	data: unknown;
}

// =============================================================================
// Executor Interface
// =============================================================================

interface CLIExecutor extends EventEmitter {
	ensureServer(config: CLIConfig): Promise<void>;
	spawn(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess>;
	createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	kill(): Promise<void>;
	parseStream(chunk: Buffer): CLIEvent[];
	getSessionId(): string | null;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;

	getAdminInfo(): { baseUrl: string; directory: string } | null;

	// Kanban-style forward compatibility: feature flags
	getCapabilities?(): ReadonlyArray<'SessionFork' | 'SetupHelper'>;
}

// =============================================================================
// Claude Executor
// =============================================================================

class ClaudeExecutor extends EventEmitter implements CLIExecutor {
	private process: ChildProcess | null = null;
	private sessionId: string | null = null;
	private stdoutBuffer = '';

	private tokenStats: TokenStats = {
		totalTokensInput: 0,
		totalTokensOutput: 0,
		currentInputTokens: 0,
		currentOutputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		reasoningTokens: 0,
		totalReasoningTokens: 0,
		subagentTokensInput: 0,
		subagentTokensOutput: 0,
	};

	getCapabilities(): ReadonlyArray<'SessionFork' | 'SetupHelper'> {
		return ['SessionFork'];
	}

	protected spawnProcess(
		command: string,
		args: string[],
		options: Parameters<typeof spawn>[2],
	): ChildProcess {
		return spawn(command, args, options);
	}

	ensureServer(_config: CLIConfig): Promise<void> {
		// Claude is spawned per request; no persistent server to ensure.
		return Promise.resolve();
	}

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		logger.info('[ClaudeExecutor] spawn called', {
			prompt: prompt.slice(0, 50),
			model: config.model,
		});

		const args = [
			'-y',
			'@anthropic-ai/claude-code@latest',
			prompt,
			'--verbose',
			'--output-format=stream-json',
			'--input-format=stream-json',
			'--include-partial-messages',
		];

		if (config.model) args.push('--model', config.model);
		if (config.yoloMode) args.push('--yolo-mode');
		if (config.agent) args.push('--agent', config.agent);

		logger.info('[ClaudeExecutor] spawning npx', { args: args.join(' ') });

		this.process = this.spawnProcess('npx', args, {
			cwd: config.workspaceRoot,
			env: { ...process.env, ...config.env },
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: true,
			detached: false,
		});

		this.process.on('error', error => {
			logger.error('[ClaudeExecutor] Process error:', error);
			this.emit('event', { type: 'error', data: { message: error.message } });
		});

		this.process.stdout?.on('data', chunk => {
			logger.debug('[ClaudeExecutor] stdout chunk:', chunk.toString().slice(0, 200));
			const events = this.parseStream(chunk);
			for (const event of events) {
				this.emit('event', event);
			}
		});

		this.process.stderr?.on('data', chunk => {
			logger.debug(`[Claude stderr] ${chunk.toString()}`);
		});

		this.process.on('close', code => {
			logger.info('[ClaudeExecutor] Process closed', { code });
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.sessionId = null;
			this.stdoutBuffer = '';
			this.resetStats();
		});

		return this.process;
	}

	async spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess> {
		const args = [
			'-y',
			'@anthropic-ai/claude-code@latest',
			prompt,
			'--fork-session',
			'--resume',
			sessionId,
			'--verbose',
			'--output-format=stream-json',
			'--input-format=stream-json',
			'--include-partial-messages',
		];

		if (config.model) args.push('--model', config.model);
		if (config.yoloMode) args.push('--yolo-mode');

		this.process = this.spawnProcess('npx', args, {
			cwd: config.workspaceRoot,
			env: { ...process.env, ...config.env },
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			shell: true,
			detached: false,
		});

		this.process.stdout?.on('data', chunk => {
			const events = this.parseStream(chunk);
			for (const event of events) {
				this.emit('event', event);
			}
		});

		this.process.on('close', code => {
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.sessionId = null;
			this.stdoutBuffer = '';
			this.resetStats();
		});

		return this.process;
	}

	parseStream(chunk: Buffer): CLIEvent[] {
		this.stdoutBuffer += chunk.toString();

		// Claude uses stream-json (JSONL); stdout chunks may split lines arbitrarily.
		const lines = this.stdoutBuffer.split(/\r?\n/);
		this.stdoutBuffer = lines.pop() ?? '';

		const events: CLIEvent[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const json = JSON.parse(trimmed);
				const normalized = this.normalizeClaudeEvent(json);
				if (normalized) events.push(normalized);
			} catch {
				// Non-JSON lines / partial output; ignore.
			}
		}

		return events;
	}

	private normalizeClaudeEvent(event: unknown): CLIEvent | null {
		const e = event as Record<string, unknown>;
		if (e.type === 'text') {
			return { type: 'message', data: { content: e.text } };
		}
		if (e.type === 'tool_use') {
			return { type: 'tool_use', data: event };
		}
		if (e.type === 'tool_result') {
			return { type: 'tool_result', data: event };
		}
		if (e.type === 'thinking') {
			return { type: 'thinking', data: { content: e.thinking } };
		}
		if (e.type === 'assistant' || e.type === 'user') {
			const sessionId = typeof e.session_id === 'string' ? e.session_id : undefined;
			if (sessionId) {
				this.sessionId = sessionId;
				return { type: 'session_updated', data: { sessionId } };
			}
		}
		if (e.type === 'stream_event') {
			const sessionId = typeof e.session_id === 'string' ? e.session_id : undefined;
			if (sessionId) {
				this.sessionId = sessionId;
				return { type: 'session_updated', data: { sessionId } };
			}

			const usage = (e.usage as TokenUsageAPI | undefined) ?? undefined;
			if (usage) {
				this.applyUsage(usage);
				return { type: 'session_updated', data: { tokenStats: this.getTokenStatsSnapshot() } };
			}
		}
		if (e.type === 'result') {
			const sessionId = typeof e.session_id === 'string' ? e.session_id : undefined;
			if (sessionId) {
				this.sessionId = sessionId;
			}

			const durationMs = typeof e.duration_ms === 'number' ? e.duration_ms : undefined;
			const numTurns = typeof e.num_turns === 'number' ? e.num_turns : undefined;
			const totalStats: Record<string, unknown> = {
				requestCount: 1,
				currentDuration: durationMs,
				currentTurns: numTurns,
				totalDuration: durationMs,
			};

			const tokenSnapshot = this.getTokenStatsSnapshot();
			return {
				type: 'session_updated',
				data: {
					sessionId: sessionId ?? undefined,
					tokenStats: tokenSnapshot,
					totalStats,
				},
			};
		}
		if (e.type === 'control_request') {
			const req = (e.request as Record<string, unknown> | undefined) ?? undefined;
			if (req?.subtype === 'can_use_tool') {
				const requestId = typeof e.request_id === 'string' ? e.request_id : undefined;
				const toolName = typeof req.tool_name === 'string' ? req.tool_name : undefined;
				const input = (req.input as Record<string, unknown> | undefined) ?? {};
				const toolUseId = typeof req.tool_use_id === 'string' ? req.tool_use_id : undefined;
				if (!requestId || !toolName) return null;
				return {
					type: 'permission',
					data: {
						id: requestId,
						tool: toolName,
						input,
						toolUseId,
					},
				};
			}
		}
		if (e.type === 'permission_required') {
			return { type: 'permission', data: event };
		}
		if (e.type === 'error') {
			return { type: 'error', data: { message: e.error } };
		}
		return null;
	}

	private applyUsage(usage: TokenUsageAPI): void {
		const patch = apiTokensToStats(usage);
		this.tokenStats = {
			...this.tokenStats,
			...patch,
			totalTokensInput: this.tokenStats.totalTokensInput + (patch.currentInputTokens ?? 0),
			totalTokensOutput: this.tokenStats.totalTokensOutput + (patch.currentOutputTokens ?? 0),
			totalReasoningTokens: this.tokenStats.totalReasoningTokens + (patch.reasoningTokens ?? 0),
		};
	}

	private resetStats(): void {
		this.tokenStats = {
			totalTokensInput: 0,
			totalTokensOutput: 0,
			currentInputTokens: 0,
			currentOutputTokens: 0,
			cacheCreationTokens: 0,
			cacheReadTokens: 0,
			reasoningTokens: 0,
			totalReasoningTokens: 0,
			subagentTokensInput: 0,
			subagentTokensOutput: 0,
		};
	}

	private getTokenStatsSnapshot(): TokenStats {
		return { ...this.tokenStats };
	}

	async kill(): Promise<void> {
		if (this.process?.pid) {
			await killProcessTree(this.process.pid);
		}
		this.process = null;
		this.sessionId = null;
		this.stdoutBuffer = '';
		this.resetStats();
	}

	async respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void> {
		const requestId = decision.requestId;
		if (!requestId) {
			throw new Error('Claude: missing requestId');
		}

		const response: Record<string, unknown> = decision.approved
			? { behavior: 'allow' }
			: { behavior: 'deny', message: 'User denied this request' };

		this.writeStdinLine({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: requestId,
				response,
			},
		});
	}

	private writeStdinLine(payload: unknown): void {
		if (!this.process?.stdin) {
			throw new Error('Claude stdin is not available');
		}
		this.process.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	async createNewSession(_prompt: string, _config: CLIConfig): Promise<ChildProcess> {
		throw new Error('ClaudeExecutor does not support creating new sessions');
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return null;
	}
}

// =============================================================================
// OpenCode Executor (SSE, Vibe Kanban-style)
// =============================================================================

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

class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	private process: ChildProcess | null = null;
	private serverUrl: string | null = null;
	private sessionId: string | null = null;
	private directory: string | null = null;

	getCapabilities(): ReadonlyArray<'SessionFork' | 'SetupHelper'> {
		return ['SessionFork'];
	}

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;

	private lastEventId: string | null = null;
	private reconnectAttempt = 0;

	private seenToolCalls = new Set<string>();
	private completedToolCalls = new Set<string>();

	// Track message roles to filter out user messages (like Vibe Kanban does)
	private messageRoles = new Map<string, 'user' | 'assistant'>();

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl && this.process) {
			return;
		}

		const timeoutMs =
			typeof config.serverTimeoutMs === 'number' && Number.isFinite(config.serverTimeoutMs)
				? config.serverTimeoutMs
				: 180_000;

		await this.ensureOpenCodeServer(config.workspaceRoot, config.env, timeoutMs);
	}

	private async ensureOpenCodeServer(
		workspaceRoot: string,
		env: Record<string, string> | undefined,
		timeoutMs: number,
	): Promise<void> {
		if (this.serverUrl && this.process) {
			return;
		}

		this.process = spawn(
			'npx',
			['-y', 'opencode-ai@1.1.3', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
			{
				cwd: workspaceRoot,
				env: { ...process.env, ...env, NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
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
		this.serverUrl = await this.waitForServerUrl(this.process.stdout, timeoutMs);
		this.directory = workspaceRoot;
		logger.info(`[OpenCode] Server started at ${this.serverUrl}`);

		// Continue draining stdout to avoid backpressure (like Vibe Kanban does)
		this.process.stdout.on('data', chunk => {
			logger.debug(`[OpenCode stdout] ${chunk.toString()}`);
		});

		this.process.stderr?.on('data', chunk => {
			logger.debug(`[OpenCode stderr] ${chunk.toString()}`);
		});

		this.process.on('close', code => {
			logger.info('[OpenCodeExecutor] Process closed', { code });
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.serverUrl = null;
			this.directory = null;
			this.sessionId = null;
		});
	}

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		logger.info('[OpenCodeExecutor] spawn called', {
			prompt: prompt.slice(0, 50),
			model: config.model,
		});

		// In OpenCode mode, `spawn()` must actually run the request:
		// - ensure the server is running
		// - create a new session
		// - start SSE stream
		// - send the prompt
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

		// Fork the existing session to continue in a fresh server-side session.
		const forkedSessionId = await this.forkSession(this.serverUrl, config.workspaceRoot, sessionId);
		this.sessionId = forkedSessionId;
		this.emit('event', { type: 'session_updated', data: { sessionId: forkedSessionId } });

		// Ensure stream is running for this session.
		this.startEventStream(this.serverUrl, config.workspaceRoot);
		await this.sendPrompt(this.serverUrl, config.workspaceRoot, forkedSessionId, prompt, config);
		return this.process;
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
		return {
			'x-opencode-directory': directory,
		};
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
				this.emit('event', {
					type: 'message',
					data: {
						content: part.text,
						partId: part.messageID,
						isDelta: false,
					},
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

// =============================================================================
// CLI Runner (Facade)
// =============================================================================

export class CLIRunner extends EventEmitter {
	private executor: CLIExecutor;
	private currentSessionId: string | null = null;

	constructor(provider: 'claude' | 'opencode') {
		super();

		if (provider === 'claude') {
			this.executor = new ClaudeExecutor();
		} else {
			this.executor = new OpenCodeExecutor();
		}

		// Forward events from executor
		this.executor.on('event', (event: CLIEvent) => {
			if (event.type === 'session_updated') {
				const data = event.data as Record<string, unknown>;
				const sessionId =
					typeof data.sessionId === 'string' ? (data.sessionId as string) : undefined;
				if (sessionId) {
					this.currentSessionId = sessionId;
				}
			}
			this.emit('event', event);
		});
	}

	async spawn(prompt: string, config: CLIConfig): Promise<void> {
		await this.executor.spawn(prompt, config);
	}

	async spawnFollowUp(prompt: string, config: CLIConfig): Promise<void> {
		if (!this.currentSessionId) {
			throw new Error('No active session');
		}
		await this.executor.spawnFollowUp(prompt, this.currentSessionId, config);
	}

	async createNewSession(prompt: string, config: CLIConfig): Promise<void> {
		await this.executor.createNewSession(prompt, config);
	}

	async respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void> {
		await this.executor.respondToPermission(decision);
	}

	async kill(): Promise<void> {
		await this.executor.kill();
		this.currentSessionId = null;
	}

	getSessionId(): string | null {
		return this.currentSessionId;
	}

	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null {
		return this.executor.getAdminInfo();
	}
}
