import * as vscode from 'vscode';
import { ClipboardContextService } from '../../services/ClipboardContextService';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class FileHandler implements WebviewMessageHandler {
	private readonly clipboardContextService = ClipboardContextService.getInstance();

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewMessage): Promise<void> {
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

	private async onOpenFile(msg: WebviewMessage): Promise<void> {
		const filePath = typeof msg.filePath === 'string' ? msg.filePath : undefined;
		if (!filePath) throw new Error('Missing filePath');
		await vscode.window.showTextDocument(vscode.Uri.file(filePath));
	}

	private async onOpenFileDiff(msg: WebviewMessage): Promise<void> {
		const filePath = typeof msg.filePath === 'string' ? msg.filePath : undefined;
		if (!filePath) throw new Error('Missing filePath');
		await vscode.commands.executeCommand('primecode.openFileDiff', filePath);
	}

	private async onOpenExternal(msg: WebviewMessage): Promise<void> {
		const url = typeof msg.url === 'string' ? msg.url : undefined;
		if (!url) throw new Error('Missing url');
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	private async onGetImageData(msg: WebviewMessage): Promise<void> {
		const maybeId = typeof msg.id === 'string' ? msg.id : undefined;
		const maybeName = typeof msg.name === 'string' ? msg.name : undefined;
		const requestedPath = typeof msg.path === 'string' ? msg.path : undefined;

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

		this.context.view.postMessage({
			type: 'imageData',
			id,
			name,
			path: fileUri.fsPath,
			dataUrl,
		});
	}

	private async onGetClipboardContext(msg: WebviewMessage): Promise<void> {
		const text = typeof msg.text === 'string' ? msg.text : undefined;
		if (!text) {
			this.context.view.postMessage({ type: 'clipboardContextNotFound', data: {} });
			return;
		}
		const ctx = this.clipboardContextService.getContextForText(text);
		if (!ctx) {
			this.context.view.postMessage({ type: 'clipboardContextNotFound', data: {} });
			return;
		}
		this.context.view.postMessage({ type: 'clipboardContext', data: ctx });
	}
}
