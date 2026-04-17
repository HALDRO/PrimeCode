/**
 * @file MessageItem - unified renderer for message rows
 * @description Provides a single component responsible for rendering one chat “item” in the UI.
 * Supports grouped tool messages, tool cards, thinking blocks, access requests, subtasks (with nested
 * rendering), and notification messages. This keeps the `App` message list implementation small and
 * centralizes per-message branching in one place.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useContainerAutoScroll } from '../../hooks/useContainerAutoScroll';
import { useSubtaskPreview } from '../../hooks/useSubtaskChildren';
import {
	type RenderAssistantMessage,
	type RenderMessage,
	type RenderSubtaskMessage,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	useMcpServers,
	useSubtaskAccessRequest,
} from '../../store';
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
import { ScrollThumb } from '../ui/ScrollContainer';
import { AccessGate } from './AccessGate';
import { SubtaskGenerationStatus } from './GenerationStatus';
import { SubtaskTimer } from './LiveStats';
import {
	InlineToolLine,
	SimpleTool,
	shouldCollapseGroupedItem,
	ThinkingMessage,
	type ToolGroup,
} from './SimpleTool';
import { ToolCard, ToolCardMessage } from './ToolCard';

interface MessageItemContext {
	totalSections: number;
	sessionId: string;
	isNestedSubtaskThread?: boolean;
}

const subtaskStatusIcon = (status: RenderSubtaskMessage['status']) => {
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

type SubtaskExpandState = 'preview' | 'expanded';

const SUBTASK_PREVIEW_MAX_HEIGHT = 150;

const SubtaskItem = React.memo<{
	message: RenderSubtaskMessage;
	ctx: MessageItemContext;
}>(({ message, ctx }) => {
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
		taskResultEntry,
		taskResultContent,
	} = useSubtaskPreview(message.id || '', ctx.sessionId, mcpServerNames);

	const groupedChildren = rawGroupedChildren;
	const shouldRenderTaskResult = Boolean(taskResultEntry) && Boolean(taskResultContent);

	const isRunning = message.status === 'running';

	const retryInfo = (
		message as typeof message & {
			retryInfo?: { message: string; attempt: number; nextRetryAt?: string };
		}
	).retryInfo;

	// Agent display name for the header
	const agentLabel =
		message.agent && message.agent !== 'subagent'
			? message.agent.charAt(0).toUpperCase() + message.agent.slice(1)
			: 'SubAgent';

	// Unified auto-scroll with detach support (mirrors main session behavior)
	const {
		scrollerRef: bodyRef,
		showScrollToBottom: showSubtaskScrollBtn,
		scrollToBottom: subtaskScrollToBottom,
	} = useContainerAutoScroll({ active: isRunning });

	// Cycle: preview ↔ expanded
	const cycleExpand = () => {
		setExpandState(prev => (prev === 'preview' ? 'expanded' : 'preview'));
	};

	// Meta info block (model) — reused in result & expanded
	const metaBlock = childModelId ? (
		<div className="text-sm text-vscode-descriptionForeground mb-2 flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<BotIcon size={14} className="shrink-0" />
				<span className="font-semibold text-vscode-foreground opacity-80">{childModelId}</span>
			</div>
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
					{message.description && (
						<span className="text-sm text-vscode-descriptionForeground truncate min-w-0">
							{message.description}
						</span>
					)}
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
							{formatNumber(tokenStats.total ?? 0)}
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
				<div className="relative bg-(--tool-bg-header)">
					<div
						ref={bodyRef}
						className="px-(--tool-content-padding) py-2 relative"
						style={
							isRunning && expandState === 'preview'
								? {
										maxHeight: SUBTASK_PREVIEW_MAX_HEIGHT,
										overflowX: 'hidden',
										overflowY: 'auto',
										scrollbarWidth: 'none' as const,
									}
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
						{groupedChildren.map((child, idx) => {
							const key = Array.isArray(child)
								? (child[0]?.id ?? `tool-group-${idx}`)
								: (child.id ?? `message-${idx}`);
							const forceCollapse = !isRunning && expandState !== 'expanded';
							return (
								<MessageItem
									key={key}
									item={child}
									ctx={{ ...ctx, isNestedSubtaskThread: true }}
									collapseGroupedTools={
										forceCollapse ||
										Array.isArray(child) ||
										shouldCollapseGroupedItem(groupedChildren, idx)
									}
								/>
							);
						})}
						{isRunning && (
							<SubtaskGenerationStatus
								isRunning={isRunning}
								status={message.status}
								retryMessage={retryInfo?.message}
							/>
						)}
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
						{shouldRenderTaskResult && (
							<InlineToolLine
								toolName="task"
								rawInput={{}}
								content={taskResultContent}
								isError={false}
								normalizedEntry={taskResultEntry}
								showCollapseOverlay
							/>
						)}
					</div>
					{isRunning && expandState === 'preview' && (
						<>
							<ScrollThumb scrollerRef={bodyRef} autoHideDelay={800} />
							{showSubtaskScrollBtn && (
								<button
									type="button"
									onClick={subtaskScrollToBottom}
									aria-label="Scroll to bottom"
									className="absolute bottom-1 left-1/2 z-10 flex items-center justify-center rounded-md cursor-pointer border-none transition-opacity duration-200"
									style={{
										transform: 'translateX(-50%)',
										width: 22,
										height: 22,
										backgroundColor: 'var(--vscode-editor-background)',
										color: 'var(--vscode-foreground)',
										boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
										opacity: 0.9,
									}}
									title="Scroll to bottom"
								>
									<ChevronDownIcon size={12} />
								</button>
							)}
						</>
					)}
				</div>
			}
		/>
	);
});
SubtaskItem.displayName = 'SubtaskItem';

const TOOL_GROUP_PREVIEW_MAX_HEIGHT = 120;

const SimpleToolGroup = React.memo<{
	messages: RenderMessage[];
	shouldCollapse: boolean;
}>(({ messages, shouldCollapse }) => {
	const isLive = (messages as ToolGroup).isLive ?? false;
	const toolUseMessages = useMemo(
		() => messages.filter((m): m is RenderToolUseMessage => m.kind === 'tool_use'),
		[messages],
	);

	const toolCountsLabel = useMemo(() => {
		const counts = new Map<string, number>();
		const order: string[] = [];

		for (const msg of toolUseMessages) {
			let name = formatToolName(msg.toolName || 'Tool');
			if ((msg.toolName || '').toLowerCase() === 'skill') {
				const skillName = (msg.rawInput as { name?: string } | undefined)?.name;
				if (skillName) {
					name = `Skill: ${skillName}`;
				}
			}
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
				m => m.kind === 'tool_use' || m.kind === 'assistant' || m.kind === 'thinking',
			),
		[messages],
	);

	const [expanded, setExpanded] = useState(isLive);
	const wasLiveRef = useRef(isLive);
	const prevShouldCollapseRef = useRef(shouldCollapse);
	const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		if (isLive && !wasLiveRef.current) {
			// Group became live — expand it and cancel any pending collapse
			clearTimeout(collapseTimerRef.current);
			setExpanded(true);
		} else if (!isLive && wasLiveRef.current) {
			// isLive went false — group finished streaming.
			// Don't collapse immediately: wait for shouldCollapse (real content
			// appeared after the group). If shouldCollapse doesn't arrive within
			// a reasonable window (e.g. group is last in the list), collapse via
			// fallback timer so the group doesn't stay open forever.
			if (shouldCollapse) {
				setExpanded(false);
			} else {
				collapseTimerRef.current = setTimeout(() => setExpanded(false), 800);
			}
		}
		wasLiveRef.current = isLive;
	}, [isLive, shouldCollapse]);

	useEffect(() => {
		if (shouldCollapse && !prevShouldCollapseRef.current) {
			// As soon as a real post-group item appears, collapse immediately.
			// Waiting for isLive=false makes live streaming keep the group open
			// until the end of the turn, which breaks the expected behavior.
			clearTimeout(collapseTimerRef.current);
			setExpanded(false);
		}
		prevShouldCollapseRef.current = shouldCollapse;
	}, [shouldCollapse]);

	// Cleanup timer on unmount
	useEffect(() => () => clearTimeout(collapseTimerRef.current), []);

	// Unified auto-scroll with detach support (mirrors main session behavior)
	const {
		scrollerRef: bodyRef,
		showScrollToBottom: showToolGroupScrollBtn,
		scrollToBottom: toolGroupScrollToBottom,
	} = useContainerAutoScroll({ active: isLive, observeCharacterData: true });

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
			<div className="relative">
				<div
					ref={bodyRef}
					className="pl-2 border-l border-(--border-subtle)"
					style={
						isLive
							? {
									maxHeight: TOOL_GROUP_PREVIEW_MAX_HEIGHT,
									overflowX: 'hidden',
									overflowY: 'auto',
									scrollbarWidth: 'none' as const,
								}
							: undefined
					}
				>
					{renderItems.map(msg => {
						if (msg.kind === 'assistant') {
							const assistantContent = (msg as RenderAssistantMessage).content || '';
							if (!assistantContent.trim()) return null;
							return (
								<div
									key={msg.id}
									className="py-1 text-sm leading-(--line-height-base) font-(family-name:--font-family-base)"
									style={{ color: 'var(--input-text-color)' }}
								>
									<Markdown
										content={assistantContent}
										isStreaming={(msg as RenderAssistantMessage).isStreaming}
									/>
								</div>
							);
						}
						if (msg.kind === 'thinking') {
							return (
								<ThinkingMessage
									key={msg.id}
									content={(msg as RenderThinkingMessage).content || ''}
									durationMs={(msg as RenderThinkingMessage).durationMs}
									isStreaming={(msg as RenderThinkingMessage).isStreaming}
									startTime={(msg as RenderThinkingMessage).startTime}
								/>
							);
						}
						// tool_use
						const toolMsg = msg as RenderToolUseMessage;
						return <ToolCardMessage key={toolMsg.id} toolUse={toolMsg} />;
					})}
				</div>
				{isLive && (
					<>
						<ScrollThumb scrollerRef={bodyRef} autoHideDelay={800} />
						{showToolGroupScrollBtn && (
							<button
								type="button"
								onClick={toolGroupScrollToBottom}
								aria-label="Scroll to bottom"
								className="absolute bottom-1 left-1/2 z-10 flex items-center justify-center rounded-md cursor-pointer border-none transition-opacity duration-200"
								style={{
									transform: 'translateX(-50%)',
									width: 20,
									height: 20,
									backgroundColor: 'var(--vscode-editor-background)',
									color: 'var(--vscode-foreground)',
									boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
									opacity: 0.9,
								}}
								title="Scroll to bottom"
							>
								<ChevronDownIcon size={10} />
							</button>
						)}
					</>
				)}
			</div>
		</SimpleTool>
	);
});
SimpleToolGroup.displayName = 'SimpleToolGroup';

export const MessageItem = React.memo<{
	item: RenderMessage | RenderMessage[];
	ctx: MessageItemContext;
	collapseGroupedTools?: boolean;
}>(
	({ item, ctx, collapseGroupedTools = false }) => {
		if (Array.isArray(item)) {
			return (
				<SimpleToolGroup messages={item as RenderMessage[]} shouldCollapse={collapseGroupedTools} />
			);
		}

		switch (item.kind) {
			case 'tool_use': {
				const isCompactTool = item.toolName === 'Summarize Conversation';
				return (
					<div
						className={isCompactTool ? 'my-8 mb-(--tool-block-margin)' : 'mb-(--tool-block-margin)'}
					>
						<ToolCardMessage toolUse={item} />
					</div>
				);
			}
			case 'subtask':
				return <SubtaskItem message={item} ctx={ctx} />;
			case 'assistant': {
				const assistantContent = (item as RenderAssistantMessage).content || '';
				if (!assistantContent.trim()) return null;
				const assistantAgent = item.agent;
				const agentBadge =
					!ctx.isNestedSubtaskThread && assistantAgent && assistantAgent !== 'build' ? (
						<span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground mb-1">
							{assistantAgent.charAt(0).toUpperCase() + assistantAgent.slice(1)}
						</span>
					) : null;
				return (
					<div
						className="bg-transparent py-(--message-padding-y) mb-(--message-gap) text-(length:--font-size-base) leading-(--line-height-base) font-(family-name:--font-family-base)"
						style={{ color: 'var(--input-text-color)' }}
					>
						{agentBadge}
						<Markdown
							content={assistantContent}
							isStreaming={(item as RenderAssistantMessage).isStreaming}
						/>
					</div>
				);
			}
			case 'thinking':
				return (
					<ThinkingMessage
						content={(item as RenderThinkingMessage).content || ''}
						durationMs={(item as RenderThinkingMessage).durationMs}
						isStreaming={(item as RenderThinkingMessage).isStreaming}
						startTime={(item as RenderThinkingMessage).startTime}
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
