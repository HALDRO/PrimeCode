/**
 * @file Header component - top navigation bar for PrimeCode
 * @description Compact header with session tabs, connection status indicator, and control buttons.
 * New session creation delegates entirely to the backend (via `createSession` message) which
 * creates a real session and responds with lifecycle events — no client-side draft IDs.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../../lib/cn';
import { openCodeRuntime } from '../../services/opencodeRuntime';
import {
	isSessionProcessing,
	useChatStore,
	useHistoryDropdownState,
	useUIActions,
} from '../../store';
import type { SessionStore } from '../../store/chatStore';
import { useSettingsStore } from '../../store/settingsStore';
import { webviewLogger } from '../../utils/logger';

const log = webviewLogger.forComponent('Header');

import { useUIStore } from '../../store/uiStore';
import { proxyFetch } from '../../utils/proxyFetch';
import { useVSCode } from '../../utils/vscode';
import { CloseIcon, MessageIcon } from '../icons';
import { ScrollContainer } from '../ui';
import { CopyActionsButton } from './CopyActions';
import { HistoryDropdown } from './HistoryDropdown';

/**
 * Minimal tab data derived from store — avoids subscribing to the entire sessionsById.
 * Only session IDs are needed for tabs; the full ChatSession object is not required.
 */
interface TabInfo {
	id: string;
}

/** Connection status dropdown menu with actions — rendered via portal to escape stacking context. */
const ConnectionStatusMenu: React.FC<{
	serverStatus: 'connected' | 'disconnected' | 'error';
	connectionDetails: {
		serverUrl: string | null;
		isServerOwner: boolean;
		uptime: number | null;
		port: number | null;
	} | null;
	lspStatus: Array<{
		id: string;
		name: string;
		root: string;
		status: 'connected' | 'error';
	}>;
	onClose: () => void;
	anchorRef: React.RefObject<HTMLButtonElement | null>;
}> = ({ serverStatus, connectionDetails, lspStatus, onClose, anchorRef }) => {
	const { postMessage } = useVSCode();
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const connectedLspCount = lspStatus.filter(item => item.status === 'connected').length;

	// Compute position from anchor button
	useLayoutEffect(() => {
		const anchor = anchorRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		setPos({
			top: rect.bottom + 4,
			left: Math.max(0, rect.right - 220),
		});
	}, [anchorRef]);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target as Node;
			if (
				menuRef.current &&
				!menuRef.current.contains(target) &&
				!anchorRef.current?.contains(target)
			) {
				onClose();
			}
		};
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('mousedown', handleClickOutside);
		document.addEventListener('keydown', handleEscape);
		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('keydown', handleEscape);
		};
	}, [onClose, anchorRef]);

	const statusLabel =
		serverStatus === 'connected'
			? 'Connected'
			: serverStatus === 'error'
				? 'Connection Error'
				: 'Disconnected';

	const statusColor =
		serverStatus === 'connected'
			? 'text-green-400'
			: serverStatus === 'error'
				? 'text-red-400'
				: 'text-gray-400';

	const uptimeLabel =
		typeof connectionDetails?.uptime === 'number'
			? `${Math.max(0, Math.floor(connectionDetails.uptime / 1000))}s`
			: null;

	if (!pos) return null;

	return createPortal(
		<div
			ref={menuRef}
			style={{ position: 'fixed', top: pos.top, left: pos.left }}
			className="z-[10000] min-w-[220px] rounded-md border border-(--alpha-10) bg-vscode-dropdown-background shadow-lg overflow-hidden"
		>
			{/* Status header */}
			<div className="px-3 py-2 border-b border-(--alpha-10)">
				<div className="flex items-center gap-2">
					<div
						className={cn(
							'w-2 h-2 rounded-full shrink-0',
							serverStatus === 'connected'
								? 'bg-green-500'
								: serverStatus === 'error'
									? 'bg-red-500'
									: 'bg-gray-500',
						)}
					/>
					<span className={cn('text-xs font-medium', statusColor)}>{statusLabel}</span>
				</div>
				{connectionDetails && (
					<div className="mt-1.5 space-y-0.5">
						{connectionDetails.port && (
							<div className="text-[10px] text-vscode-descriptionForeground">
								Port: {connectionDetails.port}
							</div>
						)}
						{connectionDetails.serverUrl && (
							<div className="text-[10px] text-vscode-descriptionForeground truncate max-w-[200px]">
								{connectionDetails.serverUrl}
							</div>
						)}
						<div className="text-[10px] text-vscode-descriptionForeground">
							{connectionDetails.isServerOwner ? 'Server owner: this window' : 'Shared server'}
						</div>
						<div className="text-[10px] text-vscode-descriptionForeground">
							Health: {serverStatus === 'connected' ? 'OK' : 'Unhealthy'}
						</div>
						{uptimeLabel && (
							<div className="text-[10px] text-vscode-descriptionForeground">
								Uptime: {uptimeLabel}
							</div>
						)}
					</div>
				)}
				<div className="mt-2 pt-2 border-t border-(--alpha-10)">
					<div className="flex items-center justify-between gap-3 text-[10px] text-vscode-descriptionForeground">
						<span>LSP</span>
						<span>
							{lspStatus.length > 0 ? `${connectedLspCount}/${lspStatus.length} connected` : 'None'}
						</span>
					</div>
					{lspStatus.length > 0 ? (
						<div className="mt-1.5 space-y-1 max-h-28 overflow-auto">
							{lspStatus.map(item => (
								<div
									key={item.id}
									className="flex items-center gap-2 text-[10px] text-vscode-descriptionForeground"
								>
									<div
										className={cn(
											'w-1.5 h-1.5 rounded-full shrink-0',
											item.status === 'connected' ? 'bg-green-500' : 'bg-red-500',
										)}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate text-vscode-foreground">{item.name || item.id}</div>
										{item.root ? <div className="truncate opacity-80">{item.root}</div> : null}
									</div>
								</div>
							))}
						</div>
					) : null}
				</div>
			</div>

			{/* Actions */}
			<div className="py-1">
				<button
					type="button"
					className="w-full text-left px-3 py-1.5 text-xs text-vscode-foreground hover:bg-(--alpha-10) transition-colors flex items-center gap-2"
					onClick={() => {
						postMessage({ type: 'restartOpenCode' });
						onClose();
					}}
					title="Reload OpenCode runtime state, resources, providers, and MCP"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 16 16"
						fill="currentColor"
						className="shrink-0 opacity-70"
						aria-hidden="true"
					>
						<path d="M12.75 8a4.5 4.5 0 0 1-8.61 1.834l-1.391.565A6.001 6.001 0 0 0 14.25 8 6 6 0 0 0 3.5 4.334V2.5H2v4h4V5H3.934A4.5 4.5 0 0 1 12.75 8z" />
					</svg>
					Reload OpenCode
				</button>
				<button
					type="button"
					className="w-full text-left px-3 py-1.5 text-xs text-vscode-foreground hover:bg-(--alpha-10) transition-colors flex items-center gap-2"
					onClick={() => {
						postMessage({ type: 'reloadExtension' });
						onClose();
					}}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 16 16"
						fill="currentColor"
						className="shrink-0 opacity-70"
						aria-hidden="true"
					>
						<path d="M2 1h12l1 1v12l-1 1H2l-1-1V2l1-1zm0 1v12h12V2H2zm3.5 5h5l-2.5 3-2.5-3z" />
					</svg>
					Reload Extension
				</button>
			</div>
		</div>,
		document.body,
	);
};

/** Module-level health check cache to prevent duplicate requests within 750ms window. */
let healthCachePromise: Promise<boolean> | null = null;
let healthCacheAt = 0;
const HEALTH_CACHE_MS = 750;

export const Header: React.FC = React.memo(() => {
	const HEALTH_POLL_INTERVAL_MS = 10_000;
	const HEALTH_FETCH_TIMEOUT_MS = 3_000;

	// Optimized selectors
	const { showHistoryDropdown } = useHistoryDropdownState();
	const { setServerStatus, showConfirmDialog } = useUIActions();
	const { postMessage } = useVSCode();

	// PERF: Only subscribe to sessionOrder and activeSessionId — NOT sessionsById.
	// sessionsById changes on every streaming event (Immer produce), but tabs only
	// need the list of session IDs and which one is active.
	const { sessionOrder, activeSessionId } = useChatStore(
		useShallow((state: SessionStore) => ({
			sessionOrder: state.sessionOrder,
			activeSessionId: state.activeSessionId,
		})),
	);
	const serverUrl = useUIStore(state => state.serverUrl);
	const serverStatus = useUIStore(state => state.serverStatus);
	const connectionDetails = useUIStore(state => state.connectionDetails);
	const lspStatus = useSettingsStore(state => state.lspStatus);

	const [showStatusMenu, setShowStatusMenu] = useState(false);
	const [tabsOverflowing, setTabsOverflowing] = useState(false);
	const statusBtnRef = useRef<HTMLButtonElement>(null);
	const tabsScrollerRef = useRef<HTMLDivElement>(null);
	const sessions: TabInfo[] = useMemo(() => sessionOrder.map(id => ({ id })), [sessionOrder]);

	useLayoutEffect(() => {
		const scroller = tabsScrollerRef.current;
		if (!scroller) return;

		const updateOverflowState = () => {
			setTabsOverflowing(scroller.scrollWidth - scroller.clientWidth > 1);
		};

		updateOverflowState();

		const resizeObserver = new ResizeObserver(() => {
			updateOverflowState();
		});
		resizeObserver.observe(scroller);

		const content = scroller.firstElementChild;
		if (content instanceof HTMLElement) {
			resizeObserver.observe(content);
		}

		return () => {
			resizeObserver.disconnect();
		};
	}, []);

	useEffect(() => {
		if (!serverUrl) return;

		let disposed = false;
		let timer: number | null = null;
		let consecutiveFailures = 0;
		const MAX_BACKOFF_MS = 60_000;
		const RETRY_COUNT = 2;
		const RETRY_DELAY_MS = 100;

		const getNextInterval = () => {
			if (consecutiveFailures === 0) return HEALTH_POLL_INTERVAL_MS;
			return Math.min(HEALTH_POLL_INTERVAL_MS * 2 ** consecutiveFailures, MAX_BACKOFF_MS);
		};

		const scheduleNext = () => {
			if (disposed) return;
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				void runCheck();
			}, getNextInterval());
		};

		const isRetryable = (error: unknown): boolean => {
			if (!(error instanceof Error)) return false;
			if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
			if (error instanceof TypeError) return true;
			return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message);
		};

		const wait = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

		const attemptHealthCheck = async (retryCount: number): Promise<boolean | null> => {
			try {
				const controller = new AbortController();
				const timeout = window.setTimeout(() => controller.abort(), HEALTH_FETCH_TIMEOUT_MS);
				const response = await proxyFetch(`${serverUrl}/global/health`, {
					method: 'GET',
					signal: controller.signal,
				});
				window.clearTimeout(timeout);
				if (disposed) return null;

				if (!response.ok) {
					if (retryCount < RETRY_COUNT) {
						await wait(RETRY_DELAY_MS * (retryCount + 1));
						if (disposed) return null;
						return attemptHealthCheck(retryCount + 1);
					}
					return false;
				}

				const payload = (await response.json()) as { healthy?: boolean };
				if (disposed) return null;
				return payload.healthy === true;
			} catch (error: unknown) {
				if (disposed) return null;
				if (retryCount < RETRY_COUNT && isRetryable(error)) {
					await wait(RETRY_DELAY_MS * (retryCount + 1));
					if (disposed) return null;
					return attemptHealthCheck(retryCount + 1);
				}
				return false;
			}
		};

		const runCheck = async () => {
			const now = Date.now();
			let resultPromise: Promise<boolean>;
			if (healthCachePromise && now - healthCacheAt < HEALTH_CACHE_MS) {
				resultPromise = healthCachePromise;
			} else {
				healthCacheAt = now;
				healthCachePromise = attemptHealthCheck(0).then(r => r ?? false);
				resultPromise = healthCachePromise;
			}
			const result = await resultPromise;
			if (disposed) return;
			if (result) {
				consecutiveFailures = 0;
				setServerStatus('connected');
			} else {
				consecutiveFailures++;
				setServerStatus('error');
			}
			scheduleNext();
		};

		void runCheck();

		return () => {
			disposed = true;
			if (timer !== null) {
				window.clearTimeout(timer);
			}
		};
	}, [serverUrl, setServerStatus]);

	const handleSwitchSession = useCallback((sessionId: string) => {
		log.info('User switched session', { sessionId });
		openCodeRuntime.switchSession(sessionId);
	}, []);

	const doCloseSession = useCallback((sessionId: string) => {
		openCodeRuntime.closeSession(sessionId);
	}, []);

	const handleCloseSession = useCallback(
		(sessionId: string) => {
			const state = useChatStore.getState();
			const processing = isSessionProcessing(state, sessionId);

			if (processing) {
				showConfirmDialog({
					title: 'Close active session?',
					message: 'This session is still processing. Are you sure you want to close it?',
					confirmLabel: 'Close',
					onConfirm: () => doCloseSession(sessionId),
				});
				return;
			}

			doCloseSession(sessionId);
		},
		[doCloseSession, showConfirmDialog],
	);

	const handleStatusClick = useCallback(() => {
		// Request structural details (owner/uptime/port) when opening the menu.
		// Health/status are tracked directly in the webview.
		postMessage({ type: 'getConnectionDetails' });
		setShowStatusMenu(prev => !prev);
	}, [postMessage]);

	const handleStatusMenuClose = useCallback(() => {
		setShowStatusMenu(false);
	}, []);

	const SessionTab: React.FC<{ sessionId: string; index: number }> = ({ sessionId, index }) => {
		const isProcessing = useChatStore((state: SessionStore) =>
			isSessionProcessing(state, sessionId),
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
				data-session-id={sessionId}
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
				<div className="flex items-center h-full overflow-hidden flex-1 min-w-0">
					<ScrollContainer
						ref={tabsScrollerRef}
						orientation="horizontal"
						autoHide="scroll"
						thumbWidth={4}
						trackGutter={tabsOverflowing ? 8 : 0}
						autoHideDelay={800}
						className="h-full"
					>
						<div className="flex items-center h-full max-w-full min-w-fit gap-(--gap-0-5)">
							{sessions.map((session, index) => (
								<SessionTab key={session.id} sessionId={session.id} index={index} />
							))}
						</div>
					</ScrollContainer>
				</div>

				{/* Right side - Status + overlay content */}
				<div
					className={cn(
						'flex h-full items-center gap-(--header-gap) shrink-0 box-border',
						tabsOverflowing && 'pb-2',
					)}
				>
					{/* Copy Actions Button */}
					<CopyActionsButton noBackground />

					{/* Connection Status Button */}
					<div className="relative">
						<button
							ref={statusBtnRef}
							type="button"
							onClick={handleStatusClick}
							className={cn(
								'flex items-center justify-center w-(--header-btn-size) h-(--header-btn-size) rounded transition-colors duration-150',
								'hover:bg-(--alpha-10)',
								showStatusMenu && 'bg-(--alpha-10)',
							)}
							title={`OpenCode Server: ${serverStatus}`}
						>
							<div
								className={cn(
									'w-2 h-2 rounded-full transition-colors duration-300',
									serverStatus === 'connected'
										? 'bg-green-500'
										: serverStatus === 'error'
											? 'bg-red-500'
											: 'bg-gray-500',
								)}
							/>
						</button>
						{showStatusMenu && (
							<ConnectionStatusMenu
								serverStatus={serverStatus}
								connectionDetails={connectionDetails}
								lspStatus={lspStatus}
								onClose={handleStatusMenuClose}
								anchorRef={statusBtnRef}
							/>
						)}
					</div>
				</div>
				{showHistoryDropdown && <HistoryDropdown />}
			</header>
		</>
	);
});
Header.displayName = 'Header';
