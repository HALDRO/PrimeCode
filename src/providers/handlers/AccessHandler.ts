/**
 * @file AccessHandler
 * @description Manages access requests and responses for both Claude CLI and OpenCode providers.
 * Handles pending access state, access request callbacks, and response routing to CLI services.
 * Uses unified SessionRouter for all message dispatching.
 *
 * Architecture note: AccessHandler is responsible ONLY for access_request messages.
 * tool_use messages are created by StreamHandler. When permission is required BEFORE
 * StreamHandler receives the tool event, AccessHandler creates a minimal tool_use placeholder
 * that StreamHandler will update when it receives the actual tool data.
 */

import type { AccessService } from '../../services/AccessService';
import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import type { CLIStreamData } from '../../services/ICLIService';
import type { SessionManager } from '../../services/SessionManager';
import type { AccessRequest } from '../../types';
import { logger } from '../../utils/logger';
import type { SessionRouter } from './SessionRouter';

// =============================================================================
// Types
// =============================================================================

export interface AccessHandlerDeps {
	router: SessionRouter;
}

interface PendingAccess {
	sessionId: string;
	accessId: string;
}

type OpenCodeAccessResponse = 'once' | 'always' | 'reject';

// =============================================================================
// AccessHandler Class
// =============================================================================

export class AccessHandler {
	private _pendingOpenCodeAccess = new Map<string, PendingAccess>();
	/** Track which tool_use IDs we've already created to avoid duplicates */
	private _createdToolUseIds = new Set<string>();

	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _accessService: AccessService,
		private readonly _deps: AccessHandlerDeps,
	) {}

	/**
	 * Handle OpenCode permission request.
	 * Creates access_request message and a placeholder tool_use if needed.
	 * The tool_use is created here because SDK sends permission-required BEFORE
	 * the part-update event for tools that need permission.
	 */
	public handleOpenCodeAccess(data: CLIStreamData): void {
		const access = data.permission;
		logger.debug('[AccessHandler] handleOpenCodeAccess called', { hasPermission: !!access, data });
		if (!access) {
			logger.warn('[AccessHandler] No permission data in CLIStreamData');
			return;
		}

		const toolUseId = access.callID || access.id;

		// Check if we've already processed this permission request
		if (this._pendingOpenCodeAccess.has(access.id)) {
			logger.debug('[AccessHandler] Permission request already pending, skipping', {
				accessId: access.id,
			});
			return;
		}

		const pendingAccess: PendingAccess = {
			sessionId: access.sessionID,
			accessId: access.id,
		};

		this._pendingOpenCodeAccess.set(access.id, pendingAccess);

		// Find session by CLI session ID (not UI session ID)
		const session = this._sessionManager.getSessionByCLISessionId(access.sessionID);
		logger.debug('[AccessHandler] Found session', {
			cliSessionId: access.sessionID,
			uiSessionId: session?.uiSessionId,
			hasSession: !!session,
		});

		if (session) {
			session.pendingAccess.set(access.id, pendingAccess);
		}

		// Format tool name with capital first letter (bash -> Bash)
		const toolName = access.type.charAt(0).toUpperCase() + access.type.slice(1);

		// Only create tool_use if we haven't already (StreamHandler may have created it)
		// This handles the case where permission-required comes before part-update
		if (!this._createdToolUseIds.has(toolUseId)) {
			this._createdToolUseIds.add(toolUseId);

			logger.info('[AccessHandler] Creating tool_use placeholder for permission', {
				toolName,
				toolUseId,
				uiSessionId: session?.uiSessionId,
			});

			this._deps.router.emitMessage(session?.uiSessionId || '', {
				id: toolUseId,
				type: 'tool_use',
				toolName,
				toolUseId,
				toolInput: access.title || '',
				rawInput: access.metadata || {},
				filePath: (access.metadata?.file_path || access.metadata?.filePath) as string | undefined,
			});
		}

		// Always create access_request (it will be deduplicated by requestId if needed)
		logger.info('[AccessHandler] Creating access_request message', {
			requestId: access.id,
			toolUseId,
			uiSessionId: session?.uiSessionId,
		});

		this._deps.router.emitMessage(session?.uiSessionId || '', {
			id: access.id,
			type: 'access_request',
			requestId: access.id,
			toolUseId,
			tool: toolName,
			input: access.metadata,
			pattern: Array.isArray(access.pattern) ? access.pattern.join(', ') : access.pattern,
			timestamp: new Date(access.time.created).toISOString(),
		});
	}

	/**
	 * Mark a toolUseId as created (called by StreamHandler when it creates tool_use)
	 * This prevents AccessHandler from creating a duplicate.
	 */
	public markToolUseCreated(toolUseId: string): void {
		this._createdToolUseIds.add(toolUseId);
	}

	/**
	 * Check if a toolUseId has been created
	 */
	public hasToolUseBeenCreated(toolUseId: string): boolean {
		return this._createdToolUseIds.has(toolUseId);
	}

	public handleAccessRequest(request: AccessRequest): void {
		let pattern: string | undefined;
		if (request.tool === 'Bash' && typeof request.input?.command === 'string') {
			pattern = this._accessService.getCommandPattern(request.input.command);
		}

		this._deps.router.emitMessage(request.sessionId || '', {
			id: request.id,
			type: 'access_request',
			requestId: request.id,
			toolUseId: request.toolUseId,
			tool: request.tool,
			input: request.input,
			pattern,
			timestamp: request.timestamp,
		});
	}

	public handleAccessResponse(
		id: string,
		approved: boolean,
		alwaysAllow = false,
		openCodeResponse?: OpenCodeAccessResponse,
	): void {
		const pendingAccess = this._pendingOpenCodeAccess.get(id);

		logger.debug(`[AccessHandler] handleAccessResponse called`, {
			id,
			approved,
			alwaysAllow,
			hasPendingAccess: !!pendingAccess,
			isOpenCode: CLIServiceFactory.isOpenCode(),
		});

		if (pendingAccess && CLIServiceFactory.isOpenCode()) {
			this._handleOpenCodeAccessResponse(
				id,
				pendingAccess,
				approved,
				alwaysAllow,
				openCodeResponse,
			);
		} else {
			logger.info(`[AccessHandler] Resolving via AccessService for id=${id}`);
			this._accessService.resolveAccessRequest(id, approved);
		}

		// accessResponse is a UI-only notification
		// Find the session to emit to
		const session = pendingAccess
			? this._sessionManager.getSessionByCLISessionId(pendingAccess.sessionId)
			: this._sessionManager.getActiveSession();

		if (session) {
			this._deps.router.emitAccessResponse(session.uiSessionId, id, approved, alwaysAllow);
		}

		if (alwaysAllow && approved && !CLIServiceFactory.isOpenCode()) {
			// Retrieve request details from service before they are cleared
			const request = this._accessService.getPendingRequest(id);
			if (request) {
				void this._accessService.saveAlwaysAllowAccess(request);
			} else {
				logger.warn(
					`[AccessHandler] Could not find pending request ${id} to save always-allow rule`,
				);
			}
		}
	}

	public clearPendingAccess(): void {
		this._pendingOpenCodeAccess.clear();
		this._createdToolUseIds.clear();
	}

	private _handleOpenCodeAccessResponse(
		id: string,
		pendingAccess: PendingAccess,
		approved: boolean,
		alwaysAllow: boolean,
		openCodeResponse?: OpenCodeAccessResponse,
	): void {
		// Find session by CLI session ID (not UI session ID)
		const session = this._sessionManager.getSessionByCLISessionId(pendingAccess.sessionId);
		const cliService = session?.cliService;

		if (!cliService) {
			logger.error(`[AccessHandler] No CLI service found for session ${pendingAccess.sessionId}`);
			return;
		}

		const response: OpenCodeAccessResponse =
			openCodeResponse || (approved ? (alwaysAllow ? 'always' : 'once') : 'reject');

		// SDK v2: permission.reply uses requestID (accessId) directly, sessionId is no longer needed
		// Optional message parameter can be used to explain rejection reason
		const rejectMessage = !approved ? 'User denied permission request' : undefined;

		void cliService
			.respondToPermission(pendingAccess.accessId, response, rejectMessage)
			.then(() => {
				this._pendingOpenCodeAccess.delete(id);
				session?.pendingAccess.delete(id);
			})
			.catch(error => {
				logger.error('[AccessHandler] Failed to respond to OpenCode access:', error);
			});
	}
}
