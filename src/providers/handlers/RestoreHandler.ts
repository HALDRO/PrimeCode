/**
 * @file RestoreHandler - Handles checkpoint restore and unrevert operations
 * @description The single source of truth for checkpoint data. The backend registers
 *              checkpoints (commitId → metadata) and the frontend only sends a commitId.
 *              RestoreHandler resolves the commitId to the real API parameters (sessionId,
 *              messageId) and calls the appropriate endpoint. The frontend has ZERO
 *              knowledge of OpenCode message IDs, session IDs, or provider differences.
 *
 * Multi-chat safety: the CLI server tracks revert state per-session via session.revert,
 * so reverting in chat A then chat B doesn't lose the ability to unrevert A.
 *
 * Restart safety: checkpoints are re-registered during history replay
 * (SessionHandler.replayHistoryIntoSession), so they survive extension restarts.
 * Revert state is read from the server's session.revert field during replay,
 * so it also survives restarts without local persistence.
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

	constructor(private readonly context: HandlerContext) {
		// Clean up legacy workspaceState key if present (was used before server-side revert tracking)
		void context.extensionContext.workspaceState.update('primecode.revertedSessions', undefined);
	}

	/** Register a checkpoint so the frontend can later restore it by commitId alone. */
	registerCheckpoint(commitId: string, record: CheckpointRecord): void {
		this.checkpoints.set(commitId, record);
		logger.trace('[RestoreHandler] Registered checkpoint', { commitId, ...record });
	}

	/** Clean up checkpoint data when a session is deleted. */
	cleanupSession(sessionId: string): void {
		for (const [commitId, record] of this.checkpoints) {
			if (record.sessionId === sessionId) {
				this.checkpoints.delete(commitId);
			}
		}
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'restoreCommit':
				await this.handleRestoreCommit(msg);
				break;
			case 'unrevert':
				await this.handleUnrevert(msg);
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

			// Single notification: success + unrevert available
			this.context.bridge.data('restoreState', {
				sessionId: record.sessionId,
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
	 * Uses activeSessionId — the UI only shows the unrevert button on sessions
	 * that were actually reverted, so activeSessionId is correct here.
	 */
	private async handleUnrevert(msg: CommandOf<'unrevert'>): Promise<void> {
		const sessionId = msg.sessionId || this.context.sessionState.activeSessionId;
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

			// Single notification: clear both unrevert flag and revert marker atomically.
			this.context.bridge.data('restoreState', {
				sessionId,
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
		this.context.bridge.data('restoreState', {
			sessionId,
			action: 'error',
			message,
		});
	}
}
