/**
 * @file Main App component for PrimeCode webview
 * @description Root React component that orchestrates the chat interface.
 * Uses react-virtuoso for message virtualization with sticky headers.
 * Implements a robust Flex Column layout to ensure the chat input is pinned to the bottom.
 */

import { useOverlayScrollbars } from 'overlayscrollbars-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ChangedFilesPanel } from './components/chat/ChangedFilesPanel';
import { GenerationStatus } from './components/chat/GenerationStatus';
import { MessageItem } from './components/chat/MessageItem';
import { NotificationOverlay } from './components/chat/NotificationOverlay.tsx';
import { shouldCollapseGroupedItem } from './components/chat/SimpleTool';
import { UserMessage } from './components/chat/UserMessage';
import { Header } from './components/header/Header';
import { ChatInput } from './components/input/ChatInput';
import { SettingsPage } from './components/settings';
import { ConfirmDialog } from './components/ui';
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
import { groupMessagesIntoSections, type MessageSection } from './utils/groupSections';

// MessageSection type and groupMessagesIntoSections are imported from ./utils/groupSections

interface MessageSectionProps {
	section: MessageSection;
	context: VirtuosoContext;
}

interface VirtuosoContext {
	isProcessing: boolean;
	totalSections: number;
}

const MessageSectionComponent = React.memo<MessageSectionProps>(
	({ section, context }) => {
		const isLastSection = section.sectionIndex === context.totalSections - 1;

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
								ctx={context}
								collapseGroupedTools={shouldCollapseGroupedItem(section.responses, idx)}
							/>
						);
					})}
					{isLastSection && context.isProcessing && <GenerationStatus />}
				</div>
			</section>
		);
	},
	(prev, next) => {
		return prev.section === next.section && prev.context === next.context;
	},
);
MessageSectionComponent.displayName = 'MessageSectionComponent';

const EmptyState: React.FC = () => (
	<div className="flex items-center justify-center flex-col h-full opacity-50">
		<div style={{ fontSize: 'var(--spacing-4)', marginBottom: 'var(--spacing-2)' }}>🤖</div>
		<div
			className="text-vscode-descriptionForeground"
			style={{ fontSize: 'var(--vscode-font-size)' }}
		>
			Start a conversation...
		</div>
	</div>
);

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
				overflow: { x: 'hidden', y: 'scroll' },
				scrollbars: { autoHide: 'leave', autoHideDelay: 500 },
			},
			defer: true,
		});

		useEffect(() => {
			if (!targetRef.current) return;
			initialize({
				target: targetRef.current,
				elements: {
					viewport: viewportRef.current || undefined,
					content: contentRef.current || undefined,
				},
			});
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

	const headerHeight = useElementHeight<HTMLDivElement>({ fallbackHeight: 44 });
	const virtuosoRef = useRef<VirtuosoHandle>(null);

	const messages = useMessages();
	const activeSessionId = useActiveSessionId();
	const activeModal = useActiveModal();
	const mcpServers = useMcpServers();
	const isProcessing = useIsProcessing();
	const revertedFromMessageId = useRevertedFromMessageId();

	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const { changedFiles } = useChangedFilesState();
	const turnTokens = useTurnTokens();

	const sections = useMemo(
		() =>
			groupMessagesIntoSections(
				messages,
				mcpServerNames,
				revertedFromMessageId,
				changedFiles,
				turnTokens,
			),
		[messages, mcpServerNames, revertedFromMessageId, changedFiles, turnTokens],
	);

	const virtuosoContext: VirtuosoContext = useMemo(
		() => ({
			isProcessing,
			totalSections: sections.length,
		}),
		[isProcessing, sections.length],
	);

	const virtuosoComponents = useMemo(
		() => ({
			Scroller: OverlayScroller,
			Footer: () => <div style={{ height: '2px' }} />,
		}),
		[],
	);

	// Auto-scroll logic
	useEffect(() => {
		if (isProcessing && virtuosoRef.current) {
			virtuosoRef.current.scrollToIndex({ index: 'LAST', behavior: 'auto' });
		}
	}, [isProcessing]);

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
				{sections.length === 0 ? (
					<div className="absolute inset-0 pointer-events-none z-0">
						<EmptyState />
					</div>
				) : (
					<Virtuoso
						ref={virtuosoRef}
						className="h-full w-full"
						style={{
							fontFamily: 'var(--vscode-editor-font-family)',
							fontSize: 'var(--vscode-editor-font-size)',
							lineHeight: 1.6,
						}}
						data={sections}
						context={virtuosoContext}
						initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
						followOutput={isAtBottom => (isAtBottom ? 'auto' : false)}
						itemContent={(index, section) => (
							<MessageSectionComponent
								key={section.userMessage.id ?? index}
								section={section}
								context={virtuosoContext}
							/>
						)}
						components={virtuosoComponents}
					/>
				)}
			</div>

			<div
				className="shrink-0 z-20"
				style={{
					backgroundColor: 'var(--surface-base)',
				}}
			>
				<NotificationOverlay />
				<div className="px-(--content-padding-x)">
					<ChangedFilesPanel />
				</div>
				<ChatInput />
			</div>

			{activeModal === 'settings' && <SettingsPage />}
			<ConfirmDialog />
		</div>
	);
};
