/**
 * @file MessageItem - unified renderer for message rows
 * @description Provides a single component responsible for rendering one chat “item” in the UI.
 * Supports grouped tool messages, tool cards, thinking blocks, access requests, subtasks (with nested
 * rendering), and notification messages. This keeps the `App` message list implementation small and
 * centralizes per-message branching in one place.
 */

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSubtaskThread } from '../../hooks/useSubtaskChildren';
import type { Message } from '../../store/chatStore';
import { useMcpServers } from '../../store/selectors';
import { formatDuration, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import {
	ChevronDownIcon,
	ListIcon,
	TimerIcon,
	TodoCheckIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from '../icons';
import { SimpleTool, shouldCollapseGroupedItem, ThinkingMessage } from './SimpleTool';
import { ToolCard, ToolCardMessage } from './ToolCard';

export interface MessageItemContext {
	isProcessing: boolean;
	totalSections: number;
}

const subtaskStatusIcon = (status: Extract<Message, { type: 'subtask' }>['status']) => {
	switch (status) {
		case 'running':
			return <TodoProgressIcon size={14} className="text-warning" />;
		case 'completed':
			return <TodoCheckIcon size={14} className="text-success" />;
		case 'cancelled':
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-40" />;
		default:
			return <TodoPendingIcon size={14} className="text-error" />;
	}
};

/** Strip <task_result> XML wrapper and task_id prefix from subtask result text */
const cleanSubtaskResult = (raw: string): string => {
	let text = raw;
	// Remove task_id: ... line at the start
	text = text.replace(/^task_id:\s*\S+.*\n?/i, '');
	// Remove <task_result> / </task_result> wrappers
	text = text.replace(/<\/?task_result>/gi, '');
	// Remove <task_metadata>...</task_metadata> blocks
	text = text.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/gi, '');
	return text.trim();
};

const SubtaskItem: React.FC<{
	message: Extract<Message, { type: 'subtask' }>;
	ctx: MessageItemContext;
}> = ({ message, ctx }) => {
	const [expanded, setExpanded] = useState(message.status === 'running');
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const { groupedChildren, totalDurationMs } = useSubtaskThread(message.id || '', mcpServerNames);

	// Build the header description: prefer description, fall back to cleaned result
	const headerDescription = useMemo(() => {
		if (message.description) return message.description;
		if (message.status === 'completed' && message.result) {
			const cleaned = cleanSubtaskResult(message.result);
			// Take first line only for the header
			const firstLine = cleaned.split('\n')[0] || '';
			return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
		}
		return 'Running...';
	}, [message.description, message.result, message.status]);

	// Show subagent_type as a secondary label if it's meaningful (not just "subagent")
	const agentType = message.agent && message.agent !== 'subagent' ? message.agent : undefined;

	return (
		<ToolCard
			headerLeft={
				<>
					<span className="toolcard-leading-icon flex items-center justify-center w-5 h-5 shrink-0">
						{subtaskStatusIcon(message.status)}
					</span>
					<span className="text-xs font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground whitespace-nowrap">
						SUB-AGENT
					</span>
					{agentType && (
						<span className="text-xs text-vscode-foreground opacity-50 whitespace-nowrap">
							{agentType}
						</span>
					)}
					<span className="text-sm text-vscode-foreground opacity-80 truncate">
						{headerDescription}
					</span>
				</>
			}
			headerRight={
				totalDurationMs > 0 ? (
					<span className="flex items-center gap-1 text-xs text-vscode-foreground opacity-70">
						<TimerIcon size={11} />
						{formatDuration(totalDurationMs)}
					</span>
				) : undefined
			}
			isCollapsible
			expanded={expanded}
			onToggle={() => setExpanded(prev => !prev)}
			className="my-2"
			body={
				expanded ? (
					<div className="px-(--tool-content-padding) py-2 bg-(--tool-bg-header)">
						{message.command && (
							<div className="text-xs font-mono opacity-50 truncate mb-2">$ {message.command}</div>
						)}
						{groupedChildren.map((child, idx) => {
							const key = Array.isArray(child)
								? (child[0]?.id ?? `tool-group-${idx}`)
								: (child.id ?? `message-${idx}`);
							return (
								<MessageItem
									key={key}
									item={child}
									ctx={ctx}
									collapseGroupedTools={shouldCollapseGroupedItem(groupedChildren, idx)}
								/>
							);
						})}
						{groupedChildren.length === 0 && message.status === 'completed' && message.result && (
							<pre className="m-0 text-sm leading-(--line-height-code) whitespace-pre-wrap text-vscode-foreground opacity-80">
								{cleanSubtaskResult(message.result)}
							</pre>
						)}
					</div>
				) : undefined
			}
		/>
	);
};

const SimpleToolGroup: React.FC<{ messages: Message[]; shouldCollapse: boolean }> = ({
	messages,
	shouldCollapse,
}) => {
	const toolUseMessages = useMemo(
		() =>
			messages.filter((m): m is Extract<Message, { type: 'tool_use' }> => m.type === 'tool_use'),
		[messages],
	);
	const localToolResults = useMemo(() => {
		const results: Record<string, Extract<Message, { type: 'tool_result' }> | undefined> = {};
		for (const msg of messages) {
			if (msg.type === 'tool_result' && msg.toolUseId) {
				results[msg.toolUseId] = msg;
			}
		}
		return results;
	}, [messages]);

	const toolCountsLabel = useMemo(() => {
		const counts = new Map<string, number>();
		const order: string[] = [];

		for (const msg of toolUseMessages) {
			const name = formatToolName(msg.toolName || 'Tool');
			if (!counts.has(name)) {
				counts.set(name, 0);
				order.push(name);
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}

		return order.map(name => `${name} x${counts.get(name) ?? 0}`).join(', ');
	}, [toolUseMessages]);

	const [expanded, setExpanded] = useState(!shouldCollapse);
	const prevShouldCollapseRef = useRef(shouldCollapse);

	useEffect(() => {
		if (shouldCollapse && !prevShouldCollapseRef.current) {
			setExpanded(false);
		}
		prevShouldCollapseRef.current = shouldCollapse;
	}, [shouldCollapse]);

	if (toolUseMessages.length === 0) return null;

	return (
		<SimpleTool
			icon={<ListIcon size={18} />}
			label={`Tools · ${toolUseMessages.length}`}
			meta={toolCountsLabel}
			expanded={expanded}
			onToggle={() => setExpanded(prev => !prev)}
			contentClassName="pl-0 ml-0 border-none mt-1 py-0 overflow-x-visible"
			rightContent={
				<ChevronDownIcon
					size={14}
					className={expanded ? 'rotate-180 transition-transform' : 'transition-transform'}
				/>
			}
			className="mb-(--tool-block-margin)"
		>
			<div className="pl-2 border-l border-(--border-subtle)">
				{toolUseMessages.map(msg => (
					<ToolCardMessage
						key={msg.id}
						message={msg}
						toolResult={msg.toolUseId ? localToolResults[msg.toolUseId] : undefined}
					/>
				))}
			</div>
		</SimpleTool>
	);
};

export const MessageItem: React.FC<{
	item: Message | Message[];
	ctx: MessageItemContext;
	collapseGroupedTools?: boolean;
}> = ({ item, ctx, collapseGroupedTools = false }) => {
	if (Array.isArray(item)) {
		return <SimpleToolGroup messages={item} shouldCollapse={collapseGroupedTools} />;
	}

	switch (item.type) {
		case 'tool_use':
			return (
				<div className="mb-(--tool-block-margin)">
					<ToolCardMessage message={item} />
				</div>
			);
		case 'access_request':
			// All access requests are rendered inline inside the related ToolCard.
			return null;
		case 'subtask':
			return <SubtaskItem message={item} ctx={ctx} />;
		case 'assistant':
			return (
				<div
					className="bg-transparent py-(--message-padding-y) mb-(--message-gap) text-(length:--font-size-base) leading-(--line-height-base) font-(family-name:--font-family-base)"
					style={{ color: 'var(--input-text-color)' }}
				>
					<Markdown content={(item as { content: string }).content || ''} />
				</div>
			);
		case 'thinking':
			return (
				<ThinkingMessage
					content={(item as Extract<Message, { type: 'thinking' }>).content || ''}
					durationMs={(item as Extract<Message, { type: 'thinking' }>).durationMs}
					isStreaming={(item as Extract<Message, { type: 'thinking' }>).isStreaming}
				/>
			);
		default:
			return null;
	}
};
