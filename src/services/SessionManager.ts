/**
 * @file Session Manager - Orchestrator for parallel chat sessions
 * @description Manages multiple SessionContext instances enabling true parallel
 * execution where several sessions can process messages simultaneously.
 * Handles session lifecycle (create, switch, close), CLI service instantiation,
 * message routing by sessionId, and session persistence to globalState.
 * Implements resource limits to prevent excessive memory/process usage.
 * Uses CLIServiceFactory for provider service instantiation (per session for Claude).
 */

import type * as vscode from 'vscode';
import type { CLIProviderType, CommitInfo, ConversationData } from '../types';
import { logger } from '../utils/logger';
import { CLIServiceFactory } from './CLIServiceFactory';
import type { CLIProcessOptions, CLIStreamData } from './ICLIService';
import { type SessionCallbacks, SessionContext, type SessionSnapshot } from './SessionContext';

/**
 * Configuration for SessionManager
 */
export interface SessionManagerConfig {
	/** Maximum number of concurrent sessions (default: 10) */
	maxSessions: number;
	/** Timeout for idle sessions in ms (0 = no timeout) */
	idleTimeoutMs: number;
	/** Enable session persistence to globalState */
	persistSessions: boolean;
}

const DEFAULT_CONFIG: SessionManagerConfig = {
	maxSessions: 10,
	idleTimeoutMs: 0, // No auto-cleanup by default
	persistSessions: true, // Enable persistence by default
};

const PERSISTENCE_KEY = 'chat.sessionSnapshots';
/**
 * Persistence version - increment when session format changes
 * v1: Initial version
 * v2: Backend is now source of truth for session IDs - clear old sessions
 * v4: Fixed message deduplication for streaming updates
 * v5: Fixed access_request/tool_use architecture - old sessions have stale permission data
 */
const PERSISTENCE_VERSION = 6;
const PERSISTENCE_VERSION_KEY = 'chat.sessionVersion';

/**
 * Events emitted by SessionManager
 */
export interface SessionManagerEvents {
	onSessionCreated: (sessionId: string) => void;
	onSessionClosed: (sessionId: string) => void;
	onSessionData: (sessionId: string, data: CLIStreamData) => void;
	onSessionClose: (sessionId: string, code: number | null, errorOutput: string) => void;
	onSessionError: (sessionId: string, error: Error) => void;
	onCommitCreated: (sessionId: string, commit: CommitInfo) => void;
}

/**
 * Manages multiple parallel chat sessions
 */
export class SessionManager {
	private _sessions: Map<string, SessionContext> = new Map();
	private _activeSessionId: string | undefined;
	private _config: SessionManagerConfig;
	private _events: SessionManagerEvents;
	private _idleCheckInterval: NodeJS.Timeout | null = null;
	private _initialized: boolean = false;
	private _initPromise: Promise<void> | null = null;
	private _activeSessionPromise: Promise<SessionContext> | null = null;
	private _persistDebounceTimer: NodeJS.Timeout | null = null;
	private static readonly PERSIST_DEBOUNCE_MS = 2000; // Debounce persistence to avoid excessive writes

	constructor(
		private readonly _context: vscode.ExtensionContext,
		events: SessionManagerEvents,
		config: Partial<SessionManagerConfig> = {},
	) {
		this._config = { ...DEFAULT_CONFIG, ...config };
		this._events = events;

		// Start idle session cleanup if configured
		if (this._config.idleTimeoutMs > 0) {
			this._startIdleCheck();
		}
	}

	// =========================================================================
	// Helper Methods
	// =========================================================================

	/**
	 * Generate unique session ID
	 */
	private _generateSessionId(): string {
		return `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
	}

	/**
	 * Create session callbacks that route events to manager
	 */
	private _createSessionCallbacks(): SessionCallbacks {
		return {
			onData: (sid, data) => this._events.onSessionData(sid, data),
			onClose: (sid, code, error) => this._events.onSessionClose(sid, code, error),
			onError: (sid, error) => this._events.onSessionError(sid, error),
			onCommitCreated: (sid, commit) => this._events.onCommitCreated(sid, commit),
			onStateChanged: () => this._debouncedPersist(),
		};
	}

	/**
	 * Debounced persistence to avoid excessive globalState writes during rapid message updates
	 */
	private _debouncedPersist(): void {
		if (this._persistDebounceTimer) {
			clearTimeout(this._persistDebounceTimer);
		}
		this._persistDebounceTimer = setTimeout(() => {
			this._persistDebounceTimer = null;
			void this._persistSessions();
		}, SessionManager.PERSIST_DEBOUNCE_MS);
	}

	/**
	 * Create and initialize a new SessionContext
	 */
	private async _createSessionContext(sessionId: string): Promise<SessionContext> {
		const session = new SessionContext(sessionId, this._createSessionCallbacks(), this._context);
		const provider = CLIServiceFactory.getCurrentProvider() || 'claude';
		await this._initializeSessionCLIForProvider(session, provider);
		return session;
	}

	/**
	 * Get sorted sessions by last active time (most recent first)
	 */
	private _getSessionsSortedByActivity(): SessionContext[] {
		return Array.from(this._sessions.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	}

	/**
	 * Restore session from conversation data (history file)
	 */
	public async restoreSessionFromHistory(data: ConversationData): Promise<SessionContext> {
		const sessionId = data.sessionId || `loaded-${Date.now()}`;
		let session = this._sessions.get(sessionId);

		// If session exists, return it (it's already active or background)
		if (session) {
			return session;
		}

		// Create new session
		session = await this._createSessionContext(sessionId);
		this._sessions.set(sessionId, session);

		// Hydrate from data
		session.loadFromData(data);

		// Notify creation
		this._events.onSessionCreated(sessionId);

		// Switch to it
		this.switchSession(sessionId);

		await this._persistSessions();

		return session;
	}

	// =========================================================================
	// Initialization
	// =========================================================================

	/**
	 * Initialize SessionManager and restore persisted sessions
	 */
	public async initialize(): Promise<void> {
		if (this._initialized) return;
		if (this._initPromise) return this._initPromise;

		this._initPromise = (async () => {
			try {
				if (this._config.persistSessions) {
					await this._restorePersistedSessions();
				}
				this._initialized = true;
				logger.info(
					`[SessionManager] Initialized with ${this._sessions.size} sessions (persistence: ${this._config.persistSessions})`,
				);

				// If no sessions restored and we have a latest conversation, try to load it
				// This handles the case where we lost session state but have history on disk
				if (this._sessions.size === 0) {
					// Note: We can't easily access ConversationService here without circular dependency
					// or passing it in. For now, rely on SessionHandler to do this fallback.
				}
			} finally {
				this._initPromise = null;
			}
		})();

		return this._initPromise;
	}

	/**
	 * Get or create active session (thread-safe)
	 */
	public async ensureActiveSession(): Promise<SessionContext> {
		await this.initialize();

		const activeSession = this.getActiveSession();
		if (activeSession) return activeSession;

		// Prevent parallel creation of initial session
		if (this._activeSessionPromise) {
			return this._activeSessionPromise;
		}

		this._activeSessionPromise = (async () => {
			try {
				// Double check inside lock
				const active = this.getActiveSession();
				if (active) return active;

				const sessionId = await this.createSession();
				const session = this._sessions.get(sessionId);
				if (!session) {
					throw new Error('Failed to create new session');
				}
				return session;
			} finally {
				this._activeSessionPromise = null;
			}
		})();

		return this._activeSessionPromise;
	}

	// =========================================================================
	// Session Lifecycle
	// =========================================================================

	/**
	 * Create a new session
	 * @returns The new session's ID
	 */
	public async createSession(uiSessionId?: string): Promise<string> {
		// Check session limit
		if (this._sessions.size >= this._config.maxSessions) {
			const closedId = await this._closeOldestIdleSession();
			if (!closedId) {
				throw new Error(
					`Maximum session limit (${this._config.maxSessions}) reached. Close some sessions first.`,
				);
			}
			logger.info(`[SessionManager] Auto-closed idle session ${closedId} to make room`);
		}

		const sessionId = uiSessionId || this._generateSessionId();

		// Check if session already exists
		if (this._sessions.has(sessionId)) {
			logger.warn(`[SessionManager] Session ${sessionId} already exists, returning existing`);
			return sessionId;
		}

		// Create and store session
		const session = await this._createSessionContext(sessionId);
		this._sessions.set(sessionId, session);

		// Set as active if first session
		if (!this._activeSessionId) {
			this._activeSessionId = sessionId;
		}

		// Persist and notify
		await this._persistSessions();
		logger.info(`[SessionManager] Created session ${sessionId} (total: ${this._sessions.size})`);
		this._events.onSessionCreated(sessionId);

		return sessionId;
	}

	/**
	 * Get or create a session
	 */
	public async getOrCreateSession(sessionId: string): Promise<SessionContext> {
		let session = this._sessions.get(sessionId);
		if (!session) {
			await this.createSession(sessionId);
			session = this._sessions.get(sessionId);
		}
		if (!session) {
			throw new Error(`Failed to create session: ${sessionId}`);
		}
		return session;
	}

	/**
	 * Switch active session (for UI focus, doesn't stop other sessions)
	 */
	public switchSession(sessionId: string): SessionContext | undefined {
		const session = this._sessions.get(sessionId);
		if (!session) {
			logger.warn(`[SessionManager] Cannot switch to non-existent session: ${sessionId}`);
			return undefined;
		}

		// Clear thinking timers from the old active session to prevent
		// stale thinking messages from being sent when the session becomes active again
		if (this._activeSessionId && this._activeSessionId !== sessionId) {
			const oldSession = this._sessions.get(this._activeSessionId);
			if (oldSession) {
				oldSession.clearThinkingTimers();
				oldSession.setStreamingThinking(false);
			}
		}

		this._activeSessionId = sessionId;
		session.markActive();
		logger.info(`[SessionManager] Switched active session to ${sessionId}`);
		// Persist active session selection so it restores correctly across reloads.
		void this._persistSessions();
		return session;
	}

	/**
	 * Close a session and clean up resources
	 */
	public async closeSession(sessionId: string): Promise<boolean> {
		const session = this._sessions.get(sessionId);
		if (!session) {
			logger.warn(`[SessionManager] Cannot close non-existent session: ${sessionId}`);
			return false;
		}

		// Dispose and remove
		await session.dispose();
		this._sessions.delete(sessionId);

		// Update active session if needed
		if (this._activeSessionId === sessionId) {
			const remaining = this._getSessionsSortedByActivity();
			this._activeSessionId = remaining.length > 0 ? remaining[0].uiSessionId : undefined;
		}

		// Persist and notify
		await this._persistSessions();
		logger.info(`[SessionManager] Closed session ${sessionId} (remaining: ${this._sessions.size})`);
		this._events.onSessionClosed(sessionId);

		return true;
	}

	/**
	 * Close all sessions
	 */
	public async closeAllSessions(): Promise<void> {
		const sessionIds = Array.from(this._sessions.keys());
		for (const sessionId of sessionIds) {
			await this.closeSession(sessionId);
		}
	}

	/**
	 * Clear all persisted session data from globalState
	 */
	public async clearPersistedSessions(): Promise<void> {
		await this._context.globalState.update(PERSISTENCE_KEY, undefined);
		logger.info('[SessionManager] Cleared all persisted sessions from globalState');
	}

	/**
	 * Close the oldest idle (not processing) session
	 */
	private async _closeOldestIdleSession(): Promise<string | null> {
		const idleSessions = Array.from(this._sessions.values())
			.filter(s => !s.isProcessing)
			.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

		if (idleSessions.length === 0) return null;

		const oldest = idleSessions[0];
		await this.closeSession(oldest.uiSessionId);
		return oldest.uiSessionId;
	}

	// =========================================================================
	// Session Access
	// =========================================================================

	/**
	 * Get session by ID
	 */
	public getSession(sessionId: string): SessionContext | undefined {
		return this._sessions.get(sessionId);
	}

	/**
	 * Get session by CLI session ID (e.g., OpenCode's ses_xxx)
	 */
	public getSessionByCLISessionId(cliSessionId: string): SessionContext | undefined {
		for (const session of this._sessions.values()) {
			if (session.cliSessionId === cliSessionId) {
				return session;
			}
		}
		return undefined;
	}

	/**
	 * Get active session
	 */
	public getActiveSession(): SessionContext | undefined {
		if (!this._activeSessionId) return undefined;
		return this._sessions.get(this._activeSessionId);
	}

	/**
	 * Get active session ID
	 */
	public get activeSessionId(): string | undefined {
		return this._activeSessionId;
	}

	/**
	 * Get all sessions
	 */
	public getAllSessions(): SessionContext[] {
		return Array.from(this._sessions.values());
	}

	/**
	 * Get session count
	 */
	public get sessionCount(): number {
		return this._sessions.size;
	}

	/**
	 * Check if any session is processing
	 */
	public isAnySessionProcessing(): boolean {
		for (const session of this._sessions.values()) {
			if (session.isProcessing) return true;
		}
		return false;
	}

	/**
	 * Get all processing sessions
	 */
	public getProcessingSessions(): SessionContext[] {
		return Array.from(this._sessions.values()).filter(s => s.isProcessing);
	}

	// =========================================================================
	// Message Processing
	// =========================================================================

	/**
	 * Send a message to a specific session
	 */
	public async sendMessage(sessionId: string, options: CLIProcessOptions): Promise<void> {
		const session = await this.getOrCreateSession(sessionId);

		// Create CLI session if needed (OpenCode session IDs must start with 'ses_')
		if (!session.cliSessionId || !session.cliSessionId.startsWith('ses_')) {
			await session.createCLISession();
		}

		await session.startProcess(options);
	}

	/**
	 * Stop processing in a specific session
	 */
	public stopSession(sessionId: string): boolean {
		const session = this._sessions.get(sessionId);
		if (!session) return false;
		return session.stopProcess();
	}

	/**
	 * Stop all processing sessions
	 */
	public stopAllSessions(): void {
		for (const session of this._sessions.values()) {
			if (session.isProcessing) {
				session.stopProcess();
			}
		}
	}

	// =========================================================================
	// CLI Service Management
	// =========================================================================

	/**
	 * Initialize CLI service for a session using CLIServiceFactory (shared instance).
	 * All sessions share a single CLI service to prevent multiple server spawns.
	 */
	private async _initializeSessionCLIForProvider(
		session: SessionContext,
		provider: CLIProviderType,
	): Promise<void> {
		const sharedService = await CLIServiceFactory.getService(provider);
		session.setCLIService(sharedService);
	}

	// =========================================================================
	// Persistence
	// =========================================================================

	/**
	 * Persist session snapshots to globalState
	 */
	private async _persistSessions(): Promise<void> {
		if (!this._config.persistSessions) return;

		const snapshots = this.getSnapshots();
		await this._context.globalState.update(PERSISTENCE_KEY, {
			activeSessionId: this._activeSessionId,
			snapshots,
		});
		// Also save version
		await this._context.globalState.update(PERSISTENCE_VERSION_KEY, PERSISTENCE_VERSION);

		logger.debug(
			`[SessionManager] Persisted ${snapshots.length} sessions (v${PERSISTENCE_VERSION})`,
		);
	}

	/**
	 * Restore sessions from globalState
	 */
	private async _restorePersistedSessions(): Promise<void> {
		const persistedVersion = this._context.globalState.get<number>(PERSISTENCE_VERSION_KEY) || 1;

		// Check persistence version - if outdated, clear all sessions
		if (persistedVersion < PERSISTENCE_VERSION) {
			logger.info(
				`[SessionManager] Persistence version mismatch (${persistedVersion} < ${PERSISTENCE_VERSION}), clearing old sessions`,
			);
			await this._context.globalState.update(PERSISTENCE_KEY, undefined);
			await this._context.globalState.update(PERSISTENCE_VERSION_KEY, PERSISTENCE_VERSION);
			return;
		}

		const persistedData = this._context.globalState.get<{
			activeSessionId?: string;
			snapshots: SessionSnapshot[];
		}>(PERSISTENCE_KEY);

		if (!persistedData?.snapshots?.length) {
			logger.info('[SessionManager] No persisted sessions to restore');
			return;
		}

		logger.info(`[SessionManager] Restoring ${persistedData.snapshots.length} persisted sessions`);

		for (const snapshot of persistedData.snapshots) {
			try {
				// Create session with callbacks and restore state
				const session = new SessionContext(
					snapshot.uiSessionId,
					this._createSessionCallbacks(),
					this._context,
				);
				session.restore(snapshot);

				// Load conversation messages from JSON file (not stored in globalState to save space)
				const messagesLoaded = await session.loadConversationFromFile();
				if (messagesLoaded) {
					logger.debug(
						`[SessionManager] Loaded conversation from file for session: ${snapshot.uiSessionId}`,
					);
				}

				// Initialize CLI service
				const provider = CLIServiceFactory.getCurrentProvider() || 'claude';
				await this._initializeSessionCLIForProvider(session, provider);
				this._sessions.set(snapshot.uiSessionId, session);

				logger.debug(`[SessionManager] Restored session: ${snapshot.uiSessionId}`);
			} catch (error) {
				logger.error(`[SessionManager] Failed to restore session ${snapshot.uiSessionId}:`, error);
			}
		}

		// Restore active session
		if (persistedData.activeSessionId && this._sessions.has(persistedData.activeSessionId)) {
			this._activeSessionId = persistedData.activeSessionId;
		} else if (this._sessions.size > 0) {
			// Fall back to the most recently active session, not arbitrary map order.
			const mostRecent = this._getSessionsSortedByActivity()[0];
			this._activeSessionId = mostRecent?.uiSessionId;
		}
	}

	/**
	 * Get snapshots of all sessions for persistence
	 */
	public getSnapshots(): SessionSnapshot[] {
		return Array.from(this._sessions.values()).map(s => s.snapshot());
	}

	/**
	 * Restore sessions from snapshots (for external use)
	 */
	public async restoreFromSnapshots(snapshots: SessionSnapshot[]): Promise<void> {
		for (const snapshot of snapshots) {
			const sessionId = await this.createSession(snapshot.uiSessionId);
			const session = this._sessions.get(sessionId);
			if (session) {
				session.restore(snapshot);
			}
		}
	}

	// =========================================================================
	// Idle Session Management
	// =========================================================================

	/**
	 * Start periodic idle session check
	 */
	private _startIdleCheck(): void {
		this._idleCheckInterval = setInterval(() => {
			const now = Date.now();
			for (const session of this._sessions.values()) {
				if (!session.isProcessing && now - session.lastActiveAt > this._config.idleTimeoutMs) {
					logger.info(`[SessionManager] Auto-closing idle session: ${session.uiSessionId}`);
					void this.closeSession(session.uiSessionId);
				}
			}
		}, 60000); // Check every minute
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	/**
	 * Dispose manager and all sessions.
	 * Note: CLI service is managed by CLIServiceFactory, not disposed here.
	 */
	public async dispose(): Promise<void> {
		// Stop idle check
		if (this._idleCheckInterval) {
			clearInterval(this._idleCheckInterval);
			this._idleCheckInterval = null;
		}

		// Clear debounce timer and persist immediately
		if (this._persistDebounceTimer) {
			clearTimeout(this._persistDebounceTimer);
			this._persistDebounceTimer = null;
		}

		// Persist before closing
		await this._persistSessions();

		// Close all sessions
		await this.closeAllSessions();

		logger.info('[SessionManager] Disposed');
	}
}
