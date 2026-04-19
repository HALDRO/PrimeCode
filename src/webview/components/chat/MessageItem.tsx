/**
 * @file MessageItem - unified renderer for message rows
 * @description Provides a single component responsible for rendering one chat “item” in the UI.
 * Supports grouped tool messages, tool cards, thinking blocks, access requests, subtasks (with nested
 * rendering), and notification messages. This keeps the `App` message list implementation small and
 * centralizes per-message branching in one place.
 */

import React, { useEffect, useMemo, useState } from 'react';
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
	CheckCircleIcon,
	ChevronDownIcon,
	CopyIcon,
	ListIcon,
	TodoCheckIcon,
	TodoPendingIcon,
	TodoProgressIcon,
	TokensIcon,
	WandIcon,
} from '../icons';
import { DropdownMenu, IconButton, Tooltip } from '../ui';
import type { DropdownMenuItem } from '../ui/Dropdown';
import { ScrollThumb } from '../ui/ScrollContainer';
import { AccessGate } from './AccessGate';
import { SubtaskGenerationStatus } from './GenerationStatus';
import { SubtaskTimer } from './LiveStats';
import {
	getGroupedItemShouldCollapse,
	InlineToolLine,
	SimpleTool,
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

const SUBTASK_EXPANDED_MAX_HEIGHT = 500;
const SUBTASK_STREAMING_PREVIEW_MAX_HEIGHT = 180;

function getReadableModelLabel(childModelId: string | undefined): string | undefined {
	if (!childModelId) return undefined;
	const trimmed = childModelId.trim();
	if (!trimmed) return undefined;
	const slashIndex = trimmed.lastIndexOf('/');
	return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function buildSubtaskPatches(items: Array<RenderMessage | RenderMessage[]>): string {
	const patches: string[] = [];
	const visit = (msg: RenderMessage) => {
		if (msg.kind !== 'tool_use') return;
		const meta = msg.metadata as Record<string, unknown> | undefined;
		const diff = meta?.diff;
		if (typeof diff === 'string' && diff.trim()) {
			patches.push(diff.trim());
		}
	};
	for (const item of items) {
		if (Array.isArray(item)) {
			for (const child of item) visit(child);
			continue;
		}
		visit(item);
	}
	return patches.join('\n\n');
}

function formatDiffCount(value: number): string {
	return `${value > 0 ? '+' : ''}${formatNumber(value)}`;
}

function formatAgentLabel(agent: string | undefined): string {
	const trimmed = agent?.trim();
	if (!trimmed) return 'SubAgent';
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function summarizePreviewTools(items: Array<RenderMessage | RenderMessage[]>): Array<{
	label: string;
	count: number;
	priority: number;
}> {
	const counts = new Map<string, { count: number; priority: number }>();

	const visit = (msg: RenderMessage) => {
		if (msg.kind !== 'tool_use') return;
		const rawName = (msg.toolName || '').toLowerCase();
		let label = formatToolName(msg.toolName || 'Tool');
		let priority = 10;

		if (rawName.includes('grep') || rawName.includes('search')) {
			label = 'Search';
			priority = 1;
		} else if (rawName.includes('read')) {
			label = 'Read';
			priority = 2;
		} else if (rawName.includes('edit') || rawName.includes('patch') || rawName.includes('write')) {
			label = 'Edit';
			priority = 3;
		} else if (rawName.includes('bash') || rawName.includes('command')) {
			label = 'Command';
			priority = 4;
		} else if (rawName.includes('glob') || rawName.includes('list')) {
			label = 'List';
			priority = 5;
		}

		const existing = counts.get(label);
		counts.set(label, {
			count: (existing?.count ?? 0) + 1,
			priority: Math.min(existing?.priority ?? priority, priority),
		});
	};

	for (const item of items) {
		if (Array.isArray(item)) {
			for (const child of item) visit(child);
			continue;
		}
		visit(item);
	}

	return Array.from(counts.entries())
		.map(([label, value]) => ({ label, count: value.count, priority: value.priority }))
		.sort((a, b) => a.priority - b.priority || b.count - a.count || a.label.localeCompare(b.label));
}

const PreviewToolSummary: React.FC<{
	toolSummary: Array<{ label: string; count: number }>;
	onOpenFullHistory: () => void;
}> = React.memo(({ toolSummary, onOpenFullHistory }) => {
	if (toolSummary.length === 0) return null;

	return (
		<SimpleTool
			icon={<ListIcon size={18} />}
			label={`Tools x${toolSummary.reduce((sum, item) => sum + item.count, 0)}`}
			meta={toolSummary.map(item => `${item.label} x${item.count}`).join(', ')}
			expanded={false}
			onToggle={onOpenFullHistory}
			className="mb-2"
		>
			<div aria-hidden="true" className="hidden" />
		</SimpleTool>
	);
});
PreviewToolSummary.displayName = 'PreviewToolSummary';

const SubtaskItem = React.memo<{
	message: RenderSubtaskMessage;
	ctx: MessageItemContext;
}>(({ message, ctx }) => {
	const [expandState, setExpandState] = useState<SubtaskExpandState>('preview');
	const [promptExpanded, setPromptExpanded] = useState(false);
	const [previewResultExpanded, setPreviewResultExpanded] = useState(false);
	const [showCopyMenu, setShowCopyMenu] = useState(false);
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const pendingAccess = useSubtaskAccessRequest(message.id);
	const {
		groupedChildren: rawGroupedChildren,
		childSessionTitle,
		totalDurationMs,
		tokenStats,
		childModelId,
		diffStats,
		taskResultEntry,
		taskResultContent,
	} = useSubtaskPreview(message.id || '', ctx.sessionId, mcpServerNames);

	const groupedChildren = rawGroupedChildren;
	const shouldRenderTaskResult = Boolean(taskResultEntry) && Boolean(taskResultContent);
	const toolSummary = useMemo(() => summarizePreviewTools(groupedChildren), [groupedChildren]);
	const patchText = useMemo(() => buildSubtaskPatches(groupedChildren), [groupedChildren]);

	const isRunning = message.status === 'running';
	const isPreviewMode = expandState === 'preview';
	const shouldRenderTranscript = expandState === 'expanded' || isRunning;

	const retryInfo = (
		message as typeof message & {
			retryInfo?: { message: string; attempt: number; nextRetryAt?: string };
		}
	).retryInfo;

	const agentLabel = formatAgentLabel(message.agent);
	const modelLabel = getReadableModelLabel(childModelId);
	const headerTitle = childSessionTitle?.trim() || message.description?.trim() || agentLabel;

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

	const openExpandedHistory = () => {
		setExpandState('expanded');
	};

	const renderedGroupedChildren = groupedChildren.map((child, idx) => {
		const key = Array.isArray(child)
			? (child[0]?.id ?? `tool-group-${idx}`)
			: (child.id ?? `message-${idx}`);
		return (
			<MessageItem
				key={key}
				item={child}
				ctx={{ ...ctx, isNestedSubtaskThread: true }}
				collapseGroupedTools={getGroupedItemShouldCollapse(child)}
			/>
		);
	});

	const copyMenuItems = useMemo<DropdownMenuItem<{ action: () => void }>[]>(() => {
		const items: DropdownMenuItem<{ action: () => void }>[] = [];
		if (taskResultContent.trim()) {
			items.push({
				id: 'copy-task-done',
				label: 'Copy Task Done',
				data: { action: () => void navigator.clipboard.writeText(taskResultContent) },
			});
		}
		if (patchText.trim()) {
			items.push({
				id: 'copy-patches',
				label: 'Copy Patch Diffs',
				data: { action: () => void navigator.clipboard.writeText(patchText) },
			});
		}
		return items;
	}, [taskResultContent, patchText]);

	// Meta info block (model) — reused in result & expanded
	const metaBlock = childModelId ? (
		<div className="mb-2 ml-2 animate-fade-slide-in">
			<div className="flex items-center gap-2 w-full min-w-0 overflow-hidden text-left bg-transparent border-none p-0 py-0.5 select-none">
				<span className="shrink-0 flex items-center justify-center text-vscode-descriptionForeground [&>svg]:w-[14px] [&>svg]:h-[14px]">
					<BotIcon size={14} />
				</span>
				<span className="text-sm font-medium whitespace-nowrap text-vscode-foreground opacity-80">
					{agentLabel}
				</span>
				<span className="text-sm text-vscode-descriptionForeground">·</span>
				<span className="min-w-0 overflow-hidden flex items-center shrink">
					<span className="text-sm truncate text-vscode-descriptionForeground">
						{modelLabel ?? childModelId}
					</span>
				</span>
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
					{headerTitle && (
						<span className="text-sm text-vscode-foreground truncate min-w-0">{headerTitle}</span>
					)}
				</>
			}
			headerRight={
				<span className="flex items-center gap-3 text-sm text-vscode-descriptionForeground group-hover/subtask:opacity-100">
					{copyMenuItems.length > 0 && (
						<div
							className="relative opacity-0 pointer-events-none transition-opacity group-hover/subtask:opacity-100 group-hover/subtask:pointer-events-auto"
							onMouseDown={e => e.stopPropagation()}
							onClick={e => e.stopPropagation()}
						>
							<Tooltip content="Copy options" position="top" delay={200}>
								<div>
									<IconButton
										icon={<CopyIcon size={12} />}
										onClick={e => {
											e.stopPropagation();
											setShowCopyMenu(prev => !prev);
										}}
										title="Copy options"
										size={18}
									/>
								</div>
							</Tooltip>
							{showCopyMenu && (
								<DropdownMenu
									items={copyMenuItems}
									onSelect={item => {
										item.action();
										setShowCopyMenu(false);
									}}
									onClose={() => setShowCopyMenu(false)}
									position="top"
									align="right"
									minWidth={180}
									maxWidth={220}
									keyHints={{}}
								/>
							)}
						</div>
					)}
					{(diffStats.added > 0 || diffStats.removed > 0) && (
						<>
							{diffStats.added > 0 && (
								<span className="text-success whitespace-nowrap text-right min-w-0">
									{formatDiffCount(diffStats.added)}
								</span>
							)}
							{diffStats.removed > 0 && (
								<span className="text-error whitespace-nowrap text-left min-w-0">
									-{formatNumber(diffStats.removed)}
								</span>
							)}
						</>
					)}
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
			className="my-2 group/subtask"
			body={
				<div className="relative bg-(--tool-bg-header)">
					<div
						ref={bodyRef}
						className="px-(--tool-content-padding) py-2 relative"
						style={
							expandState === 'expanded'
								? {
										maxHeight: SUBTASK_EXPANDED_MAX_HEIGHT,
										overflowX: 'hidden',
										overflowY: 'auto',
										scrollbarWidth: 'none' as const,
									}
								: isRunning && expandState === 'preview'
									? {
											maxHeight: SUBTASK_STREAMING_PREVIEW_MAX_HEIGHT,
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
								showCollapseOverlay
								className="mb-2"
							>
								<div className="text-sm text-vscode-descriptionForeground whitespace-pre-wrap">
									{message.prompt}
								</div>
							</SimpleTool>
						)}
						{expandState === 'expanded' && message.command && (
							<div className="text-xs font-mono opacity-50 truncate mb-2">$ {message.command}</div>
						)}
						{!shouldRenderTranscript ? (
							<>
								{pendingAccess && (
									<div className="mb-2 text-sm text-warning whitespace-pre-wrap break-words">
										Waiting for permission to continue
									</div>
								)}
								<PreviewToolSummary
									toolSummary={toolSummary}
									onOpenFullHistory={openExpandedHistory}
								/>
								{shouldRenderTaskResult && taskResultContent.trim() && (
									<SimpleTool
										icon={<CheckCircleIcon size={14} />}
										label="Task Done"
										meta={!previewResultExpanded ? taskResultContent : undefined}
										expanded={previewResultExpanded}
										onToggle={() => setPreviewResultExpanded(prev => !prev)}
										showCollapseOverlay
										className="mb-0"
									>
										<Markdown
											content={taskResultContent}
											className="[&_p]:!text-sm [&_p]:!text-vscode-descriptionForeground [&_li]:!text-sm [&_li]:!text-vscode-descriptionForeground [&_ul]:!text-sm [&_ol]:!text-sm !text-vscode-descriptionForeground"
										/>
									</SimpleTool>
								)}
							</>
						) : (
							renderedGroupedChildren
						)}
						{isRunning && (
							<SubtaskGenerationStatus
								isRunning={isRunning}
								status={message.status}
								retryMessage={retryInfo?.message}
							/>
						)}
						{shouldRenderTranscript && pendingAccess && (
							<AccessGate
								requestId={pendingAccess.requestId}
								messageId={pendingAccess.id}
								tool={pendingAccess.tool}
								input={pendingAccess.input}
								pattern={pendingAccess.pattern}
								className="my-2"
							/>
						)}
						{expandState === 'expanded' && shouldRenderTaskResult && (
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
					{isRunning && isPreviewMode && (
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
	sessionId: string;
}>(({ messages, shouldCollapse, sessionId }) => {
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

	const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
	const autoExpanded = isLive || !shouldCollapse;
	const expanded = manualExpanded ?? autoExpanded;

	// Reset manual override when collapse state changes (boundary appeared/disappeared)
	useEffect(() => {
		setManualExpanded(null);
	}, []);

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
			onToggle={() => setManualExpanded(prev => !(prev ?? autoExpanded))}
			showCollapseOverlay
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
						return <ToolCardMessage key={toolMsg.id} toolUse={toolMsg} sessionId={sessionId} />;
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
				<SimpleToolGroup
					messages={item as RenderMessage[]}
					shouldCollapse={collapseGroupedTools || getGroupedItemShouldCollapse(item)}
					sessionId={ctx.sessionId}
				/>
			);
		}

		switch (item.kind) {
			case 'tool_use': {
				const isCompactTool = item.toolName === 'Summarize Conversation';
				return (
					<div
						className={isCompactTool ? 'my-8 mb-(--tool-block-margin)' : 'mb-(--tool-block-margin)'}
					>
						<ToolCardMessage toolUse={item} sessionId={ctx.sessionId} />
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
