/**
 * @file useExtensionMessages - hook for handling VS Code extension messages
 * @description Centralizes all message handling logic from the VS Code extension.
 *              Dispatches messages to appropriate Zustand stores (chatStore, uiStore, settingsStore).
 */

import { useEffect } from 'react';
import type { ExtensionMessage } from '../../common';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { vscode } from '../utils/vscode';

let didSendInitialRequests = false;

// =============================================================================
// Main Message Handler
// =============================================================================

const handleExtensionMessage = (message: ExtensionMessage): void => {
	// Dispatch to all stores - they will filter relevant messages internally
	useChatStore.getState().actions.handleExtensionMessage(message);
	useUIStore.getState().actions.handleExtensionMessage(message);
	useSettingsStore.getState().actions.handleExtensionMessage(message);
};

// =============================================================================
// Hook Implementation
// =============================================================================

export function useExtensionMessages(): void {
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			handleExtensionMessage(message);
		};

		window.addEventListener('message', handleMessage);

		if (!didSendInitialRequests) {
			didSendInitialRequests = true;
			// Request initial data from extension
			vscode.postMessage({ type: 'webviewDidLaunch' });
			vscode.postMessage({ type: 'getSettings' });
			vscode.postMessage({ type: 'getAccess' });
			vscode.postMessage({ type: 'getCommands' });
			vscode.postMessage({ type: 'getSkills' });
			vscode.postMessage({ type: 'getHooks' });
			vscode.postMessage({ type: 'getSubagents' });
			vscode.postMessage({ type: 'loadMCPServers' });
			vscode.postMessage({ type: 'fetchMcpMarketplaceCatalog', data: { forceRefresh: false } });
			vscode.postMessage({ type: 'loadProxyModels', data: { baseUrl: '' } });
			vscode.postMessage({ type: 'checkOpenCodeStatus' });
			vscode.postMessage({ type: 'reloadAllProviders' });
			vscode.postMessage({ type: 'checkDiscoveryStatus' });
			vscode.postMessage({ type: 'getRules' });
		}

		return () => window.removeEventListener('message', handleMessage);
	}, []);
}
