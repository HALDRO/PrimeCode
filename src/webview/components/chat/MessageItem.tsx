/**
 * @file MessageItem - unified renderer for message rows
 * @description Provides a single component responsible for rendering one chat “item” in the UI.
 * Supports grouped tool messages, tool cards, thinking blocks, access requests, subtasks (with nested
 * rendering), and notification messages. This keeps the `App` message list implementation small and
 * centralizes per-message branching in one place.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { useSubtaskThread } from '../../hooks/useSubtaskChildren';
import type { Message } from '../../store/chatStore';
import { useMcpServers, useSubtaskAccessRequest } from '../../store/selectors';
import { formatNumber, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import {
	BotIcon,
	ChevronDownIcon,
	ListIcon,
	TodoCheckIcon,
	TodoPendingIcon,
	TodoProgressIcon,
	TokensIcon,
	WandIcon,
} from '../icons';
import { AccessGate } from './AccessGate';
import { SubtaskTimer } from './LiveStats';
import { QuestionCard } from './QuestionCard';
import {
	InlineToolLine,
	liveToolGroups,
	SimpleTool,
	shouldCollapseGroupedItem,
	ThinkingMessage,
} from './SimpleTool';
import { ToolCard, ToolCardMessage } from './ToolCard';

interface MessageItemContext {
	totalSections: number;
}

const subtaskStatusIcon = (status: Extract<Message, { type: 'subtask' }>['status']) => {
	switch (status) {
		case 'running':
			return <TodoProgressIcon size={14} className="text-warning animate-spin-smooth" />;
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

type SubtaskExpandState = 'preview' | 'expanded';

const SUBTASK_PREVIEW_MAX_HEIGHT = 150;

const SubtaskItem: React.FC<{
	message: Extract<Message, { type: 'subtask' }>;
	ctx: MessageItemContext;
}> = ({ message, ctx }) => {
	const [expandState, setExpandState] = useState<SubtaskExpandState>('preview');
	const [promptExpanded, setPromptExpanded] = useState(false);
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const pendingAccess = useSubtaskAccessRequest(message.id);
	const {
		groupedChildren: rawGroupedChildren,
		totalDurationMs,
		tokenStats,
		childModelId,
	} = useSubtaskThread(message.id || '', mcpServerNames);

	// Strip trailing assistant message that duplicates the subtask result
	const groupedChildren = useMemo(() => {
		if (message.status === 'completed' && message.result && rawGroupedChildren.length > 0) {
			const last = rawGroupedChildren[rawGroupedChildren.length - 1];
			if (!Array.isArray(last) && last.type === 'assistant') {
				return rawGroupedChildren.slice(0, -1);
			}
		}
		return rawGroupedChildren;
	}, [rawGroupedChildren, message.status, message.result]);

	// Build TaskResult normalizedEntry from the subtask's own normalizedEntry or result text
	const taskResultEntry = useMemo((): NormalizedEntry | undefined => {
		if (message.status !== 'completed' || !message.result) return undefined;
		const existing = (message as unknown as { normalizedEntry?: NormalizedEntry }).normalizedEntry;
		if (
			existing?.entryType &&
			typeof existing.entryType === 'object' &&
			'actionType' in existing.entryType &&
			existing.entryType.actionType.type === 'TaskResult'
		) {
			return existing;
		}
		const cleaned = cleanSubtaskResult(message.result);
		return {
			timestamp: message.timestamp || new Date().toISOString(),
			entryType: {
				type: 'ToolUse',
				toolName: 'task',
				actionType: {
					type: 'TaskResult',
					description: message.description || '',
					result: cleaned,
					status: 'completed',
				},
				status: 'success',
			},
			content: cleaned,
		};
	}, [message.status, message.result, message.description, message.timestamp, message]);

	const isRunning = message.status === 'running';

	// Agent display name for the header
	const agentLabel =
		message.agent && message.agent !== 'subagent'
			? message.agent.charAt(0).toUpperCase() + message.agent.slice(1)
			: 'SubAgent';

	// Auto-scroll the preview container to bottom as content streams in.
	// Uses MutationObserver to catch all DOM changes (streaming text, new children, etc.)
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = bodyRef.current;
		if (!isRunning || !el) return;
		const scroll = () => {
			el.scrollTop = el.scrollHeight;
		};
		scroll();
		const observer = new MutationObserver(scroll);
		observer.observe(el, { childList: true, subtree: true, characterData: true });
		return () => observer.disconnect();
	}, [isRunning]);

	// Cycle: preview ↔ expanded
	const cycleExpand = () => {
		setExpandState(prev => (prev === 'preview' ? 'expanded' : 'preview'));
	};

	// Meta info block (model, task description) — reused in result & expanded
	const metaBlock =
		childModelId || message.description ? (
			<div className="text-sm text-vscode-descriptionForeground mb-2 flex flex-col gap-1">
				{childModelId && (
					<div className="flex items-center gap-2">
						<BotIcon size={14} className="shrink-0" />
						<span className="font-semibold text-vscode-foreground opacity-80">{childModelId}</span>
					</div>
				)}
				{message.description && (
					<div className="flex items-start gap-2">
						<span className="shrink-0 opacity-60">Task</span>
						<span className="text-vscode-descriptionForeground">·</span>
						<span>{message.description}</span>
					</div>
				)}
			</div>
		) : null;

	return (
		<ToolCard
			headerLeft={
				<>
					<span className="toolcard-leading-icon flex items-center justify-center w-5 h-5 shrink-0">
						{subtaskStatusIcon(message.status)}
					</span>
					<span className="text-sm font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground whitespace-nowrap">
						{agentLabel}
					</span>
				</>
			}
			headerRight={
				<span className="flex items-center gap-3 text-sm font-bold text-vscode-descriptionForeground">
					{tokenStats && (
						<span
							className="flex items-center gap-1"
							title={`Input: ${formatNumber(tokenStats.input)} · Output: ${formatNumber(tokenStats.output)}`}
						>
							<TokensIcon size={11} />
							{formatNumber(tokenStats.total)}
						</span>
					)}
					<SubtaskTimer
						isRunning={isRunning}
						startTime={message.startTime}
						fallbackMs={totalDurationMs}
					/>
				</span>
			}
			isCollapsible
			expanded
			showCollapseOverlay={expandState === 'expanded'}
			onToggle={cycleExpand}
			className="my-2"
			body={
				<div
					ref={bodyRef}
					className="px-(--tool-content-padding) py-2 bg-(--tool-bg-header) relative"
					style={
						isRunning && expandState === 'preview'
							? { maxHeight: SUBTASK_PREVIEW_MAX_HEIGHT, overflowY: 'auto' }
							: undefined
					}
				>
					{metaBlock}
					{message.prompt && message.prompt !== message.description && (
						<SimpleTool
							icon={<WandIcon size={14} />}
							label="Prompt"
							meta={!promptExpanded ? message.prompt : undefined}
							expanded={promptExpanded}
							onToggle={() => setPromptExpanded(prev => !prev)}
							className="mb-2"
						>
							<div className="text-sm text-vscode-descriptionForeground whitespace-pre-wrap">
								{message.prompt}
							</div>
						</SimpleTool>
					)}
					{message.command && (
						<div className="text-xs font-mono opacity-50 truncate mb-2">$ {message.command}</div>
					)}
					{(isRunning || expandState === 'expanded') &&
						groupedChildren.map((child, idx) => {
							const key = Array.isArray(child)
								? (child[0]?.id ?? `tool-group-${idx}`)
								: (child.id ?? `message-${idx}`);
							return (
								<MessageItem
									key={key}
									item={child}
									ctx={ctx}
									collapseGroupedTools={
										Array.isArray(child) || shouldCollapseGroupedItem(groupedChildren, idx)
									}
								/>
							);
						})}
					{pendingAccess && (
						<AccessGate
							requestId={pendingAccess.requestId}
							messageId={pendingAccess.id}
							tool={pendingAccess.tool}
							input={pendingAccess.input}
							pattern={pendingAccess.pattern}
							className="my-2"
						/>
					)}
					{taskResultEntry && (
						<InlineToolLine
							toolName="task"
							rawInput={{}}
							content={cleanSubtaskResult(message.result || '')}
							isError={false}
							normalizedEntry={taskResultEntry}
							showCollapseOverlay
						/>
					)}
				</div>
			}
		/>
	);
};

const TOOL_GROUP_PREVIEW_MAX_HEIGHT = 120;

const SimpleToolGroup: React.FC<{
	messages: Message[];
	shouldCollapse: boolean;
}> = ({ messages, shouldCollapse }) => {
	const isLive = liveToolGroups.has(messages);
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

	/** Ordered list of renderable items: tool_use messages and bridge messages (assistant/thinking) */
	const renderItems = useMemo(
		() =>
			messages.filter(
				m => m.type === 'tool_use' || m.type === 'assistant' || m.type === 'thinking',
			),
		[messages],
	);

	const [expanded, setExpanded] = useState(!shouldCollapse);
	const prevShouldCollapseRef = useRef(shouldCollapse);

	useEffect(() => {
		if (shouldCollapse && !prevShouldCollapseRef.current && !isLive) {
			setExpanded(false);
		}
		prevShouldCollapseRef.current = shouldCollapse;
	}, [shouldCollapse, isLive]);

	// Auto-scroll preview container to bottom as new tools stream in
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = bodyRef.current;
		if (!isLive || !el) return;
		const scroll = () => {
			el.scrollTop = el.scrollHeight;
		};
		scroll();
		const observer = new MutationObserver(scroll);
		observer.observe(el, { childList: true, subtree: true, characterData: true });
		return () => observer.disconnect();
	}, [isLive]);

	if (toolUseMessages.length === 0) return null;

	return (
		<SimpleTool
			icon={<ListIcon size={18} />}
			label={`Tools x${toolUseMessages.length}`}
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
			<div
				ref={bodyRef}
				className="pl-2 border-l border-(--border-subtle)"
				style={isLive ? { maxHeight: TOOL_GROUP_PREVIEW_MAX_HEIGHT, overflowY: 'auto' } : undefined}
			>
				{renderItems.map(msg => {
					if (msg.type === 'assistant') {
						return (
							<div
								key={msg.id}
								className="py-1 text-sm leading-(--line-height-base) font-(family-name:--font-family-base)"
								style={{ color: 'var(--input-text-color)' }}
							>
								<Markdown content={(msg as { content: string }).content || ''} />
							</div>
						);
					}
					if (msg.type === 'thinking') {
						return (
							<ThinkingMessage
								key={msg.id}
								content={(msg as Extract<Message, { type: 'thinking' }>).content || ''}
								durationMs={(msg as Extract<Message, { type: 'thinking' }>).durationMs}
								isStreaming={(msg as Extract<Message, { type: 'thinking' }>).isStreaming}
							/>
						);
					}
					// tool_use
					const toolMsg = msg as Extract<Message, { type: 'tool_use' }>;
					return (
						<ToolCardMessage
							key={toolMsg.id}
							message={toolMsg}
							toolResult={toolMsg.toolUseId ? localToolResults[toolMsg.toolUseId] : undefined}
						/>
					);
				})}
			</div>
		</SimpleTool>
	);
};

export const MessageItem = React.memo<{
	item: Message | Message[];
	ctx: MessageItemContext;
	collapseGroupedTools?: boolean;
}>(
	({ item, ctx, collapseGroupedTools = false }) => {
		if (Array.isArray(item)) {
			return <SimpleToolGroup messages={item} shouldCollapse={collapseGroupedTools} />;
		}

		switch (item.type) {
			case 'tool_use': {
				const isCompactTool = item.toolName === 'Summarize Conversation';
				return (
					<div
						className={isCompactTool ? 'my-8 mb-(--tool-block-margin)' : 'mb-(--tool-block-margin)'}
					>
						<ToolCardMessage message={item} />
					</div>
				);
			}
			case 'access_request':
				// All access requests are rendered inline inside the related ToolCard.
				return null;
			case 'question':
				return <QuestionCard message={item as Extract<Message, { type: 'question' }>} />;
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
	},
	(prev, next) =>
		prev.item === next.item &&
		prev.ctx === next.ctx &&
		prev.collapseGroupedTools === next.collapseGroupedTools,
);
MessageItem.displayName = 'MessageItem';
