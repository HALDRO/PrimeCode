/**
 * @file SessionHandler
 * @description Manages session lifecycle operations: initialization, creation, switching, and closing.
 * Uses unified SessionRouter for lifecycle events and local conversation history as authoritative source.
 */

import type { SessionManager } from '../../services/SessionManager';
import { logger } from '../../utils/logger';
import type { SessionRouter } from './SessionRouter';

// =============================================================================
// Types
// =============================================================================

export interface SessionHandlerDeps {
	router: SessionRouter;
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
				this._deps.router.emitSessionCreated(session.uiSessionId);
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

	public newSession(): void {
		const session = this._sessionManager.getActiveSession();
		if (!session) {
			logger.warn('[SessionHandler] newSession called without active session');
			return;
		}

		session.stopProcess();
		session.clearCommits();
		session.clearConversation();
		// emitStatus handles both UI notification and backend state update
		this._deps.router.emitStatus(session.uiSessionId, 'idle');
		this._deps.router.emitSessionCleared(session.uiSessionId);
	}

	public async handleCreateSession(): Promise<void> {
		try {
			const uiSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
			await this._sessionManager.createSession(uiSessionId);
			logger.info(`[SessionHandler] Created session: ${uiSessionId}`);
		} catch (error) {
			logger.error('[SessionHandler] Failed to create session:', error);
			const activeSessionId = this._sessionManager.activeSessionId;
			if (activeSessionId) {
				this._deps.router.emitError(
					activeSessionId,
					error instanceof Error ? error.message : 'Failed to create session',
				);
			}
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
			// Clear any session-scoped UI state first to avoid mixing old and new.
			this._deps.router.emitSessionCleared(uiSessionId);

			// Then send sessionSwitched with correct state (including isProcessing)
			this._deps.router.emitSessionSwitched(uiSessionId, {
				isProcessing: session.isProcessing,
				totalStats: session.getStats(),
				messages:
					session.conversationMessages.length > 0 ? session.conversationMessages : undefined,
			});

			// Restore commits/checkpoints for restore functionality
			if (session.commits.length > 0) {
				this._deps.router.emitRestoreCommits(uiSessionId, session.commits);
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
