/**
 * @file ClipboardContextService - tracks copy events from VS Code editor
 * @description Intercepts clipboard copy command to capture source file context (path, line numbers).
 *              Stores the last copied context in memory for use when pasting into webview.
 *              This workaround is needed because webview cannot access vscode-editor-data from clipboard.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export interface ClipboardContext {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
	timestamp: number;
}

/**
 * Service that tracks copy events from VS Code editor and stores context
 */
export class ClipboardContextService implements vscode.Disposable {
	private static _instance: ClipboardContextService | null = null;
	private _lastContext: ClipboardContext | null = null;
	private _disposables: vscode.Disposable[] = [];
	private _isIntercepting = false;

	private constructor() {
		this._registerCopyInterceptor();
	}

	public static getInstance(): ClipboardContextService {
		if (!ClipboardContextService._instance) {
			ClipboardContextService._instance = new ClipboardContextService();
		}
		return ClipboardContextService._instance;
	}

	/**
	 * Get the last copied context if it's still valid (within 30 seconds)
	 */
	public getLastContext(): ClipboardContext | null {
		if (!this._lastContext) return null;

		// Context expires after 30 seconds
		const MAX_AGE_MS = 30000;
		if (Date.now() - this._lastContext.timestamp > MAX_AGE_MS) {
			this._lastContext = null;
			return null;
		}

		return this._lastContext;
	}

	/**
	 * Check if the given text matches the last copied content
	 */
	public getContextForText(text: string): ClipboardContext | null {
		const context = this.getLastContext();
		if (!context) {
			logger.debug('[ClipboardContextService] No context available');
			return null;
		}

		// Normalize line endings for comparison
		const normalizedPasted = text.replace(/\r\n/g, '\n').trim();
		const normalizedStored = context.content.replace(/\r\n/g, '\n').trim();

		logger.debug(
			'[ClipboardContextService] Comparing texts:',
			`pasted length=${normalizedPasted.length}, stored length=${normalizedStored.length}`,
		);

		// Check if the pasted text matches the stored content
		if (normalizedStored === normalizedPasted) {
			logger.debug('[ClipboardContextService] Text match found!');
			return context;
		}

		// Also check if pasted text is contained in stored (partial paste)
		// or stored is contained in pasted (extra whitespace added)
		if (
			normalizedStored.includes(normalizedPasted) ||
			normalizedPasted.includes(normalizedStored)
		) {
			logger.debug('[ClipboardContextService] Partial text match found');
			return context;
		}

		logger.debug('[ClipboardContextService] No text match');
		return null;
	}

	/**
	 * Clear the stored context
	 */
	public clearContext(): void {
		this._lastContext = null;
	}

	private _registerCopyInterceptor(): void {
		// Intercept the copy command to capture context
		const copyDisposable = vscode.commands.registerCommand(
			'editor.action.clipboardCopyAction',
			async () => {
				// Prevent recursion
				if (this._isIntercepting) {
					return;
				}

				try {
					this._isIntercepting = true;

					// Capture context before copy
					const editor = vscode.window.activeTextEditor;
					if (editor && !editor.selection.isEmpty) {
						const document = editor.document;
						const selection = editor.selection;
						const content = document.getText(selection);

						this._lastContext = {
							filePath: vscode.workspace.asRelativePath(document.uri, false),
							startLine: selection.start.line + 1,
							endLine: selection.end.line + 1,
							content,
							timestamp: Date.now(),
						};

						logger.debug(
							'[ClipboardContextService] Captured copy context:',
							this._lastContext.filePath,
							`lines ${this._lastContext.startLine}-${this._lastContext.endLine}`,
						);
					}

					// Unregister temporarily to execute original command
					copyDisposable.dispose();

					// Execute the original copy command
					await vscode.commands.executeCommand('editor.action.clipboardCopyAction');

					// Re-register the interceptor after a small delay to ensure command completes
					setTimeout(() => {
						this._disposables = this._disposables.filter(d => d !== copyDisposable);
						this._registerCopyInterceptor();
					}, 10);
				} catch (error) {
					logger.error('[ClipboardContextService] Error intercepting copy:', error);
				} finally {
					this._isIntercepting = false;
				}
			},
		);

		this._disposables.push(copyDisposable);
	}

	public dispose(): void {
		for (const disposable of this._disposables) {
			disposable.dispose();
		}
		this._disposables = [];
		ClipboardContextService._instance = null;
	}
}
