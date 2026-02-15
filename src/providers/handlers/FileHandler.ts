import * as vscode from 'vscode';
import type { CommandOf, WebviewCommand } from '../../common/protocol';
import { ClipboardContextService } from '../../services/ClipboardContextService';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class FileHandler implements WebviewMessageHandler {
	private readonly clipboardContextService = ClipboardContextService.getInstance();

	constructor(private context: HandlerContext) {}

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
			case 'getClipboardContext':
				await this.onGetClipboardContext(msg);
				break;
		}
	}

	private async onOpenFile(msg: CommandOf<'openFile'>): Promise<void> {
		const { filePath } = msg;

		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const isAbsolute =
			process.platform === 'win32'
				? /^[a-zA-Z]:\\/.test(filePath) || /^[a-zA-Z]:\//.test(filePath)
				: filePath.startsWith('/');

		const absolutePath =
			!isAbsolute && root ? vscode.Uri.joinPath(vscode.Uri.file(root), filePath).fsPath : filePath;

		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.file(absolutePath);
		} catch {
			// Fallback if formatting fails
			uri = vscode.Uri.file(filePath);
		}

		await vscode.window.showTextDocument(uri);
	}

	private async onOpenFileDiff(msg: CommandOf<'openFileDiff'>): Promise<void> {
		const { filePath, oldContent, newContent } = msg;

		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const isAbsolute =
			process.platform === 'win32'
				? /^[a-zA-Z]:\\/.test(filePath) || /^[a-zA-Z]:\//.test(filePath)
				: filePath.startsWith('/');

		const absolutePath =
			!isAbsolute && root ? vscode.Uri.joinPath(vscode.Uri.file(root), filePath).fsPath : filePath;

		// If we have old/new content, show an in-memory diff directly
		if (oldContent !== undefined || newContent !== undefined) {
			const fileName = absolutePath.split(/[\\/]/).pop() ?? 'file';
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

		await vscode.commands.executeCommand('primecode.openFileDiff', absolutePath);
	}

	private async onOpenExternal(msg: CommandOf<'openExternal'>): Promise<void> {
		await vscode.env.openExternal(vscode.Uri.parse(msg.url));
	}

	private async onGetImageData(msg: CommandOf<'getImageData'>): Promise<void> {
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
		});
	}

	private async onGetClipboardContext(msg: CommandOf<'getClipboardContext'>): Promise<void> {
		const { text } = msg;
		if (!text) {
			this.context.bridge.send({ type: 'clipboardContextNotFound', text: '' });
			return;
		}
		const ctx = this.clipboardContextService.getContextForText(text);
		if (!ctx) {
			this.context.bridge.send({ type: 'clipboardContextNotFound', text });
			return;
		}
		this.context.bridge.send({ type: 'clipboardContext', ...ctx });
	}
}
