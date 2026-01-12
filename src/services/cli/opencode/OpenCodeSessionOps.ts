/**
 * @file OpenCode Session Operations
 * @description Handles session-related operations (CRUD, commands, shell, summary, status monitoring).
 * Extends BaseOpenCodeOps for unified error handling and reduced boilerplate.
 * Uses Context Accessor pattern for safe state access.
 * Updated for SDK v2 flat parameter style. Includes session.status() for monitoring.
 */

import type { CLISession } from '../../ICLIService';
import { BaseOpenCodeOps } from './BaseOpenCodeOps.js';
import type { OpenCodeSession } from './types.js';

export class OpenCodeSessionOps extends BaseOpenCodeOps {
	// =========================================================================
	// Core Session CRUD
	// =========================================================================

	public async createSession(): Promise<string> {
		const client = this._getClient();
		const res = await client.session.create({ directory: this._workspaceDir });
		if (res.error) throw new Error(`Create session failed: ${JSON.stringify(res.error)}`);
		return (res.data as OpenCodeSession).id;
	}

	public async listSessions(): Promise<CLISession[]> {
		return this.safeExecuteOrThrow(
			'List sessions',
			client => client.session.list({ directory: this._workspaceDir }),
			(data: OpenCodeSession[]) =>
				(data || []).map(s => ({
					id: s.id,
					title: s.title,
					projectID: s.projectID,
					directory: s.directory,
					time: s.time,
				})),
		);
	}

	public async switchSession(sessionId: string): Promise<CLISession> {
		return this.safeExecuteOrThrow(
			`Get session ${sessionId}`,
			client =>
				client.session.get({
					sessionID: sessionId,
					directory: this._workspaceDir,
				}),
			(data: OpenCodeSession) => ({
				id: data.id,
				title: data.title,
				projectID: data.projectID,
				directory: data.directory,
				time: data.time,
			}),
		);
	}

	public async getMessages(sessionId: string): Promise<Array<{ info: unknown; parts: unknown[] }>> {
		return this.safeExecuteOrThrow(
			`Get messages for session ${sessionId}`,
			client =>
				client.session.messages({
					sessionID: sessionId,
					directory: this._workspaceDir,
				}),
			(data: Array<{ info: unknown; parts: unknown[] }>) => data || [],
		);
	}

	public async deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Deleting session ${sessionId}`, client =>
			client.session.delete({
				sessionID: sessionId,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	public async updateSession(
		sessionId: string,
		updates: { title?: string },
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Updating session ${sessionId}`, client =>
			client.session.update({
				sessionID: sessionId,
				directory: this._workspaceDir,
				title: updates.title,
			}),
		);
		return { success: result.success, error: result.error };
	}

	public async abortSession(sessionId: string): Promise<void> {
		await this.safeExecuteOrThrow(`Abort session ${sessionId}`, client =>
			client.session.abort({
				sessionID: sessionId,
				directory: this._workspaceDir,
			}),
		);
	}

	// =========================================================================
	// Session Status & Monitoring
	// =========================================================================

	/**
	 * Get status of all sessions (idle, busy, retry).
	 * SDK v2 API: session.status()
	 * @returns Map of sessionId to status object, or null on error
	 */
	public async getSessionStatus(): Promise<Record<
		string,
		{ type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string; next?: number }
	> | null> {
		return this.safeExecute('Get session status', client =>
			client.session.status({ directory: this._workspaceDir }),
		);
	}

	// =========================================================================
	// Session State Operations
	// =========================================================================

	public async getSessionTodos(
		sessionId: string,
	): Promise<Array<{ id: string; content: string; status: string; priority: string }> | null> {
		return this.safeExecute(`Get todos for session ${sessionId}`, client =>
			client.session.todo({
				sessionID: sessionId,
				directory: this._workspaceDir,
			}),
		);
	}

	public async getSessionDiff(
		sessionId: string,
		messageId?: string,
	): Promise<Array<{
		file: string;
		before: string;
		after: string;
		additions: number;
		deletions: number;
	}> | null> {
		return this.safeExecute(`Getting diff for session ${sessionId}`, client =>
			client.session.diff({
				sessionID: sessionId,
				directory: this._workspaceDir,
				messageID: messageId,
			}),
		);
	}

	public async getSessionChildren(sessionId: string): Promise<CLISession[] | null> {
		return this.safeExecute(
			`Get children for session ${sessionId}`,
			client =>
				client.session.children({
					sessionID: sessionId,
					directory: this._workspaceDir,
				}),
			(data: OpenCodeSession[]) =>
				(data || []).map(s => ({
					id: s.id,
					title: s.title,
					projectID: s.projectID,
					directory: s.directory,
					time: s.time,
				})),
		);
	}

	// =========================================================================
	// Session Commands & Actions
	// =========================================================================

	public async initSession(
		sessionId: string,
		options?: { providerID?: string; modelID?: string; messageID?: string },
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Initializing session ${sessionId}`, client =>
			client.session.init({
				sessionID: sessionId,
				directory: this._workspaceDir,
				providerID: options?.providerID,
				modelID: options?.modelID,
				messageID: options?.messageID,
			}),
		);
		return { success: result.success, error: result.error };
	}

	public async executeCommand(
		sessionId: string,
		command: string,
		args?: string,
		options?: { agent?: string; model?: string },
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Executing command ${command} in session ${sessionId}`,
			client =>
				client.session.command({
					sessionID: sessionId,
					directory: this._workspaceDir,
					command,
					arguments: args || '',
					agent: options?.agent,
					model: options?.model,
				}),
		);
		return { success: result.success, error: result.error };
	}

	public async executeShell(
		sessionId: string,
		command: string,
		options?: { agent?: string; providerID?: string; modelID?: string },
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Executing shell command in session ${sessionId}`,
			client =>
				client.session.shell({
					sessionID: sessionId,
					directory: this._workspaceDir,
					command,
					agent: options?.agent || 'build',
					model:
						options?.providerID && options?.modelID
							? { providerID: options.providerID, modelID: options.modelID }
							: undefined,
				}),
		);
		return { success: result.success, error: result.error };
	}

	public async summarizeSession(
		sessionId: string,
		options?: { providerID?: string; modelID?: string; auto?: boolean },
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Summarizing session ${sessionId}`, client =>
			client.session.summarize({
				sessionID: sessionId,
				directory: this._workspaceDir,
				providerID: options?.providerID || 'anthropic',
				modelID: options?.modelID || 'claude-sonnet-4-5',
				auto: options?.auto,
			}),
		);
		return { success: result.success, error: result.error };
	}

	// =========================================================================
	// Session Sharing
	// =========================================================================

	public async shareSession(
		sessionId: string,
	): Promise<{ success: boolean; shareUrl?: string; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Sharing session ${sessionId}`,
			client =>
				client.session.share({
					sessionID: sessionId,
					directory: this._workspaceDir,
				}),
			(data: { share?: { url: string } }) => ({ shareUrl: data?.share?.url }),
		);
		return {
			success: result.success,
			shareUrl: result.data?.shareUrl,
			error: result.error,
		};
	}

	public async unshareSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Unsharing session ${sessionId}`, client =>
			client.session.unshare({
				sessionID: sessionId,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	// =========================================================================
	// Session History Operations (Revert/Fork)
	// =========================================================================

	public async revertToMessage(
		sessionId: string,
		messageId: string,
	): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Reverting session ${sessionId} to message ${messageId}`,
			client =>
				client.session.revert({
					sessionID: sessionId,
					directory: this._workspaceDir,
					messageID: messageId,
				}),
		);
		return { success: result.success, error: result.error };
	}

	public async unrevertSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
		const result = await this.safeExecuteWithLog(`Unreverting session ${sessionId}`, client =>
			client.session.unrevert({
				sessionID: sessionId,
				directory: this._workspaceDir,
			}),
		);
		return { success: result.success, error: result.error };
	}

	public async forkSession(
		sessionId: string,
		messageId: string,
	): Promise<{ success: boolean; newSessionId?: string; error?: string }> {
		const result = await this.safeExecuteWithLog(
			`Forking session ${sessionId} at message ${messageId}`,
			client =>
				client.session.fork({
					sessionID: sessionId,
					directory: this._workspaceDir,
					messageID: messageId,
				}),
			(data: { id?: string } | undefined) => {
				const newSessionId = data?.id;
				if (!newSessionId) {
					throw new Error('Fork succeeded but no new session ID returned');
				}
				return { newSessionId };
			},
		);

		return {
			success: result.success,
			newSessionId: result.data?.newSessionId,
			error: result.error,
		};
	}
}
