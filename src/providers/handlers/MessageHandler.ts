/**
 * @file MessageHandler
 * @description Handles sending messages to CLI, building process options, and managing backups/checkpoints.
 *              Processes structured attachments (files, code snippets, images) and formats them for CLI.
 */

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { AccessService } from '../../services/AccessService';
import { CLIServiceFactory } from '../../services/CLIServiceFactory';
import { ErrorCode, errorService, GitError } from '../../services/ErrorService';
import {
	getGlobalProvider,
	initializeSessionProvider,
	isSessionOpenCode,
} from '../../services/ProviderResolver';
import type { SessionManager } from '../../services/SessionManager';
import type { SettingsService } from '../../services/SettingsService';
import type { MessageAttachments } from '../../types';
import { logger } from '../../utils/logger';
import type { ImageHandler } from './ImageHandler';
import type { StreamHandler } from './StreamHandler';

// =============================================================================
// Types
// =============================================================================

export interface MessageHandlerDeps {
	postMessage: (msg: unknown) => void;
	sendAndSaveMessage: (msg: { type: string; [key: string]: unknown }, sessionId?: string) => void;
}

interface ProcessOptions {
	message: string;
	sessionId?: string;
	selectedModel: string;
	mcpConfigPath?: string;
	agent?: string;
	proxyConfig?: {
		enabled: boolean;
		baseUrl: string;
		apiKey?: string;
		/** When true, only main model is used for all tasks. When false, task-specific models are used. */
		useSingleModel?: boolean;
		/** Model for fast/simple tasks (Explore agent, quick checks). Defaults to main model. */
		haikuModel?: string;
		/** Model for standard tasks. Defaults to main model. */
		sonnetModel?: string;
		/** Model for complex tasks (plan mode). Defaults to main model. */
		opusModel?: string;
		/** Model for subagents. Defaults to main model. */
		subagentModel?: string;
	};
	/** OpenCode command to execute (e.g., 'init', 'review') */
	command?: string;
	/** Arguments for the command */
	commandArgs?: string;
}

// =============================================================================
// MessageHandler Class
// =============================================================================

export class MessageHandler {
	constructor(
		private readonly _sessionManager: SessionManager,
		private readonly _settingsService: SettingsService,
		private readonly _accessService: AccessService,
		private readonly _imageHandler: ImageHandler,
		private readonly _streamHandler: StreamHandler,
		private readonly _deps: MessageHandlerDeps,
	) {}

	/**
	 * Send a message to a specific UI session.
	 * @description This is the only correct way to support parallel multi-session chat.
	 * The caller must provide the UI sessionId so we never race on SessionManager.activeSessionId.
	 */
	public async sendMessageToSession(
		uiSessionId: string | undefined,
		message: string,
		planMode?: boolean,
		attachments?: MessageAttachments,
	): Promise<void> {
		const resolvedUiSessionId = uiSessionId || this._sessionManager.activeSessionId;
		if (!resolvedUiSessionId) {
			this._deps.postMessage({
				type: 'error',
				data: { content: 'No active session. Please reload the webview.' },
			});
			return;
		}

		let actualMessage = message;

		// Process images from attachments
		if (attachments?.images && attachments.images.length > 0) {
			const imagePaths = await this._imageHandler.saveImagesToTemp(attachments.images);
			if (imagePaths.length > 0) {
				const imageRefs = imagePaths.map(p => `@${p}`).join(' ');
				actualMessage = `${imageRefs}\n\n${actualMessage}`;
			}
		}

		// Process file references from attachments
		if (attachments?.files && attachments.files.length > 0) {
			const fileRefs = attachments.files.map(f => `@${f}`).join(' ');
			actualMessage = `${fileRefs}\n\n${actualMessage}`;
		}

		// Process code snippets from attachments
		if (attachments?.codeSnippets && attachments.codeSnippets.length > 0) {
			const snippetParts: string[] = [];
			for (const snippet of attachments.codeSnippets) {
				snippetParts.push(`@${snippet.filePath} (${snippet.startLine}-${snippet.endLine})`);
				snippetParts.push('```');
				snippetParts.push(snippet.content);
				snippetParts.push('```');
			}
			actualMessage = `${actualMessage}\n\n${snippetParts.join('\n')}`;
		}

		if (planMode) {
			actualMessage = `PLAN FIRST FOR THIS MESSAGE ONLY: Plan first before making any changes... \n\n${actualMessage}`;
		}

		const session = await this._sessionManager.getOrCreateSession(resolvedUiSessionId);

		// Determine provider type: use session's saved provider if available, otherwise use global config
		// ProviderResolver handles this logic centrally
		const isOpenCode = isSessionOpenCode(session);

		// For new sessions, initialize provider from global config
		if (!session.providerType) {
			initializeSessionProvider(session);
			logger.info(
				`[MessageHandler] New session, initialized provider from global config: ${getGlobalProvider()}`,
			);
		} else {
			logger.info(`[MessageHandler] Using session's saved provider: ${session.providerType}`);
		}

		// Clear any error/interrupted messages from previous interactions
		const clearedMessageIds = session.clearErrorMessages();
		if (clearedMessageIds.length > 0) {
			// Notify UI to remove these messages
			for (const messageId of clearedMessageIds) {
				this._deps.postMessage({
					type: 'messagePartRemoved',
					data: { messageId, partId: messageId },
					sessionId: session.uiSessionId,
				});
			}
			logger.info(
				`[MessageHandler] Cleared ${clearedMessageIds.length} error/interrupted messages before new message`,
			);
		}

		session.setProcessing(true);
		session.setReceivedResponse(false);
		session.setCheckpointCreated(false);
		session.lastPartContent.clear();
		session.resetMessageTokenTracking();

		// Clear unrevert state - user is sending a new message, unrevert no longer makes sense
		session.clearMessagesSnapshot();
		this._deps.postMessage({
			type: 'unrevertAvailable',
			data: { sessionId: session.uiSessionId, available: false },
			sessionId: session.uiSessionId,
		});

		const messageId = crypto.randomUUID();

		this._deps.sendAndSaveMessage(
			{
				id: messageId,
				type: 'user',
				content: message,
				model: this._settingsService.selectedModel,
				attachments: attachments,
			},
			session.uiSessionId,
		);
		this._deps.postMessage({
			type: 'setProcessing',
			data: { isProcessing: true, sessionId: session.uiSessionId },
		});

		session.setDraftMessage('');

		if (!isOpenCode) {
			await this.createBackupForSession(session.uiSessionId, message, messageId);
		}

		const providerName = isOpenCode ? 'OpenCode' : 'Claude';
		this._deps.postMessage({
			type: 'loading',
			data: `${providerName} is working...`,
			sessionId: session.uiSessionId,
		});

		try {
			// Ensure we have the correct service type based on configuration
			const expectedType = isOpenCode ? 'opencode' : 'claude';

			if (session.cliService && session.cliService.getProviderType() !== expectedType) {
				logger.info(
					`[MessageHandler] Switching session service from ${session.cliService.getProviderType()} to ${expectedType}`,
				);
				const newService = await CLIServiceFactory.getService(expectedType);
				session.setCLIService(newService);
			} else if (!session.cliService) {
				const globalService = await CLIServiceFactory.getService(expectedType);
				if (globalService) {
					session.setCLIService(globalService);
				} else {
					throw new Error('Session CLI service not initialized');
				}
			}

			if (isOpenCode) {
				// Check if we need to create or validate CLI session
				const existingCliSessionId = session.cliSessionId;
				let needsNewSession = !existingCliSessionId || !existingCliSessionId.startsWith('ses_');

				// If we have a CLI session ID, verify it still exists on the server
				// (server may have restarted, losing the session)
				if (!needsNewSession && existingCliSessionId && session.cliService) {
					try {
						logger.info(
							`[MessageHandler] Verifying OpenCode CLI session exists: ${existingCliSessionId}`,
						);
						const cliService = session.cliService as {
							switchSession?: (id: string) => Promise<unknown>;
						};
						if (cliService.switchSession) {
							await cliService.switchSession(existingCliSessionId);
							logger.info(
								`[MessageHandler] OpenCode CLI session verified: ${existingCliSessionId}`,
							);
						}
					} catch (error) {
						// Session doesn't exist on server anymore (server restarted)
						logger.warn(
							`[MessageHandler] OpenCode CLI session ${existingCliSessionId} not found on server, will create new one. Error: ${error}`,
						);
						needsNewSession = true;
					}
				}

				if (needsNewSession) {
					logger.info(
						`[MessageHandler] Creating new OpenCode CLI session for ${session.uiSessionId}...`,
					);
					await session.createCLISession();
					logger.info(`[MessageHandler] OpenCode CLI session created: ${session.cliSessionId}`);
				}
			}

			if (isOpenCode) {
				await this.createBackupForSession(session.uiSessionId, message, messageId);
			}

			const options = this._buildProcessOptions(actualMessage, session.uiSessionId, isOpenCode);
			await session.startProcess(options);
		} catch (error) {
			this._streamHandler.handleProcessError(error as Error, session.uiSessionId);
		}
	}

	private async createBackupForSession(
		uiSessionId: string,
		message: string,
		messageId?: string,
	): Promise<void> {
		await this.createBackup(message, messageId, uiSessionId);
	}

	public async createBackup(
		message: string,
		messageId?: string,
		sessionId?: string,
	): Promise<void> {
		const session = sessionId
			? this._sessionManager.getSession(sessionId)
			: this._sessionManager.getActiveSession();

		if (!session) return;

		// Use session's provider type via ProviderResolver
		const isOpenCode = isSessionOpenCode(session);

		// For OpenCode, use native SDK checkpointing based on message history.
		// OpenCode manages file snapshots internally via its Snapshot system,
		// so we don't need to create our own git backup.
		// If this is the first message (no lastOpenCodeMessageId yet), fall back to a git backup
		// so the UI can still offer a restore option immediately after the first assistant response.
		if (isOpenCode) {
			// We need the ID of the *previous* assistant message to revert to it.
			// revert(messageID) keeps that message and everything before it,
			// removing everything after (i.e., the current turn we're about to send).
			const lastOpenCodeId = session.lastOpenCodeMessageId;

			logger.info(
				`[MessageHandler] Creating OpenCode checkpoint: lastOpenCodeId=${lastOpenCodeId}, messageId=${messageId}, cliSessionId=${session.cliSessionId}`,
			);

			if (messageId && session.cliSessionId && lastOpenCodeId) {
				// OpenCode handles file snapshots internally via Snapshot.revert()
				// We only need to track the checkpoint metadata for UI and state management
				const checkpointInfo = {
					id: messageId,
					sha: lastOpenCodeId, // Use OpenCode message ID as the "SHA" for revert
					message: `Checkpoint: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`,
					timestamp: new Date().toISOString(),
					associatedMessageId: messageId,
					// Store UI session ID for SessionManager lookup, and CLI session ID for SDK revert
					sessionId: session.uiSessionId,
					cliSessionId: session.cliSessionId,
					isOpenCodeCheckpoint: true,
				};

				logger.info(
					`[MessageHandler] OpenCode checkpoint created: revert target=${lastOpenCodeId}, associated with user message=${messageId}`,
				);

				// Persist the checkpoint in the session
				session.addCommit(checkpointInfo);
				this._deps.sendAndSaveMessage(
					{ type: 'showRestoreOption', data: checkpointInfo },
					session.uiSessionId,
				);
			} else {
				// First message: create a git-based checkpoint.
				// This does not revert OpenCode's internal conversation, but it restores workspace files
				// and gives the user a consistent "undo" affordance.
				try {
					const commitInfo = await session.createBackupCommit(message, messageId);
					if (commitInfo) {
						this._deps.sendAndSaveMessage(
							{ type: 'showRestoreOption', data: commitInfo },
							session.uiSessionId,
						);
					}
				} catch (e) {
					const gitError =
						e instanceof GitError
							? e
							: new GitError(
									e instanceof Error ? e.message : String(e),
									ErrorCode.GIT_OPERATION_FAILED,
								);
					errorService.handle(gitError, 'MessageHandler.createBackup');
				}
			}
			return;
		}

		// For Claude CLI, use git-based backup via SessionContext
		try {
			const commitInfo = await session.createBackupCommit(message, messageId);
			if (commitInfo) {
				this._deps.sendAndSaveMessage(
					{ type: 'showRestoreOption', data: commitInfo },
					session.uiSessionId,
				);
			}
		} catch (e) {
			const gitError =
				e instanceof GitError
					? e
					: new GitError(
							e instanceof Error ? e.message : String(e),
							ErrorCode.GIT_OPERATION_FAILED,
						);
			errorService.handle(gitError, 'MessageHandler.createBackup');
		}
	}

	public stopProcess(sessionId?: string): void {
		const session = sessionId
			? this._sessionManager.getSession(sessionId)
			: this._sessionManager.getActiveSession();
		if (!session) return;

		if (session.stopProcess()) {
			session.setProcessing(false);
			this._deps.postMessage({
				type: 'setProcessing',
				data: { isProcessing: false, sessionId: session.uiSessionId },
			});
			this._deps.postMessage({ type: 'clearLoading', sessionId: session.uiSessionId });

			const interruptedId = crypto.randomUUID();
			this._deps.sendAndSaveMessage(
				{
					type: 'interrupted',
					data: {
						id: interruptedId,
						timestamp: new Date().toISOString(),
						content: 'Processing was stopped by user',
						reason: 'user_stopped',
					},
				},
				session.uiSessionId,
			);
		}
	}

	/**
	 * Resume processing after an error occurred.
	 * Sends a "Continue" prompt to the CLI to attempt recovery.
	 * For OpenCode: checks if SDK is already auto-retrying to avoid duplicate requests.
	 */
	public async resumeAfterError(uiSessionId: string): Promise<void> {
		const session = this._sessionManager.getSession(uiSessionId);
		if (!session) {
			logger.warn(`[MessageHandler] Cannot resume: session ${uiSessionId} not found`);
			return;
		}

		// Check if already processing
		if (session.isProcessing) {
			logger.warn(`[MessageHandler] Cannot resume: session ${uiSessionId} is already processing`);
			return;
		}

		// Check if OpenCode SDK is already auto-retrying
		if (session.isAutoRetrying) {
			logger.info(
				`[MessageHandler] Skipping manual resume: session ${uiSessionId} is auto-retrying via SDK`,
			);
			return;
		}

		logger.info(`[MessageHandler] Resuming after error for session ${uiSessionId}`);

		// Send a continuation prompt
		await this.sendMessageToSession(uiSessionId, 'Continue from where you left off.');
	}

	/**
	 * Dismiss an error/interrupted message - removes it from both UI and backend history
	 */
	public dismissErrorMessage(uiSessionId: string, messageId: string): void {
		const session = this._sessionManager.getSession(uiSessionId);
		if (!session) {
			logger.warn(`[MessageHandler] Cannot dismiss: session ${uiSessionId} not found`);
			return;
		}

		const removed = session.removeConversationMessage(messageId);
		if (removed) {
			logger.info(
				`[MessageHandler] Dismissed error message ${messageId} from session ${uiSessionId}`,
			);
		} else {
			logger.warn(`[MessageHandler] Message ${messageId} not found in session ${uiSessionId}`);
		}
	}

	private _buildProcessOptions(
		message: string,
		sessionId?: string,
		isOpenCode?: boolean,
	): ProcessOptions {
		const config = vscode.workspace.getConfiguration('primeCode');

		// Use passed isOpenCode or determine from session via ProviderResolver
		const session = sessionId ? this._sessionManager.getSession(sessionId) : undefined;
		const effectiveIsOpenCode = isOpenCode ?? isSessionOpenCode(session);

		const selectedModel = this._settingsService.selectedModel;
		logger.debug(
			`[MessageHandler] Building process options with selectedModel: "${selectedModel}"`,
		);

		// Build proxy config using centralized factory method
		const providerType = effectiveIsOpenCode ? 'opencode' : 'claude';
		const proxyConfig = CLIServiceFactory.buildProxyConfig(selectedModel, providerType);

		if (proxyConfig) {
			logger.info(
				`[MessageHandler] Using proxy config: baseUrl="${proxyConfig.baseUrl}", hasApiKey=${!!proxyConfig.apiKey}, useSingleModel=${proxyConfig.useSingleModel}`,
			);
		}

		// Check if message is a command (starts with /) for OpenCode
		let command: string | undefined;
		let commandArgs: string | undefined;
		const actualMessage = message;

		if (effectiveIsOpenCode && message.trim().startsWith('/')) {
			const trimmedMessage = message.trim();
			const spaceIndex = trimmedMessage.indexOf(' ');
			if (spaceIndex > 0) {
				command = trimmedMessage.substring(1, spaceIndex);
				commandArgs = trimmedMessage.substring(spaceIndex + 1).trim();
			} else {
				command = trimmedMessage.substring(1);
				commandArgs = '';
			}
			// For commands, we still pass the original message for display purposes
			// but the actual execution will use session.command()
			logger.info(`[MessageHandler] Detected OpenCode command: /${command} args="${commandArgs}"`);
		}

		return {
			message: actualMessage,
			sessionId,
			selectedModel,
			mcpConfigPath: effectiveIsOpenCode ? this._accessService.getMCPConfigPath() : undefined,
			agent: effectiveIsOpenCode
				? config.get<string>('opencode.agent', '') || undefined
				: undefined,
			command,
			commandArgs,
			proxyConfig,
		};
	}
}
