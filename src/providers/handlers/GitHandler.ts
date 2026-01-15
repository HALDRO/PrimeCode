/**
 * @file GitHandler
 * @description Handles Git operations: diff viewing, undo changes, and copying patches.
 * Uses SessionRouter for session-specific file change notifications.
 */

import * as vscode from 'vscode';
import { ErrorCode, errorService, GitError } from '../../services/ErrorService';
import type { FileService } from '../../services/FileService';
import type { SessionManager } from '../../services/SessionManager';
import { cacheDiffContent } from '../../utils/diffCache';
import { logger } from '../../utils/logger';
import type { SessionRouter } from './SessionRouter';

// =============================================================================
// Types
// =============================================================================

export interface GitHandlerDeps {
	router: SessionRouter;
}

interface GitChange {
	uri: vscode.Uri;
}

// =============================================================================
// GitHandler Class
// =============================================================================

export class GitHandler {
	constructor(
		private readonly _fileService: FileService,
		private readonly _sessionManager: SessionManager,
		private readonly _deps: GitHandlerDeps,
	) {}

	public async openFileDiff(
		filePath: string,
		oldContent?: string,
		newContent?: string,
	): Promise<void> {
		try {
			const absolutePath = this._fileService.resolveFilePath(filePath);
			const uri = vscode.Uri.file(absolutePath);
			const fileName = absolutePath.split(/[/\\]/).pop() || 'file';

			logger.debug(
				`[GitHandler] openFileDiff called: filePath=${filePath}, hasOldContent=${oldContent !== undefined}, hasNewContent=${newContent !== undefined}`,
			);

			if (oldContent !== undefined || newContent !== undefined) {
				const { oldFull, newFull } = await this._buildDiffContents(
					uri,
					oldContent || '',
					newContent || '',
				);

				logger.debug(
					`[GitHandler] Opening virtual diff: oldContent length=${oldFull.length}, newContent length=${newFull.length}`,
				);

				// Extract file extension for syntax highlighting
				const fileExtension = fileName.includes('.') ? `.${fileName.split('.').pop()}` : '';

				const oldUri = cacheDiffContent(oldFull, `${fileName} (old)`, fileExtension);
				const newUri = cacheDiffContent(newFull, `${fileName} (new)`, fileExtension);

				await vscode.commands.executeCommand(
					'vscode.diff',
					oldUri,
					newUri,
					`${fileName} (Changes)`,
					{ preview: true },
				);
				return;
			}

			const gitExtension = vscode.extensions.getExtension('vscode.git');
			if (gitExtension?.isActive) {
				await vscode.commands.executeCommand('git.openChange', uri);
			} else {
				await this._fileService.openFileInEditor(absolutePath);
			}
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
				{ filePath },
			);
			errorService.handle(gitError, 'GitHandler.openFileDiff');
			const absolutePath = this._fileService.resolveFilePath(filePath);
			await this._fileService.openFileInEditor(absolutePath);
		}
	}

	public async undoFileChanges(filePath: string): Promise<void> {
		const sessionId = this._sessionManager.activeSessionId || '';

		try {
			const absolutePath = this._fileService.resolveFilePath(filePath);
			const uri = vscode.Uri.file(absolutePath);

			const gitExtension = vscode.extensions.getExtension('vscode.git');
			if (!gitExtension) {
				logger.info(`[GitHandler] Git extension not found, trying to delete file: ${absolutePath}`);
				await vscode.workspace.fs.delete(uri, { useTrash: true });
				this._deps.router.emitFileUndone(sessionId, filePath);
				return;
			}

			const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
			const api = git.getAPI(1);

			if (!api || api.repositories.length === 0) {
				logger.info(`[GitHandler] No Git repository found, trying to delete file: ${absolutePath}`);
				await vscode.workspace.fs.delete(uri, { useTrash: true });
				this._deps.router.emitFileUndone(sessionId, filePath);
				return;
			}

			const repo = api.repositories[0];
			const fileExists = await this._checkFileExists(uri);

			if (!fileExists) {
				logger.info(`[GitHandler] File does not exist: ${absolutePath}`);
				this._deps.router.emitFileUndone(sessionId, filePath);
				return;
			}

			const status = repo.state;
			const untrackedChanges: GitChange[] = status.untrackedChanges || [];
			const workingTreeChanges: GitChange[] = status.workingTreeChanges || [];

			logger.info(`[GitHandler] Undo file: ${absolutePath}`);
			logger.info(`[GitHandler] Untracked changes: ${untrackedChanges.length}`);
			logger.info(`[GitHandler] Working tree changes: ${workingTreeChanges.length}`);

			const isUntracked = untrackedChanges.some(change => change.uri.fsPath === uri.fsPath);
			const isModified = workingTreeChanges.some(change => change.uri.fsPath === uri.fsPath);

			logger.info(`[GitHandler] isUntracked: ${isUntracked}, isModified: ${isModified}`);

			if (isUntracked) {
				logger.info(`[GitHandler] Deleting untracked file: ${absolutePath}`);
				await vscode.workspace.fs.delete(uri, { useTrash: true });
			} else if (isModified) {
				await this._revertModifiedFile(repo, uri, absolutePath);
			} else {
				logger.info(`[GitHandler] File not in git state, trying to delete: ${absolutePath}`);
				try {
					await vscode.workspace.fs.delete(uri, { useTrash: true });
				} catch (deleteError) {
					logger.info(`[GitHandler] Delete failed: ${deleteError}`);
					throw deleteError;
				}
			}

			this._deps.router.emitFileUndone(sessionId, filePath);
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
				{ filePath },
			);
			errorService.handle(gitError, 'GitHandler.undoFileChanges');
			this._deps.router.emitError(sessionId, gitError.userMessage);
		}
	}

	public async undoAllChanges(): Promise<void> {
		const sessionId = this._sessionManager.activeSessionId || '';

		try {
			const gitExtension = vscode.extensions.getExtension('vscode.git');
			if (!gitExtension) {
				throw new Error('Git extension not found');
			}

			const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
			const api = git.getAPI(1);

			if (!api || api.repositories.length === 0) {
				throw new Error('No Git repository found');
			}

			const repo = api.repositories[0];
			const untrackedChanges: GitChange[] = repo.state.untrackedChanges || [];
			const workingTreeChanges: GitChange[] = repo.state.workingTreeChanges || [];

			// Delete untracked files
			for (const change of untrackedChanges) {
				try {
					await vscode.workspace.fs.delete(change.uri, { useTrash: true });
				} catch {
					// Ignore errors for individual files
				}
			}

			// Revert modified files
			if (workingTreeChanges.length > 0) {
				const uris = workingTreeChanges.map(change => change.uri);
				try {
					await repo.revert(uris);
				} catch {
					for (const uri of uris) {
						try {
							await repo.revert([uri]);
						} catch {
							// Ignore errors for individual files
						}
					}
				}
			}

			this._deps.router.emitAllFilesUndone(sessionId);
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
			);
			errorService.handle(gitError, 'GitHandler.undoAllChanges');
			this._deps.router.emitError(sessionId, gitError.userMessage);
		}
	}

	public async copyDiffs(filePaths: string[]): Promise<void> {
		try {
			const diffs: string[] = [];
			for (const filePath of filePaths) {
				const diff = await this._getFileDiff(filePath);
				if (diff) {
					diffs.push(diff);
				}
			}
			if (diffs.length > 0) {
				const fullPatch = diffs.join('\n');
				await vscode.env.clipboard.writeText(fullPatch);
			}
			// Silent operation - no toast notifications
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
			);
			errorService.handle(gitError, 'GitHandler.copyDiffs');
			errorService.showError(gitError);
		}
	}

	public async copyAllDiffs(): Promise<void> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) {
				vscode.window.showWarningMessage('No workspace folder found');
				return;
			}

			const { exec } = await import('node:child_process');
			const { promisify } = await import('node:util');
			const execAsync = promisify(exec);

			const cwd = workspaceFolder.uri.fsPath;

			const { stdout: unstagedDiff } = await execAsync('git diff --unified=3', {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
			});
			const { stdout: stagedDiff } = await execAsync('git diff --cached --unified=3', {
				cwd,
				maxBuffer: 10 * 1024 * 1024,
			});

			const parts: string[] = [];
			if (stagedDiff.trim()) {
				parts.push(`# Staged Changes\n\n${stagedDiff}`);
			}
			if (unstagedDiff.trim()) {
				parts.push(`# Unstaged Changes\n\n${unstagedDiff}`);
			}

			if (parts.length > 0) {
				await vscode.env.clipboard.writeText(parts.join('\n\n'));
			}
			// Silent operation - no toast notifications
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
			);
			errorService.handle(gitError, 'GitHandler.copyAllDiffs');
			errorService.showError(gitError);
		}
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private async _buildDiffContents(
		uri: vscode.Uri,
		oldContent: string,
		newContent: string,
	): Promise<{ oldFull: string; newFull: string }> {
		// Read the current file content from disk
		let currentFileContent = '';
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			currentFileContent = document.getText();
			logger.debug(
				`[GitHandler] _buildDiffContents: currentFileContent length=${currentFileContent.length}`,
			);
		} catch {
			// File might not exist yet if it's a new file
			// In this case, oldContent should be empty and newContent is the full new file
			logger.debug('[GitHandler] _buildDiffContents: file not found, using fragments directly');
			return { oldFull: oldContent, newFull: newContent };
		}

		// If we have both old and new content fragments, we need to:
		// 1. Find where the old fragment is in the current file
		// 2. Create "before" version by replacing newContent with oldContent in current file
		// 3. Use current file as "after" version (since changes are already applied)

		if (oldContent && newContent && currentFileContent) {
			// The file on disk already has the new content applied
			// So currentFileContent is the "new" state
			// We need to reconstruct the "old" state by replacing newContent with oldContent

			// Normalize line endings for comparison
			const normalizedCurrent = currentFileContent.replace(/\r\n/g, '\n');
			const normalizedNew = newContent.replace(/\r\n/g, '\n');
			const normalizedOld = oldContent.replace(/\r\n/g, '\n');

			logger.debug(
				`[GitHandler] _buildDiffContents: checking includes - newContent in current: ${normalizedCurrent.includes(normalizedNew)}, oldContent in current: ${normalizedCurrent.includes(normalizedOld)}`,
			);

			if (normalizedCurrent.includes(normalizedNew)) {
				// Current file contains the new content - this is the expected case
				// Reconstruct old version by replacing new with old
				const oldFull = normalizedCurrent.replace(normalizedNew, normalizedOld);
				logger.debug(
					`[GitHandler] _buildDiffContents: reconstructed old from current, oldFull length=${oldFull.length}`,
				);
				return { oldFull, newFull: normalizedCurrent };
			}

			if (normalizedCurrent.includes(normalizedOld)) {
				// Current file still has old content (changes not yet applied)
				// New version is current file with old replaced by new
				const newFull = normalizedCurrent.replace(normalizedOld, normalizedNew);
				logger.debug(
					`[GitHandler] _buildDiffContents: created new from current, newFull length=${newFull.length}`,
				);
				return { oldFull: normalizedCurrent, newFull };
			}

			// Fragments don't match exactly - try to show full file with the change
			// This happens when the fragment has slight differences (whitespace, etc.)
			logger.debug(
				'[GitHandler] _buildDiffContents: fragments do not match current file exactly, showing full file diff',
			);
			// Use current file as "new" and reconstruct "old" by appending the old fragment info
			// Actually, let's just show the current file vs current file with manual replacement attempt
			// Best effort: show current file as new, and try to create old by simple replacement
			return { oldFull: currentFileContent, newFull: currentFileContent };
		}

		// Fallback: if we can't match fragments, just use what we have
		// This handles cases like new files or when fragments don't match exactly
		if (!oldContent && newContent) {
			// New file case
			logger.debug('[GitHandler] _buildDiffContents: new file case');
			return { oldFull: '', newFull: newContent };
		}

		if (oldContent && !newContent) {
			// File deletion case
			logger.debug('[GitHandler] _buildDiffContents: file deletion case');
			return { oldFull: oldContent, newFull: '' };
		}

		// Last resort: use the fragments directly
		logger.debug('[GitHandler] _buildDiffContents: using fragments directly as last resort');
		return { oldFull: oldContent, newFull: newContent };
	}

	private async _checkFileExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
	}

	private async _revertModifiedFile(
		repo: {
			revert: (uris: vscode.Uri[]) => Promise<void>;
			clean: (paths: string[]) => Promise<void>;
			exec: (args: string[]) => Promise<void>;
		},
		uri: vscode.Uri,
		absolutePath: string,
	): Promise<void> {
		logger.info(`[GitHandler] Reverting modified file via discardChanges: ${absolutePath}`);
		try {
			await repo.revert([uri]);
		} catch (revertError) {
			logger.info(`[GitHandler] revert failed, trying clean: ${revertError}`);
			try {
				await repo.clean([uri.fsPath]);
			} catch (cleanError) {
				logger.info(`[GitHandler] clean also failed: ${cleanError}`);
				await repo.exec(['checkout', '--', absolutePath]);
			}
		}
	}

	private async _getFileDiff(filePath: string): Promise<string | null> {
		try {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			if (!workspaceFolder) return null;

			const { exec } = await import('node:child_process');
			const { promisify } = await import('node:util');
			const execAsync = promisify(exec);

			const cwd = workspaceFolder.uri.fsPath;
			const absolutePath = this._fileService.resolveFilePath(filePath);

			const relativePath = absolutePath
				.replace(cwd, '')
				.replace(/^[/\\]/, '')
				.replace(/\\/g, '/');

			let diff = '';
			try {
				const { stdout: unstagedDiff } = await execAsync(
					`git diff --unified=3 -- "${relativePath}"`,
					{ cwd, maxBuffer: 5 * 1024 * 1024 },
				);
				const { stdout: stagedDiff } = await execAsync(
					`git diff --cached --unified=3 -- "${relativePath}"`,
					{ cwd, maxBuffer: 5 * 1024 * 1024 },
				);
				diff = [stagedDiff, unstagedDiff].filter(Boolean).join('\n');
			} catch {
				const { stdout: statusOut } = await execAsync(
					`git status --porcelain -- "${relativePath}"`,
					{ cwd },
				);
				if (statusOut.startsWith('??') || statusOut.startsWith('A ')) {
					const fs = await import('node:fs/promises');
					const content = await fs.readFile(absolutePath, 'utf-8');
					const lines = content.split('\n');
					diff = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`;
				}
			}

			return diff.trim() || null;
		} catch (error) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
				{ filePath },
			);
			errorService.handle(gitError, 'GitHandler.getFileDiff');
			return null;
		}
	}
}
