/**
 * @file VS Code API utilities - unified wrapper for webview-extension communication
 * @description Provides both singleton instance and React hook for VS Code webview API.
 * Singleton (`vscode`) is used outside React lifecycle (e.g., in message handlers).
 * Hook (`useVSCode`) provides stable references for React components to prevent
 * unnecessary re-renders. Includes localStorage fallback for state when running
 * outside VS Code environment (development mode).
 * `useSessionMessage` hook automatically attaches activeSessionId to messages.
 */

import { useCallback, useMemo } from 'react';
import type { VSCodeApi, WebviewMessage } from '../../types';
import { useChatStore } from '../store/chatStore';

// ============================================================================
// VS Code API Singleton
// ============================================================================

let vscodeApi: VSCodeApi | undefined;

/**
 * Initialize and get VS Code API instance (singleton)
 * Checks window.vscode first, then tries acquireVsCodeApi()
 */
function getVSCodeApi(): VSCodeApi | undefined {
	if (!vscodeApi && typeof window !== 'undefined') {
		if (window.vscode) {
			vscodeApi = window.vscode as VSCodeApi;
		} else if (typeof window.acquireVsCodeApi === 'function') {
			vscodeApi = window.acquireVsCodeApi();
			window.vscode = vscodeApi;
		}
	}
	return vscodeApi;
}

/**
 * VS Code API wrapper class with localStorage fallback for development
 */
class VSCodeAPIWrapper {
	constructor() {
		// Initialize API on construction
		getVSCodeApi();
	}

	/**
	 * Send message to VS Code extension
	 */
	public postMessage(message: WebviewMessage): void {
		const api = getVSCodeApi();
		if (api) {
			api.postMessage(message);
		}
	}

	/**
	 * Get persisted state (with localStorage fallback)
	 */
	public getState(): unknown {
		const api = getVSCodeApi();
		if (api) {
			return api.getState();
		}
		// Fallback for development outside VS Code
		const state = localStorage.getItem('vscodeState');
		return state ? JSON.parse(state) : undefined;
	}

	/**
	 * Set persisted state (with localStorage fallback)
	 */
	public setState<T>(newState: T): T {
		const api = getVSCodeApi();
		if (api) {
			return api.setState(newState) as T;
		}
		// Fallback for development outside VS Code
		localStorage.setItem('vscodeState', JSON.stringify(newState));
		return newState;
	}
}

/**
 * Singleton instance for use outside React components
 * Use this in event handlers, store actions, and other non-React code
 */
export const vscode = new VSCodeAPIWrapper();

// Expose on window for global access
if (typeof window !== 'undefined') {
	(window as unknown as { vscode: VSCodeAPIWrapper }).vscode = vscode;
}

// ============================================================================
// React Hook
// ============================================================================

/**
 * Post message to VS Code extension (stable function for hook)
 */
function postMessageToVSCode(type: string, data?: unknown): void {
	const api = getVSCodeApi();
	if (!api) {
		return;
	}

	// Ensure data is an object before spreading, or pass as data property
	const message =
		data && typeof data === 'object' && !Array.isArray(data) ? { type, ...data } : { type, data };

	api.postMessage(message);
}

/**
 * React hook for VS Code API with stable function references
 * Use this in React components to prevent unnecessary re-renders
 *
 * @example
 * const { postMessage } = useVSCode();
 * postMessage('openFile', { filePath: '/path/to/file' });
 */
export function useVSCode() {
	// Ensure API is initialized
	getVSCodeApi();

	// Stable postMessage reference
	const postMessage = useCallback((type: string, data?: unknown) => {
		postMessageToVSCode(type, data);
	}, []);

	// Message listener with cleanup
	const onMessage = useCallback((handler: (message: unknown) => void) => {
		const listener = (event: MessageEvent) => {
			handler(event.data);
		};
		window.addEventListener('message', listener);
		return () => window.removeEventListener('message', listener);
	}, []);

	// State accessors
	const getState = useCallback(() => vscodeApi?.getState(), []);
	const setState = useCallback((state: unknown) => vscodeApi?.setState(state), []);

	return useMemo(
		() => ({
			postMessage,
			onMessage,
			getState,
			setState,
		}),
		[postMessage, onMessage, getState, setState],
	);
}

// ============================================================================
// Session-Aware Message Hook
// ============================================================================

/**
 * React hook that automatically attaches activeSessionId to messages
 * Use this for any message that needs to be routed to a specific session
 *
 * @example
 * const { postSessionMessage } = useSessionMessage();
 * postSessionMessage('sendMessage', { text: 'Hello' });
 * // Automatically becomes: { type: 'sendMessage', text: 'Hello', sessionId: 'session-xxx' }
 */
export function useSessionMessage() {
	const activeSessionId = useChatStore(state => state.activeSessionId);

	// Post message with automatic sessionId attachment
	const postSessionMessage = useCallback(
		(type: string, data?: Record<string, unknown>) => {
			const api = getVSCodeApi();
			if (!api) {
				return;
			}

			const message = {
				type,
				...data,
				sessionId: activeSessionId,
			};

			api.postMessage(message);
		},
		[activeSessionId],
	);

	// For messages that don't need sessionId (global commands)
	const postGlobalMessage = useCallback((type: string, data?: unknown) => {
		postMessageToVSCode(type, data);
	}, []);

	return useMemo(
		() => ({
			postSessionMessage,
			postGlobalMessage,
			activeSessionId,
		}),
		[postSessionMessage, postGlobalMessage, activeSessionId],
	);
}
