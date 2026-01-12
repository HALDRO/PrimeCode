import * as vscode from 'vscode';
import { ChatProvider } from './providers/ChatProvider';
import { ChatWebviewProvider } from './providers/ChatWebviewProvider';
import { ClipboardContextService } from './services/ClipboardContextService';
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

	try {
		// Initialize clipboard context service for tracking copy events
		const clipboardContextService = ClipboardContextService.getInstance();
		context.subscriptions.push(clipboardContextService);

		// Create main chat provider
		logger.info('Creating ChatProvider...');
		const provider = new ChatProvider(context.extensionUri, context);
		logger.info('ChatProvider created');

		const disposable = vscode.commands.registerCommand(
			'primecode.openChat',
			(column?: vscode.ViewColumn) => {
				logger.info('openChat command executed');
				provider.show(column);
			},
		);

		const loadConversationDisposable = vscode.commands.registerCommand(
			'primecode.loadConversation',
			(filename: string) => {
				logger.info('loadConversation command executed:', filename);
				provider.loadConversation(filename);
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
		context.subscriptions.push({ dispose: () => clearInterval(cacheCleanupInterval) });

		// Register webview view provider for sidebar chat (using shared provider instance)
		logger.info('Registering WebviewViewProvider...');
		const webviewProvider = new ChatWebviewProvider(context.extensionUri, context, provider);
		const webviewProviderDisposable = vscode.window.registerWebviewViewProvider(
			'primecode.chat',
			webviewProvider,
		);
		logger.info('WebviewViewProvider registered');

		// Create status bar item
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		statusBarItem.text = 'PrimeCode';
		statusBarItem.tooltip = 'Open PrimeCode';
		statusBarItem.command = 'primecode.openChat';
		statusBarItem.show();

		context.subscriptions.push(
			disposable,
			loadConversationDisposable,
			openFileDiffDisposable,
			diffProviderDisposable,
			webviewProviderDisposable,
			statusBarItem,
		);

		logger.info('Extension activation completed successfully!');

		// Show output channel to make it visible
		logger.show(true);
	} catch (error) {
		logger.error('Extension activation failed:', error);
		throw error;
	}
}

export function deactivate() {
	logger.info('Extension is being deactivated');
}
