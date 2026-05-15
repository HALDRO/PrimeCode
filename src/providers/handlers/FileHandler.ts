import * as vscode from 'vscode';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import { logger } from '../../utils/logger';
import { decodeFilePath, getPathBaseName, pathsReferToSameFile } from '../../utils/path';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class FileHandler implements WebviewMessageHandler {
	constructor(private context: HandlerContext) {}

	private resolveFileUri(filePath: string): vscode.Uri {
		const trimmed = decodeFilePath(filePath);
		if (/^file:\/\//i.test(trimmed)) {
			return vscode.Uri.parse(trimmed);
		}

		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const isAbsolute =
			process.platform === 'win32'
				? /^[a-zA-Z]:\\/.test(trimmed) || /^[a-zA-Z]:\//.test(trimmed)
				: trimmed.startsWith('/');

		const absolutePath =
			!isAbsolute && root ? vscode.Uri.joinPath(vscode.Uri.file(root), trimmed).fsPath : trimmed;
		return vscode.Uri.file(absolutePath);
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'openFile':
				await this.onOpenFile(msg);
				break;
			case 'openFileDiff':
				await this.onOpenFileDiff(msg);
				break;
			case 'openExternal':
				await this.onOpenExternal(msg);
				break;
			case 'getImageData':
				await this.onGetImageData(msg);
				break;
			case 'browseFiles':
				await this.onBrowseFiles(msg);
				break;
			case 'browseFolders':
				await this.onBrowseFolders(msg);
				break;
		}
	}

	private async onOpenFile(msg: CommandOf<'openFile'>): Promise<void> {
		const { filePath, line, startLine, endLine } = msg;
		logger.info(`[FileHandler] User opened file`, { filePath, line: line ?? startLine });
		let uri: vscode.Uri;
		try {
			uri = this.resolveFileUri(filePath);
		} catch {
			uri = vscode.Uri.file(filePath);
		}

		// Try direct path first, then fuzzy search by filename
		let doc: vscode.TextDocument | undefined;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch {
			// File not found at exact path — search workspace by filename
			const fileName = getPathBaseName(filePath);
			if (fileName) {
				const matches = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 5);
				if (matches.length === 1) {
					uri = matches[0];
					doc = await vscode.workspace.openTextDocument(uri);
				} else if (matches.length > 1) {
					// Multiple matches — pick the one whose path best matches the input
					const best = matches.find(m => pathsReferToSameFile(m.fsPath, filePath));
					uri = best ?? matches[0];
					doc = await vscode.workspace.openTextDocument(uri);
				}
			}
		}

		if (!doc) return;

		const start =
			typeof line === 'number' && line > 0
				? line - 1
				: typeof startLine === 'number' && startLine > 0
					? startLine - 1
					: 0;
		const end = typeof endLine === 'number' && endLine > 0 ? endLine - 1 : start;
		const selection = new vscode.Range(start, 0, end, 0);
		await vscode.window.showTextDocument(doc, { selection });
	}

	private async onOpenFileDiff(msg: CommandOf<'openFileDiff'>): Promise<void> {
		const { filePath, oldContent, newContent } = msg;
		logger.info(`[FileHandler] User opened file diff`, { filePath });
		const fileUri = this.resolveFileUri(filePath);
		const absolutePath = fileUri.fsPath;

		// If we have old/new content, show an in-memory diff directly
		if (oldContent !== undefined || newContent !== undefined) {
			const fileName = getPathBaseName(absolutePath) || 'file';
			// Keep the original extension so VS Code detects language & icon
			const ts = Date.now();
			const oldUri = vscode.Uri.from({
				scheme: 'primecode-diff',
				path: `/before/${ts}/${fileName}`,
			});
			const newUri = vscode.Uri.from({
				scheme: 'primecode-diff-new',
				path: `/after/${ts}/${fileName}`,
			});

			const oldProvider = new (class implements vscode.TextDocumentContentProvider {
				provideTextDocumentContent(): string {
					return oldContent ?? '';
				}
			})();
			const newProvider = new (class implements vscode.TextDocumentContentProvider {
				provideTextDocumentContent(): string {
					return newContent ?? '';
				}
			})();

			const disposable1 = vscode.workspace.registerTextDocumentContentProvider(
				'primecode-diff',
				oldProvider,
			);
			const disposable2 = vscode.workspace.registerTextDocumentContentProvider(
				'primecode-diff-new',
				newProvider,
			);

			await vscode.commands.executeCommand(
				'vscode.diff',
				oldUri,
				newUri,
				`${fileName} (before ↔ after)`,
			);

			// Clean up providers after a delay (documents are already loaded)
			setTimeout(() => {
				disposable1.dispose();
				disposable2.dispose();
			}, 5000);
			return;
		}

		await vscode.commands.executeCommand('primecode.openFileDiff', absolutePath, msg.line);
	}

	private async onOpenExternal(msg: CommandOf<'openExternal'>): Promise<void> {
		logger.info(`[FileHandler] User opened external URL`, { url: msg.url });
		await vscode.env.openExternal(vscode.Uri.parse(msg.url));
	}

	private async onGetImageData(msg: CommandOf<'getImageData'>): Promise<void> {
		logger.info(`[FileHandler] User requested image data`, { id: msg.id, path: msg.path });
		const maybeId = msg.id;
		const maybeName = msg.name;
		const requestedPath = msg.path;

		let fileUri: vscode.Uri | undefined;
		if (requestedPath) {
			try {
				fileUri = vscode.Uri.file(requestedPath);
			} catch {
				fileUri = undefined;
			}
		}

		if (!fileUri) {
			const pick = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: 'Attach',
				filters: {
					Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'],
				},
			});
			fileUri = pick?.[0];
		}

		if (!fileUri) {
			return; // user cancelled
		}

		const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';
		const mime =
			ext === 'png'
				? 'image/png'
				: ext === 'jpg' || ext === 'jpeg'
					? 'image/jpeg'
					: ext === 'gif'
						? 'image/gif'
						: ext === 'webp'
							? 'image/webp'
							: ext === 'bmp'
								? 'image/bmp'
								: ext === 'svg'
									? 'image/svg+xml'
									: ext === 'ico'
										? 'image/x-icon'
										: 'application/octet-stream';

		const bytes = await vscode.workspace.fs.readFile(fileUri);
		const base64 = Buffer.from(bytes).toString('base64');
		const dataUrl = `data:${mime};base64,${base64}`;

		const name = maybeName || fileUri.path.split('/').pop() || 'image';
		const id = maybeId || `img-${Date.now()}-${name}`;

		this.context.bridge.send({
			type: 'imageData',
			id,
			name,
			path: fileUri.fsPath,
			dataUrl,
			requestId: msg.requestId,
		});
	}

	private static readonly IMAGE_EXTENSIONS = new Set([
		'png',
		'jpg',
		'jpeg',
		'gif',
		'webp',
		'bmp',
		'svg',
		'ico',
	]);

	private async onBrowseFiles(msg: CommandOf<'browseFiles'>): Promise<void> {
		logger.info('[FileHandler] User opened file browser');
		const picks = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			openLabel: 'Attach',
			title: 'Attach files or images',
		});

		if (!picks || picks.length === 0) return;

		const filePaths: string[] = [];

		for (const fileUri of picks) {
			const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';

			if (FileHandler.IMAGE_EXTENSIONS.has(ext)) {
				// Treat as image — base64 encode and send imageData
				const mime =
					ext === 'png'
						? 'image/png'
						: ext === 'jpg' || ext === 'jpeg'
							? 'image/jpeg'
							: ext === 'gif'
								? 'image/gif'
								: ext === 'webp'
									? 'image/webp'
									: ext === 'bmp'
										? 'image/bmp'
										: ext === 'svg'
											? 'image/svg+xml'
											: 'image/x-icon';

				const bytes = await vscode.workspace.fs.readFile(fileUri);
				const base64 = Buffer.from(bytes).toString('base64');
				const dataUrl = `data:${mime};base64,${base64}`;
				const name = fileUri.path.split('/').pop() || 'image';
				const id = `img-${Date.now()}-${name}`;

				this.context.bridge.send({
					type: 'imageData',
					id,
					name,
					path: fileUri.fsPath,
					dataUrl,
					requestId: msg.requestId,
				});
			} else {
				// Regular file — collect path
				filePaths.push(fileUri.fsPath);
			}
		}

		if (filePaths.length > 0) {
			this.context.bridge.send({
				type: 'browsedFiles',
				paths: filePaths,
				requestId: msg.requestId,
			});
		}
	}

	private async onBrowseFolders(msg: CommandOf<'browseFolders'>): Promise<void> {
		logger.info('[FileHandler] User opened folder browser');
		const picks = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: true,
			openLabel: 'Attach',
			title: 'Attach folders',
		});

		if (!picks || picks.length === 0) return;

		this.context.bridge.send({
			type: 'browsedFiles',
			paths: picks.map(folderUri => folderUri.fsPath),
			requestId: msg.requestId,
		});
	}
}
