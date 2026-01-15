/**
 * @file HistoryHandler
 * @description Manages conversation history operations: loading, renaming, deleting, and listing.
 *              Uses SessionRouter for session-scoped UI state (created/switched/messages/stats).
 *              Keeps non-session global messages (conversationList, allConversationsCleared) as-is.
 */

import type { ConversationService } from '../../services/ConversationService';
import type { SessionManager } from '../../services/SessionManager';
import { logger } from '../../utils/logger';
import type { SessionRouter } from './SessionRouter';

// =============================================================================
// Types
// =============================================================================

export interface HistoryHandlerDeps {
	router: SessionRouter;
	postMessage: (msg: unknown) => void;
	sendReadyMessage: () => Promise<void>;
}

// =============================================================================
// HistoryHandler Class
// =============================================================================

export class HistoryHandler {
	constructor(
		private readonly _conversationService: ConversationService,
		private readonly _sessionManager: SessionManager,
		private readonly _deps: HistoryHandlerDeps,
	) {}

	public sendConversationList(): void {
		const list = this._conversationService.conversationIndex;
		logger.info(`[HistoryHandler] Sending conversation list (${list.length} items)`);
		this._deps.postMessage({
			type: 'conversationList',
			data: list,
		});
	}

	public async renameConversation(filename: string, newTitle: string): Promise<void> {
		const success = await this._conversationService.renameConversation(filename, newTitle);
		if (success) {
			this.sendConversationList();
		}
	}

	public async deleteConversation(filename: string): Promise<void> {
		const success = await this._conversationService.deleteConversation(filename);
		if (!success) return;

		// Also close any session that was using this conversation
		const index = this._conversationService.conversationIndex;
		const entry = index.find(e => e.filename === filename);
		if (entry?.sessionId) {
			const session = this._sessionManager.getSession(entry.sessionId);
			if (session) {
				await this._sessionManager.closeSession(entry.sessionId);
			}
		}

		this.sendConversationList();
	}

	/**
	 * Clear all conversations and sessions - complete reset.
	 */
	public async clearAllConversations(): Promise<void> {
		logger.info('[HistoryHandler] Clearing all conversations and sessions');

		try {
			await this._sessionManager.closeAllSessions();
			await this._conversationService.clearAllConversations();
			await this._sessionManager.clearPersistedSessions();

			this._deps.postMessage({ type: 'allConversationsCleared' });
			this.sendConversationList();

			// Create a fresh session and send ready message
			await this._deps.sendReadyMessage();

			logger.info('[HistoryHandler] All conversations and sessions cleared');
		} catch (error) {
			logger.error('[HistoryHandler] Failed to clear all conversations:', error);
		}
	}

	public async loadConversationHistory(filename: string): Promise<void> {
		const data = await this._conversationService.loadConversation(filename);
		if (!data) return;

		try {
			const session = await this._sessionManager.restoreSessionFromHistory(data);
			const sessionId = session.uiSessionId;

			// Ensure tab exists in UI, then switch and replay full state.
			this._deps.router.emitSessionCreated(sessionId);
			this._deps.router.emitSessionSwitched(sessionId, {
				isProcessing: session.isProcessing,
				totalStats: session.getStats(),
				messages:
					session.conversationMessages.length > 0 ? session.conversationMessages : undefined,
			});

			if (session.commits.length > 0) {
				this._deps.router.emitRestoreCommits(sessionId, session.commits);
			}

			if (session.changedFiles.length > 0) {
				for (const file of session.changedFiles) {
					this._deps.router.emitFileChanged(sessionId, {
						filePath: file.filePath,
						fileName: file.fileName,
						linesAdded: file.linesAdded,
						linesRemoved: file.linesRemoved,
						toolUseId: file.toolUseId,
					});
				}
			}
		} catch (error) {
			logger.error(`[HistoryHandler] Failed to restore session from ${filename}:`, error);
		}
	}
}
