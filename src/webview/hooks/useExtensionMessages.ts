/**
 * @file useExtensionMessages - hook for handling VS Code extension messages
 * @description Centralizes all message handling logic from the VS Code extension.
 *              Dispatches messages to appropriate Zustand stores (chatStore, uiStore, settingsStore).
 */

import { useEffect, useRef } from 'react';
import type { ConversationIndexEntry, ExtensionMessage } from '../../common';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { vscode } from '../utils/vscode';

// =============================================================================
// Main Message Handler
// =============================================================================

const handleExtensionMessage = (message: ExtensionMessage): void => {
	// Dispatch to all stores - they will filter relevant messages internally
	useChatStore.getState().actions.handleExtensionMessage(message);
	useUIStore.getState().actions.handleExtensionMessage(message);
	useSettingsStore.getState().actions.handleExtensionMessage(message);

	// UX Optimization: When conversation list loads, pre-fetch recent sessions
	// so switching tabs feels instant/seamless.
	if (message.type === 'conversationList') {
		const list = message.data as ConversationIndexEntry[];
		if (Array.isArray(list) && list.length > 0) {
			const chatStore = useChatStore.getState();
			// Preload the top 3 most recent sessions that aren't already loaded
			const recentSessions = list.slice(0, 3);
			for (const session of recentSessions) {
				// Only load if we don't have messages for this session yet
				if (!chatStore.sessionsById[session.filename]?.messages.length) {
					// Trigger load in background
					vscode.postMessage({ type: 'loadConversation', filename: session.filename });
				}
			}
		}
	}
};

// =============================================================================
// Hook Implementation
// =============================================================================

export function useExtensionMessages(): void {
	const didSendInitialRequests = useRef(false);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			handleExtensionMessage(message);
		};

		window.addEventListener('message', handleMessage);

		if (!didSendInitialRequests.current) {
			didSendInitialRequests.current = true;
			// Request initial data from extension
			// syncAll is triggered by the extension itself after OpenCode server starts
			// (or deferred until the webview is ready), so we only need webviewDidLaunch here.
			vscode.postMessage({ type: 'webviewDidLaunch' });
			vscode.postMessage({ type: 'checkExtensionVersion' });
		}

		return () => window.removeEventListener('message', handleMessage);
	}, []);
}
