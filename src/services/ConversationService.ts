/**
 * @file Conversation history persistence service
 * @description Manages saving, loading, and indexing of chat conversations.
 * Stores conversations as JSON files with metadata for quick access.
 * stateless service - session data is passed in.
 * Integrates with ErrorService for centralized error handling.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ConversationData, ConversationIndexEntry, ConversationMessage } from '../types';
import { logger } from '../utils/logger';
import { ErrorCode, errorService, FileSystemError, ValidationError } from './ErrorService';

export class ConversationService {
	private _conversationsPath: string | undefined;
	private _initPromise: Promise<void>;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._initPromise = this._initializeConversations();
	}

	/**
	 * Extract text from userInput message data.
	 * Handles both legacy string format and new object format {text, messageId}.
	 */
	private _extractUserMessageText(message: ConversationMessage | undefined): string {
		if (!message) return 'No message';
		if (message.type === 'user' && 'content' in message) {
			return message.content || 'No message';
		}
		return 'No message';
	}

	public async waitForInitialization(): Promise<void> {
		return this._initPromise;
	}

	public get conversationIndex(): ConversationIndexEntry[] {
		// Ensure we always return an array, even if state is undefined
		return (
			this._context.workspaceState.get<ConversationIndexEntry[]>('chat.conversationIndex') || []
		);
	}

	public async saveConversation(data: ConversationData): Promise<void> {
		if (!this._conversationsPath) {
			logger.warn('[ConversationService] No conversations path set, cannot save');
			return;
		}

		try {
			logger.info(
				`[ConversationService] Saving conversation ${data.filename} (messages: ${data.messages.length})`,
			);
			await this._writeConversationFile(data.filename, data);
			this._updateConversationIndex(data);
		} catch (error) {
			logger.error(`[ConversationService] Error saving conversation: ${error}`);
			const fsError = FileSystemError.fromNodeError(
				error as NodeJS.ErrnoException,
				this._conversationsPath,
			);
			errorService.handle(fsError, 'ConversationService.saveConversation');
		}
	}

	public async loadConversation(filename: string): Promise<ConversationData | undefined> {
		if (!this._conversationsPath) return undefined;

		try {
			const filePath = path.join(this._conversationsPath, filename);
			const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
			return JSON.parse(new TextDecoder().decode(content));
		} catch (error) {
			if (error instanceof SyntaxError) {
				const validationError = ValidationError.fromJsonParseError(error, filename);
				errorService.handle(validationError, 'ConversationService.loadConversation');
			} else {
				const fsError = FileSystemError.fromNodeError(
					error as NodeJS.ErrnoException,
					path.join(this._conversationsPath, filename),
				);
				errorService.handle(fsError, 'ConversationService.loadConversation');
			}
			return undefined;
		}
	}

	public getLatestConversation(): ConversationIndexEntry | undefined {
		const index = this.conversationIndex;
		return index[0];
	}

	public async renameConversation(filename: string, newTitle: string): Promise<boolean> {
		const index = this.conversationIndex;
		const entryIndex = index.findIndex(e => e.filename === filename);
		if (entryIndex === -1) return false;

		// Update index entry with custom title
		index[entryIndex] = {
			...index[entryIndex],
			customTitle: newTitle,
		};

		await this._context.workspaceState.update('chat.conversationIndex', index);
		return true;
	}

	public async deleteConversation(filename: string): Promise<boolean> {
		if (!this._conversationsPath) return false;

		try {
			// Delete file
			const filePath = path.join(this._conversationsPath, filename);
			await vscode.workspace.fs.delete(vscode.Uri.file(filePath));

			// Remove from index
			const index = this.conversationIndex.filter(e => e.filename !== filename);
			await this._context.workspaceState.update('chat.conversationIndex', index);

			return true;
		} catch (error) {
			const fsError = FileSystemError.fromNodeError(
				error as NodeJS.ErrnoException,
				path.join(this._conversationsPath, filename),
			);
			errorService.handle(fsError, 'ConversationService.deleteConversation');
			return false;
		}
	}

	/**
	 * Delete all conversation files and clear the index
	 * Uses parallel deletion for better performance with many files
	 */
	public async clearAllConversations(): Promise<void> {
		const conversationsPath = this._conversationsPath;
		if (!conversationsPath) return;

		try {
			// Get all conversation files
			const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(conversationsPath));
			const jsonFiles = files.filter(
				([name, type]) => type === vscode.FileType.File && name.endsWith('.json'),
			);

			logger.info(`[ConversationService] Deleting ${jsonFiles.length} conversation files`);

			// Delete files in parallel for better performance
			const deletePromises = jsonFiles.map(([name]) => {
				const filePath = path.join(conversationsPath, name);
				return vscode.workspace.fs.delete(vscode.Uri.file(filePath)).then(
					() => undefined,
					(err: unknown) => {
						logger.warn(`[ConversationService] Failed to delete ${name}:`, err);
					},
				);
			});

			await Promise.all(deletePromises);

			// Clear the index
			await this._context.workspaceState.update('chat.conversationIndex', []);

			logger.info('[ConversationService] All conversations cleared');
		} catch (error) {
			logger.error('[ConversationService] Failed to clear all conversations:', error);
		}
	}

	private async _initializeConversations(): Promise<void> {
		const storagePath = this._context.storageUri?.fsPath;
		logger.info(`[ConversationService] Initializing conversations. Storage path: ${storagePath}`);

		if (!storagePath) {
			logger.warn(
				'[ConversationService] No storage path available. Conversations will not be saved.',
			);
			return;
		}

		this._conversationsPath = path.join(storagePath, 'conversations');
		logger.info(`[ConversationService] Conversations path: ${this._conversationsPath}`);

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._conversationsPath));
			logger.info('[ConversationService] Conversations directory verified');

			// Check if index is empty and rebuild if necessary
			if (this.conversationIndex.length === 0) {
				logger.info(
					'[ConversationService] Index is empty, checking for existing conversation files...',
				);
				await this.rebuildIndex();
			}
		} catch (error) {
			logger.error(`[ConversationService] Error creating conversations directory: ${error}`);
			const fsError = new FileSystemError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.FS_DIRECTORY_ERROR,
				{ path: this._conversationsPath },
			);
			errorService.handle(fsError, 'ConversationService._initializeConversations');
		}
	}

	public async rebuildIndex(): Promise<void> {
		if (!this._conversationsPath) return;

		try {
			const files = await vscode.workspace.fs.readDirectory(
				vscode.Uri.file(this._conversationsPath),
			);
			const jsonFiles = files.filter(
				([name, type]) => type === vscode.FileType.File && name.endsWith('.json'),
			);

			logger.info(`[ConversationService] Found ${jsonFiles.length} conversation files to index`);

			const newIndex: ConversationIndexEntry[] = [];

			for (const [name] of jsonFiles) {
				try {
					const data = await this.loadConversation(name);
					if (data) {
						const userMessages = data.messages.filter(
							(m: ConversationMessage) => m.type === 'user',
						);

						const firstUserMessage = this._extractUserMessageText(userMessages[0]).substring(
							0,
							100,
						);

						const lastUserMessage = this._extractUserMessageText(
							userMessages[userMessages.length - 1],
						).substring(0, 100);

						newIndex.push({
							filename: data.filename,
							sessionId: data.sessionId,
							startTime: data.startTime || '',
							endTime: data.endTime,
							messageCount: data.messageCount,
							totalCost: data.totalCost,
							firstUserMessage,
							lastUserMessage,
						});
					}
				} catch (err) {
					logger.warn(`[ConversationService] Failed to index file ${name}:`, err);
				}
			}

			// Sort by startTime descending
			newIndex.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

			// Take top 50
			const limitedIndex = newIndex.slice(0, 50);

			logger.info(`[ConversationService] Rebuilt index with ${limitedIndex.length} items`);
			await this._context.workspaceState.update('chat.conversationIndex', limitedIndex);
		} catch (error) {
			logger.error('[ConversationService] Failed to rebuild index:', error);
		}
	}

	private async _writeConversationFile(filename: string, data: ConversationData): Promise<void> {
		if (!this._conversationsPath) return;
		const filePath = path.join(this._conversationsPath, filename);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.file(filePath),
			new TextEncoder().encode(JSON.stringify(data, null, 2)),
		);
	}

	private _updateConversationIndex(data: ConversationData): void {
		// Re-read index to avoid race conditions
		const currentIndex = this.conversationIndex;
		logger.debug(
			`[ConversationService] Updating index for ${data.filename}. Current index size: ${currentIndex.length}`,
		);

		const userMessages = data.messages.filter((m: ConversationMessage) => m.type === 'user');

		const firstUserMessage = this._extractUserMessageText(userMessages[0]).substring(0, 100);

		const lastUserMessage = this._extractUserMessageText(
			userMessages[userMessages.length - 1],
		).substring(0, 100);

		const entry: ConversationIndexEntry = {
			filename: data.filename,
			sessionId: data.sessionId,
			startTime: data.startTime || '',
			endTime: data.endTime,
			messageCount: data.messageCount,
			totalCost: data.totalCost,
			firstUserMessage,
			lastUserMessage,
		};

		// Check if entry exists to preserve customTitle
		const existingEntry = currentIndex.find(e => e.filename === data.filename);
		if (existingEntry?.customTitle) {
			entry.customTitle = existingEntry.customTitle;
		}

		const newIndex = [entry, ...currentIndex.filter(e => e.filename !== data.filename)].slice(
			0,
			50,
		);

		logger.debug(`[ConversationService] Updated index. New size: ${newIndex.length}`);
		this._context.workspaceState.update('chat.conversationIndex', newIndex);
	}
}
