/**
 * @file RestoreHandler - Handles checkpoint restore and unrevert operations
 * @description The single source of truth for checkpoint data. The backend registers
 *              checkpoints (commitId → metadata) and the frontend only sends a commitId.
 *              RestoreHandler resolves the commitId to the real API parameters (sessionId,
 *              messageId) and calls the appropriate endpoint. The frontend has ZERO
 *              knowledge of OpenCode message IDs, session IDs, or provider differences.
 */

import * as vscode from 'vscode';
import type { CommandOf, SessionEventMessage, WebviewCommand } from '../../common/protocol';
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

	constructor(private readonly context: HandlerContext) {}

	/** Register a checkpoint so the frontend can later restore it by commitId alone. */
	registerCheckpoint(commitId: string, record: CheckpointRecord): void {
		this.checkpoints.set(commitId, record);
		logger.debug('[RestoreHandler] Registered checkpoint', { commitId, ...record });
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
	 * The frontend sends ONLY `{ commitId }`. This handler looks up the
	 * checkpoint in the backend registry and calls the appropriate API.
	 */
	private async handleRestoreCommit(msg: CommandOf<'restoreCommit'>): Promise<void> {
		const { commitId } = msg;

		if (!commitId) {
			logger.warn('[RestoreHandler] restoreCommit: no commitId provided');
			return;
		}

		const record = this.checkpoints.get(commitId);
		if (!record) {
			logger.warn('[RestoreHandler] restoreCommit: unknown commitId', { commitId });
			return;
		}

		// OpenCode: POST /session/:id/revert { messageID }
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[RestoreHandler] restoreCommit: no workspace root');
			return;
		}

		logger.info('[RestoreHandler] Restoring checkpoint', {
			commitId,
			sessionId: record.sessionId,
			messageId: record.messageId,
		});

		try {
			await this.context.cli.truncateSession(record.sessionId, record.messageId, {
				provider: 'opencode',
				workspaceRoot,
			});

			this.notifyRestoreResult(record.sessionId, {
				canUnrevert: true,
				revertedFromMessageId: record.associatedMessageId,
			});
			this.notifyUnrevertAvailable(record.sessionId, true);
			logger.info('[RestoreHandler] Checkpoint restored successfully');
		} catch (error) {
			logger.error('[RestoreHandler] Failed to restore checkpoint', error);
			this.notifyError(record.sessionId, `Failed to restore checkpoint: ${error}`);
		}
	}

	/**
	 * Handle unrevert from webview.
	 * Frontend sends `{ }` — we use the active session.
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
			const serverInfo = this.context.cli.getOpenCodeServerInfo();
			if (!serverInfo) throw new Error('OpenCode server not running');

			const url = new URL(`${serverInfo.baseUrl}/session/${sessionId}/unrevert`);
			url.searchParams.append('directory', workspaceRoot);

			const resp = await fetch(url.toString(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			});

			if (!resp.ok) {
				const text = await resp.text();
				throw new Error(`Unrevert failed: ${resp.status} ${resp.statusText} - ${text}`);
			}

			this.notifyRestoreResult(sessionId, { canUnrevert: false });
			this.notifyUnrevertAvailable(sessionId, false);
			logger.info('[RestoreHandler] Unrevert successful');
		} catch (error) {
			logger.error('[RestoreHandler] Unrevert failed', error);
			this.notifyError(sessionId, `Failed to unrevert: ${error}`);
		}
	}

	// =========================================================================
	// Notification helpers — keep the main methods clean
	// =========================================================================

	private notifyRestoreResult(
		sessionId: string,
		opts: { canUnrevert: boolean; revertedFromMessageId?: string },
	): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore',
			payload: {
				eventType: 'restore',
				action: 'success',
				canUnrevert: opts.canUnrevert,
				revertedFromMessageId: opts.revertedFromMessageId,
			},
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}

	private notifyUnrevertAvailable(sessionId: string, available: boolean): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore',
			payload: { eventType: 'restore', action: 'unrevert_available', available },
			timestamp: Date.now(),
			sessionId,
		} satisfies SessionEventMessage);
	}

	private notifyError(sessionId: string, message: string): void {
		this.context.view.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore',
			payload: { eventType: 'restore', action: 'error', message },
			timestamp: Date.now(),
			sessionId,
		} as SessionEventMessage);
	}
}
