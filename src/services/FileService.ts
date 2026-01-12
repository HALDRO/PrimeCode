/**
 * @file File operations service for workspace file management
 * @description Provides file search, selection, reading, and creation utilities.
 * Handles image file operations and clipboard access.
 * Integrates with ErrorService for centralized error handling.
 */

import * as vscode from 'vscode';
import { EXCLUDE_PATTERNS, PATHS } from '../shared/constants';
import type { WorkspaceFile } from '../types';
import { ErrorCode, errorService, FileSystemError } from './ErrorService';

// =============================================================================
// FileService Class
// =============================================================================

export class FileService {
	public async getWorkspaceFiles(searchTerm?: string): Promise<WorkspaceFile[]> {
		try {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			if (!workspaceFolders?.length) {
				return [];
			}

			const term = searchTerm?.trim();

			let files: vscode.Uri[] = [];

			if (term && term.length >= 2) {
				try {
					files = await vscode.workspace.findFiles(
						`**/*${term}*`,
						EXCLUDE_PATTERNS.VSCODE_GLOB,
						200,
					);
				} catch (error) {
					this._handleError(error, 'FileService.getWorkspaceFiles.search');
				}
			}

			if (files.length === 0) {
				try {
					files = await vscode.workspace.findFiles('**/*', EXCLUDE_PATTERNS.VSCODE_GLOB, 1000);
				} catch (error) {
					this._handleError(error, 'FileService.getWorkspaceFiles.findAll');
					return [];
				}
			}

			return this._processFiles(files, term);
		} catch (error) {
			this._handleError(error, 'FileService.getWorkspaceFiles');
			return [];
		}
	}

	public async selectImageFiles(): Promise<string[]> {
		try {
			const result = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: true,
				title: 'Select image files',
				filters: {
					Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'],
				},
			});

			return result ? result.map(uri => uri.fsPath) : [];
		} catch (error) {
			this._handleError(error, 'FileService.selectImageFiles');
			return [];
		}
	}

	/**
	 * Opens a file in the editor, optionally revealing specific lines.
	 * @param filePath - Absolute or workspace-relative path to the file
	 * @param startLine - Optional 1-based start line to reveal and select
	 * @param endLine - Optional 1-based end line for selection range
	 */
	public async openFileInEditor(
		filePath: string,
		startLine?: number,
		endLine?: number,
	): Promise<void> {
		try {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);

			// If line numbers provided, reveal and select the range
			if (startLine !== undefined && startLine > 0) {
				const start = new vscode.Position(startLine - 1, 0); // Convert to 0-based
				const end = new vscode.Position(
					(endLine ?? startLine) - 1,
					document.lineAt((endLine ?? startLine) - 1).text.length,
				);
				const range = new vscode.Range(start, end);

				editor.selection = new vscode.Selection(start, end);
				editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
			}
		} catch (error) {
			const fsError = new FileSystemError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.FS_FILE_NOT_FOUND,
				{ path: filePath },
			);
			errorService.handle(fsError, 'FileService.openFileInEditor');
			errorService.showError(fsError);
		}
	}

	public async createImageFile(imageData: string, imageType: string): Promise<string | undefined> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) return undefined;

		try {
			const base64Data = imageData.split(',')[1];
			const buffer = Buffer.from(base64Data, 'base64');
			const extension = imageType.split('/')[1] || 'png';
			const fileName = `image_${Date.now()}.${extension}`;

			const imagesDir = vscode.Uri.joinPath(workspaceFolder.uri, ...PATHS.AGENTS_IMAGES.split('/'));

			await vscode.workspace.fs.createDirectory(imagesDir);
			await this._ensureGitIgnore(imagesDir);

			const imagePath = vscode.Uri.joinPath(imagesDir, fileName);
			await vscode.workspace.fs.writeFile(imagePath, buffer);

			return imagePath.fsPath;
		} catch (error) {
			const fsError = new FileSystemError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.FS_WRITE_ERROR,
				{ imageType },
			);
			errorService.handle(fsError, 'FileService.createImageFile');
			errorService.showError(fsError);
			return undefined;
		}
	}

	public resolveFilePath(filePath: string): string {
		if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath)) {
			return filePath;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (workspaceRoot) {
			return vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), filePath).fsPath;
		}
		return filePath;
	}

	public async getClipboardText(): Promise<string> {
		try {
			return await vscode.env.clipboard.readText();
		} catch (error) {
			errorService.handle(errorService.normalize(error), 'FileService.getClipboardText');
			return '';
		}
	}

	/**
	 * Ensures a directory exists, creating it if necessary
	 */
	public async ensureDirectoryExists(dirPath: string): Promise<void> {
		try {
			const uri = vscode.Uri.file(dirPath);
			await vscode.workspace.fs.createDirectory(uri);
		} catch (error) {
			// Directory might already exist, which is fine
			if ((error as { code?: string }).code !== 'FileExists') {
				this._handleError(error, 'FileService.ensureDirectoryExists');
			}
		}
	}

	/**
	 * Checks if a directory exists
	 */
	public async directoryExists(dirPath: string): Promise<boolean> {
		try {
			const uri = vscode.Uri.file(dirPath);
			const stat = await vscode.workspace.fs.stat(uri);
			return stat.type === vscode.FileType.Directory;
		} catch {
			return false;
		}
	}

	/**
	 * Checks if a file exists
	 */
	public async fileExists(filePath: string): Promise<boolean> {
		try {
			const uri = vscode.Uri.file(filePath);
			const stat = await vscode.workspace.fs.stat(uri);
			return stat.type === vscode.FileType.File;
		} catch {
			return false;
		}
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private _handleError(error: unknown, context: string): void {
		const fsError = FileSystemError.fromNodeError(error as NodeJS.ErrnoException);
		errorService.handle(fsError, context);
	}

	private async _ensureGitIgnore(dir: vscode.Uri): Promise<void> {
		const gitignorePath = vscode.Uri.joinPath(dir, '.gitignore');
		try {
			await vscode.workspace.fs.stat(gitignorePath);
		} catch {
			await vscode.workspace.fs.writeFile(gitignorePath, new TextEncoder().encode('*\n'));
		}
	}

	private _processFiles(files: vscode.Uri[], term?: string): WorkspaceFile[] {
		const normalizedTerm = term?.toLowerCase();
		const fileList: WorkspaceFile[] = [];
		const seenPaths = new Set<string>();

		for (const file of files) {
			const relativePath = vscode.workspace.asRelativePath(file);

			if (seenPaths.has(relativePath)) continue;
			seenPaths.add(relativePath);

			const name = file.path.split('/').pop() || '';

			if (name.startsWith('.') && !normalizedTerm?.startsWith('.')) {
				continue;
			}

			if (normalizedTerm) {
				const filePath = relativePath.toLowerCase();
				const nameLower = name.toLowerCase();

				if (!nameLower.includes(normalizedTerm) && !filePath.includes(normalizedTerm)) {
					continue;
				}
			}

			fileList.push({
				name,
				path: relativePath,
				fsPath: file.fsPath,
			});
		}

		return fileList.sort((a, b) => this._sortFiles(a, b, normalizedTerm)).slice(0, 50);
	}

	private _sortFiles(a: WorkspaceFile, b: WorkspaceFile, term?: string): number {
		if (term) {
			const aName = a.name.toLowerCase();
			const bName = b.name.toLowerCase();

			const aExact = aName === term;
			const bExact = bName === term;
			if (aExact && !bExact) return -1;
			if (!aExact && bExact) return 1;

			const aStarts = aName.startsWith(term);
			const bStarts = bName.startsWith(term);
			if (aStarts && !bStarts) return -1;
			if (!aStarts && bStarts) return 1;

			const aContains = aName.includes(term);
			const bContains = bName.includes(term);
			if (aContains && !bContains) return -1;
			if (!aContains && bContains) return 1;
		}

		return a.name.length - b.name.length || a.name.localeCompare(b.name);
	}
}
