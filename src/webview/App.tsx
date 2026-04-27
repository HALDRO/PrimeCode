/**
 * @file Main App component for PrimeCode webview
 * @description Root React component that orchestrates the chat interface.
 * Uses react-virtuoso for message virtualization with sticky headers.
 * Implements a robust Flex Column layout to ensure the chat input is pinned to the bottom.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChangedFilesPanel } from './components/chat/ChangedFilesPanel';
import { GenerationStatus } from './components/chat/GenerationStatus';
import { MessageItem } from './components/chat/MessageItem';
import { NotificationOverlay } from './components/chat/NotificationOverlay.tsx';
import { QueuedMessageBanner } from './components/chat/QueuedMessageBanner';
import { getGroupedItemShouldCollapse } from './components/chat/SimpleTool';
import { Header } from './components/header/Header';
import { ChevronDownIcon } from './components/icons';
import { ChatInput } from './components/input/ChatInput.tsx';
import { UserMessage } from './components/input/UserMessage.tsx';
import { SettingsPage } from './components/settings';
import { ConfirmDialog } from './components/ui';
import { ScrollThumb } from './components/ui/ScrollContainer';
import { useElementHeight } from './hooks/useElementHeight';
import {
	useActiveModal,
	useActiveSessionId,
	useChatStore,
	useIsProcessing,
	useMessageSections,
} from './store';
import type { WebviewSdkEvent } from './store/eventReducer';
import type { MessageSection } from './store/projector';
import { useSettingsStore } from './store/settingsStore';
import { useUIStore } from './store/uiStore';
import { vscode } from './utils/vscode';

let queue: WebviewSdkEvent[] = [];
let buffer: WebviewSdkEvent[] = [];
const coalesced = new Map<string, number>();
let pendingFrameId: number | null = null;

function coalescingKey(event: WebviewSdkEvent): string | null {
	switch (event.type) {
		case 'session.status':
			return `session.status:${event.properties.sessionID}`;
		case 'message.part.updated':
			return `message.part.updated:${event.properties.part.messageID}:${event.properties.part.id}`;
		default:
			return null;
	}
}

function enqueue(event: WebviewSdkEvent): void {
	const key = coalescingKey(event);
	if (key) {
		const existing = coalesced.get(key);
		if (existing !== undefined) {
			queue[existing] = event;
			return;
		}
		coalesced.set(key, queue.length);
	}
	queue.push(event);
	if (pendingFrameId === null) {
		pendingFrameId = window.requestAnimationFrame(flush);
	}
}

function flush(): void {
	pendingFrameId = null;
	if (queue.length === 0) return;
	const events = queue;
	queue = buffer;
	buffer = events;
	queue.length = 0;
	coalesced.clear();
	useChatStore.getState().actions.applyBatch(events);
	buffer.length = 0;
}

const handleExtensionMessage = (message: unknown): void => {
	const msg = message as { type?: string; [key: string]: unknown };

	if (msg.type === 'sdk_event') {
		const sdkEvent = (msg as { event: WebviewSdkEvent }).event;
		enqueue(sdkEvent);
		useUIStore
			.getState()
			.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
		useSettingsStore
			.getState()
			.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
		return;
	}

	if (msg.type === 'sdk_event_batch') {
		const events = (msg as { events: WebviewSdkEvent[] }).events;
		for (const event of events) {
			enqueue(event);
		}
		useUIStore
			.getState()
			.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
		useSettingsStore
			.getState()
			.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
		return;
	}

	useChatStore.getState().actions.handleExtensionMessage(message);
	useUIStore
		.getState()
		.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
	useSettingsStore
		.getState()
		.actions.handleExtensionMessage(message as import('../common').ExtensionMessage);
};

/**
 * Static context object for MessageItem — totalSections is no longer needed
 * since GenerationStatus rendering is controlled via a dedicated prop.
 * Using a stable reference prevents memo invalidation.
 */
const buildMessageItemCtx = (sessionId: string) => ({ totalSections: 0, sessionId });

interface ChatVirtuosoContext {
	isProcessing: boolean;
	totalSections: number;
}

interface MessageSectionProps {
	section: MessageSection;
	isLastSection: boolean;
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
	({ section, isLastSection, sessionId }) => {
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
					{isLastSection && <GenerationStatus />}
				</div>
			</section>
		);
	},
	(prev, next) => {
		return prev.section === next.section && prev.isLastSection === next.isLastSection;
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
 * ChatArea — isolated component that owns useMessages() and Virtuoso.
 * Extracted from App so that per-token message updates don't cascade
 * into ChatInput, ChangedFilesPanel, and other siblings.
 */
const ChatArea = React.memo<{ activeSessionId: string }>(({ activeSessionId }) => {
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);
	const sessionSwitchRef = useRef(false);

	const sections = useMessageSections();
	const isProcessing = useIsProcessing();

	const virtuosoComponents = useMemo(
		() => ({
			Scroller: HiddenNativeScroller,
			Footer: () => <div style={{ height: 40 }} />,
		}),
		[],
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
			if (isProcessing && !userScrolledUpRef.current) return 'smooth' as const;
			return false as const;
		},
		[isProcessing],
	);

	// MutationObserver fallback: followOutput only fires when Virtuoso detects item
	// count/size changes. When content streams inside fixed-height containers (ToolCard,
	// SubtaskItem, SimpleToolGroup with maxHeight + overflowY), the outer Virtuoso item
	// height doesn't change, so followOutput never fires and auto-scroll stops.
	// NOTE: ResizeObserver on a scroll container does NOT fire when inner content grows
	// (only when the container itself resizes). MutationObserver with childList+subtree
	// (without characterData) catches structural DOM changes while rAF dedup prevents
	// layout thrashing from per-token text updates.
	useEffect(() => {
		const el = scrollerRef.current;
		if (!isProcessing || !el) return;

		let rafId: number | null = null;
		const nudgeScroll = () => {
			if (userScrolledUpRef.current) return;
			if (rafId !== null) return; // already scheduled
			rafId = requestAnimationFrame(() => {
				rafId = null;
				const scroller = scrollerRef.current;
				if (!scroller || userScrolledUpRef.current) return;
				// Only nudge if we're close to the bottom (within 150px) to avoid
				// fighting with Virtuoso's own scroll management
				const distanceFromBottom =
					scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
				if (distanceFromBottom < 150) {
					scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
				}
			});
		};

		const observer = new MutationObserver(nudgeScroll);
		// childList+subtree catches new elements (messages, tool cards) without
		// the per-token overhead of characterData. rAF dedup above prevents thrashing.
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
					isLastSection={isLast}
					sessionId={activeSessionId}
				/>
			);
		},
		[activeSessionId],
	);

	// Scroll to bottom on session switch. Uses a two-phase approach:
	// Phase 1: mark that a switch happened.
	// Phase 2: on next render with sections, scroll to bottom.
	// Also handles the case where sectionCount hasn't changed (session already loaded).
	useEffect(() => {
		if (activeSessionId) {
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
	}, [activeSessionId]);

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
	}, [sectionCount, lastSectionUserMsgId]);

	const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
		const div = el instanceof HTMLElement ? (el as HTMLDivElement) : null;
		(scrollerRef as React.MutableRefObject<HTMLDivElement | null>).current = div;
		setScrollerEl(div);
	}, []);

	const handleScrollToBottom = useCallback(() => {
		userScrolledUpRef.current = false;
		const scrollOnce = () =>
			virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
		scrollOnce();
		// Virtuoso renders lazily — retry after content settles to ensure we reach true bottom
		setTimeout(scrollOnce, 150);
		setTimeout(scrollOnce, 400);
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
						defaultItemHeight={300}
						increaseViewportBy={{ top: 400, bottom: 400 }}
						itemContent={renderItem}
						components={virtuosoComponents}
					/>
				)}

				{sections.length > 0 && <ScrollThumb scrollerRef={scrollerRef} />}

				{sections.length > 0 && (
					<button
						type="button"
						onClick={handleScrollToBottom}
						aria-label="Scroll to bottom"
						className="absolute bottom-2 left-1/2 z-10 flex items-center justify-center rounded-md cursor-pointer border-none transition-all duration-300 ease-out"
						style={{
							transform: 'translateX(-50%)',
							width: 28,
							height: 28,
							backgroundColor: 'var(--vscode-editor-background)',
							color: 'var(--vscode-foreground)',
							boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
							opacity: showScrollToBottom ? 1 : 0,
							pointerEvents: showScrollToBottom ? 'auto' : 'none',
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

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			handleExtensionMessage(message);
		};

		window.addEventListener('message', handleMessage);

		if (!didSendInitialRequests.current) {
			didSendInitialRequests.current = true;
			vscode.postMessage({ type: 'webviewDidLaunch' });
			vscode.postMessage({ type: 'checkExtensionVersion' });
		}

		return () => {
			window.removeEventListener('message', handleMessage);
			if (pendingFrameId !== null) {
				cancelAnimationFrame(pendingFrameId);
				pendingFrameId = null;
			}
			flush();
		};
	}, []);

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
				<ChatArea activeSessionId={activeSessionId} />
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
