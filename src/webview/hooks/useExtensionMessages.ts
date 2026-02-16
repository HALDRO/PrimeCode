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
			// syncAll is triggered by the extension itself after OpenCode server starts
			// (or deferred until the webview is ready), so we only need webviewDidLaunch here.
			vscode.postMessage({ type: 'webviewDidLaunch' });
		}

		return () => window.removeEventListener('message', handleMessage);
	}, []);
}
