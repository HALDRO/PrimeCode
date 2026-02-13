/**
 * @file ConversationService - Conversation history persistence
 * @description Provides conversation listing for the History dropdown. For OpenCode provider,
 *              delegates to the CLI runner API (`GET /session`) — single source of truth.
 *              For local provider, reads JSON files from `.agents/conversations/`.
 *              Subagent sessions (those with parentID) are filtered out from the history list
 *              since they represent child tasks, not standalone conversations.
 */

import type { ConversationIndexEntry } from '../common';
import type { ICLIConfig, ICLIRunner } from '../core/contracts';
import { logger } from '../utils/logger';

export class ConversationService {
	private workspaceRoot: string | undefined;
	private cliRunner: ICLIRunner | undefined;

	setWorkspaceRoot(root: string) {
		this.workspaceRoot = root;
	}

	setCLIRunner(runner: ICLIRunner) {
		this.cliRunner = runner;
	}

	async listConversations(): Promise<ConversationIndexEntry[]> {
		// Always delegate to OpenCode API (Single Source of Truth)
		if (this.cliRunner) {
			logger.info('[ConversationService] listConversations: using OpenCode API', {
				workspaceRoot: this.workspaceRoot,
			});
			return this.listOpenCodeConversations();
		}

		logger.warn('[ConversationService] listConversations: no cliRunner available');
		return [];
	}

	private async listOpenCodeConversations(): Promise<ConversationIndexEntry[]> {
		if (!this.cliRunner) {
			logger.warn('[ConversationService] listOpenCodeConversations: no cliRunner');
			return [];
		}

		try {
			// NOTE: We do NOT fallback to local files for OpenCode.
			// The executor already uses roots=true to filter child sessions
			// and resolves default titles from first user message.
			const config: ICLIConfig = {
				provider: 'opencode',
				workspaceRoot: this.workspaceRoot || '',
			};
			const sessions = await this.cliRunner.listSessions(config);

			logger.info('[ConversationService] listOpenCodeConversations result', {
				totalFromAPI: sessions.length,
			});

			return sessions
				.map(s => ({
					filename: s.id,
					sessionId: s.id,
					startTime: new Date(s.created || s.lastModified || 0).toISOString(),
					endTime: new Date(s.lastModified || 0).toISOString(),
					messageCount: 0,
					totalCost: 0,
					firstUserMessage: s.title || 'New Session',
					lastUserMessage: '',
					customTitle: s.title || undefined,
				}))
				.sort((a, b) => new Date(b.endTime).getTime() - new Date(a.endTime).getTime());
		} catch (error) {
			logger.warn('[ConversationService] Failed to list CLI sessions:', error);
			return [];
		}
	}
}
