/**
 * @file CLIRunner.ts
 * @description Stateless facade over CLI executors (Claude / OpenCode).
 * All session-ID tracking lives in SessionState (single source of truth);
 * CLIRunner passes sessionId explicitly via method parameters.
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
	private readonly provider: 'claude' | 'opencode';

	constructor(provider: 'claude' | 'opencode') {
		super();
		this.provider = provider;

		if (provider === 'claude') {
			this.executor = new ClaudeExecutor();
		} else {
			this.executor = new OpenCodeExecutor();
		}

		this.executor.on('event', (event: CLIEvent) => this.emit('event', event));
	}

	/**
	 * Starts the CLI server if needed (OpenCode).
	 */
	async start(config: CLIConfig): Promise<void> {
		if (this.executor instanceof OpenCodeExecutor) {
			await this.executor.ensureServer(config);
		}
	}

	/**
	 * Spawns a new CLI process/session with a prompt.
	 */
	async spawn(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		await this.executor.spawn(prompt, config);
		return null;
	}

	/**
	 * Sends a follow-up message to the specified session.
	 */
	async spawnFollowUp(
		prompt: string,
		sessionId: string,
		config: CLIConfig,
	): Promise<ChildProcess | null> {
		await this.executor.spawnFollowUp(prompt, sessionId, config);
		return null;
	}

	/**
	 * Truncates session history at the specified message ID (OpenCode only).
	 */
	async truncateSession(sessionId: string, messageId: string, config: CLIConfig): Promise<void> {
		if (this.executor.truncateSession) {
			await this.executor.truncateSession(sessionId, messageId, config);
		}
	}

	/**
	 * Spawns a code review session.
	 */
	async spawnReview(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		if (this.executor.spawnReview) {
			await this.executor.spawnReview(prompt, config);
		} else {
			// Fallback if not specifically implemented
			await this.executor.spawn(prompt, config);
		}
		return null;
	}

	/**
	 * Creates a new session explicitly.
	 */
	async createNewSession(prompt: string, config: CLIConfig): Promise<ChildProcess | null> {
		await this.executor.createNewSession(prompt, config);
		return null;
	}

	/**
	 * Creates an empty session without sending a message. Returns the session ID.
	 */
	async createEmptySession(config: CLIConfig): Promise<string> {
		return this.executor.createEmptySession(config);
	}

	/**
	 * Responds to a permission request.
	 */
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

	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null {
		return this.executor.getAdminInfo();
	}

	/**
	 * Lists available sessions from the provider.
	 */
	async listSessions(config: CLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>
	> {
		return this.executor.listSessions(config);
	}

	/**
	 * Retrieves history for a specific session.
	 */
	async getHistory(sessionId: string, config: CLIConfig): Promise<CLIEvent[]> {
		return this.executor.getHistory(sessionId, config);
	}

	async deleteSession(sessionId: string, config: CLIConfig): Promise<boolean> {
		return this.executor.deleteSession(sessionId, config);
	}

	async renameSession(sessionId: string, title: string, config: CLIConfig): Promise<boolean> {
		return this.executor.renameSession(sessionId, title, config);
	}

	getProvider(): 'claude' | 'opencode' {
		return this.provider;
	}
}
