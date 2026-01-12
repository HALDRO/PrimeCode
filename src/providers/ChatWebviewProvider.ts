import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import type { ChatProvider } from './ChatProvider';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
	constructor(
		private readonly _extensionUri: vscode.Uri,
		readonly _context: vscode.ExtensionContext,
		private readonly _chatProvider: ChatProvider,
	) {
		logger.info('ChatWebviewProvider constructor called');
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		logger.info('resolveWebviewView called');
		logger.info('Extension URI:', this._extensionUri.toString());

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this._extensionUri,
				vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
			],
		};
		logger.info('Webview options set, localResourceRoots:', this._extensionUri.toString());

		// Use the shared chat provider instance for the sidebar
		logger.info('Calling showInWebview...');
		this._chatProvider.showInWebview(webviewView.webview, webviewView);
		logger.info('showInWebview completed');

		// Handle visibility changes to reinitialize when sidebar reopens
		webviewView.onDidChangeVisibility(() => {
			logger.info('Webview visibility changed, visible:', webviewView.visible);
			if (webviewView.visible) {
				// Close main panel when sidebar becomes visible
				if (this._chatProvider.panel) {
					logger.info('Closing main panel because sidebar became visible');
					this._chatProvider.panel.dispose();
				}
				this._chatProvider.reinitializeWebview();
			} else {
				// Mark as disposed when sidebar becomes hidden to prevent
				// async operations from trying to post messages to hidden webview
				this._chatProvider.setDisposed(true);
			}
		});

		// Handle webview disposal (when sidebar is completely closed/destroyed)
		webviewView.onDidDispose(() => {
			logger.info('WebviewView disposed');
			this._chatProvider.setDisposed(true);
		});
	}
}
