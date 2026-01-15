import * as vscode from 'vscode';
import { ChatProvider } from './providers/ChatProvider';
import { ChatWebviewProvider } from './providers/ChatWebviewProvider';
import { ClipboardContextService } from './services/ClipboardContextService';
import { OpenCodeServerManager } from './services/cli/opencode/OpenCodeServerManager';
import { cleanupDiffCache, getDiffContent } from './utils/diffCache';
import { logger } from './utils/logger';

export { cacheDiffContent } from './utils/diffCache';
export { logger } from './utils/logger';

export function activate(context: vscode.ExtensionContext) {
	// Create output channel first for logging
	logger.initialize('PrimeCode');
	if (logger.channel) {
		context.subscriptions.push(logger.channel);
	}

	logger.info('Extension is being activated...');
	logger.info('Extension path:', context.extensionPath);
	logger.info('Extension mode:', context.extensionMode);

	// Track provider for lazy initialization
	let provider: ChatProvider | undefined;
	let providerError: Error | undefined;

	// Register command FIRST to ensure it's always available
	const disposable = vscode.commands.registerCommand(
		'primecode.openChat',
		async (column?: vscode.ViewColumn) => {
			logger.info('openChat command executed');
			try {
				if (!provider && !providerError) {
					// Lazy initialize provider on first command execution
					provider = await initializeProvider(context);
				}
				if (provider) {
					provider.show(column);
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
			// Clean up orphaned OpenCode processes from previous sessions
			await OpenCodeServerManager.cleanUpOrphans();

			// Initialize clipboard context service for tracking copy events
			const clipboardContextService = ClipboardContextService.getInstance();
			ctx.subscriptions.push(clipboardContextService);

			// Create main chat provider
			logger.info('Creating ChatProvider...');
			const newProvider = new ChatProvider(ctx.extensionUri, ctx);
			logger.info('ChatProvider created');

			const loadConversationDisposable = vscode.commands.registerCommand(
				'primecode.loadConversation',
				(filename: string) => {
					logger.info('loadConversation command executed:', filename);
					newProvider.loadConversation(filename);
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

			// Register TextDocumentContentProvider for virtual diff documents
			// Uses cache-based approach instead of query-string to avoid encoding issues
			const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
				provideTextDocumentContent(uri: vscode.Uri): string {
					return getDiffContent(uri);
				}
			})();
			const diffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
				'prime-diff',
				diffContentProvider,
			);

			// Periodically cleanup diff cache
			const cacheCleanupInterval = setInterval(cleanupDiffCache, 60000);
			ctx.subscriptions.push({ dispose: () => clearInterval(cacheCleanupInterval) });

			// Register webview view provider for sidebar chat (using shared provider instance)
			logger.info('Registering WebviewViewProvider...');
			const webviewProvider = new ChatWebviewProvider(ctx.extensionUri, ctx, newProvider);
			const webviewProviderDisposable = vscode.window.registerWebviewViewProvider(
				'primecode.chat',
				webviewProvider,
			);
			logger.info('WebviewViewProvider registered');

			ctx.subscriptions.push(
				loadConversationDisposable,
				openFileDiffDisposable,
				diffProviderDisposable,
				webviewProviderDisposable,
			);

			logger.info('Provider initialization completed successfully!');
			return newProvider;
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

	// Dispose CLI services to stop OpenCode/Claude processes
	try {
		const { CLIServiceFactory } = await import('./services/CLIServiceFactory.js');
		await CLIServiceFactory.dispose();
		logger.info('CLI services disposed successfully');
	} catch (error) {
		logger.error('Failed to dispose CLI services:', error);
	}
}
