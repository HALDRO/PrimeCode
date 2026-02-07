/**
 * @file ClaudeExecutor
 * @description Executor implementation for Claude Code CLI.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { apiTokensToStats, type TokenUsageAPI } from '../../common';
import { logger } from '../../utils/logger';
import { LogNormalizer } from './LogNormalizer';
import type { CLIConfig, CLIEvent, CLIExecutor } from './types';

interface TokenStats {
	totalTokensInput: number;
	totalTokensOutput: number;
	currentInputTokens: number;
	currentOutputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	totalReasoningTokens: number;
	subagentTokensInput: number;
	subagentTokensOutput: number;
}

export class ClaudeExecutor extends EventEmitter implements CLIExecutor {
	private process: ChildProcess | null = null;
	private sessionId: string | null = null;
	private stdoutBuffer = '';
	private logNormalizer = new LogNormalizer();
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

	constructor() {
		super();
		// Forward normalized entries
		this.logNormalizer.on('entry', entry => {
			this.emit('event', {
				type: 'normalized_log',
				data: entry,
				normalizedEntry: entry,
				sessionId: this.sessionId ?? undefined,
			});

			// Legacy compatibility: ensure 'error' events are still emitted for clustered stderr
			if (entry.entryType.type === 'ErrorMessage') {
				this.emit('event', {
					type: 'error',
					data: { message: entry.content },
					normalizedEntry: entry,
					sessionId: this.sessionId ?? undefined,
				});
			}
		});
	}

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
			'--disallowedTools=AskUserQuestion',
		];

		if (config.model) args.push('--model', config.model);
		if (config.yoloMode) args.push('--yolo-mode');
		if (config.agent) args.push('--agent', config.agent);

		logger.info('[ClaudeExecutor] spawning npx', { args: args.join(' ') });

		this.process = this.spawnProcess('npx', args, {
			cwd: config.workspaceRoot,
			env: { ...process.env, ...config.env, NPM_CONFIG_LOGLEVEL: 'error' },
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
			const text = chunk.toString();
			logger.debug(`[Claude stderr] ${text}`);
			this.logNormalizer.processStderr(text);
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
			env: { ...process.env, ...config.env, NPM_CONFIG_LOGLEVEL: 'error' },
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

	async spawnReview(prompt: string, config: CLIConfig): Promise<ChildProcess> {
		// Reference: spawn_review in Rust implementation
		// Effectively calls spawn_follow_up if session exists, or spawn new.
		// Since we don't track session ID here easily for "current", we rely on spawn being sufficient
		// or spawnFollowUp if requested.
		// For a fresh review, it's just spawn with a specific prompt (already constructed by caller).
		logger.info('[ClaudeExecutor] spawnReview called');
		return this.spawn(prompt, config);
	}

	async createNewSession(_prompt: string, _config: CLIConfig): Promise<ChildProcess | null> {
		throw new Error('ClaudeExecutor does not support creating new sessions');
	}

	async createEmptySession(_config: CLIConfig): Promise<string> {
		// Claude doesn't have persistent sessions - generate a local ID
		const sessionId = `claude-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		this.sessionId = sessionId;
		return sessionId;
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
		if (e.type === 'message') {
			const content = typeof e.content === 'string' ? e.content : '';

			const entry = this.logNormalizer.normalizeMessage(content, 'assistant');
			this.emit('event', {
				type: 'normalized_log',
				data: entry,
				normalizedEntry: entry,
				sessionId: this.sessionId ?? undefined,
			});

			return {
				type: 'message',
				data: { content, sender: 'assistant' },
				normalizedEntry: entry,
				sessionId: this.sessionId ?? undefined,
			};
		}
		if (e.type === 'tool_use') {
			const toolName = (e.tool as string) || 'unknown';
			const input = (e.tool_input as Record<string, unknown>) || {};
			const toolUseId = (e.tool_use_id as string) || 'unknown';

			const normalized = this.logNormalizer.normalizeToolUse(toolName, input, toolUseId);
			this.emit('event', {
				type: 'normalized_log',
				data: normalized,
				normalizedEntry: normalized,
				sessionId: this.sessionId ?? undefined,
			});

			return {
				type: 'tool_use',
				data: {
					tool: toolName,
					input,
					tool_use_id: toolUseId,
				},
				normalizedEntry: normalized,
				sessionId: this.sessionId ?? undefined,
			};
		}
		if (e.type === 'tool_result') {
			return { type: 'tool_result', data: event, sessionId: this.sessionId ?? undefined };
		}
		if (e.type === 'thinking') {
			return {
				type: 'thinking',
				data: { content: e.thinking },
				sessionId: this.sessionId ?? undefined,
			};
		}
		if (e.type === 'assistant' || e.type === 'user') {
			const sessionId = typeof e.session_id === 'string' ? e.session_id : undefined;
			if (sessionId) {
				this.sessionId = sessionId;
				return { type: 'session_updated', data: { sessionId }, sessionId };
			}
		}
		if (e.type === 'stream_event') {
			const sessionId = typeof e.session_id === 'string' ? e.session_id : undefined;
			if (sessionId) {
				this.sessionId = sessionId;
				return { type: 'session_updated', data: { sessionId }, sessionId };
			}

			const usage = (e.usage as TokenUsageAPI | undefined) ?? undefined;
			if (usage) {
				this.applyUsage(usage);
				return {
					type: 'session_updated',
					data: { tokenStats: this.getTokenStatsSnapshot() },
					sessionId: this.sessionId ?? undefined,
				};
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
				sessionId: this.sessionId ?? undefined,
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
					sessionId: this.sessionId ?? undefined,
				};
			}
			if (req?.subtype === 'hook_callback') {
				// Handle hook callbacks (e.g. Stop Git Check)
				const requestId = typeof e.request_id === 'string' ? e.request_id : undefined;
				const callbackId = typeof req.callback_id === 'string' ? req.callback_id : undefined;
				const input = (req.input as Record<string, unknown> | undefined) ?? {};

				if (requestId && callbackId === 'STOP_GIT_CHECK_CALLBACK_ID') {
					// Auto-approve or check status.
					// Since we don't have direct git access here, we should probably emit permission request
					// or handle it if we can.
					// Reference: client.rs handles this by checking git status.
					// We'll emit a special permission type so Handler can check Git.
					return {
						type: 'permission',
						data: {
							id: requestId,
							tool: 'StopGitCheck', // Virtual tool name for hook
							input,
							metadata: { callbackId },
						},
						sessionId: this.sessionId ?? undefined,
					};
				}
			}
		}
		if (e.type === 'permission_required') {
			return { type: 'permission', data: event, sessionId: this.sessionId ?? undefined };
		}
		if (e.type === 'error') {
			return { type: 'error', data: { message: e.error }, sessionId: this.sessionId ?? undefined };
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

	async abort(): Promise<void> {
		// Claude executor runs as a process, so aborting basically means killing the process
		// or sending SIGINT if we want to be gentle, but for now kill is fine.
		await this.kill();
	}

	async kill(): Promise<void> {
		if (this.process) {
			this.process.kill();
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

	getSessionId(): string | null {
		return this.sessionId;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return null;
	}

	async listSessions(
		_config: CLIConfig,
	): Promise<Array<{ id: string; title?: string; lastModified?: number }>> {
		// Claude executor does not support listing sessions via API
		return [];
	}

	async getHistory(_sessionId: string, _config: CLIConfig): Promise<CLIEvent[]> {
		// Claude executor does not support getting history via API
		// History is loaded from local files by ConversationService
		return [];
	}

	async deleteSession(_sessionId: string, _config: CLIConfig): Promise<boolean> {
		// Claude CLI does not expose a session delete API
		return false;
	}

	async renameSession(_sessionId: string, _title: string, _config: CLIConfig): Promise<boolean> {
		// Claude CLI does not expose a session rename API
		return false;
	}
}
