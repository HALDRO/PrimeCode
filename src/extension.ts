import * as vscode from 'vscode';
import { ServiceRegistry } from './core/ServiceRegistry';
import { ChatProvider } from './providers/ChatProvider';
import { logger } from './utils/logger';

export { logger } from './utils/logger';

let serviceRegistry: ServiceRegistry | undefined;

export function activate(context: vscode.ExtensionContext) {
	// Create output channel first for logging
	logger.initialize('PrimeCode');
	if (logger.channel) {
		context.subscriptions.push(logger.channel);
	}

	logger.info('Extension is being activated...');
	logger.info('Extension path:', context.extensionPath);
	logger.info('Extension mode:', context.extensionMode);
	logger.info('Architecture: NEW (simplified)');

	// Initialize Service Registry
	serviceRegistry = new ServiceRegistry(context);
	context.subscriptions.push(serviceRegistry);

	// Track provider for lazy initialization — shared promise prevents double-init race
	let provider: ChatProvider | undefined;
	let providerError: Error | undefined;
	let providerPromise: Promise<ChatProvider | undefined> | undefined;

	// Register command FIRST to ensure it's always available
	const disposable = vscode.commands.registerCommand(
		'primecode.openChat',
		async (_column?: vscode.ViewColumn) => {
			logger.info('openChat command executed');
			try {
				if (!provider && !providerError) {
					// Reuse in-flight promise to prevent concurrent initialization
					if (!providerPromise) {
						providerPromise = initializeProvider(context);
					}
					provider = await providerPromise;
				}
				if (provider) {
					// Reveal sidebar chat view
					await vscode.commands.executeCommand('workbench.view.extension.primecode');
				} else if (providerError) {
					vscode.window.showErrorMessage(
						`PrimeCode failed to initialize: ${providerError.message}`,
					);
				}
			} catch (error) {
				logger.error('Error in openChat command:', error);
				vscode.window.showErrorMessage(
					`PrimeCode error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
	);
	context.subscriptions.push(disposable);
	logger.info('Command primecode.openChat registered');

	// Initialize provider and other components
	async function initializeProvider(
		ctx: vscode.ExtensionContext,
	): Promise<ChatProvider | undefined> {
		try {
			// Create main chat provider (unified session_event architecture)
			logger.info('Creating ChatProvider (unified session_event)...');
			logger.info('Using unified session_event architecture');

			// Command to open file diff from chat participant
			const openFileDiffDisposable = vscode.commands.registerCommand(
				'primecode.openFileDiff',
				async (filePath: string, line?: number) => {
					try {
						logger.info('openFileDiff command executed:', filePath);
						const fileUri = vscode.Uri.file(filePath);
						const fileName = filePath.split(/[\\/]/).pop() ?? 'file';

						// Try git: URI for HEAD version. For new files (untracked/not in HEAD),
						// this will fail — just open the file directly.
						let opened = false;
						try {
							const headUri = fileUri.with({
								scheme: 'git',
								query: JSON.stringify({ path: fileUri.fsPath, ref: 'HEAD' }),
							});
							await vscode.workspace.openTextDocument(headUri);
							await vscode.commands.executeCommand(
								'vscode.diff',
								headUri,
								fileUri,
								`${fileName} (HEAD ↔ Working Tree)`,
							);
							opened = true;
						} catch {
							// New file — just open it
							await vscode.commands.executeCommand('vscode.open', fileUri);
							opened = true;
						}
						if (!opened) {
							await vscode.commands.executeCommand('vscode.open', fileUri);
						}

						// Scroll to the first changed line if provided
						if (line !== undefined) {
							setTimeout(() => {
								const editor = vscode.window.activeTextEditor;
								if (editor) {
									const pos = new vscode.Position(Math.max(0, line - 1), 0);
									editor.selection = new vscode.Selection(pos, pos);
									editor.revealRange(
										new vscode.Range(pos, pos),
										vscode.TextEditorRevealType.InCenter,
									);
								}
							}, 300);
						}
					} catch (error) {
						logger.error('Error opening diff:', error);
						await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
					}
				},
			);

			// Command to add selection to prompt
			const addSelectionDisposable = vscode.commands.registerCommand(
				'primecode.addSelectionToPrompt',
				async () => {
					const editor = vscode.window.activeTextEditor;
					if (!editor) {
						vscode.window.showInformationMessage('PrimeCode: No active editor selection.');
						return;
					}

					const selection = editor.selection;
					const text = editor.document.getText(selection);

					if (!text.trim()) {
						vscode.window.showInformationMessage('PrimeCode: Selection is empty.');
						return;
					}

					const document = editor.document;
					// Resolve relative path
					const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
					const relPath = workspaceFolder
						? vscode.workspace.asRelativePath(document.uri)
						: document.uri.fsPath;

					// Format the selection as a block with file context
					const formattedSelection = `\n\n\`\`\`${document.languageId}:${relPath}\n${text}\n\`\`\`\n\n`;

					// Ensure chat is open
					await vscode.commands.executeCommand('primecode.openChat');

					// Send to webview
					if (provider) {
						provider.postMessage({
							type: 'editorSelection',
							data: {
								text: formattedSelection,
								fileName: relPath,
							},
						});
					}
				},
			);

			// Register webview view provider for sidebar chat
			logger.info('Registering WebviewViewProvider...');

			if (!serviceRegistry) {
				throw new Error('ServiceRegistry not initialized');
			}

			const webviewProvider = new ChatProvider(ctx, serviceRegistry);
			const webviewProviderDisposable = vscode.window.registerWebviewViewProvider(
				'primecode.chat',
				webviewProvider,
				{ webviewOptions: { retainContextWhenHidden: true } },
			);
			logger.info('WebviewViewProvider registered');

			ctx.subscriptions.push(
				openFileDiffDisposable,
				addSelectionDisposable,
				webviewProviderDisposable,
				webviewProvider,
			);

			logger.info('Provider initialization completed successfully!');
			return webviewProvider;
		} catch (error) {
			logger.error('Provider initialization failed:', error);
			providerError = error instanceof Error ? error : new Error(String(error));
			return undefined;
		}
	}

	// Try to initialize provider eagerly but don't block activation
	// Reuse shared promise so openChat command awaits the same initialization
	providerPromise = initializeProvider(context);
	providerPromise
		.then(p => {
			provider = p;
			if (p) {
				// Create status bar item only after successful initialization
				const statusBarItem = vscode.window.createStatusBarItem(
					vscode.StatusBarAlignment.Right,
					100,
				);
				statusBarItem.text = 'PrimeCode';
				statusBarItem.tooltip = 'Open PrimeCode';
				statusBarItem.command = 'primecode.openChat';
				statusBarItem.show();
				context.subscriptions.push(statusBarItem);
				logger.info('Extension activation completed successfully!');
			}
		})
		.catch(error => {
			logger.error('Async provider initialization failed:', error);
			providerError = error instanceof Error ? error : new Error(String(error));
		});
}

export async function deactivate(): Promise<void> {
	logger.info('Extension is being deactivated');
}
