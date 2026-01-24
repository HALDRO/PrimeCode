/**
 * @file ClaudeExecutor
 * @description Executor implementation for Claude Code CLI.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { apiTokensToStats, type TokenStats, type TokenUsageAPI } from '../../common';
import { logger } from '../../utils/logger';
import { killProcessTree } from '../../utils/process';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

export class ClaudeExecutor extends EventEmitter implements CLIExecutor {
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
