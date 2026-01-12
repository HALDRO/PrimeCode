/**
 * @file SessionHandler
 * @description Manages session lifecycle operations: initialization, creation, switching, and closing.
 * Uses local conversation history as the authoritative source for message replay.
 */

import type { SessionManager } from '../../services/SessionManager';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface SessionHandlerDeps {
	postMessage: (msg: unknown) => void;
	sendReadyMessage: () => Promise<void>;
	loadConversationHistory: (filename: string) => Promise<void>;
	getLatestConversation: () => Promise<{ filename: string } | undefined>;
}

// =============================================================================
// SessionHandler Class
// =============================================================================

export class SessionHandler {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _deps: SessionHandlerDeps,
	) {}

	public async initializeSession(): Promise<void> {
		await this._sessionManager.initialize();

		// Check active session first
		const activeSession = this._sessionManager.getActiveSession();
		const allSessions = this._sessionManager.getAllSessions();

		if (allSessions.length > 0) {
			logger.info(
				`[SessionHandler] Restored ${allSessions.length} sessions, active: ${activeSession?.uiSessionId || 'none'}`,
			);

			// First, notify UI about ALL restored sessions so they appear in the tab bar
			for (const session of allSessions) {
				this._deps.postMessage({
					type: 'sessionCreated',
					data: { sessionId: session.uiSessionId },
				});
			}

			// Then send ready message for the active one to replay its history
			if (activeSession) {
				await this._deps.sendReadyMessage();
			} else {
				// If no active session but sessions exist, pick the first one
				const firstSession = allSessions[0];
				this._sessionManager.switchSession(firstSession.uiSessionId);
				await this._deps.sendReadyMessage();
			}
			return;
		}

		// Try loading latest conversation if no active session AND no sessions at all
		if (this._sessionManager.sessionCount === 0) {
			const latest = await this._deps.getLatestConversation();
			if (latest) {
				logger.info(`[SessionHandler] Loading latest conversation: ${latest.filename}`);
				// Load history directly, which will create the session and notify UI
				await this._deps.loadConversationHistory(latest.filename);

				// If loading history didn't result in an active session (e.g. failed), fallback to new session
				if (!this._sessionManager.getActiveSession()) {
					logger.info('[SessionHandler] Failed to load history, initializing fresh session');
					await this._sessionManager.ensureActiveSession();
					await this._deps.sendReadyMessage();
				}
				return;
			}

			// Only create new session if truly nothing exists
			logger.info('[SessionHandler] No existing sessions or history, initializing fresh session');
			await this._sessionManager.ensureActiveSession();
			await this._deps.sendReadyMessage();
		} else {
			// Sessions exist but none active (rare case, but possible if persistence saved sessions but no active ID)
			// Pick the first available one
			const sessions = this._sessionManager.getAllSessions();
			if (sessions.length > 0) {
				const firstSession = sessions[0];
				this._sessionManager.switchSession(firstSession.uiSessionId);
				await this._deps.sendReadyMessage();
			}
		}
	}

	public newSession(postMessage: (msg: unknown) => void): void {
		const session = this._sessionManager.getActiveSession();
		if (session) {
			session.stopProcess();
			session.clearCommits();
			session.clearConversation();
			session.setProcessing(false);
		}
		postMessage({ type: 'setProcessing', data: { isProcessing: false } });
		postMessage({ type: 'sessionCleared' });
	}

	public async handleCreateSession(): Promise<void> {
		try {
			const uiSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
			await this._sessionManager.createSession(uiSessionId);
			logger.info(`[SessionHandler] Created session: ${uiSessionId}`);
		} catch (error) {
			logger.error('[SessionHandler] Failed to create session:', error);
			this._deps.postMessage({
				type: 'error',
				data: {
					content: error instanceof Error ? error.message : 'Failed to create session',
				},
			});
		}
	}

	public async handleSwitchSession(uiSessionId: string): Promise<void> {
		if (uiSessionId === this._sessionManager.activeSessionId) {
			return;
		}

		let session = this._sessionManager.switchSession(uiSessionId);
		if (!session) {
			logger.warn(`[SessionHandler] Session ${uiSessionId} not found, creating it`);
			await this._sessionManager.createSession(uiSessionId);
			session = this._sessionManager.getSession(uiSessionId);
		}

		if (session) {
			this._deps.postMessage({
				type: 'sessionSwitched',
				data: {
					sessionId: uiSessionId,
					isProcessing: session.isProcessing,
					totalStats: session.getStats(),
				},
			});

			// Clear any session-scoped UI state first to avoid mixing old and new.
			this._deps.postMessage({ type: 'sessionCleared', sessionId: uiSessionId });

			// Replay local conversation history (authoritative source after persistence improvements)
			if (session.conversationMessages.length > 0) {
				logger.info(
					`[SessionHandler] Sending ${session.conversationMessages.length} messages from local history`,
				);
				// Messages are already in unified format, no conversion needed
				this._deps.postMessage({
					type: 'messagesReloaded',
					data: { messages: session.conversationMessages },
					sessionId: uiSessionId,
				});
			}

			// Send stats
			this._deps.postMessage({
				type: 'updateTotals',
				data: session.getStats(),
				sessionId: uiSessionId,
			});

			// Restore commits/checkpoints for restore functionality
			if (session.commits.length > 0) {
				for (const commit of session.commits) {
					this._deps.postMessage({
						type: 'showRestoreOption',
						data: commit,
						sessionId: uiSessionId,
					});
				}
			}
		}
	}

	public async handleCloseSession(uiSessionId: string): Promise<void> {
		const closed = await this._sessionManager.closeSession(uiSessionId);
		if (!closed) {
			logger.warn(`[SessionHandler] Failed to close session: ${uiSessionId}`);
		}
	}
}
