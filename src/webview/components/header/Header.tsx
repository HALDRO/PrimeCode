/**
 * @file Header component - top navigation bar for PrimeCode
 * @description Compact header with consistent button styling. Contains title,
 * workspace info badge, and control buttons.
 * Session-specific data (changedFiles, restoreCommits) is now managed per-session
 * in chatStore, so no manual clearing is needed on session switch.
 */

import React, { useCallback, useMemo } from 'react';
import { cn } from '../../lib/cn';
import {
	type ChatSession,
	useChatActions,
	useChatStore,
	useHistoryDropdownState,
	useUIActions,
} from '../../store';
import { useVSCode } from '../../utils/vscode';
import { CloseIcon, FileIcon, HistoryIcon, PlusIcon, SettingsIcon } from '../icons';
import { Button } from '../ui';
import { HistoryDropdown } from './HistoryDropdown';

export const Header: React.FC = React.memo(() => {
	// Optimized selectors
	const { showHistoryDropdown, setShowHistoryDropdown } = useHistoryDropdownState();
	const { setActiveModal } = useUIActions();
	const { postMessage } = useVSCode();
	const { switchSession, closeSession } = useChatActions();
	const { sessionsById, sessionOrder, activeSessionId } = useChatStore();
	const sessions = useMemo(
		() => sessionOrder.map(id => sessionsById[id]).filter((s): s is ChatSession => !!s),
		[sessionOrder, sessionsById],
	);

	const handleSwitchSession = useCallback(
		(sessionId: string) => {
			// Keep UI responsive (local switch) but also sync backend state
			// so session-specific messages and restore state route correctly.
			switchSession(sessionId);
			postMessage('switchSession', { sessionId });
		},
		[postMessage, switchSession],
	);

	const handleCloseSession = useCallback(
		(sessionId: string) => {
			closeSession(sessionId);
			postMessage('closeSession', { sessionId });
		},
		[closeSession, postMessage],
	);

	const handleCreateSession = useCallback(() => {
		postMessage('createSession');
	}, [postMessage]);

	const handleHistoryToggle = useCallback(() => {
		setShowHistoryDropdown(!showHistoryDropdown);
	}, [setShowHistoryDropdown, showHistoryDropdown]);

	const handleSettingsOpen = useCallback(() => {
		setActiveModal('settings');
	}, [setActiveModal]);

	return (
		<header className="z-50 relative flex justify-between items-center select-none px-(--layout-padding-x) min-h-(--header-height) gap-(--gap-0-5)">
			{/* Left side - Chat Tabs (Icons only) */}
			<div className="flex items-center h-full overflow-hidden flex-1">
				<div className="flex items-center h-full max-w-full overflow-x-auto no-scrollbar gap-(--gap-0-5)">
					{sessions.map((session, index) => (
						<div
							key={session.id}
							onClick={() => handleSwitchSession(session.id)}
							onAuxClick={e => {
								if (e.button === 1) {
									e.preventDefault();
									handleCloseSession(session.id);
								}
							}}
							className={cn(
								'group flex items-center h-(--tab-height) px-(--gap-0-5) gap-0 rounded transition-all duration-150 cursor-pointer relative select-none min-w-(--icon-btn-md) justify-center border border-transparent',
								session.id === activeSessionId
									? 'bg-(--alpha-10) text-vscode-foreground border-(--alpha-5)'
									: 'text-vscode-descriptionForeground hover:bg-(--alpha-10) hover:text-vscode-foreground',
							)}
							title={`Chat ${index + 1}`}
						>
							<FileIcon
								size={14}
								className={cn(session.id === activeSessionId ? 'opacity-100' : 'opacity-60')}
							/>
							<span className="text-sm font-medium">{index + 1}</span>

							{/* Close button on hover */}
							<button
								type="button"
								onClick={e => {
									e.stopPropagation();
									handleCloseSession(session.id);
								}}
								className="opacity-0 group-hover:opacity-100 p-(--gap-0-5) hover:bg-(--alpha-10) rounded transition-opacity flex items-center justify-center"
							>
								<CloseIcon size={12} />
							</button>
						</div>
					))}
				</div>
			</div>

			{/* Right side - Order: New (Plus), History, Settings */}
			<div className="flex items-center gap-(--header-gap)">
				<Button
					variant="icon"
					size="icon"
					onClick={handleCreateSession}
					title="New Chat"
					className="w-(--header-btn-size) h-(--header-btn-size)"
				>
					<PlusIcon size={16} />
				</Button>

				<div className="relative">
					<Button
						variant="icon"
						size="icon"
						onClick={handleHistoryToggle}
						title="History"
						className="w-(--header-btn-size) h-(--header-btn-size)"
					>
						<HistoryIcon size={16} />
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
	);
});
Header.displayName = 'Header';
