/**
 * @file ConversationService - Conversation history persistence
 * @description Provides conversation listing for the History dropdown. For OpenCode provider,
 *              delegates to the CLI runner API (`GET /session`) — single source of truth.
 *              For Claude provider, reads local JSON files from `.agents/conversations/`.
 *              Subagent sessions (those with parentID) are filtered out from the history list
 *              since they represent child tasks, not standalone conversations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ConversationIndexEntry } from '../common';
import type { ICLIConfig, ICLIRunner } from '../core/contracts';
import { logger } from '../utils/logger';

interface ConversationFile {
	sessionId?: string;
	startTime?: string;
	endTime?: string;
	messageCount?: number;
	totalCost?: number;
	firstUserMessage?: string;
	lastUserMessage?: string;
	customTitle?: string;
}

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
		const provider = this.cliRunner?.getProvider();

		// 1. If OpenCode, delegate strictly to API (Single Source of Truth)
		if (this.cliRunner && provider === 'opencode') {
			logger.info('[ConversationService] listConversations: using OpenCode API', {
				workspaceRoot: this.workspaceRoot,
			});
			return this.listOpenCodeConversations();
		}

		// 2. If Claude (or no runner), use local files (Legacy / Claude persistence)
		logger.info('[ConversationService] listConversations: using local files', {
			hasRunner: !!this.cliRunner,
			provider,
		});
		return this.listLocalConversations();
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

	private async listLocalConversations(): Promise<ConversationIndexEntry[]> {
		if (!this.workspaceRoot) {
			return [];
		}

		const conversationsDir = path.join(this.workspaceRoot, '.agents', 'conversations');
		if (!fs.existsSync(conversationsDir)) {
			return [];
		}

		try {
			const entries = await fs.promises.readdir(conversationsDir, { withFileTypes: true });
			const conversations: ConversationIndexEntry[] = [];

			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json')) {
					continue;
				}

				try {
					const filePath = path.join(conversationsDir, entry.name);
					const content = await fs.promises.readFile(filePath, 'utf-8');
					const data = JSON.parse(content) as ConversationFile;

					conversations.push({
						filename: entry.name,
						sessionId: data.sessionId || entry.name.replace('.json', ''),
						startTime: data.startTime || new Date(0).toISOString(),
						endTime: data.endTime || new Date(0).toISOString(),
						messageCount: data.messageCount || 0,
						totalCost: data.totalCost || 0,
						firstUserMessage: data.firstUserMessage || 'New Chat',
						lastUserMessage: data.lastUserMessage || '',
						customTitle: data.customTitle,
					});
				} catch (e) {
					logger.warn(`[ConversationService] Failed to parse ${entry.name}:`, e);
				}
			}

			// Sort by date (newest first)
			return conversations.sort(
				(a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
			);
		} catch (error) {
			logger.error('[ConversationService] Failed to list conversations:', error);
			return [];
		}
	}
}
