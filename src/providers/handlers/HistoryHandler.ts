/**
 * @file HistoryHandler
 * @description Manages conversation history operations: loading, renaming, deleting, and listing.
 *              Switches the UI session before replaying history to avoid routing messages/commits
 *              into the wrong session.
 */

import type { ConversationService } from '../../services/ConversationService';
import type { SessionManager } from '../../services/SessionManager';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface HistoryHandlerDeps {
	postMessage: (msg: unknown) => void;
	sendReadyMessage: () => Promise<void>;
	handleSwitchSession: (sessionId: string) => Promise<void>;
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
		if (success) {
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
	}

	/**
	 * Clear all conversations and sessions - complete reset
	 */
	public async clearAllConversations(): Promise<void> {
		logger.info('[HistoryHandler] Clearing all conversations and sessions');

		try {
			// 1. Close all sessions
			await this._sessionManager.closeAllSessions();

			// 2. Delete all conversation files
			await this._conversationService.clearAllConversations();

			// 3. Clear globalState persistence
			await this._sessionManager.clearPersistedSessions();

			// 4. Notify UI that all conversations are cleared
			this._deps.postMessage({ type: 'allConversationsCleared' });
			this.sendConversationList();

			// 5. Create a fresh session and send ready message
			// This ensures UI and backend are in sync with a new session
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
			// Delegate restoration logic to SessionManager
			const session = await this._sessionManager.restoreSessionFromHistory(data);
			const sessionId = session.uiSessionId;

			// Switch to this session in UI before replaying messages/commits
			// Note: handleSwitchSession already sends messagesReloaded, so we don't duplicate here
			await this._deps.handleSwitchSession(sessionId);

			// Re-verify session still exists
			if (!this._sessionManager.getSession(sessionId)) return;

			// Send stats
			this._deps.postMessage({
				type: 'updateTotals',
				data: {
					totalCost: session.totalCost,
					totalTokensInput: session.totalTokensInput,
					totalTokensOutput: session.totalTokensOutput,
					totalReasoningTokens: session.totalReasoningTokens,
					totalDuration: session.totalDuration,
					requestCount: session.requestCount,
				},
				sessionId,
			});

			// Restore commits/checkpoints for restore functionality
			if (session.commits.length > 0) {
				for (const commit of session.commits) {
					this._deps.postMessage({
						type: 'showRestoreOption',
						data: commit,
						sessionId,
					});
				}
			}
		} catch (error) {
			logger.error(`[HistoryHandler] Failed to restore session from ${filename}:`, error);
		}
	}
}
