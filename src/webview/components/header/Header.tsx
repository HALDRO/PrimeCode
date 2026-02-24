/**
 * @file Header component - top navigation bar for PrimeCode
 * @description Compact header with session tabs, connection status indicator, and control buttons.
 * New session creation delegates entirely to the backend (via `createSession` message) which
 * creates a real session and responds with lifecycle events — no client-side draft IDs.
 */

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/cn';
import { useChatActions, useChatStore, useHistoryDropdownState, useUIActions } from '../../store';
import type { ChatState } from '../../store/chatStore';
import { useUIStore } from '../../store/uiStore';
import { proxyEventSource } from '../../utils/proxyEventSource';
import { useVSCode } from '../../utils/vscode';
import { CloseIcon, HistoryIcon, MessageIcon, PlusIcon, SettingsIcon } from '../icons';
import { Button } from '../ui';
import { HistoryDropdown } from './HistoryDropdown';

/**
 * Minimal tab data derived from store — avoids subscribing to the entire sessionsById.
 * Only session IDs are needed for tabs; the full ChatSession object is not required.
 */
interface TabInfo {
	id: string;
}

export const Header: React.FC = React.memo(() => {
	// Optimized selectors
	const { showHistoryDropdown, setShowHistoryDropdown } = useHistoryDropdownState();
	const { setActiveModal, setServerStatus } = useUIActions();
	const { postMessage } = useVSCode();
	const { switchSession, closeSession } = useChatActions();

	// PERF: Only subscribe to sessionOrder and activeSessionId — NOT sessionsById.
	// sessionsById changes on every streaming event (Immer produce), but tabs only
	// need the list of session IDs and which one is active.
	const { sessionOrder, activeSessionId } = useChatStore(
		useShallow((state: ChatState) => ({
			sessionOrder: state.sessionOrder,
			activeSessionId: state.activeSessionId,
		})),
	);
	const serverUrl = useUIStore(state => state.serverUrl);
	const serverStatus = useUIStore(state => state.serverStatus);

	const sessions: TabInfo[] = useMemo(() => sessionOrder.map(id => ({ id })), [sessionOrder]);

	// Subscribe to server events for connection status
	useEffect(() => {
		if (!serverUrl) {
			setServerStatus('disconnected');
			return;
		}

		const unsubscribe = proxyEventSource(
			`${serverUrl}/event`,
			() => {
				// Any event means we are connected
				setServerStatus('connected');
			},
			() => {
				setServerStatus('error');
			},
		);

		return () => {
			unsubscribe();
		};
	}, [serverUrl, setServerStatus]);

	const handleSwitchSession = useCallback(
		(sessionId: string) => {
			// OPTIMIZED: Wrap expensive session switch in startTransition so React
			// prioritizes keeping the UI responsive (tab click feels instant) over
			// the heavy re-render of the new message list.
			startTransition(() => {
				switchSession(sessionId);
			});
			// postMessage is async/fast, safe to keep outside transition
			postMessage({ type: 'switchSession', sessionId });
		},
		[postMessage, switchSession],
	);

	const handleCloseSession = useCallback(
		(sessionId: string) => {
			const isClosingActive = sessionId === activeSessionId;
			closeSession(sessionId);
			postMessage({ type: 'closeSession', sessionId });

			// When closing the active tab, closeSession in Zustand silently picks a new
			// activeSessionId but never notifies the backend. Without a switchSession
			// message the backend won't replay history for the newly-active session,
			// leaving the user with an empty chat.
			if (isClosingActive) {
				// Read the new activeSessionId that closeSession just set.
				const newActiveId = useChatStore.getState().activeSessionId;
				if (newActiveId) {
					startTransition(() => {
						switchSession(newActiveId);
					});
					postMessage({ type: 'switchSession', sessionId: newActiveId });
				}
			}
		},
		[activeSessionId, closeSession, postMessage, switchSession],
	);

	const handleCreateSession = useCallback(() => {
		postMessage({ type: 'createSession' });
	}, [postMessage]);

	const handleHistoryToggle = useCallback(() => {
		setShowHistoryDropdown(!showHistoryDropdown);
	}, [setShowHistoryDropdown, showHistoryDropdown]);

	const handleSettingsOpen = useCallback(() => {
		setActiveModal('settings');
	}, [setActiveModal]);

	const SessionTab: React.FC<{ sessionId: string; index: number }> = ({ sessionId, index }) => {
		const isProcessing = useChatStore(
			(state: ChatState) => state.sessionsById[sessionId]?.isProcessing ?? false,
		);
		const isActive = sessionId === activeSessionId;
		const [hasFinishedWhileInactive, setHasFinishedWhileInactive] = useState(false);
		const prevProcessingRef = useRef(isProcessing);

		useEffect(() => {
			const wasProcessing = prevProcessingRef.current;
			if (isProcessing) {
				setHasFinishedWhileInactive(false);
			}
			if (wasProcessing && !isProcessing && !isActive) {
				setHasFinishedWhileInactive(true);
			}
			prevProcessingRef.current = isProcessing;
		}, [isProcessing, isActive]);

		useEffect(() => {
			if (isActive) {
				setHasFinishedWhileInactive(false);
			}
		}, [isActive]);

		const iconColor = hasFinishedWhileInactive
			? 'text-success'
			: isActive
				? 'text-vscode-foreground'
				: 'text-vscode-descriptionForeground';
		const iconOpacity = isActive ? 'opacity-100' : 'opacity-60';
		const showAnimation = isProcessing && !isActive;

		return (
			<div
				onClick={() => handleSwitchSession(sessionId)}
				onMouseDown={e => {
					if (e.button === 1) {
						e.preventDefault();
					}
				}}
				onAuxClick={e => {
					if (e.button === 1) {
						e.preventDefault();
						handleCloseSession(sessionId);
					}
				}}
				className={cn(
					'group flex items-center h-(--tab-height) px-(--gap-2) gap-(--gap-1-5) rounded transition-all duration-150 cursor-pointer select-none border border-transparent',
					isActive
						? 'bg-(--alpha-10) text-vscode-foreground border-(--alpha-5)'
						: 'text-vscode-descriptionForeground hover:bg-(--alpha-10) hover:text-vscode-foreground',
				)}
				title={`Chat ${index + 1}`}
			>
				<MessageIcon
					size={16}
					className={cn(
						'shrink-0',
						iconColor,
						iconOpacity,
						showAnimation && 'header-tab-processing',
					)}
				/>
				<span className="text-sm font-medium shrink-0">{index + 1}</span>
				<button
					type="button"
					onClick={e => {
						e.stopPropagation();
						handleCloseSession(sessionId);
					}}
					className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center rounded transition-opacity duration-150 hover:bg-(--alpha-20)"
				>
					<CloseIcon size={16} />
				</button>
			</div>
		);
	};

	return (
		<>
			<style>{`@keyframes headerTabProcessing {
	0%, 100% { color: currentColor; }
	50% { color: var(--color-accent); }
}
.header-tab-processing { animation: headerTabProcessing 1.5s ease-in-out infinite; }`}</style>
			<header className="z-50 relative flex justify-between items-center select-none px-(--layout-padding-x) min-h-(--header-height) gap-(--gap-0-5)">
				{/* Left side - Chat Tabs (Icons only) */}
				<div className="flex items-center h-full overflow-hidden flex-1">
					<div className="flex items-center h-full max-w-full overflow-x-auto scrollbar-thin-x gap-(--gap-0-5)">
						{sessions.map((session, index) => (
							<SessionTab key={session.id} sessionId={session.id} index={index} />
						))}
					</div>
				</div>

				{/* Right side - Order: New (Plus), History, Settings */}
				<div className="flex items-center gap-(--header-gap)">
					{/* Connection Status Indicator */}
					{serverUrl && (
						<div
							className={cn(
								'w-2 h-2 rounded-full mr-2 transition-colors duration-300',
								serverStatus === 'connected'
									? 'bg-green-500'
									: serverStatus === 'error'
										? 'bg-red-500'
										: 'bg-gray-500',
							)}
							title={`OpenCode Server: ${serverStatus}`}
						/>
					)}

					<Button
						variant="icon"
						size="icon"
						onClick={handleCreateSession}
						title="New Chat"
						className="w-(--header-btn-size) h-(--header-btn-size)"
					>
						<PlusIcon size={18} />
					</Button>

					<div className="relative">
						<Button
							variant="icon"
							size="icon"
							onClick={handleHistoryToggle}
							title="History"
							className="w-(--header-btn-size) h-(--header-btn-size)"
						>
							<HistoryIcon size={18} />
						</Button>
						{showHistoryDropdown && <HistoryDropdown />}
					</div>

					<Button
						variant="icon"
						size="icon"
						onClick={handleSettingsOpen}
						title="Settings"
						className="w-(--header-btn-size) h-(--header-btn-size)"
					>
						<SettingsIcon size={16} />
					</Button>
				</div>
			</header>
		</>
	);
});
Header.displayName = 'Header';
