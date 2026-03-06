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
import { precomputeCollapseFlags } from './components/chat/SimpleTool';
import { Header } from './components/header/Header';
import { ChevronDownIcon } from './components/icons';
import { ChatInput } from './components/input/ChatInput.tsx';
import { UserMessage } from './components/input/UserMessage.tsx';
import { SettingsPage } from './components/settings';
import { ConfirmDialog } from './components/ui';
import { ScrollThumb } from './components/ui/ScrollContainer';
import { useElementHeight } from './hooks/useElementHeight';
import { useExtensionMessages } from './hooks/useExtensionMessages';
import {
	useActiveModal,
	useActiveSessionId,
	useChangedFilesState,
	useIsProcessing,
	useMcpServers,
	useMessages,
	useRevertedFromMessageId,
	useTurnTokens,
} from './store';
import { useSettingsStore } from './store/settingsStore';
import { groupMessagesIntoSections, type MessageSection } from './utils/groupSections';
import { vscode } from './utils/vscode';

/**
 * Structurally compare two sections — reuse the old ref if nothing meaningful changed.
 * This preserves referential equality for Virtuoso's memo check (prev.section === next.section).
 */
function sectionChanged(prev: MessageSection, next: MessageSection): boolean {
	if (prev.userMessage !== next.userMessage) return true;
	if (prev.isReverted !== next.isReverted) return true;
	if (prev.isRevertPoint !== next.isRevertPoint) return true;
	if (prev.responses.length !== next.responses.length) return true;
	// Check referential equality of all responses to catch mid-list updates
	// (e.g. a tool completing in the middle while streaming continues at the end)
	for (let i = 0; i < prev.responses.length; i++) {
		const p = prev.responses[i];
		const n = next.responses[i];
		if (p !== n) {
			// Arrays are recreated by groupToolMessages — compare by last id + length
			if (Array.isArray(p) && Array.isArray(n)) {
				if (p.length !== n.length) return true;
				const pId = p[p.length - 1]?.id;
				const nId = n[n.length - 1]?.id;
				if (pId !== nId) return true;
			} else {
				return true;
			}
		}
	}
	// Stats: compare by value (computeSectionStats creates new objects every time)
	const ps = prev.stats;
	const ns = next.stats;
	if (ps.tokenCount !== ns.tokenCount) return true;
	if (ps.durationMs !== ns.durationMs) return true;
	if (ps.isLast !== ns.isLast) return true;
	if (ps.lastResponseTs !== ns.lastResponseTs) return true;
	// fileChanges: both null, or same values
	if (ps.fileChanges !== ns.fileChanges) {
		if (!ps.fileChanges || !ns.fileChanges) return true;
		if (
			ps.fileChanges.added !== ns.fileChanges.added ||
			ps.fileChanges.removed !== ns.fileChanges.removed ||
			ps.fileChanges.files !== ns.fileChanges.files
		)
			return true;
	}
	return false;
}

/** Stabilize section refs — reuse previous objects when data hasn't changed */
function stabilizeSections(
	next: MessageSection[],
	prevRef: React.MutableRefObject<MessageSection[]>,
): MessageSection[] {
	const prev = prevRef.current;
	if (prev.length === 0 || next.length === 0) {
		prevRef.current = next;
		return next;
	}

	let allSame = prev.length === next.length;
	const result: MessageSection[] = new Array(next.length);

	for (let i = 0; i < next.length; i++) {
		const p = prev[i];
		const n = next[i];
		// Match by userMessage.id and sectionIndex
		if (p && p.userMessage.id === n.userMessage.id && !sectionChanged(p, n)) {
			result[i] = p; // reuse old ref
		} else {
			result[i] = n;
			allSame = false;
		}
	}

	if (allSame) return prev; // entire array unchanged
	prevRef.current = result;
	return result;
}

/**
 * Static context object for MessageItem — totalSections is no longer needed
 * since GenerationStatus rendering is controlled via a dedicated prop.
 * Using a stable reference prevents memo invalidation.
 */
const STATIC_MESSAGE_ITEM_CTX = { totalSections: 0 };

interface ChatVirtuosoContext {
	isProcessing: boolean;
	totalSections: number;
}

interface MessageSectionProps {
	section: MessageSection;
	showGenerationStatus: boolean;
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
	({ section, showGenerationStatus }) => {
		const collapseFlags = useMemo(
			() => precomputeCollapseFlags(section.responses),
			[section.responses],
		);

		return (
			<section className="relative pb-(--gap-4)">
				<div
					className="sticky top-0 z-40 px-(--layout-padding-x)"
					style={{ backgroundColor: 'var(--surface-base)' }}
				>
					<UserMessage
						message={section.userMessage}
						isRevertPoint={section.isRevertPoint}
						stats={section.stats}
					/>
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
								ctx={STATIC_MESSAGE_ITEM_CTX}
								collapseGroupedTools={collapseFlags[idx]}
							/>
						);
					})}
					{showGenerationStatus && <GenerationStatus />}
				</div>
			</section>
		);
	},
	(prev, next) => {
		return prev.section === next.section && prev.showGenerationStatus === next.showGenerationStatus;
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
								className="text-vscode-textLink-foreground hover:underline cursor-pointer bg-transparent border-none p-0 font-inherit"
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

	const messages = useMessages();
	const mcpServers = useMcpServers();
	const isProcessing = useIsProcessing();
	const revertedFromMessageId = useRevertedFromMessageId();
	const { changedFiles } = useChangedFilesState();
	const turnTokens = useTurnTokens();

	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

	const prevSectionsRef = useRef<MessageSection[]>([]);

	const sections = useMemo(() => {
		const raw = groupMessagesIntoSections(
			messages,
			mcpServerNames,
			revertedFromMessageId,
			changedFiles,
			turnTokens,
			isProcessing,
		);
		return stabilizeSections(raw, prevSectionsRef);
	}, [messages, mcpServerNames, revertedFromMessageId, changedFiles, turnTokens, isProcessing]);

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
	const [scrollerEl, setScrollerEl] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!scrollerEl) return;
		let rafId: number | null = null;
		const onScroll = () => {
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				if (!scrollerEl) return;
				const distance = scrollerEl.scrollHeight - scrollerEl.scrollTop - scrollerEl.clientHeight;
				setShowScrollToBottom(distance > SCROLL_BUTTON_THRESHOLD);
			});
		};
		scrollerEl.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			scrollerEl.removeEventListener('scroll', onScroll);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [scrollerEl]);

	const handleFollowOutput = useCallback(
		(_isAtBottom: boolean) => {
			if (isProcessing && !userScrolledUpRef.current) return 'auto' as const;
			return false as const;
		},
		[isProcessing],
	);

	// MutationObserver fallback: followOutput only fires when Virtuoso detects item
	// count/size changes. When content streams inside fixed-height containers (ToolCard,
	// SubtaskItem, SimpleToolGroup with maxHeight + overflowY), the outer Virtuoso item
	// height doesn't change, so followOutput never fires and auto-scroll stops.
	// This observer watches for ANY DOM mutation inside the scroller and scrolls to bottom
	// when the user hasn't manually scrolled up.
	useEffect(() => {
		const el = scrollerRef.current;
		if (!isProcessing || !el) return;

		let rafId: number | null = null;
		const onMutation = () => {
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
					scroller.scrollTop = scroller.scrollHeight;
				}
			});
		};

		const observer = new MutationObserver(onMutation);
		observer.observe(el, { childList: true, subtree: true, characterData: true });

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
					showGenerationStatus={isLast && context.isProcessing}
				/>
			);
		},
		[],
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

	const prevSectionCountRef = useRef(sectionCount);
	useEffect(() => {
		const prev = prevSectionCountRef.current;
		prevSectionCountRef.current = sectionCount;

		if (sectionCount > prev && prev > 0 && !sessionSwitchRef.current && virtuosoRef.current) {
			const targetIndex = sectionCount - 1;
			const raf = requestAnimationFrame(() => {
				virtuosoRef.current?.scrollToIndex({
					index: targetIndex,
					align: 'start',
					behavior: 'auto',
				});
			});
			return () => cancelAnimationFrame(raf);
		}
		return undefined;
	}, [sectionCount]);

	const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
		const div = el instanceof HTMLElement ? (el as HTMLDivElement) : null;
		(scrollerRef as React.MutableRefObject<HTMLDivElement | null>).current = div;
		setScrollerEl(div);
	}, []);

	const handleScrollToBottom = useCallback(() => {
		virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
	}, []);

	return (
		<>
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
		</>
	);
});
ChatArea.displayName = 'ChatArea';

export const App: React.FC = () => {
	useExtensionMessages();

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
