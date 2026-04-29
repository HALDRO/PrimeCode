/**
 * @file RestoreHandler
 * @description Canonical history mutation handler for restore/unrevert operations.
 *              The frontend addresses real session/message IDs directly.
 *              After each mutation we resync the session from the server snapshot
 *              instead of maintaining a parallel local restore control plane.
 */

import type { Part } from '@opencode-ai/sdk/v2/client';
import * as vscode from 'vscode';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import { logger } from '../../utils/logger';
import { sanitizePartForHistory } from '../../utils/toolPartSanitizer';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class RestoreHandler implements WebviewMessageHandler {
	constructor(private readonly context: HandlerContext) {}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'restoreMessage':
				await this.handleRestoreMessage(msg);
				break;
			case 'unrevert':
				await this.handleUnrevert(msg);
				break;
		}
	}

	private async handleRestoreMessage(msg: CommandOf<'restoreMessage'>): Promise<void> {
		const { sessionId, messageId } = msg;
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[RestoreHandler] restoreMessage: no workspace root');
			return;
		}

		logger.info('[RestoreHandler] Restoring session to message', {
			sessionId,
			messageId,
		});

		try {
			await this.context.cli.truncateSession(sessionId, messageId, {
				provider: 'opencode',
				workspaceRoot,
			});
			await this.resyncSession(sessionId, workspaceRoot);
		} catch (error) {
			logger.error('[RestoreHandler] Failed to restore message', error);
			this.notifyError(sessionId, `Failed to restore message: ${error}`);
		}
	}

	private async handleUnrevert(msg: CommandOf<'unrevert'>): Promise<void> {
		const { sessionId } = msg;
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			logger.warn('[RestoreHandler] unrevert: no workspace root');
			return;
		}

		logger.info('[RestoreHandler] Unreverting session', { sessionId });

		try {
			await this.context.cli.unrevertSession(sessionId, {
				provider: 'opencode',
				workspaceRoot,
			});
			await this.resyncSession(sessionId, workspaceRoot);
		} catch (error) {
			logger.error('[RestoreHandler] Unrevert failed', error);
			this.notifyError(sessionId, `Failed to unrevert: ${error}`);
		}
	}

	private async resyncSession(sessionId: string, workspaceRoot: string): Promise<void> {
		const sdkClient = this.context.cli.getSdkClient?.();
		if (!sdkClient) {
			throw new Error('OpenCode SDK client unavailable for restore resync');
		}

		const [messagesResult, sessionResult, diffResult, todoResult, statusResult] = await Promise.all(
			[
				sdkClient.session.messages({ sessionID: sessionId, directory: workspaceRoot }),
				sdkClient.session.get({ sessionID: sessionId, directory: workspaceRoot }),
				sdkClient.session.diff({ sessionID: sessionId, directory: workspaceRoot }),
				sdkClient.session
					.todo({ sessionID: sessionId, directory: workspaceRoot })
					.catch(() => null),
				sdkClient.session.status({ directory: workspaceRoot }).catch(() => null),
			],
		);

		if (messagesResult.error) {
			throw new Error(`Failed to fetch session messages: ${JSON.stringify(messagesResult.error)}`);
		}

		const entries = (messagesResult.data ?? []).sort(
			(a, b) => a.info.time.created - b.info.time.created,
		);
		const skipParts = new Set(['patch', 'step-start', 'step-finish', 'snapshot']);
		const partsByMessageId: Record<string, Part[]> = {};
		for (const entry of entries) {
			partsByMessageId[entry.info.id] = entry.parts
				.filter(part => !skipParts.has(part.type))
				.map(sanitizePartForHistory);
		}

		this.context.bridge.data('restore_session', {
			sessionId,
			messages: entries.map(entry => entry.info),
			parts: partsByMessageId,
		});

		if (sessionResult.error) {
			throw new Error(`Failed to fetch session info: ${JSON.stringify(sessionResult.error)}`);
		}

		const sessionInfo = sessionResult.data;
		if (sessionInfo) {
			this.context.sessionManager.setSession(sessionInfo);
			this.context.bridge.sendSdkEvent({
				type: 'session.updated',
				properties: {
					info: sessionInfo,
				},
			});
		}

		const status = statusResult?.data?.[sessionId];
		if (status) {
			this.context.bridge.sendSdkEvent({
				type: 'session.status',
				properties: {
					sessionID: sessionId,
					status,
				},
			});
		}

		this.context.bridge.sendSdkEvent({
			type: 'session.diff',
			properties: {
				sessionID: sessionId,
				diff: diffResult.data ?? [],
			},
		});

		if (todoResult?.data) {
			this.context.bridge.sendSdkEvent({
				type: 'todo.updated',
				properties: {
					sessionID: sessionId,
					todos: todoResult.data,
				},
			});
		}
	}

	private notifyError(sessionId: string, message: string): void {
		this.context.bridge.data('showNotification', {
			notification: {
				id: `restore-error-${Date.now()}`,
				type: 'error',
				content: message,
				timestamp: new Date().toISOString(),
			},
		});
		this.context.bridge.sendSdkEvent({
			type: 'session.status',
			properties: {
				sessionID: sessionId,
				status: { type: 'error' },
			},
		});
	}
}
