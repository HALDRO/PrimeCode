/**
 * @file Git-based backup service for workspace state management
 * @description Provides automatic backup functionality using a separate Git repository
 * to track workspace changes before AI operations. Enables rollback to previous
 * states if needed. Integrates with ErrorService for centralized error handling.
 * Supports multi-session isolation: each UI session has its own commit history.
 */

import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as util from 'node:util';
import * as vscode from 'vscode';
import type { CommitInfo } from '../types';
import { logger } from '../utils/logger';
import { ErrorCode, errorService, FileSystemError, GitError } from './ErrorService';

const exec = util.promisify(cp.exec);

export class BackupService {
	private _backupRepoPath: string | undefined;
	// Multi-session support: Map<sessionId, commits[]>
	private _sessionCommits: Map<string, CommitInfo[]> = new Map();
	private _activeSessionId: string | undefined;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._initializeBackupRepo();
	}

	/**
	 * Get commits for the active session (backward compatible)
	 */
	public get commits(): CommitInfo[] {
		if (!this._activeSessionId) return [];
		return this._sessionCommits.get(this._activeSessionId) || [];
	}

	/**
	 * Get commits for a specific session
	 */
	public getSessionCommits(sessionId: string): CommitInfo[] {
		return this._sessionCommits.get(sessionId) || [];
	}

	/**
	 * Set the active session for commit operations
	 */
	public setActiveSession(sessionId: string): void {
		this._activeSessionId = sessionId;
		// Initialize commits array for new session if needed
		if (!this._sessionCommits.has(sessionId)) {
			this._sessionCommits.set(sessionId, []);
		}
	}

	/**
	 * Clear commits for a specific session
	 */
	public clearSessionCommits(sessionId: string): void {
		this._sessionCommits.delete(sessionId);
	}

	public async createBackupCommit(
		userMessage: string,
		associatedMessageId?: string,
	): Promise<CommitInfo | undefined> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder || !this._backupRepoPath) return undefined;

		try {
			const workspacePath = workspaceFolder.uri.fsPath;
			const timestamp = new Date().toISOString();
			const shortMsg = userMessage.length > 50 ? `${userMessage.substring(0, 50)}...` : userMessage;
			const commitMsg = `Before: ${shortMsg}`;

			await this._runGit(`add -A`, workspacePath);

			const status = await this._runGit(`status --porcelain`, workspacePath);
			const isFirst = await this._isFirstCommit();

			const finalMsg = isFirst
				? `Initial backup: ${shortMsg}`
				: status.trim()
					? commitMsg
					: `Checkpoint (no changes): ${shortMsg}`;

			await this._runGit(`commit --allow-empty -m "${finalMsg}"`, workspacePath, {
				config: {
					'user.name': 'PrimeCode',
					'user.email': 'primecode@local',
				},
			});
			const sha = await this._runGit(`rev-parse HEAD`, workspacePath);

			const commitInfo: CommitInfo = {
				id: `commit-${timestamp.replace(/[:.]/g, '-')}`,
				sha: sha.trim(),
				message: finalMsg,
				timestamp,
				associatedMessageId,
			};

			// Add to active session's commits
			if (this._activeSessionId) {
				const sessionCommits = this._sessionCommits.get(this._activeSessionId) || [];
				sessionCommits.push(commitInfo);
				this._sessionCommits.set(this._activeSessionId, sessionCommits);
			}

			return commitInfo;
		} catch (error: unknown) {
			if (error instanceof Error && error.message.includes('index.lock')) {
				await this._removeLockFile();
				return undefined;
			}
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
				{ operation: 'createBackupCommit' },
			);
			errorService.handle(gitError, 'BackupService.createBackupCommit');
			return undefined;
		}
	}

	public async restoreToCommit(commitSha: string): Promise<{ success: boolean; message: string }> {
		logger.info(`[BackupService] restoreToCommit called with SHA: ${commitSha}`);

		// Search in active session first, then all sessions
		let commit = this.commits.find(c => c.sha === commitSha);
		if (!commit) {
			// Search across all sessions
			for (const [, commits] of this._sessionCommits) {
				commit = commits.find(c => c.sha === commitSha);
				if (commit) break;
			}
		}

		logger.info(`[BackupService] Commit found in internal list: ${!!commit}`);

		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder || !this._backupRepoPath) {
			logger.error(
				`[BackupService] Workspace or backup repo unavailable. workspaceFolder=${!!workspaceFolder}, backupRepoPath=${this._backupRepoPath}`,
			);
			return { success: false, message: 'Workspace or backup repo unavailable' };
		}

		// Store commit message for later use (before try block to handle fallback case)
		let commitMessage = commit?.message ?? `Checkpoint ${commitSha.substring(0, 7)}`;

		try {
			const workspacePath = workspaceFolder.uri.fsPath;
			logger.info(`[BackupService] Workspace path: ${workspacePath}`);

			// Verify the commit SHA exists in git history (even if not in our internal list)
			// This handles cases where the extension was reloaded and _sessionCommits is empty
			if (!commit) {
				try {
					logger.info(`[BackupService] Verifying SHA exists in git: ${commitSha}`);
					await this._runGit(`cat-file -t ${commitSha}`, workspacePath);
					// SHA exists in git, we can proceed with restore
					commitMessage = `Checkpoint ${commitSha.substring(0, 7)}`;
					logger.info(`[BackupService] SHA verified in git history`);
				} catch (gitError) {
					logger.error(`[BackupService] SHA not found in git history: ${commitSha}`, gitError);
					return { success: false, message: 'Commit not found in git history' };
				}
			}

			// Get list of files changed between target commit and current working tree
			// Note: We compare with working tree (not HEAD) because HEAD in backup repo
			// may not reflect the latest changes made by the model
			logger.info(`[BackupService] Getting changed files between ${commitSha} and working tree`);
			const changedFiles = await this._runGit(`diff --name-only ${commitSha}`, workspacePath);

			logger.info(`[BackupService] Changed files: ${changedFiles.trim() || '(none)'}`);

			if (changedFiles.trim()) {
				// Restore only the changed files to the target commit state
				const files = changedFiles
					.trim()
					.split('\n')
					.filter(f => f.length > 0);
				logger.info(`[BackupService] Restoring ${files.length} files`);
				for (const file of files) {
					try {
						await this._runGit(`checkout ${commitSha} -- "${file}"`, workspacePath);
						logger.info(`[BackupService] Restored file: ${file}`);
					} catch {
						// File might have been deleted in target commit, try to remove it
						try {
							const filePath = vscode.Uri.file(`${workspacePath}/${file}`);
							await vscode.workspace.fs.delete(filePath);
							logger.info(`[BackupService] Deleted file: ${file}`);
						} catch {
							// Ignore if file doesn't exist
						}
					}
				}
			}

			// Silent operation - restore result is returned to caller
			logger.info(`[BackupService] Restore completed successfully`);
			return { success: true, message: `Restored to: ${commitMessage}` };
		} catch (error: unknown) {
			const gitError = new GitError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.GIT_OPERATION_FAILED,
				{ operation: 'restoreToCommit', commitSha },
			);
			errorService.handle(gitError, 'BackupService.restoreToCommit');
			errorService.showError(gitError);
			return { success: false, message: gitError.userMessage };
		}
	}

	/**
	 * Clear commits for the active session (backward compatible)
	 */
	public clearCommits(): void {
		if (this._activeSessionId) {
			this._sessionCommits.set(this._activeSessionId, []);
		}
	}

	private async _initializeBackupRepo(): Promise<void> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const storagePath = this._context.storageUri?.fsPath;

		if (!workspaceFolder || !storagePath) return;

		this._backupRepoPath = path.join(storagePath, 'backups', '.git');

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(this._backupRepoPath));
			const gitDir = this._backupRepoPath;
			const workTree = workspaceFolder.uri.fsPath;

			try {
				await this._runGit('rev-parse --is-inside-git-dir', workTree);
			} catch {
				await exec(`git --git-dir="${gitDir}" --work-tree="${workTree}" init`);
			}
		} catch (error) {
			const fsError = FileSystemError.fromNodeError(
				error as NodeJS.ErrnoException,
				this._backupRepoPath,
			);
			errorService.handle(fsError, 'BackupService._initializeBackupRepo');
		}
	}

	private async _runGit(
		command: string,
		workTree: string,
		options?: { config?: Record<string, string> },
	): Promise<string> {
		if (!this._backupRepoPath) {
			throw new GitError('Backup repo not initialized', ErrorCode.GIT_NOT_FOUND);
		}

		const configArgs = options?.config
			? Object.entries(options.config)
					.map(([key, value]) => `-c "${key}=${value}"`)
					.join(' ')
			: '';

		const { stdout } = await exec(
			`git --git-dir="${this._backupRepoPath}" --work-tree="${workTree}" ${configArgs} ${command}`,
		);
		return stdout;
	}

	private async _isFirstCommit(): Promise<boolean> {
		if (!this._backupRepoPath) return true;
		try {
			await exec(`git --git-dir="${this._backupRepoPath}" rev-parse HEAD`);
			return false;
		} catch {
			return true;
		}
	}

	private async _removeLockFile(): Promise<void> {
		if (!this._backupRepoPath) return;
		try {
			const lockPath = path.join(this._backupRepoPath, 'index.lock');
			await vscode.workspace.fs.delete(vscode.Uri.file(lockPath));
		} catch (error) {
			const fsError = FileSystemError.fromNodeError(
				error as NodeJS.ErrnoException,
				path.join(this._backupRepoPath, 'index.lock'),
			);
			errorService.handle(fsError, 'BackupService._removeLockFile');
		}
	}
}
