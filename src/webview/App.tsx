/**
 * @file Main App component for PrimeCode webview
 * @description Root React component that orchestrates the chat interface.
 * Uses react-virtuoso for message virtualization with sticky headers.
 * Implements a robust Flex Column layout to ensure the chat input is pinned to the bottom.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type StateSnapshot, Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChangedFilesPanel } from './components/chat/ChangedFilesPanel';
import { GenerationStatus } from './components/chat/GenerationStatus';
import { MessageItem } from './components/chat/MessageItem';
import { NotificationOverlay } from './components/chat/NotificationOverlay.tsx';
import { QueuedMessageBanner } from './components/chat/QueuedMessageBanner';
import { SessionStatisticsPanel } from './components/chat/SessionStatisticsPanel';
import { getGroupedItemShouldCollapse } from './components/chat/SimpleTool';
import { SectionCopyButton } from './components/header/CopyActions';
import { Header } from './components/header/Header';
import { ChevronDownIcon } from './components/icons';
import { ChatInput } from './components/input/ChatInput.tsx';
import { UserMessage } from './components/input/UserMessage.tsx';
import { SettingsPage } from './components/settings';
import { ConfirmDialog } from './components/ui';
import { ScrollThumb } from './components/ui/ScrollContainer';
import { useElementHeight } from './hooks/useElementHeight';
import { useOpenCodeBootstrap } from './hooks/useOpenCodeBootstrap';
import { eventRuntime } from './services/eventRuntime';
import {
	useActiveModal,
	useActiveSessionId,
	useMessageSections,
	useSessionProcessing,
} from './store';
import { useChatStore } from './store/chatStore';
import type { MessageSection } from './store/derived';
import { useSettingsStore } from './store/settingsStore';
import { useUIStore } from './store/uiStore';
import { vscode } from './utils/vscode';

/**
 * Static context object for MessageItem. Using a stable reference prevents
 * memo invalidation during streaming updates.
 */
const buildMessageItemCtx = (sessionId: string) => ({ totalSections: 0, sessionId });

interface ChatVirtuosoContext {
	isProcessing: boolean;
	totalSections: number;
}

interface MessageSectionProps {
	section: MessageSection;
	isStreaming: boolean;
	sessionId: string;
}

const HiddenNativeScroller = React.forwardRef<
	HTMLDivElement,
	React.ComponentPropsWithoutRef<'div'>
>(({ style, children, ...props }, ref) => (
	<div
		ref={ref}
		{...props}
		style={{ ...style, overflowX: 'hidden', overflowY: 'scroll', scrollbarWidth: 'none' as const }}
	>
		{children}
	</div>
));
HiddenNativeScroller.displayName = 'HiddenNativeScroller';

const MessageSectionComponent = React.memo<MessageSectionProps>(
	({ section, isStreaming, sessionId }) => {
		const messageItemCtx = useMemo(() => buildMessageItemCtx(sessionId), [sessionId]);

		return (
			<section className="relative pb-(--message-gap)">
				{!section.stats.isFirst && <div style={{ height: 40 }} />}
				<div
					className="sticky top-0 z-40 px-(--layout-padding-x)"
					style={{ backgroundColor: 'var(--surface-base)' }}
				>
					<UserMessage
						message={section.userMessage}
						isRevertPoint={section.isRevertPoint}
						stats={section.stats}
					/>
					<div
						aria-hidden="true"
						className="pointer-events-none absolute z-50 overflow-hidden"
						style={{
							left: '13px',
							right: '13px',
							bottom: -15,
							height: 15,
							borderBottomLeftRadius: '10px',
							borderBottomRightRadius: '10px',
						}}
					>
						<div
							className="absolute left-0 right-0"
							style={{
								top: '-3px',
								height: 18,
								background:
									'linear-gradient(to bottom, color-mix(in srgb, var(--surface-base) 72%, transparent) 0%, color-mix(in srgb, var(--surface-base) 42%, transparent) 28%, color-mix(in srgb, var(--surface-base) 16%, transparent) 62%, rgba(0, 0, 0, 0) 100%)',
								filter: 'blur(5px)',
								opacity: 0.78,
							}}
						/>
					</div>
				</div>
				<div
					className="px-(--content-padding-x)"
					style={section.isReverted ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
				>
					{section.responses.map((responseItem, idx) => {
						const key = Array.isArray(responseItem)
							? (responseItem[0]?.id ?? `tool-group-${idx}`)
							: (responseItem.id ?? `message-${idx}`);

						return (
							<MessageItem
								key={key}
								item={responseItem}
								ctx={messageItemCtx}
								collapseGroupedTools={getGroupedItemShouldCollapse(responseItem)}
							/>
						);
					})}
					<div className="relative z-20 flex items-center mt-0.5 pr-2 min-h-5">
						{!isStreaming && !section.isReverted && section.responses.length > 0 && (
							<div className="flex items-center justify-end flex-1">
								<SectionCopyButton
									responses={section.responses}
									userMessage={section.userMessage}
								/>
							</div>
						)}
					</div>
				</div>
			</section>
		);
	},
	(prev, next) => {
		return prev.section === next.section && prev.isStreaming === next.isStreaming;
	},
);
MessageSectionComponent.displayName = 'MessageSectionComponent';

const EmptyState: React.FC = () => {
	const { current, latest, updateAvailable, releaseUrl, isChecking } = useSettingsStore(
		s => s.extensionVersion,
	);

	return (
		<div className="flex items-center justify-center flex-col h-full gap-3">
			<div
				className="font-semibold text-vscode-foreground"
				style={{ fontSize: 'var(--font-size-lg, 16px)' }}
			>
				PrimeCode
			</div>
			<div
				className="text-vscode-descriptionForeground"
				style={{ fontSize: 'var(--font-size-base, 13px)' }}
			>
				What can I help you with?
			</div>
			<div
				className="text-vscode-descriptionForeground mt-2"
				style={{ fontSize: 'var(--font-size-sm, 11px)', opacity: 0.7 }}
			>
				{isChecking ? (
					<span>Checking for updates...</span>
				) : updateAvailable && latest ? (
					<span>
						v{current} —{' '}
						{releaseUrl ? (
							<button
								type="button"
								onClick={() => vscode.postMessage({ type: 'openExternal', url: releaseUrl })}
								className="text-vscode-textLink-foreground hover:underline cursor-pointer bg-transparent border-none p-0 font-inherit pointer-events-auto"
								style={{ fontSize: 'inherit' }}
								title="Download latest release"
							>
								v{latest} available
							</button>
						) : (
							<span>v{latest} available</span>
						)}
					</span>
				) : current !== '0.0.0' ? (
					<span>v{current}</span>
				) : null}
			</div>
		</div>
	);
};

/**
 * ChatArea — isolated component that owns Virtuoso subscriptions.
 * Extracted from App so that per-token session updates don't cascade
 * into ChatInput, ChangedFilesPanel, and other siblings.
 */

/** Per-session Virtuoso state cache — preserves measured item heights across session switches. */
const virtuosoStateCache = new Map<string, StateSnapshot>();

const ChatArea = React.memo<{ activeSessionId: string }>(({ activeSessionId }) => {
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	const sessionSwitchRef = useRef(false);

	const sections = useMessageSections();
	const isProcessing = useSessionProcessing(activeSessionId);

	// Evict closed sessions from the Virtuoso state cache to prevent memory leaks
	const sessionOrder = useChatStore(state => state.sessionOrder);
	useEffect(() => {
		const activeIds = new Set(sessionOrder);
		for (const cachedId of virtuosoStateCache.keys()) {
			if (!activeIds.has(cachedId)) {
				virtuosoStateCache.delete(cachedId);
			}
		}
	}, [sessionOrder]);

	// Save Virtuoso state when switching away from a session (cleanup runs before new value applies)
	useEffect(() => {
		return () => {
			virtuosoRef.current?.getState(snapshot => {
				virtuosoStateCache.set(activeSessionId, snapshot);
			});
		};
	}, [activeSessionId]);

	// Restore state for the current session (if cached)
	const restoreState = useMemo(() => virtuosoStateCache.get(activeSessionId), [activeSessionId]);

	const virtuosoComponents = useMemo(
		() => ({
			Scroller: HiddenNativeScroller,
			Footer: () => (
				<div className="h-[72px] pointer-events-none overflow-visible box-border relative">
					<div className="absolute -top-[10px] left-0 right-0 h-8 px-(--content-padding-x) overflow-hidden box-border z-10">
						<div className="flex h-full items-start">
							<GenerationStatus sessionId={activeSessionId} className="text-left" />
						</div>
					</div>
					<div className="h-10" />
				</div>
			),
		}),
		[activeSessionId],
	);

	// Track whether the user has manually scrolled up during this processing run.
	// Reset when processing starts so auto-scroll re-engages each new generation.
	const userScrolledUpRef = useRef(false);
	useEffect(() => {
		if (isProcessing) {
			userScrolledUpRef.current = false;
		}
	}, [isProcessing]);

	const handleAtBottomStateChange = useCallback(
		(atBottom: boolean) => {
			isAtBottomRef.current = atBottom;
			setIsAtBottom(atBottom);
			// If user scrolls away from bottom during processing, mark as manually scrolled up.
			// If they scroll back to bottom, clear the flag so auto-scroll re-engages.
			if (isProcessing) {
				userScrolledUpRef.current = !atBottom;
			}
		},
		[isProcessing],
	);

	// Show scroll-to-bottom button only after scrolling 200px+ from bottom.
	// Uses a dedicated scroll listener instead of atBottomStateChange (which has a 40px threshold
	// needed for followOutput) so the button doesn't flash on minor scroll jitter.
	const SCROLL_BUTTON_THRESHOLD = 200;
	const MANUAL_UNSTICK_THRESHOLD = 8;
	const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!scrollerEl) return;
		let rafId: number | null = null;
		let lastScrollTop = scrollerEl.scrollTop;
		const onScroll = () => {
			const currentScrollTop = scrollerEl.scrollTop;
			const distance = scrollerEl.scrollHeight - currentScrollTop - scrollerEl.clientHeight;
			setIsAtBottom(distance <= MANUAL_UNSTICK_THRESHOLD);

			// Detach immediately when the user manually scrolls upward during streaming.
			// Relying only on Virtuoso's atBottomStateChange can feel sticky because it uses
			// a bottom threshold and may lag behind DOM mutations from streaming updates.
			if (isProcessing) {
				if (currentScrollTop < lastScrollTop && distance > MANUAL_UNSTICK_THRESHOLD) {
					userScrolledUpRef.current = true;
				} else if (distance <= MANUAL_UNSTICK_THRESHOLD) {
					userScrolledUpRef.current = false;
				}
			}

			lastScrollTop = currentScrollTop;

			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				if (!scrollerEl) return;
				const distance = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
				setShowScrollToBottom(distance > SCROLL_BUTTON_THRESHOLD);
				setIsAtBottom(distance <= MANUAL_UNSTICK_THRESHOLD);
			});
		};

		onScroll();
		scrollerEl.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			scrollerEl.removeEventListener('scroll', onScroll);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [isProcessing, scrollerEl]);

	const handleFollowOutput = useCallback(
		(_isAtBottom: boolean) => {
			if (isProcessing && !userScrolledUpRef.current) return 'auto' as const;
			return false as const;
		},
		[isProcessing],
	);

	// MutationObserver fallback: keep exactly one pending rAF-based bottom settle.
	// Throttled to avoid layout thrashing during rapid token streaming.
	useEffect(() => {
		const el = scrollerRef.current;
		if (!isProcessing || !el) return;

		let rafId: number | null = null;
		let lastKnownScrollHeight = 0;
		let lastExecutionTime = 0;
		const THROTTLE_MS = 100;

		const nudgeScroll = () => {
			if (userScrolledUpRef.current) return;
			if (rafId !== null) return;
			const now = performance.now();
			if (now - lastExecutionTime < THROTTLE_MS) return;

			rafId = requestAnimationFrame(() => {
				rafId = null;
				const scroller = scrollerRef.current;
				if (!scroller || userScrolledUpRef.current) return;
				const nextScrollHeight = scroller.scrollHeight;
				const grew = nextScrollHeight !== lastKnownScrollHeight;
				lastKnownScrollHeight = nextScrollHeight;
				if (grew) {
					const distanceFromBottom =
						scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
					if (distanceFromBottom < 120) {
						scroller.scrollTo({ top: nextScrollHeight, behavior: 'auto' });
					}
				}
				lastExecutionTime = performance.now();
			});
		};

		const observer = new MutationObserver(nudgeScroll);
		lastKnownScrollHeight = el.scrollHeight;
		observer.observe(el, { childList: true, subtree: true });

		return () => {
			observer.disconnect();
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [isProcessing]);

	const virtuosoContext = useMemo(
		() => ({ isProcessing, totalSections: sections.length }),
		[isProcessing, sections.length],
	);

	const computeItemKey = useCallback(
		(index: number, item: MessageSection) => item.userMessage.id ?? `section-${index}`,
		[],
	);

	const renderItem = useCallback(
		(index: number, section: MessageSection, context: ChatVirtuosoContext) => {
			if (!section) return null;
			const isLast = index === context.totalSections - 1;
			return (
				<MessageSectionComponent
					section={section}
					isStreaming={isLast && context.isProcessing}
					sessionId={activeSessionId}
				/>
			);
		},
		[activeSessionId],
	);

	// Scroll to bottom on session switch ONLY if there's no cached scroll state.
	// If restoreStateFrom is available, Virtuoso will restore the scroll position itself.
	useEffect(() => {
		if (activeSessionId && !restoreState) {
			sessionSwitchRef.current = true;
			// Reset scroll-up flag so auto-scroll works on the new session
			userScrolledUpRef.current = false;
			// Immediate attempt — covers the case where sections are already loaded
			// and sectionCount won't change (so the sectionCount effect below won't fire).
			requestAnimationFrame(() => {
				if (sessionSwitchRef.current && virtuosoRef.current) {
					sessionSwitchRef.current = false;
					virtuosoRef.current.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
				}
			});
		}
	}, [activeSessionId, restoreState]);

	const sectionCount = sections.length;
	useEffect(() => {
		if (sessionSwitchRef.current && sectionCount > 0 && virtuosoRef.current) {
			sessionSwitchRef.current = false;
			const raf = requestAnimationFrame(() => {
				virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
			});
			return () => cancelAnimationFrame(raf);
		}
		return undefined;
	}, [sectionCount]);

	// Stable primitive: id of the last section's user message.
	// Changes only when a new message is sent or an edit replaces the last section.
	const lastSectionUserMsgId = sections[sections.length - 1]?.userMessage.id;

	const prevSectionCountRef = useRef(sectionCount);
	const prevLastUserMsgIdRef = useRef(lastSectionUserMsgId);
	useEffect(() => {
		const prevCount = prevSectionCountRef.current;
		prevSectionCountRef.current = sectionCount;
		const prevMsgId = prevLastUserMsgIdRef.current;
		prevLastUserMsgIdRef.current = lastSectionUserMsgId;

		// Skip session switch — handled separately above
		if (sessionSwitchRef.current) return undefined;

		const shouldScroll =
			// New section added (normal send)
			(sectionCount > prevCount && prevCount > 0) ||
			// Edit: last user message id changed (sections were replaced)
			(lastSectionUserMsgId !== prevMsgId &&
				prevMsgId !== undefined &&
				lastSectionUserMsgId !== undefined &&
				sectionCount > 0);

		if (shouldScroll && virtuosoRef.current) {
			userScrolledUpRef.current = false;
			const raf = requestAnimationFrame(() => {
				virtuosoRef.current?.scrollToIndex({
					index: 'LAST',
					align: 'end',
					behavior: 'auto',
				});
			});
			return () => cancelAnimationFrame(raf);
		}
		return undefined;
	}, [lastSectionUserMsgId, sectionCount]);

	const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
		const div = el instanceof HTMLElement ? (el as HTMLDivElement) : null;
		(scrollerRef as React.MutableRefObject<HTMLDivElement | null>).current = div;
		setScrollerEl(div);
	}, []);

	const handleScrollToBottom = useCallback(() => {
		userScrolledUpRef.current = false;
		virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
	}, []);

	return (
		<div className="flex flex-col h-full w-full">
			<div className="flex-1 min-h-0 relative w-full">
				{sections.length === 0 ? (
					<div className="absolute inset-0 pointer-events-none z-0">
						<EmptyState />
					</div>
				) : (
					<Virtuoso
						ref={virtuosoRef}
						scrollerRef={handleScrollerRef}
						className="h-full w-full"
						style={{
							fontFamily: 'var(--vscode-editor-font-family)',
							fontSize: 'var(--vscode-editor-font-size)',
							lineHeight: 1.6,
						}}
						data={sections}
						context={virtuosoContext}
						computeItemKey={computeItemKey}
						followOutput={handleFollowOutput}
						atBottomStateChange={handleAtBottomStateChange}
						atBottomThreshold={40}
						defaultItemHeight={500}
						increaseViewportBy={{ top: 800, bottom: 800 }}
						restoreStateFrom={restoreState}
						itemContent={renderItem}
						components={virtuosoComponents}
					/>
				)}

				{sections.length > 0 && (
					<ScrollThumb
						scrollerRef={scrollerRef}
						alwaysVisible
						thumbColor="color-mix(in srgb, var(--input-bg) 90%, white)"
					/>
				)}

				{sections.length > 0 && isAtBottom && <SessionStatisticsPanel />}

				{sections.length > 0 && showScrollToBottom && (
					<button
						type="button"
						onClick={handleScrollToBottom}
						aria-label="Scroll to bottom"
						className="absolute bottom-2 left-1/2 z-10 flex items-center justify-center rounded-md cursor-pointer border-none -translate-x-1/2"
						style={{
							width: 28,
							height: 28,
							backgroundColor: 'var(--vscode-editor-background)',
							color: 'var(--vscode-foreground)',
							boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
						}}
						title="Scroll to bottom"
					>
						<ChevronDownIcon size={16} />
					</button>
				)}
			</div>
		</div>
	);
});
ChatArea.displayName = 'ChatArea';

export const App: React.FC = () => {
	const didSendInitialRequests = useRef(false);
	useOpenCodeBootstrap();
	const serverUrl = useUIStore(state => state.serverUrl);
	const workspaceRoot = useUIStore(state => state.workspaceRoot);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			eventRuntime.handleExtensionMessage(event.data);
		};

		window.addEventListener('message', handleMessage);

		if (!didSendInitialRequests.current) {
			didSendInitialRequests.current = true;
			vscode.postMessage({ type: 'webviewDidLaunch' });
			vscode.postMessage({ type: 'checkExtensionVersion' });
		}

		return () => {
			window.removeEventListener('message', handleMessage);
			eventRuntime.stop();
		};
	}, []);

	useEffect(() => {
		if (!serverUrl || !workspaceRoot) {
			useUIStore.getState().actions.setServerStatus('disconnected');
			eventRuntime.stop();
			return;
		}

		eventRuntime.start(serverUrl, workspaceRoot);
		return () => eventRuntime.stop();
	}, [serverUrl, workspaceRoot]);

	const headerHeight = useElementHeight<HTMLDivElement>({ fallbackHeight: 44 });
	const activeSessionId = useActiveSessionId();
	const activeModal = useActiveModal();

	if (!activeSessionId) {
		return (
			<div
				className="flex flex-col h-screen overflow-hidden"
				style={{ backgroundColor: 'var(--surface-base)' }}
			>
				<div ref={headerHeight.ref}>
					<Header />
				</div>
				<div className="flex-1 relative">
					<EmptyState />
				</div>
				<div
					className="shrink-0 z-20"
					style={{
						backgroundColor: 'var(--surface-base)',
					}}
				>
					<NotificationOverlay />
					<div className="px-(--content-padding-x)">
						<QueuedMessageBanner />
					</div>
					<ChatInput />
				</div>

				{activeModal === 'settings' && <SettingsPage />}
				<ConfirmDialog />
			</div>
		);
	}

	return (
		<div
			className="flex flex-col h-screen overflow-hidden"
			style={{ backgroundColor: 'var(--surface-base)' }}
		>
			<div ref={headerHeight.ref} className="shrink-0 z-10">
				<Header />
			</div>

			<div className="flex-1 min-h-0 relative">
				<ChatArea key={activeSessionId} activeSessionId={activeSessionId} />
			</div>

			<div
				className="shrink-0 z-20"
				style={{
					backgroundColor: 'var(--surface-base)',
				}}
			>
				<NotificationOverlay />
				<div className="px-(--content-padding-x)">
					<QueuedMessageBanner />
					<ChangedFilesPanel />
				</div>
				<ChatInput />
			</div>

			{activeModal === 'settings' && <SettingsPage />}
			<ConfirmDialog />
		</div>
	);
};
