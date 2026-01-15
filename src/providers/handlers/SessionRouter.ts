/**
 * @file SessionRouter
 * @description Unified event router for all session-related messages.
 * Single routing point that handles targetId resolution and message normalization.
 * All session events flow through this router, ensuring consistent handling
 * of parent and child sessions without conditional logic at call sites.
 * Eliminates scattered postMessage calls and provides type-safe event emission.
 */

import type { SessionManager } from '../../services/SessionManager';
import type { CommitInfo, ConversationMessage, TokenStats, TotalStats } from '../../types';
import type {
	SessionAuthPayload,
	SessionCompletePayload,
	SessionEventType,
	SessionLifecycleAction,
	SessionMessageData,
	SessionMessageRemovedPayload,
	SessionStatus,
	SessionStatusPayload,
	SessionTerminalPayload,
} from '../../types/extensionMessages';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface SessionRouterDeps {
	postMessage: (msg: unknown) => void;
}

// =============================================================================
// SessionRouter Class
// =============================================================================

export class SessionRouter {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _deps: SessionRouterDeps,
	) {}

	// =========================================================================
	// Message Events
	// =========================================================================

	/**
	 * Emit a message event to a session.
	 * Automatically resolves targetId from childSessionId or sessionId.
	 *
	 * @param sessionId - Parent session ID (used for conversation storage)
	 * @param message - Message data to emit
	 * @param childSessionId - Optional child session ID (for subtask messages)
	 */
	public emitMessage(
		sessionId: string,
		message: SessionMessageData,
		childSessionId?: string,
	): void {
		if (!sessionId) {
			logger.warn('[SessionRouter] emitMessage called without sessionId');
			return;
		}

		const targetId = childSessionId || sessionId;

		const normalizedMessage: SessionMessageData = {
			...message,
			id: message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
			timestamp: message.timestamp || new Date().toISOString(),
			childSessionId: childSessionId || undefined,
		};

		this._deps.postMessage({
			type: 'session_event',
			targetId,
			eventType: 'message' as SessionEventType,
			payload: {
				eventType: 'message',
				message: normalizedMessage,
			},
			timestamp: Date.now(),
		});

		// Persist into authoritative parent session history.
		const session = this._sessionManager.getSession(sessionId);
		if (session) {
			session.addConversationMessage(
				normalizedMessage as Partial<ConversationMessage> & { type: string },
			);
		}
	}

	/**
	 * Emit a full messages reload (e.g., restore/unrevert).
	 */
	public emitMessagesReload(sessionId: string, messages: unknown[]): void {
		if (!sessionId) {
			logger.warn('[SessionRouter] emitMessagesReload called without sessionId');
			return;
		}

		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'messages_reload' as SessionEventType,
			payload: {
				eventType: 'messages_reload',
				messages,
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Status Events
	// =========================================================================

	/**
	 * Emit a status change event.
	 * Automatically updates backend session state.
	 * Child session status changes don't affect parent session state.
	 */
	public emitStatus(
		sessionId: string,
		status: SessionStatus,
		retryInfo?: SessionStatusPayload['retryInfo'],
		childSessionId?: string,
		statusText?: string,
		loadingMessage?: string,
	): void {
		if (!sessionId) {
			logger.warn('[SessionRouter] emitStatus called without sessionId');
			return;
		}

		const targetId = childSessionId || sessionId;

		// Child sessions: only emit idle, don't propagate busy/retry/error to parent UI.
		if (childSessionId && status !== 'idle') {
			return;
		}

		this._deps.postMessage({
			type: 'session_event',
			targetId,
			eventType: 'status' as SessionEventType,
			payload: {
				eventType: 'status',
				status,
				statusText,
				loadingMessage,
				retryInfo,
			} as SessionStatusPayload,
			timestamp: Date.now(),
		});

		if (!childSessionId) {
			const session = this._sessionManager.getSession(sessionId);
			if (session) {
				session.setProcessing(status === 'busy');
				session.setAutoRetrying(status === 'retrying');
			}
		}
	}

	/**
	 * Emit loading state change.
	 * Uses status event and optional `loadingMessage` for UI.
	 */
	public emitLoading(sessionId: string, isLoading: boolean, message?: string): void {
		if (!sessionId) return;
		this.emitStatus(
			sessionId,
			isLoading ? 'busy' : 'idle',
			undefined,
			undefined,
			undefined,
			message,
		);
	}

	// =========================================================================
	// Stats Events
	// =========================================================================

	/**
	 * Emit token/cost statistics update.
	 */
	public emitStats(
		sessionId: string,
		stats: {
			tokenStats?: Partial<TokenStats>;
			totalStats?: Partial<TotalStats>;
		},
	): void {
		if (!sessionId) {
			logger.warn('[SessionRouter] emitStats called without sessionId');
			return;
		}

		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'stats' as SessionEventType,
			payload: {
				eventType: 'stats',
				...stats,
			},
			timestamp: Date.now(),
		});
	}

	public emitTokenStats(sessionId: string, tokenStats: Partial<TokenStats>): void {
		this.emitStats(sessionId, { tokenStats });
	}

	public emitTotalStats(sessionId: string, totalStats: Partial<TotalStats>): void {
		this.emitStats(sessionId, { totalStats });
	}

	// =========================================================================
	// Complete Events
	// =========================================================================

	/**
	 * Emit streaming complete event for a part.
	 */
	public emitComplete(sessionId: string, partId: string, toolUseId?: string): void {
		if (!sessionId) {
			logger.warn('[SessionRouter] emitComplete called without sessionId');
			return;
		}

		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'complete' as SessionEventType,
			payload: {
				eventType: 'complete',
				partId,
				toolUseId,
			} as SessionCompletePayload,
			timestamp: Date.now(),
		});
	}

	/**
	 * Emit message part removed notification.
	 */
	public emitMessagePartRemoved(sessionId: string, messageId: string, partId: string): void {
		if (!sessionId) return;

		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'message_removed' as SessionEventType,
			payload: {
				eventType: 'message_removed',
				messageId,
				partId,
			} as SessionMessageRemovedPayload,
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Lifecycle Events
	// =========================================================================

	public emitLifecycle(
		action: SessionLifecycleAction,
		sessionId: string,
		parentId?: string,
		data?: {
			isProcessing?: boolean;
			totalStats?: TotalStats;
			messages?: unknown[];
		},
	): void {
		this._deps.postMessage({
			type: 'session_lifecycle',
			action,
			sessionId,
			parentId,
			data,
		});
	}

	public emitSessionCreated(sessionId: string, parentId?: string): void {
		this.emitLifecycle('created', sessionId, parentId);
	}

	public emitSessionClosed(sessionId: string): void {
		this.emitLifecycle('closed', sessionId);
	}

	public emitSessionSwitched(
		sessionId: string,
		data?: {
			isProcessing?: boolean;
			totalStats?: TotalStats;
			messages?: unknown[];
		},
	): void {
		this.emitLifecycle('switched', sessionId, undefined, data);
	}

	public emitSessionCleared(sessionId: string): void {
		this.emitLifecycle('cleared', sessionId);
	}

	public emitChildSessionCreated(
		parentSessionId: string,
		childSession: { id: string; parentId?: string },
	): void {
		if (!parentSessionId) return;
		this._deps.postMessage({
			type: 'session_lifecycle',
			action: 'created' as SessionLifecycleAction,
			sessionId: childSession.id,
			parentId: parentSessionId,
		});
	}

	public emitSessionInfo(
		sessionId: string,
		data: { sessionId: string; tools: string[]; mcpServers: string[] },
	): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'session_info' as SessionEventType,
			payload: {
				eventType: 'session_info',
				data,
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Restore Events
	// =========================================================================

	public emitRestoreProgress(sessionId: string, message: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'progress',
				message,
			},
			timestamp: Date.now(),
		});
	}

	public emitRestoreSuccess(
		sessionId: string,
		data: {
			message: string;
			commitHash?: string;
			associatedMessageId?: string;
			canUnrevert?: boolean;
		},
	): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'success',
				message: data.message,
				canUnrevert: data.canUnrevert,
			},
			timestamp: Date.now(),
		});
	}

	public emitRestoreError(sessionId: string, error: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'error',
				message: error,
			},
			timestamp: Date.now(),
		});
	}

	public emitUnrevertAvailable(sessionId: string, available: boolean): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'unrevert_available',
				available,
			},
			timestamp: Date.now(),
		});
	}

	public emitRestoreCommits(sessionId: string, commits: CommitInfo[]): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'set_commits',
				commits,
			},
			timestamp: Date.now(),
		});
	}

	public emitRestoreOption(sessionId: string, commit: CommitInfo): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'add_commit',
				commit,
			},
			timestamp: Date.now(),
		});
	}

	public emitRestoreInput(sessionId: string, text: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'restore' as SessionEventType,
			payload: {
				eventType: 'restore',
				action: 'restore_input',
				text,
			},
			timestamp: Date.now(),
		});
	}

	public emitDeleteMessagesAfter(sessionId: string, messageId: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'delete_messages_after' as SessionEventType,
			payload: {
				eventType: 'delete_messages_after',
				messageId,
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// File Events
	// =========================================================================

	public emitFileChanged(
		sessionId: string,
		data: {
			filePath: string;
			fileName: string;
			linesAdded: number;
			linesRemoved: number;
			toolUseId: string;
		},
	): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'file' as SessionEventType,
			payload: {
				eventType: 'file',
				action: 'changed',
				filePath: data.filePath,
				fileName: data.fileName,
				linesAdded: data.linesAdded,
				linesRemoved: data.linesRemoved,
				toolUseId: data.toolUseId,
			},
			timestamp: Date.now(),
		});
	}

	public emitFileUndone(sessionId: string, filePath: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'file' as SessionEventType,
			payload: {
				eventType: 'file',
				action: 'undone',
				filePath,
			},
			timestamp: Date.now(),
		});
	}

	public emitAllFilesUndone(sessionId: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'file' as SessionEventType,
			payload: {
				eventType: 'file',
				action: 'all_undone',
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Access Events
	// =========================================================================

	public emitAccessResponse(
		sessionId: string,
		requestId: string,
		approved: boolean,
		alwaysAllow?: boolean,
	): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'access' as SessionEventType,
			payload: {
				eventType: 'access',
				action: 'response',
				requestId,
				approved,
				alwaysAllow,
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Project Events
	// =========================================================================

	public emitProjectUpdated(sessionId: string, project: unknown): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'message' as SessionEventType,
			payload: {
				eventType: 'message',
				message: {
					id: `project-${Date.now()}`,
					type: 'system_notice' as const,
					metadata: { projectUpdated: project },
				},
			},
			timestamp: Date.now(),
		});
	}

	// =========================================================================
	// Error Events
	// =========================================================================

	public emitError(sessionId: string, content: string): void {
		this.emitMessage(sessionId, {
			id: `error-${Date.now()}`,
			type: 'error',
			content,
		});
	}

	public emitGlobalError(content: string): void {
		this._deps.postMessage({
			type: 'error',
			data: { content },
		});
	}

	// =========================================================================
	// Auth & Terminal Events
	// =========================================================================

	public emitAuthRequired(sessionId: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'auth' as SessionEventType,
			payload: {
				eventType: 'auth',
				action: 'login_required',
			} as SessionAuthPayload,
			timestamp: Date.now(),
		});
	}

	public emitTerminalOpened(sessionId: string, content?: string): void {
		if (!sessionId) return;
		this._deps.postMessage({
			type: 'session_event',
			targetId: sessionId,
			eventType: 'terminal' as SessionEventType,
			payload: {
				eventType: 'terminal',
				action: 'opened',
				content,
			} as SessionTerminalPayload,
			timestamp: Date.now(),
		});
	}
}
