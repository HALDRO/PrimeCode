/**
 * @file CLIRunner
 * @description Unified CLI executor for Claude and OpenCode.
 * Inspired by Vibe Kanban's trait-based architecture.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
	env?: Record<string, string>;
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
	spawn(prompt: string, config: CLIConfig): Promise<ChildProcess>;
	spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess>;
	kill(): Promise<void>;
	parseStream(chunk: Buffer): CLIEvent[];
	getSessionId(): string | null;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;
}

// =============================================================================
// Claude Executor
// =============================================================================

class ClaudeExecutor extends EventEmitter implements CLIExecutor {
	private process: ChildProcess | null = null;
	private sessionId: string | null = null;
	private stdoutBuffer = '';

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
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

		this.process = spawn('npx', args, {
			cwd: config.workspaceRoot,
			env: { ...process.env, ...config.env },
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
		});

		this.process.stdout?.on('data', chunk => {
			const events = this.parseStream(chunk);
			for (const event of events) {
				this.emit('event', event);
			}
		});

		this.process.stderr?.on('data', chunk => {
			logger.debug(`[Claude stderr] ${chunk.toString()}`);
		});

		this.process.on('close', code => {
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.sessionId = null;
			this.stdoutBuffer = '';
		});

		return this.process;
	}

	async spawnFollowUp(prompt: string, sessionId: string, config: CLIConfig): Promise<ChildProcess> {
		const args = [
			'-y',
			'@anthropic-ai/claude-code@latest',
			prompt,
			'--session',
			sessionId,
			'--verbose',
			'--output-format=stream-json',
			'--input-format=stream-json',
			'--include-partial-messages',
		];

		if (config.model) args.push('--model', config.model);
		if (config.yoloMode) args.push('--yolo-mode');

		this.process = spawn('npx', args, {
			cwd: config.workspaceRoot,
			env: { ...process.env, ...config.env },
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
			detached: process.platform !== 'win32',
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

	async kill(): Promise<void> {
		if (this.process?.pid) {
			await killProcessTree(this.process.pid);
		}
		this.process = null;
		this.sessionId = null;
		this.stdoutBuffer = '';
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

	getSessionId(): string | null {
		return this.sessionId;
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

	private eventAbort: AbortController | null = null;
	private eventStreamRunning = false;

	private seenToolCalls = new Set<string>();
	private completedToolCalls = new Set<string>();

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		this.process = spawn(
			'npx',
			['-y', 'opencode-ai@1.1.3', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
			{
				cwd: config.workspaceRoot,
				env: { ...process.env, ...config.env, NODE_NO_WARNINGS: '1', NO_COLOR: '1' },
				stdio: ['pipe', 'pipe', 'pipe'],
			},
		);

		if (!this.process.stdout) {
			throw new Error('OpenCode process stdout is null');
		}

		this.serverUrl = await this.waitForServerUrl(this.process.stdout);
		this.directory = config.workspaceRoot;
		logger.info(`[OpenCode] Server started at ${this.serverUrl}`);

		this.sessionId = await this.createSession(this.serverUrl, config.workspaceRoot);
		this.emit('event', { type: 'session_updated', data: { sessionId: this.sessionId } });

		this.startEventStream(this.serverUrl, config.workspaceRoot, this.sessionId);
		await this.sendPrompt(this.serverUrl, config.workspaceRoot, this.sessionId, prompt, config);

		this.process.stderr?.on('data', chunk => {
			logger.debug(`[OpenCode stderr] ${chunk.toString()}`);
		});

		this.process.on('close', code => {
			this.emit('event', { type: 'finished', data: { code } });
			this.process = null;
			this.serverUrl = null;
			this.directory = null;
			this.sessionId = null;
		});

		return this.process;
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
		this.startEventStream(this.serverUrl, config.workspaceRoot, forkedSessionId);
		await this.sendPrompt(this.serverUrl, config.workspaceRoot, forkedSessionId, prompt, config);
		return this.process;
	}

	private async waitForServerUrl(stdout: NodeJS.ReadableStream): Promise<string> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Timed out waiting for OpenCode server URL')),
				180_000,
			);

			stdout.on('data', chunk => {
				const text = chunk.toString();
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
		payload: { response: 'once' | 'always' | 'reject'; message?: string },
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
		const idx = model.indexOf('/');
		if (idx <= 0 || idx === model.length - 1) return undefined;
		return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
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

	private startEventStream(baseUrl: string, directory: string, sessionId: string): void {
		if (this.eventStreamRunning) {
			return;
		}
		this.eventStreamRunning = true;

		this.eventAbort = new AbortController();
		const signal = this.eventAbort.signal;

		void (async () => {
			try {
				const resp = await fetch(`${baseUrl}/event?directory=${encodeURIComponent(directory)}`, {
					method: 'GET',
					headers: { Accept: 'text/event-stream', ...this.buildOpenCodeHeaders(directory) },
					signal,
				});

				if (!resp.ok || !resp.body) {
					throw new Error(`OpenCode event stream failed: ${resp.status} ${resp.statusText}`);
				}

				for await (const event of this.iterSseEvents(resp.body)) {
					if (signal.aborted) break;
					this.handleSdkEvent(event, sessionId);
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
	): AsyncGenerator<unknown, void, unknown> {
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

				const dataLines = rawEvent
					.split(/\r?\n/)
					.map(l => l.trimEnd())
					.filter(l => l.startsWith('data:'))
					.map(l => l.slice('data:'.length).trimStart());

				if (dataLines.length === 0) continue;
				const data = dataLines.join('\n');
				try {
					yield JSON.parse(data);
				} catch {
					// Ignore malformed events.
				}
			}
		}
	}

	private handleSdkEvent(raw: unknown, expectedSessionId: string): void {
		const envelope = raw as OpenCodeSdkEnvelope;
		if (!envelope || typeof envelope.type !== 'string') {
			return;
		}

		const eventType = envelope.type;
		const props = (envelope.properties ?? {}) as Record<string, unknown>;

		const sessionIdFromEvent = this.extractSessionId(eventType, props);
		if (sessionIdFromEvent && sessionIdFromEvent !== expectedSessionId) {
			return;
		}

		switch (eventType) {
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

	private extractSessionId(eventType: string, props: Record<string, unknown>): string | undefined {
		if (eventType === 'message.part.updated') {
			const partValue = props.part as Record<string, unknown> | undefined;
			const part = this.normalizePart(partValue);
			return part.type !== 'other' && typeof part.sessionID === 'string'
				? part.sessionID
				: undefined;
		}
		if (eventType === 'message.updated') {
			const info = (props.info as Record<string, unknown> | undefined) ?? {};
			return typeof info.sessionID === 'string' ? (info.sessionID as string) : undefined;
		}
		return typeof props.sessionID === 'string' ? (props.sessionID as string) : undefined;
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
			const content = (delta ?? part.text ?? '').toString();
			if (content.length > 0) {
				this.emit('event', { type: 'message', data: { content } });
			}
			return;
		}

		if (part.type === 'reasoning') {
			const content = (delta ?? part.text ?? '').toString();
			if (content.length > 0) {
				this.emit('event', { type: 'thinking', data: { content } });
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

		const response =
			decision.response ??
			(decision.approved ? (decision.alwaysAllow ? 'always' : 'once') : 'reject');

		await this.sendPermissionReply(baseUrl, directory, requestId, {
			response,
			message: response === 'reject' ? 'User denied this request' : undefined,
		});
	}

	getSessionId(): string | null {
		return this.sessionId;
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
}
