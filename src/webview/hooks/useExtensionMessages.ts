/**
 * @file useExtensionMessages - hook for handling VS Code extension messages
 * @description Centralizes all message handling logic from the VS Code extension.
 *              Dispatches messages to appropriate Zustand stores (chatStore, uiStore, settingsStore).
 *
 *              High-frequency streaming events (`session_event` with `message` eventType) are
 *              coalesced via requestAnimationFrame so that multiple per-token deltas arriving
 *              between two frames are flushed as a single batched Zustand update, drastically
 *              reducing re-renders and layout thrashing during streaming.
 */

import { useEffect, useRef } from 'react';
import type { ExtensionMessage, SessionEventMessage } from '../../common';
import { useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { vscode } from '../utils/vscode';

// =============================================================================
// RAF-coalesced streaming event buffer
// =============================================================================

/**
 * Event types that arrive at very high frequency during streaming and benefit
 * from being coalesced into a single store update per animation frame.
 */
const COALESCABLE_EVENT_TYPES = new Set(['message', 'status', 'stats', 'turn_tokens']);

let pendingEvents: SessionEventMessage[] = [];
let rafId: number | null = null;

function flushPendingEvents(): void {
	rafId = null;
	const events = pendingEvents;
	pendingEvents = [];
	if (events.length === 0) return;

	// Flush all coalesced events in a single batched store update
	useChatStore.getState().actions.dispatchBatch(events);
}

function enqueueStreamingEvent(event: SessionEventMessage): void {
	pendingEvents.push(event);
	if (rafId === null) {
		rafId = requestAnimationFrame(flushPendingEvents);
	}
}

// =============================================================================
// Main Message Handler
// =============================================================================

const handleExtensionMessage = (message: ExtensionMessage): void => {
	// High-frequency streaming events → coalesce via rAF
	if (
		message.type === 'session_event' &&
		COALESCABLE_EVENT_TYPES.has((message as SessionEventMessage).eventType)
	) {
		enqueueStreamingEvent(message as SessionEventMessage);
		// Still dispatch to UI/settings stores immediately (they do light work)
		useUIStore.getState().actions.handleExtensionMessage(message);
		useSettingsStore.getState().actions.handleExtensionMessage(message);
		return;
	}

	// All other messages — dispatch synchronously as before
	useChatStore.getState().actions.handleExtensionMessage(message);
	useUIStore.getState().actions.handleExtensionMessage(message);
	useSettingsStore.getState().actions.handleExtensionMessage(message);
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
			// Request initial data only after the webview listener is installed.
			// Some extension bootstrap messages can be posted before the webview JS is
			// fully listening, so we explicitly re-request syncAll here to avoid stale
			// defaults like a false Disconnected indicator.
			vscode.postMessage({ type: 'webviewDidLaunch' });
			vscode.postMessage({ type: 'syncAll' });
			vscode.postMessage({ type: 'checkExtensionVersion' });
		}

		return () => {
			window.removeEventListener('message', handleMessage);
			// Flush any pending events on unmount so nothing is lost
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			if (pendingEvents.length > 0) {
				const events = pendingEvents;
				pendingEvents = [];
				useChatStore.getState().actions.dispatchBatch(events);
			}
		};
	}, []);
}
