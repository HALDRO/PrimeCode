/**
 * @file RestoreHandler - Handles checkpoint restore and unrevert operations
 * @description The single source of truth for checkpoint data. The backend registers
 *              checkpoints (commitId → metadata) and the frontend only sends a commitId.
 *              RestoreHandler resolves the commitId to the real API parameters (sessionId,
 *              messageId) and calls the appropriate endpoint. The frontend has ZERO
 *              knowledge of OpenCode message IDs, session IDs, or provider differences.
 *
 * Multi-chat safety: revertedSessions is a per-session Set, so reverting in
 * chat A then chat B doesn't lose the ability to unrevert A.
 *
 * Restart safety: checkpoints are re-registered during history replay
 * (SessionHandler.replayHistoryIntoSession), so they survive extension restarts.
 */

import * as vscode from 'vscode';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

/** Internal checkpoint record — never sent to the frontend */
interface CheckpointRecord {
	/** The OpenCode session ID (or CLI session) this checkpoint belongs to */
	sessionId: string;
	/** The real OpenCode message ID (msg_...) to pass to the revert API */
	messageId: string;
	/** The UI message ID (user message) this checkpoint is associated with */
	associatedMessageId: string;
	/** Whether this is an OpenCode checkpoint (vs git-based) */
	isOpenCode: boolean;
}

export class RestoreHandler implements WebviewMessageHandler {
	/**
	 * Backend-only registry: commitId → checkpoint metadata.
	 * The frontend never sees the internals — it only knows commitId.
	 */
	private readonly checkpoints = new Map<string, CheckpointRecord>();

	/**
	 * Per-session revert tracking. When a session is reverted, its ID is added.
	 * When unrevert completes, it's removed. This ensures multi-chat safety:
	 * reverting in chat A then chat B doesn't lose the ability to unrevert A.
	 *
	 * Persisted to workspaceState so unrevert survives extension restarts.
	 */
	private static readonly REVERTED_KEY = 'primecode.revertedSessions';

	constructor(private readonly context: HandlerContext) {}

	private get revertedSessions(): Set<string> {
		const arr = this.context.extensionContext.workspaceState.get<string[]>(
			RestoreHandler.REVERTED_KEY,
			[],
		);
		return new Set(arr);
	}

	private persistRevertedSessions(sessions: Set<string>): void {
		void this.context.extensionContext.workspaceState.update(
			RestoreHandler.REVERTED_KEY,
			Array.from(sessions),
		);
	}

	/** Register a checkpoint so the frontend can later restore it by commitId alone. */
	registerCheckpoint(commitId: string, record: CheckpointRecord): void {
		this.checkpoints.set(commitId, record);
		logger.debug('[RestoreHandler] Registered checkpoint', { commitId, ...record });
	}

	/**
	 * Update all checkpoints for a session that still use a local UI messageId
	 * with the real server-assigned messageId. Called when SSE `message.updated`
	 * arrives for a user message, giving us the real OpenCode ID.
	 */
	resolveServerMessageId(sessionId: string, serverMessageId: string): void {
		let updated = 0;
		for (const [commitId, record] of this.checkpoints) {
			// Only update checkpoints for the same session that still have local IDs
			// (local IDs start with 'msg-' prefix from generateId, server IDs don't)
			if (record.sessionId === sessionId && record.messageId.startsWith('msg-')) {
				record.messageId = serverMessageId;
				updated++;
				logger.debug('[RestoreHandler] Resolved checkpoint messageId', {
					commitId,
					localId: record.associatedMessageId,
					serverMessageId,
				});
			}
		}
		if (updated > 0) {
			logger.info('[RestoreHandler] Resolved server messageId for checkpoints', {
				sessionId,
				serverMessageId,
				count: updated,
			});
		}
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'restoreCommit':
				await this.handleRestoreCommit(msg);
				break;
			case 'unrevert':
				await this.handleUnrevert();
				break;
		}
	}

	/**
	 * Handle restoreCommit from webview.
	 *
	 * The frontend sends `{ type: 'restoreCommit', data: { commitId } }`.
	 * The protocol also allows `{ commitId }` at the top level for backwards compat.
	 */
	private async handleRestoreCommit(msg: CommandOf<'restoreCommit'>): Promise<void> {
		const commitId = msg.data?.commitId || msg.commitId;

		if (!commitId) {
			logger.warn('[RestoreHandler] restoreCommit: no commitId provided', {
				hasData: !!msg.data,
				topLevelCommitId: msg.commitId,
			});
			return;
		}

		const record = this.checkpoints.get(commitId);
		if (!record) {
			logger.warn('[RestoreHandler] restoreCommit: unknown commitId', { commitId });
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[RestoreHandler] restoreCommit: no workspace root');
			return;
		}

		logger.info('[RestoreHandler] Restoring checkpoint', {
			commitId,
			sessionId: record.sessionId,
			messageId: record.messageId,
			associatedMessageId: record.associatedMessageId,
		});

		try {
			await this.context.cli.truncateSession(record.sessionId, record.messageId, {
				provider: 'opencode',
				workspaceRoot,
			});

			// Track this session as reverted (persisted to workspaceState)
			const sessions = this.revertedSessions;
			sessions.add(record.sessionId);
			this.persistRevertedSessions(sessions);

			// Single notification: success + unrevert available
			this.context.bridge.session.restore(record.sessionId, {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: record.associatedMessageId,
			});
			logger.info('[RestoreHandler] Checkpoint restored successfully');
		} catch (error) {
			logger.error('[RestoreHandler] Failed to restore checkpoint', error);
			this.notifyError(record.sessionId, `Failed to restore checkpoint: ${error}`);
		}
	}

	/**
	 * Handle unrevert from webview.
	 *
	 * Uses activeSessionId and validates it against revertedSessions.
	 * The UI only shows the unrevert button on sessions that were actually reverted,
	 * so activeSessionId is correct here — the user must be viewing the reverted session.
	 */
	private async handleUnrevert(): Promise<void> {
		const sessionId = this.context.sessionState.activeSessionId;
		if (!sessionId) {
			logger.warn('[RestoreHandler] unrevert: no active session');
			return;
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[RestoreHandler] unrevert: no workspace root');
			return;
		}

		logger.info('[RestoreHandler] Unreverting session', { sessionId });

		try {
			await this.context.cli.unrevertSession(sessionId, {
				provider: 'opencode',
				workspaceRoot,
			});

			// Remove from reverted set (persisted)
			const sessions = this.revertedSessions;
			sessions.delete(sessionId);
			this.persistRevertedSessions(sessions);

			// Single notification: success + unrevert no longer available
			this.context.bridge.session.restore(sessionId, {
				action: 'success',
				canUnrevert: false,
			});
			// Clear the revert marker in the UI
			this.context.bridge.session.restore(sessionId, {
				action: 'unrevert_available',
				available: false,
			});
			logger.info('[RestoreHandler] Unrevert successful');
		} catch (error) {
			logger.error('[RestoreHandler] Unrevert failed', error);
			this.notifyError(sessionId, `Failed to unrevert: ${error}`);
		}
	}

	private notifyError(sessionId: string, message: string): void {
		this.context.bridge.session.restore(sessionId, {
			action: 'error',
			message,
		});
	}
}
