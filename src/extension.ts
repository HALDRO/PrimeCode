import * as vscode from 'vscode';
import { ServiceRegistry } from './core/ServiceRegistry';
import { ChatProvider } from './providers/ChatProvider';
import { ClipboardContextService } from './services/ClipboardContextService';
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

	// Track provider for lazy initialization
	let provider: ChatProvider | undefined;
	let providerError: Error | undefined;

	// Register command FIRST to ensure it's always available
	const disposable = vscode.commands.registerCommand(
		'primecode.openChat',
		async (_column?: vscode.ViewColumn) => {
			logger.info('openChat command executed');
			try {
				if (!provider && !providerError) {
					// Lazy initialize provider on first command execution
					provider = await initializeProvider(context);
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
			// Initialize clipboard context service for tracking copy events
			const clipboardContextService = ClipboardContextService.getInstance();
			ctx.subscriptions.push(clipboardContextService);

			// Create main chat provider (unified session_event architecture)
			logger.info('Creating ChatProvider (unified session_event)...');
			logger.info('Using unified session_event architecture');

			const loadConversationDisposable = vscode.commands.registerCommand(
				'primecode.loadConversation',
				(filename: string) => {
					logger.info('loadConversation command executed:', filename);
					vscode.window.showWarningMessage(
						'Conversation history is not available in the unified session_event architecture yet.',
					);
				},
			);

			// Command to open file diff from chat participant
			const openFileDiffDisposable = vscode.commands.registerCommand(
				'primecode.openFileDiff',
				async (filePath: string) => {
					try {
						logger.info('openFileDiff command executed:', filePath);
						const uri = vscode.Uri.file(filePath);
						const gitExtension = vscode.extensions.getExtension('vscode.git');
						if (gitExtension?.isActive) {
							await vscode.commands.executeCommand('git.openChange', uri);
						} else {
							await vscode.commands.executeCommand('vscode.open', uri);
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
				loadConversationDisposable,
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
	initializeProvider(context)
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

	// Show output channel to make it visible
	logger.show(true);
}

export async function deactivate(): Promise<void> {
	logger.info('Extension is being deactivated');
}
