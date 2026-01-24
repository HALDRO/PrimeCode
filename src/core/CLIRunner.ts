/**
 * @file CLIRunner
 * @description Unified CLI executor for Claude and OpenCode.
 * Re-exports from src/core/cli.
 */

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
