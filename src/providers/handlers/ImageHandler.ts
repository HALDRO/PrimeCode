/**
 * @file ImageHandler
 * @description Handles image operations: selection, reading, conversion to base64, and temp storage.
 * Uses Dependency Injection pattern for postMessage to maintain consistency with other handlers.
 */

import * as vscode from 'vscode';
import { errorService, FileSystemError } from '../../services/ErrorService';
import type { FileService } from '../../services/FileService';
import { PATHS } from '../../shared/constants';

// =============================================================================
// Types
// =============================================================================

export interface ImageHandlerDeps {
	postMessage: (msg: unknown) => void;
}

interface ImageAttachment {
	id?: string;
	name: string;
	dataUrl: string;
	path?: string;
}

const MIME_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
};

// =============================================================================
// ImageHandler Class
// =============================================================================

export class ImageHandler {
	constructor(
		private readonly _fileService: FileService,
		private readonly _deps: ImageHandlerDeps,
	) {}

	public async selectImageFile(): Promise<void> {
		const filePaths = await this._fileService.selectImageFiles();
		for (const path of filePaths) {
			this._deps.postMessage({ type: 'imagePath', path });
		}
	}

	public async getImageData(filePath: string, id?: string, name?: string): Promise<void> {
		try {
			const absolutePath = this._fileService.resolveFilePath(filePath);
			const uri = vscode.Uri.file(absolutePath);
			const fileData = await vscode.workspace.fs.readFile(uri);

			const ext = filePath.toLowerCase().split('.').pop() || 'png';
			const mimeType = MIME_TYPES[ext] || 'image/png';

			const base64 = Buffer.from(fileData).toString('base64');
			const dataUrl = `data:${mimeType};base64,${base64}`;

			this._deps.postMessage({
				type: 'imageData',
				dataUrl,
				path: filePath,
				id: id || `img-${Date.now()}`,
				name: name || filePath.split(/[/\\]/).pop() || 'image',
			});
		} catch (error) {
			const fsError = FileSystemError.fromNodeError(error as NodeJS.ErrnoException, filePath);
			errorService.handle(fsError, 'ImageHandler.getImageData');
		}
	}

	public async saveImagesToTemp(images: ImageAttachment[]): Promise<string[]> {
		const paths: string[] = [];
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) return paths;

		const tempDir = vscode.Uri.joinPath(workspaceFolder.uri, ...PATHS.AGENTS_TEMP.split('/'));
		try {
			await vscode.workspace.fs.createDirectory(tempDir);
		} catch {
			// Directory might already exist
		}

		for (const image of images) {
			try {
				if (image.path) {
					paths.push(image.path);
					continue;
				}

				const matches = image.dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
				if (!matches) continue;

				const [, ext, base64Data] = matches;
				const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
				const filePath = vscode.Uri.joinPath(tempDir, fileName);

				const buffer = Buffer.from(base64Data, 'base64');
				await vscode.workspace.fs.writeFile(filePath, buffer);

				paths.push(`${PATHS.AGENTS_TEMP}/${fileName}`);
			} catch (error) {
				const fsError = FileSystemError.fromNodeError(error as NodeJS.ErrnoException, image.name);
				errorService.handle(fsError, 'ImageHandler.saveImagesToTemp');
			}
		}

		return paths;
	}

	public async createImageFile(imageData: string, imageType: string): Promise<void> {
		const filePath = await this._fileService.createImageFile(imageData, imageType);
		if (filePath) {
			this._deps.postMessage({ type: 'imagePath', data: { filePath } });
		}
	}
}
