/**
 * @file RestoreHandler
 * @description Unified restore/revert operations for all CLI providers (Claude CLI, OpenCode).
 * Implements Cursor-style UX: files are restored immediately, user message stays in place
 * for inline editing, only assistant responses after user message are removed from UI.
 * For OpenCode: uses native session.revert() with unrevert support.
 * For Claude CLI: uses git-based restore without unrevert support.
 */

import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import type { SessionManager } from '../../services/SessionManager';
import { logger } from '../../utils/logger';
import {
	convertOpenCodeMessagesToStorage,
	type OpenCodeMessage,
} from '../../utils/openCodeAdapter';

// =============================================================================
// Types
// =============================================================================

export interface RestoreHandlerDeps {
	postMessage: (msg: unknown) => void;
	sendAndSaveMessage: (msg: { type: string; [key: string]: unknown }, sessionId?: string) => void;
}

// =============================================================================
// RestoreHandler Class
// =============================================================================

export class RestoreHandler {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _deps: RestoreHandlerDeps,
	) {}

	public async restoreToCommit(commitSha: string): Promise<void> {
		const session = this._sessionManager.getActiveSession();
		if (!session) {
			logger.warn('[RestoreHandler] No active session for restore');
			return;
		}

		// Capture commit metadata before restore truncates/clears it.
		const commit = session.commits.find(c => c.sha === commitSha);

		const result = await session.restoreToCommit(commitSha);
		if (result.success) {
			// If user restored to the very first checkpoint in this session, treat it as a full reset:
			// clear conversation history and start fresh.
			const commits = session.commits;
			const isFirstCheckpoint = commits.length > 0 && commits[0]?.sha === commitSha;
			if (isFirstCheckpoint) {
				try {
					session.clearConversation();
					session.clearCommits();

					if (CLIServiceFactory.isOpenCode()) {
						// Ensure CLI service exists and create a new OpenCode session timeline.
						if (!session.cliService) {
							const globalService = await CLIServiceFactory.getService();
							if (globalService) session.setCLIService(globalService);
						}
						if (session.cliService) {
							await session.createCLISession();
						}
					}

					this._deps.postMessage({ type: 'sessionCleared', sessionId: session.uiSessionId });
					this._deps.postMessage({ type: 'clearRestoreCommits', sessionId: session.uiSessionId });
				} catch (e) {
					logger.error(
						'[RestoreHandler] Failed to fully reset session after first-checkpoint restore:',
						e,
					);
				}
			} else if (commit?.associatedMessageId) {
				// UI Management (Cursor-style) - same for all CLI providers:
				// - Git has already reverted files
				// - Keep user message in place for inline editing
				// - Only remove assistant responses after user message

				// Truncate local storage to keep user message but remove assistant responses after it
				session.truncateConversationAfterMessage(commit.associatedMessageId);
				logger.info(
					`[RestoreHandler] Truncated local storage after user message: ${commit.associatedMessageId}`,
				);

				// Truncate commits after this checkpoint
				session.truncateCommitsBeforeUserMessage(commit.associatedMessageId);

				// Tell UI to delete messages after the user message (keep user message for editing)
				this._deps.postMessage({
					type: 'deleteMessagesAfter',
					data: { messageId: commit.associatedMessageId },
					sessionId: session.uiSessionId,
				});
			}

			// restoreSuccess is a UI-only message
			this._deps.postMessage({
				type: 'restoreSuccess',
				data: {
					message: 'Files restored. Click on your message to edit and resend.',
					commitSha,
					canUnrevert: false, // Git-based restore doesn't support unrevert
				},
				sessionId: session.uiSessionId,
			});

			// Send updated commits list
			this._deps.postMessage({
				type: 'updateRestoreCommits',
				data: session.commits,
				sessionId: session.uiSessionId,
			});
		} else {
			this._deps.postMessage({ type: 'restoreError', data: result.message });
		}
	}

	/**
	 * Revert to a specific message using OpenCode's native revert mechanism.
	 *
	 * OpenCode's revert does two things:
	 * 1. Immediately rolls back files via Snapshot.revert() (git-based)
	 * 2. Marks messages for deletion - they are removed on next prompt via SessionRevert.cleanup()
	 *
	 * This is the same mechanism used by /undo command in OpenCode TUI.
	 * We do NOT need to do our own git restore - OpenCode handles it internally.
	 *
	 * UI Management (Cursor-style):
	 * - SDK reverts files immediately
	 * - UI keeps user message in place for inline editing
	 * - Only assistant responses after user message are removed from UI
	 */
	public async revertToMessage(
		sessionId: string,
		messageId: string,
		cliSessionId?: string,
		associatedMessageId?: string,
	): Promise<void> {
		const session = this._sessionManager.getSession(sessionId);
		if (!session) {
			this._deps.postMessage({ type: 'restoreError', data: 'Session not found', sessionId });
			return;
		}

		// Capture checkpoint metadata for truncating our local persisted state
		const checkpoint = session.commits.find(c => c.isOpenCodeCheckpoint && c.sha === messageId);
		// Use provided associatedMessageId or fall back to checkpoint metadata
		const effectiveAssociatedMessageId = associatedMessageId || checkpoint?.associatedMessageId;

		logger.info(
			`[RestoreHandler] revertToMessage: sessionId=${sessionId}, messageId=${messageId}, cliSessionId=${cliSessionId}`,
		);
		logger.info(`[RestoreHandler] Checkpoint: associatedMessageId=${effectiveAssociatedMessageId}`);

		if (!session.cliService) {
			this._deps.postMessage({
				type: 'restoreError',
				data: 'CLI service not available for this session',
				sessionId,
			});
			return;
		}

		const cliService = session.cliService;

		if (!cliService.revertToMessage) {
			this._deps.postMessage({
				type: 'restoreError',
				data: 'Native revert not supported for this provider',
				sessionId,
			});
			return;
		}

		this._deps.postMessage({
			type: 'restoreProgress',
			data: 'Reverting to checkpoint...',
			sessionId,
		});

		try {
			const effectiveCliSessionId = cliSessionId || session.cliSessionId || sessionId;

			logger.info(
				`[RestoreHandler] Calling OpenCode revert: cliSessionId=${effectiveCliSessionId}, messageId=${messageId}`,
			);

			// Call OpenCode's native revert - this handles:
			// 1. Creating a snapshot of current state (for potential unrevert)
			// 2. Rolling back files via Snapshot.revert()
			// 3. Setting session.revert marker for message cleanup on next prompt
			const result = await cliService.revertToMessage(effectiveCliSessionId, messageId);

			logger.info(
				`[RestoreHandler] OpenCode revert result: success=${result.success}, error=${result.error}`,
			);

			if (result.success) {
				// Update our internal tracking
				session.setLastOpenCodeMessageId(messageId);
				logger.info(`[RestoreHandler] Updated lastOpenCodeMessageId to: ${messageId}`);

				// UI Management (Cursor-style):
				// - SDK has already reverted files
				// - We DON'T sync UI with SDK messages (SDK removes user message, but we want to keep it)
				// - Instead, we tell UI to delete only assistant messages after the user message
				// - User message stays in place for inline editing

				// Truncate local storage to keep user message but remove assistant responses after it
				if (effectiveAssociatedMessageId) {
					// Keep messages up to and including the user message
					session.truncateConversationAfterMessage(effectiveAssociatedMessageId);
					logger.info(
						`[RestoreHandler] Truncated local storage after user message: ${effectiveAssociatedMessageId}`,
					);
				}

				// Tell UI to delete messages after the user message (keep user message for editing)
				// This is different from messagesReloaded - we're telling UI to remove specific messages
				this._deps.postMessage({
					type: 'deleteMessagesAfter',
					data: { messageId: effectiveAssociatedMessageId },
					sessionId,
				});

				// restoreSuccess is a UI-only message
				this._deps.postMessage({
					type: 'restoreSuccess',
					data: {
						message: 'Files restored. Click on your message to edit and resend.',
						messageId,
						canUnrevert: true,
					},
					sessionId,
				});

				// Notify UI that unrevert is available
				this._deps.postMessage({
					type: 'unrevertAvailable',
					data: { sessionId, cliSessionId: effectiveCliSessionId },
					sessionId,
				});

				// Send updated commits list
				this._deps.postMessage({
					type: 'updateRestoreCommits',
					data: session.commits,
					sessionId,
				});
			} else {
				this._deps.postMessage({
					type: 'restoreError',
					data: result.error || 'Failed to revert session',
					sessionId,
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error('[RestoreHandler] Revert error:', error);
			this._deps.postMessage({ type: 'restoreError', data: errorMessage, sessionId });
		}
	}

	/**
	 * Undo the last revert operation using OpenCode's native unrevert mechanism.
	 * This restores files to their state before the revert and clears the revert marker.
	 */
	public async unrevert(sessionId: string, cliSessionId?: string): Promise<void> {
		const session = this._sessionManager.getSession(sessionId);
		if (!session) {
			this._deps.postMessage({ type: 'restoreError', data: 'Session not found', sessionId });
			return;
		}

		if (!session.cliService) {
			this._deps.postMessage({
				type: 'restoreError',
				data: 'CLI service not available for this session',
				sessionId,
			});
			return;
		}

		const cliService = session.cliService;

		// Check if unrevert is supported
		if (!cliService.unrevertSession) {
			this._deps.postMessage({
				type: 'restoreError',
				data: 'Unrevert not supported for this provider',
				sessionId,
			});
			return;
		}

		this._deps.postMessage({
			type: 'restoreProgress',
			data: 'Undoing revert...',
			sessionId,
		});

		try {
			const effectiveCliSessionId = cliSessionId || session.cliSessionId || sessionId;

			logger.info(
				`[RestoreHandler] Calling OpenCode unrevert: cliSessionId=${effectiveCliSessionId}`,
			);

			const result = await cliService.unrevertSession(effectiveCliSessionId);

			logger.info(
				`[RestoreHandler] OpenCode unrevert result: success=${result.success}, error=${result.error}`,
			);

			if (result.success) {
				// After unrevert, files are restored to their state before the revert.
				// We restore messages from our local snapshot (saved before revert).
				const restoredMessages = session.restoreMessagesFromSnapshot();

				if (restoredMessages && restoredMessages.length > 0) {
					logger.info(
						`[RestoreHandler] Restored ${restoredMessages.length} messages from snapshot after unrevert`,
					);

					this._deps.postMessage({
						type: 'messagesReloaded',
						data: { messages: restoredMessages },
						sessionId,
					});
				} else {
					// Fallback: if no snapshot, get messages from OpenCode SDK
					// Note: This may cause ID mismatch issues with commits
					logger.warn('[RestoreHandler] No snapshot available, falling back to SDK messages');
					const rawMessages = await cliService.getMessages(effectiveCliSessionId);
					const messages = convertOpenCodeMessagesToStorage(rawMessages as OpenCodeMessage[]);

					if (messages.length > 0) {
						// Filter out duplicates in messages from SDK
						const uniqueMessages = messages.filter(
							(msg, index, self) =>
								index ===
								self.findIndex(m => {
									const isSameId = m.id === msg.id && m.type === msg.type;
									// For types with content, compare content. For others, assume ID/type is enough.
									if ('content' in m && 'content' in msg) {
										return isSameId && m.content === msg.content;
									}
									return isSameId;
								}),
						);

						session.replaceConversationMessages(uniqueMessages);
						this._deps.postMessage({
							type: 'messagesReloaded',
							data: { messages: uniqueMessages },
							sessionId,
						});
					}
				}

				// restoreSuccess is a UI-only message
				this._deps.postMessage({
					type: 'restoreSuccess',
					data: {
						message: 'Unrevert successful. Files and messages restored.',
					},
					sessionId,
				});

				// Notify UI that unrevert is no longer available
				this._deps.postMessage({
					type: 'unrevertAvailable',
					data: { sessionId, available: false },
					sessionId,
				});

				// Send updated commits list to restore the restore buttons
				this._deps.postMessage({
					type: 'updateRestoreCommits',
					data: session.commits,
					sessionId,
				});

				logger.info(`[RestoreHandler] Sent ${session.commits.length} commits after unrevert`);
			} else {
				this._deps.postMessage({
					type: 'restoreError',
					data: result.error || 'Failed to unrevert session',
					sessionId,
				});
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error('[RestoreHandler] Unrevert error:', error);
			this._deps.postMessage({ type: 'restoreError', data: errorMessage, sessionId });
		}
	}
}
