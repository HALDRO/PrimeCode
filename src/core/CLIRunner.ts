/**
 * @file CLIRunner
 * @description Unified CLI executor for Claude and OpenCode.
 * Re-exports from src/core/cli.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ClaudeExecutor } from './executor/ClaudeCode';
import { OpenCodeExecutor } from './executor/OpenCode';
import type { CLIConfig, CLIEvent, CLIExecutor } from './executor/types';

export type { CLIConfig, CLIEvent, CLIExecutor };

// =============================================================================
// CLI Runner (Facade)
// =============================================================================

export class CLIRunner extends EventEmitter {
	private executor: CLIExecutor;
	private currentSessionId: string | null = null;
	private provider: 'claude' | 'opencode';

	constructor(provider: 'claude' | 'opencode') {
		super();
		this.provider = provider;

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

	async start(config: CLIConfig): Promise<void> {
		if (this.executor instanceof OpenCodeExecutor) {
			await this.executor.ensureServer(config);
		}
	}

	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		await this.executor.spawn(prompt, config);
		return null;
	}

	async spawnFollowUp(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		if (!this.currentSessionId) {
			throw new Error('No active session');
		}
		await this.executor.spawnFollowUp(prompt, this.currentSessionId, config);
		return null;
	}

	async spawnReview(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		if (this.executor.spawnReview) {
			await this.executor.spawnReview(prompt, config);
		} else {
			// Fallback if not specifically implemented
			await this.executor.spawn(prompt, config);
		}
		return null;
	}

	async createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		await this.executor.createNewSession(prompt, config);
		return null;
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

	async dispose(): Promise<void> {
		if (this.executor instanceof OpenCodeExecutor) {
			await this.executor.dispose();
		} else {
			await this.executor.kill();
		}
	}

	async abort(): Promise<void> {
		await this.executor.abort();
	}

	getSessionId(): string | null {
		return this.currentSessionId;
	}

	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null {
		return this.executor.getAdminInfo();
	}

	getProvider(): 'claude' | 'opencode' {
		return this.provider;
	}
}
