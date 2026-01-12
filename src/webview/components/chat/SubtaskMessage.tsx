/**
 * @file SubtaskMessage
 * @description Consolidated chat components for rendering subtask containers and response items.
 * Includes SubtaskMessage (collapsible container), SubtaskHeader (status/header UI), and ResponseItem
 * (renderer for assistant/thinking/error/tool group/subtask). Designed to support nested rendering
 * where child tool calls are hidden from the main flow but visible inside subtasks.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { SubtaskMessage as SubtaskMessageType } from '../../../types';
import { useSubtaskChildren } from '../../hooks/useSubtaskChildren';
import { cn } from '../../lib/cn';
import { useMcpServers } from '../../store';
import type { Message } from '../../store/chatStore';
import { formatDuration } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { groupToolMessages, shouldTriggerCollapse } from '../../utils/messageGrouping';
import {
	AgentsIcon,
	ExpandChevronIcon,
	TodoCheckIcon,
	TodoProgressIcon,
} from '../icons/CustomIcons';
import { ErrorMessage } from './ErrorMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { ToolGroup } from './ToolGroup';

// =============================================================================
// Response Item
// =============================================================================

// Memoized message components
const ClaudeMessage = React.memo<{ message: Message }>(({ message }) => (
	<div
		className="bg-transparent py-(--message-padding-y) mb-(--message-gap) text-(length:--font-size-base) leading-(--line-height-base) font-(family-name:--font-family-base)"
		style={{ color: 'var(--input-text-color)' }}
	>
		<Markdown content={(message as { content: string }).content || ''} />
	</div>
));
ClaudeMessage.displayName = 'ClaudeMessage';

const ThinkingMessageWrapper = React.memo<{ message: Message }>(({ message }) => {
	const thinkingMsg = message as Extract<Message, { type: 'thinking' }>;
	return (
		<div className="mb-(--message-gap)">
			<ThinkingMessage message={thinkingMsg} isStreaming={thinkingMsg.isStreaming} />
		</div>
	);
});
ThinkingMessageWrapper.displayName = 'ThinkingMessageWrapper';

export interface ResponseItemProps {
	item: Message | Message[];
	onErrorResume?: () => void;
	onErrorDismiss?: (messageId: string) => void;
	canResume?: boolean;
	isAutoRetrying?: boolean;
	retryInfo?: { attempt: number; message: string; nextRetryAt?: string } | null;
	/** Whether there's content after this item (for auto-collapsing tool groups) */
	hasFollowingContent?: boolean;
}

export const ResponseItem = React.memo<ResponseItemProps>(
	({
		item,
		onErrorResume,
		onErrorDismiss,
		canResume,
		isAutoRetrying,
		retryInfo,
		hasFollowingContent,
	}) => {
		// Handle tool groups
		if (Array.isArray(item)) {
			const groupKey = item[0]?.id || `group-${Math.random()}`;
			return <ToolGroup key={groupKey} messages={item} hasFollowingContent={hasFollowingContent} />;
		}

		const message = item;
		switch (message.type) {
			case 'system_notice':
				return (
					<ErrorMessage
						message={message as Extract<Message, { type: 'system_notice' }>}
						onDismiss={onErrorDismiss}
						canResume={false}
					/>
				);
			case 'assistant':
				return <ClaudeMessage message={message} />;
			case 'thinking':
				return <ThinkingMessageWrapper message={message} />;
			case 'subtask':
				return <SubtaskMessage message={message as SubtaskMessageType} />;
			case 'access_request':
				// Access requests are handled inline via InlineToolAccessGate in ToolMessage
				// Don't render a separate component here to avoid duplication
				return null;
			case 'error':
				return (
					<ErrorMessage
						message={message as Extract<Message, { type: 'error' }>}
						onResume={onErrorResume}
						onDismiss={onErrorDismiss}
						canResume={canResume}
						isAutoRetrying={isAutoRetrying}
						retryInfo={retryInfo}
					/>
				);
			case 'interrupted':
				return (
					<ErrorMessage
						message={message as Extract<Message, { type: 'interrupted' }>}
						onResume={onErrorResume}
						onDismiss={onErrorDismiss}
						canResume={canResume}
						isAutoRetrying={isAutoRetrying}
						retryInfo={retryInfo}
					/>
				);
			default:
				return null;
		}
	},
);
ResponseItem.displayName = 'ResponseItem';

// =============================================================================
// Subtask Header
// =============================================================================

interface SubtaskHeaderProps {
	subtask: SubtaskMessageType;
	isExpanded: boolean;
	onToggle: () => void;
	totalDuration?: number;
}

const SubtaskHeader: React.FC<SubtaskHeaderProps> = ({
	subtask,
	isExpanded,
	onToggle,
	totalDuration,
}) => {
	const isRunning = subtask.status === 'running';
	const isCompleted = subtask.status === 'completed';
	const isError = subtask.status === 'error';

	return (
		<div
			onClick={onToggle}
			className={cn(
				'flex items-center gap-2 p-2 cursor-pointer select-none transition-colors group',
				'bg-vscode-input-background hover:bg-vscode-toolbar-hoverBackground',
			)}
		>
			<div
				className={cn(
					'flex items-center justify-center w-5 h-5 rounded-full shrink-0',
					isRunning && 'text-vscode-button-background',
					isCompleted && 'text-vscode-editorGutter-addedBackground',
					isError && 'text-vscode-errorForeground',
				)}
			>
				{isRunning && (
					<div className="animate-spin duration-3000">
						<TodoProgressIcon size={14} />
					</div>
				)}
				{isCompleted && <TodoCheckIcon size={14} />}
				{isError && (
					<div className="text-vscode-errorForeground">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-label="Error">
							<title>Error</title>
							<path d="M8 7.293l3.646-3.647.708.708L8.707 8l3.647 3.646-.708.708L8 8.707l-3.646 3.647-.708-.708L7.293 8 3.646 4.354l.708-.708L8 7.293z" />
						</svg>
					</div>
				)}
			</div>

			<div className="flex-1 min-w-0 flex flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground flex items-center gap-1">
						<AgentsIcon size={10} />
						{subtask.agent.toUpperCase()}
					</span>
					<span className="text-xs opacity-70 truncate">
						{isCompleted && subtask.result ? subtask.result : subtask.description}
					</span>
				</div>
				{subtask.command && (
					<div className="text-xs font-mono opacity-50 truncate pl-0.5">$ {subtask.command}</div>
				)}
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{totalDuration && totalDuration > 0 ? (
					<span className="text-xs text-vscode-foreground opacity-70">
						{formatDuration(totalDuration)}
					</span>
				) : null}
				<div className="opacity-50 group-hover:opacity-100 transition-opacity">
					<ExpandChevronIcon expanded={isExpanded} size={14} />
				</div>
			</div>
		</div>
	);
};

// =============================================================================
// Subtask Message
// =============================================================================

interface SubtaskMessageProps {
	message: SubtaskMessageType;
}

export const SubtaskMessage: React.FC<SubtaskMessageProps> = ({ message }) => {
	// Auto-expand if running
	const [isExpanded, setIsExpanded] = useState(message.status === 'running');

	// Update expansion state when status changes to running
	useEffect(() => {
		if (message.status === 'running') {
			setIsExpanded(true);
		}
	}, [message.status]);

	// Use empty string if ID is undefined (shouldn't happen for persisted messages)
	const children = useSubtaskChildren(message.id || '');
	const mcpServers = useMcpServers();
	const serverNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

	const groupedChildren = useMemo(
		() => groupToolMessages(children, serverNames),
		[children, serverNames],
	);

	const totalDuration = useMemo(() => {
		let duration = 0;

		for (const msg of children) {
			if (msg.type === 'tool_result' || msg.type === 'thinking') {
				if (msg.durationMs) {
					duration += msg.durationMs;
				}
			}
		}
		return duration;
	}, [children]);

	if (!message) {
		return null;
	}

	return (
		<div className="my-2 border border-vscode-input-border rounded-md overflow-hidden bg-vscode-input-background">
			<SubtaskHeader
				subtask={message}
				isExpanded={isExpanded}
				onToggle={() => setIsExpanded(!isExpanded)}
				totalDuration={totalDuration}
			/>

			{isExpanded && (
				<div className="px-(--tool-content-padding) py-2 bg-(--tool-bg-header)">
					{groupedChildren.map((child, idx) => {
						// Check if there's following content after this item
						const hasFollowingContent =
							idx < groupedChildren.length - 1 &&
							groupedChildren.slice(idx + 1).some(item => {
								if (Array.isArray(item)) return false;
								return shouldTriggerCollapse(item as Message);
							});

						return (
							<ResponseItem
								key={Array.isArray(child) ? child[0]?.id || idx : child.id || idx}
								item={child}
								hasFollowingContent={hasFollowingContent}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
};
