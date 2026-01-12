/**
 * @file Main App component for PrimeCode webview
 * @description Root React component that orchestrates the chat interface. Renders message list
 *              with section-based layout where each user message + its responses form a section.
 *              User messages use CSS position:sticky within their section for push-up behavior.
 *              Uses react-virtuoso for virtualization.
 *              Avoids scroll jank on send by keeping scroll logic declarative (followOutput)
 *              and using a stable footer spacer instead of imperative timed scroll jumps.
 *              Integrates OverlayScrollbars via a custom Virtuoso Scroller component so the
 *              scrollable element is always the OverlayScrollbars viewport (no native scrollbar
 *              fallback). Always lands at bottom on session switch/history load by remounting
 *              Virtuoso when a session transitions from empty->loaded.
 *              Zustand stores manage state, useExtensionMessages hook handles VS Code communication.
 */

import { useOverlayScrollbars } from 'overlayscrollbars-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChangedFilesPanel } from './components/chat/ChangedFilesPanel';
import { ResponseItem } from './components/chat/SubtaskMessage';
import { UserMessage } from './components/chat/UserMessage';
import { Header } from './components/header/Header';
import { ChatInput } from './components/input/ChatInput';
import { FilePicker } from './components/modals/FilePicker';
import { SettingsPage } from './components/settings';
import { ConfirmDialog } from './components/ui';
import { useElementHeight } from './hooks/useElementHeight';
import { useExtensionMessages } from './hooks/useExtensionMessages';
import {
	type Message,
	useActiveModal,
	useActiveSessionId,
	useIsAutoRetrying,
	useIsProcessing,
	useMcpServers,
	useMessages,
	useRetryInfo,
} from './store';
import { groupToolMessages, shouldTriggerCollapse } from './utils/messageGrouping';
import { vscode } from './utils/vscode';

/**
 * Section represents a user message and all subsequent messages until the next user message.
 * This structure enables push-up sticky headers - each user message sticks within their section,
 * and when the section scrolls away, the sticky header goes with it.
 */
interface MessageSection {
	userMessage: Message & { type: 'user' };
	responses: (Message | Message[])[]; // Grouped tool messages and other responses
	sectionIndex: number;
}

/**
 * Group messages into sections. Each section starts with a user message
 * and contains all responses until the next user message.
 * Filters out hidden messages (dismissed errors, etc.)
 */
const groupMessagesIntoSections = (msgs: Message[], mcpServerNames: string[]): MessageSection[] => {
	// Filter out hidden messages
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));

	const sections: MessageSection[] = [];
	let currentSection: MessageSection | null = null;
	let currentResponses: Message[] = [];
	let sectionIndex = 0;

	for (const msg of visibleMsgs) {
		if (msg.type === 'user') {
			// Flush previous section
			if (currentSection) {
				currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
				sections.push(currentSection);
				currentResponses = [];
			}
			// Start new section
			currentSection = {
				userMessage: msg as Message & { type: 'user' },
				responses: [],
				sectionIndex: sectionIndex++,
			};
		} else if (currentSection) {
			currentResponses.push(msg);
		}
	}

	// Flush last section
	if (currentSection) {
		currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
		sections.push(currentSection);
	}

	return sections;
};

/**
 * MessageSection component - renders a user message with its responses in a section.
 * The user message is sticky within this section, enabling push-up behavior:
 * when this section scrolls away, the sticky header goes with it.
 * UserMessage uses --layout-padding-x, responses use --content-padding-x for wider content area.
 */
interface MessageSectionProps {
	section: MessageSection;
	context: VirtuosoContext;
}

/**
 * Context passed to Virtuoso itemContent for stable callback references.
 * Using context prop prevents renderItem from being recreated when callbacks change.
 */
interface VirtuosoContext {
	onErrorResume: () => void;
	onErrorDismiss: (messageId: string) => void;
	canResume: boolean;
	isAutoRetrying: boolean;
	retryInfo: { attempt: number; message: string; nextRetryAt?: string } | null;
	stickyTopOffset: number;
	footerHeightPx: number;
}

const MessageSectionComponent = React.memo<MessageSectionProps>(
	({ section, context }) => (
		<section className="relative">
			<div
				className="sticky z-40 px-(--layout-padding-x)"
				style={{ top: `${context.stickyTopOffset}px` }}
			>
				<UserMessage message={section.userMessage} />
			</div>
			<div className="px-(--content-padding-x)">
				{section.responses.map((responseItem, idx) => {
					// Check if there's following content after this item
					// (text, edit tools, bash, etc - anything that's not a utility tool group)
					const hasFollowingContent =
						idx < section.responses.length - 1 &&
						section.responses.slice(idx + 1).some(item => {
							if (Array.isArray(item)) return false; // Another tool group - doesn't count
							return shouldTriggerCollapse(item as Message);
						});

					return (
						<ResponseItem
							key={
								Array.isArray(responseItem) ? responseItem[0]?.id || idx : responseItem.id || idx
							}
							item={responseItem}
							onErrorResume={context.onErrorResume}
							onErrorDismiss={context.onErrorDismiss}
							canResume={context.canResume}
							isAutoRetrying={context.isAutoRetrying}
							retryInfo={context.retryInfo}
							hasFollowingContent={hasFollowingContent}
						/>
					);
				})}
			</div>
		</section>
	),
	(prev, next) => {
		// 1. Context is compared by reference - if context object is stable, skip deep comparison
		// The context object is memoized in App component, so it only changes when its values change
		if (prev.context !== next.context) {
			return false;
		}

		// 2. Check User Message (should be stable ref if not editing/streaming that specific msg)
		if (prev.section.userMessage !== next.section.userMessage) {
			return false;
		}

		// 3. Check Responses (array of Messages or Arrays of Messages)
		const prevResp = prev.section.responses;
		const nextResp = next.section.responses;

		if (prevResp.length !== nextResp.length) {
			return false;
		}

		// Shallow compare of response list items
		for (let i = 0; i < prevResp.length; i++) {
			const p = prevResp[i];
			const n = nextResp[i];

			if (Array.isArray(p) && Array.isArray(n)) {
				// Tool Group: check content refs
				if (p.length !== n.length) {
					return false;
				}
				for (let j = 0; j < p.length; j++) {
					if (p[j] !== n[j]) {
						return false;
					}
				}
			} else if (p !== n) {
				// Single Message
				return false;
			}
		}

		return true;
	},
);
MessageSectionComponent.displayName = 'MessageSectionComponent';

// Empty state component
const EmptyState: React.FC = () => (
	<div className="flex items-center justify-center flex-col h-full opacity-50">
		<div style={{ fontSize: 'var(--spacing-4)', marginBottom: 'var(--spacing-2)' }}>🤖</div>
		<div
			className="text-vscode-descriptionForeground"
			style={{ fontSize: 'var(--vscode-font-size)' }}
		>
			Start a conversation with Claude Code
		</div>
	</div>
);

// Modals container
const Modals: React.FC = () => <FilePicker />;

// Virtuoso Footer component - uses context for dynamic height
const VirtuosoFooterDynamic: React.FC<{ context?: VirtuosoContext }> = ({ context }) => (
	<div style={{ height: context?.footerHeightPx ?? 0 }} />
);
VirtuosoFooterDynamic.displayName = 'VirtuosoFooterDynamic';

// followOutput callback - stable reference
const followOutputCallback = (isAtBottom: boolean): 'auto' | false => (isAtBottom ? 'auto' : false);

type ScrollerProps = React.ComponentPropsWithoutRef<'div'>;

const OverlayScroller = React.forwardRef<HTMLDivElement, ScrollerProps>(
	({ style, className, children, ...restProps }, forwardedRef) => {
		const targetRef = useRef<HTMLDivElement | null>(null);
		const viewportRef = useRef<HTMLDivElement | null>(null);
		const contentRef = useRef<HTMLDivElement | null>(null);

		const handleViewportRef = useCallback(
			(node: HTMLDivElement | null) => {
				viewportRef.current = node;
				if (typeof forwardedRef === 'function') {
					forwardedRef(node);
				} else if (forwardedRef) {
					forwardedRef.current = node;
				}
			},
			[forwardedRef],
		);

		const [initialize, instance] = useOverlayScrollbars({
			options: {
				showNativeOverlaidScrollbars: false,
				overflow: { x: 'hidden', y: 'scroll' },
				scrollbars: {
					autoHide: 'scroll',
					autoHideDelay: 700,
					autoHideSuspend: false,
					theme: 'os-theme-dark',
				},
			},
			defer: true,
		});

		useEffect(() => {
			if (targetRef.current) {
				initialize({
					target: targetRef.current,
					elements: {
						viewport: viewportRef.current || undefined,
						content: contentRef.current || undefined,
					},
				});
			}
			return () => {
				instance()?.destroy();
			};
		}, [initialize, instance]);

		return (
			<div ref={targetRef} style={style} className={className}>
				<div ref={handleViewportRef} className="os-viewport" {...restProps}>
					<div ref={contentRef} className="os-content">
						{children}
					</div>
				</div>
			</div>
		);
	},
);
OverlayScroller.displayName = 'OverlayScroller';

export const App: React.FC = () => {
	useExtensionMessages();

	const chatInputHeight = useElementHeight<HTMLDivElement>({ fallbackHeight: 0 });
	const changedFilesPanelHeight = useElementHeight<HTMLDivElement>({ fallbackHeight: 0 });

	const messages = useMessages();
	const activeSessionId = useActiveSessionId();
	const activeModal = useActiveModal();
	const mcpServers = useMcpServers();
	const isProcessing = useIsProcessing();
	const isAutoRetrying = useIsAutoRetrying();
	const retryInfo = useRetryInfo();
	// Get MCP server names for tool grouping
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

	const sections = useMemo(
		() => groupMessagesIntoSections(messages, mcpServerNames),
		[messages, mcpServerNames],
	);

	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const lastSectionCount = useRef(sections.length);
	const lastSessionId = useRef<string | null>(activeSessionId);

	// Error message handlers - use proper message types instead of text workarounds
	const handleErrorResume = useCallback(() => {
		if (activeSessionId) {
			vscode.postMessage({
				type: 'resumeAfterError',
				sessionId: activeSessionId,
			});
		}
	}, [activeSessionId]);

	const handleErrorDismiss = useCallback(
		(messageId: string) => {
			if (activeSessionId) {
				vscode.postMessage({
					type: 'dismissError',
					messageId,
					sessionId: activeSessionId,
				});
			}
		},
		[activeSessionId],
	);

	const virtuosoComponents = useMemo(
		() => ({
			Scroller: OverlayScroller,
			Footer: VirtuosoFooterDynamic,
		}),
		[],
	);

	const bottomReservePx = chatInputHeight.height + changedFilesPanelHeight.height;
	const footerPx = Math.max(80, bottomReservePx);

	// Memoized context for Virtuoso - contains all callbacks and state needed by items
	// This prevents renderItem from being recreated when these values change
	const virtuosoContext = useMemo<VirtuosoContext>(
		() => ({
			onErrorResume: handleErrorResume,
			onErrorDismiss: handleErrorDismiss,
			canResume: !isProcessing,
			isAutoRetrying,
			retryInfo,
			stickyTopOffset: 0,
			footerHeightPx: footerPx,
		}),
		[handleErrorResume, handleErrorDismiss, isProcessing, isAutoRetrying, retryInfo, footerPx],
	);

	// Memoized itemContent renderer - now only depends on stable reference
	const renderItem = useCallback(
		(_index: number, section: MessageSection, context: VirtuosoContext) => (
			<MessageSectionComponent section={section} context={context} />
		),
		[],
	);

	useEffect(() => {
		// Track session changes for section count reset
		const sessionChanged = activeSessionId !== lastSessionId.current;
		lastSessionId.current = activeSessionId;

		if (sessionChanged) {
			lastSectionCount.current = sections.length;
		}

		lastSectionCount.current = sections.length;
	}, [sections.length, activeSessionId]);

	return (
		<div
			className="flex flex-col overflow-hidden w-full h-screen"
			style={{ backgroundColor: 'var(--vscode-sideBar-background)' }}
		>
			<Header />

			<div className="flex-1 overflow-hidden relative">
				{messages.length === 0 && (
					<div className="absolute inset-0 pointer-events-none">
						<EmptyState />
					</div>
				)}

				<Virtuoso
					ref={virtuosoRef}
					key={`${activeSessionId ?? 'no-session'}:${sections.length > 0 ? 'loaded' : 'empty'}`}
					style={{
						fontFamily: 'var(--vscode-editor-font-family)',
						fontSize: 'var(--vscode-editor-font-size)',
						lineHeight: 1.6,
						height: '100%',
						scrollPaddingTop: 'var(--gap-4)',
					}}
					data={sections}
					context={virtuosoContext}
					initialTopMostItemIndex={
						sections.length > 0 ? ({ index: 'LAST', align: 'end' } as const) : 0
					}
					atBottomThreshold={32}
					followOutput={followOutputCallback}
					itemContent={renderItem}
					computeItemKey={(index, section) => section.userMessage.id ?? `${index}`}
					components={virtuosoComponents}
				/>

				<div className="absolute bottom-0 left-0 right-0 z-20 pointer-events-none">
					<div
						ref={changedFilesPanelHeight.ref}
						className="pointer-events-auto px-(--content-padding-x)"
					>
						<ChangedFilesPanel />
					</div>
				</div>
			</div>

			<div ref={chatInputHeight.ref}>
				<ChatInput />
			</div>
			<Modals />
			<ConfirmDialog />
			{activeModal === 'settings' && <SettingsPage />}
		</div>
	);
};

export default App;
