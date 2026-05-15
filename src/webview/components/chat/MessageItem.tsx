/**
 * @file MessageItem - unified renderer for message rows
 * @description Provides a single component responsible for rendering one chat “item” in the UI.
 * Supports grouped tool messages, tool cards, thinking blocks, access requests, subtasks (with nested
 * rendering), and notification messages. This keeps the `App` message list implementation small and
 * centralizes per-message branching in one place.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { extractCanonicalTaskResult } from '../../../common';
import { STREAM_PREVIEW_MAX_HEIGHT, TOOL_CARD_EXPANDED_MAX_HEIGHT_PX } from '../../constants';
import { useContainerAutoScroll } from '../../hooks/useContainerAutoScroll';
import { cn } from '../../lib/cn';
import {
	type RenderAssistantMessage,
	type RenderNode,
	type RenderSystemEventNode,
	type RenderTaskCardNode,
	type RenderTaskResultNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	useChatStore,
	useChildSessionAgent,
	useChildSessionMessages,
	useChildSessionSlug,
	useChildSessionSummary,
	useChildSessionTitle,
	useMcpServers,
	useSubtaskAccessRequest,
} from '../../store';
import { formatNumber, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import {
	BotIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	FileTextIcon,
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
	getGroupedItemShouldCollapse,
	SimpleTool,
	ThinkingMessage,
	type ToolGroup,
} from './SimpleTool';
import { AnimatedCardBody, CopyButton, ToolCard, ToolCardMessage } from './ToolCard';
import { type GroupedResponseItem, groupToolMessages } from './toolGrouping';

interface MessageItemContext {
	totalSections: number;
	sessionId: string;
	isNestedSubtaskThread?: boolean;
}

const taskCardStatusIcon = (status: RenderTaskCardNode['status']) => {
	switch (status) {
		case 'running':
			return <TodoProgressIcon size={14} className="text-warning animate-spin-smooth" />;
		case 'completed':
			return <TodoCheckIcon size={14} className="text-success" />;
		case 'cancelled':
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-40" />;
		case 'pending':
			return <TodoProgressIcon size={14} className="text-warning animate-spin-smooth" />;
		default:
			return <TodoPendingIcon size={14} className="text-error" />;
	}
};

type SubtaskExpandState = 'preview' | 'expanded';

const SUBTASK_EXPANDED_MAX_HEIGHT = 500;
const SUBTASK_STREAMING_PREVIEW_MAX_HEIGHT = 180;
const SCROLL_TO_BOTTOM_BUTTON_CLASS_NAME =
	'absolute bottom-1 left-1/2 z-10 flex size-[22px] -translate-x-1/2 items-center justify-center rounded-full cursor-pointer ' +
	'bg-vscode-editor-background/80 text-vscode-foreground backdrop-blur-md transition-all duration-200 ' +
	'border border-[color-mix(in_srgb,var(--vscode-foreground)_10%,transparent)] ' +
	'shadow-[0_4px_12px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_50%,transparent)] ' +
	'hover:bg-vscode-editor-background/95 hover:shadow-[0_6px_16px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_60%,transparent)] ' +
	'active:scale-95';

function getReadableModelLabel(childModelId: string | undefined): string | undefined {
	if (!childModelId) return undefined;
	const trimmed = childModelId.trim();
	if (!trimmed) return undefined;
	// Strip only the provider prefix (part before the FIRST slash), preserving
	// any namespace segments in the model name (e.g. "kiro/claude-opus-4-6").
	const slashIndex = trimmed.indexOf('/');
	return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function formatAgentLabel(agent: string | undefined): string {
	const trimmed = agent?.trim().replace(/^@+/, '');
	if (!trimmed) return '';
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function getSystemEventMeta(content: string): string | undefined {
	return content
		.split('\n')
		.map(line => line.trim())
		.find(Boolean);
}

function stripSubagentSuffix(title: string | undefined): string {
	if (!title) return '';
	return title.replace(/\s*\(@[^)]*subagent\)\s*$/i, '').trim();
}

function summarizePreviewTools(items: Array<RenderNode | RenderNode[]>): Array<{
	label: string;
	count: number;
	priority: number;
}> {
	const counts = new Map<string, { count: number; priority: number }>();

	const visit = (msg: RenderNode) => {
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

function useGroupedTranscript(
	items: RenderNode[] | undefined,
	mcpServerNames: string[],
	isRunning: boolean,
): GroupedResponseItem[] {
	return useMemo(() => {
		if (!items || items.length === 0) return [];
		return groupToolMessages(items, mcpServerNames, isRunning);
	}, [items, mcpServerNames, isRunning]);
}

function TaskResultLine({ message }: { message: RenderTaskResultNode }) {
	const content = extractCanonicalTaskResult(message.content).trim();
	if (!content) return null;
	const taskIdLine = message.taskIdLine;

	return (
		<SimpleTool
			icon={<CheckCircleIcon size={14} />}
			label="Task Done"
			meta={content}
			defaultExpanded={false}
			showCollapseOverlay
			className="mb-0"
		>
			<Markdown
				content={content}
				className="[&_p]:!text-sm [&_p]:!text-vscode-descriptionForeground [&_li]:!text-sm [&_li]:!text-vscode-descriptionForeground [&_ul]:!text-sm [&_ol]:!text-sm !text-vscode-descriptionForeground"
			/>
			{taskIdLine && (
				<div className="mt-2 pt-1.5 border-t border-vscode-widget-border text-xs text-vscode-descriptionForeground opacity-50 font-mono select-all">
					{taskIdLine}
				</div>
			)}
		</SimpleTool>
	);
}

function SystemEventLine({ message }: { message: RenderSystemEventNode }) {
	const meta = useMemo(() => getSystemEventMeta(message.content), [message.content]);
	return (
		<SimpleTool
			icon={<FileTextIcon size={14} />}
			label={message.title}
			meta={meta}
			defaultExpanded={false}
			className="my-1 opacity-90"
			contentClassName="text-vscode-descriptionForeground"
		>
			<Markdown content={message.content} />
		</SimpleTool>
	);
}

const TaskCardItem = React.memo<{
	message: RenderTaskCardNode;
	ctx: MessageItemContext;
}>(({ message, ctx }) => {
	const [expandState, setExpandState] = useState<SubtaskExpandState>('preview');
	const [promptExpanded, setPromptExpanded] = useState(false);
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const pendingAccess = useSubtaskAccessRequest(message.id);

	// All data from the projector's pre-computed summary — no store access needed
	const { status, agent, description, prompt, category } = message;
	const { title, modelId: childModelId } = message.childSummary;
	const childSessionId = message.childSessionId;
	const liveChildSummary = useChildSessionSummary(childSessionId);
	const effectiveStatus =
		liveChildSummary.statusType === 'busy' || liveChildSummary.statusType === 'retry'
			? 'running'
			: status;
	const durationMs = liveChildSummary.durationMs ?? message.childSummary.durationMs;
	const childTokens = liveChildSummary.tokens ?? message.childSummary.tokens;
	const childCount = childSessionId ? liveChildSummary.childCount : message.childSummary.childCount;

	const childSessionAgent = useChildSessionAgent(childSessionId);
	const childSessionSlug = useChildSessionSlug(childSessionId);
	const childTitle = useChildSessionTitle(childSessionId);
	const rawChildItems = useChildSessionMessages(childSessionId);
	const taskResultItems = rawChildItems.filter(
		(item): item is RenderTaskResultNode => item.kind === 'task_result',
	);
	const isRunning = effectiveStatus === 'running';
	const isPending = effectiveStatus === 'pending';
	const isPreviewMode = expandState === 'preview';
	const shouldRenderTranscript = expandState === 'expanded' || isRunning;
	const groupedChildren = useGroupedTranscript(rawChildItems, mcpServerNames, isRunning);
	const toolSummary = useMemo(() => summarizePreviewTools(groupedChildren), [groupedChildren]);
	const retryInfo = message.retryInfo;

	const headerTitle = useMemo(
		() =>
			stripSubagentSuffix(childTitle) || stripSubagentSuffix(title) || description?.trim() || '',
		[childTitle, title, description],
	);
	const agentLabel = useMemo(
		() => formatAgentLabel(agent || childSessionAgent || childSessionSlug),
		[agent, childSessionAgent, childSessionSlug],
	);
	const effectiveModelId = childModelId;
	const modelLabel = useMemo(() => getReadableModelLabel(effectiveModelId), [effectiveModelId]);
	const shouldShowAgentMeta = agentLabel.trim().length > 0;
	const taskMetaItems = useMemo(() => {
		const items: Array<{ key: string; title: string; value: string }> = [];
		if (shouldShowAgentMeta && agentLabel) {
			items.push({ key: 'agent', title: `Agent: ${agentLabel}`, value: agentLabel });
		}
		if (effectiveModelId) {
			items.push({
				key: 'model',
				title: `Model: ${modelLabel ?? effectiveModelId}`,
				value: modelLabel ?? effectiveModelId,
			});
		}
		if (category) {
			items.push({ key: 'category', title: `Category: ${category}`, value: category });
		}
		return items;
	}, [agentLabel, category, effectiveModelId, modelLabel, shouldShowAgentMeta]);

	// Unified auto-scroll with detach support (mirrors main session behavior)
	const {
		scrollerRef: bodyRef,
		scrollerObjectRef: bodyObjectRef,
		showScrollToBottom: showSubtaskScrollBtn,
		scrollToBottom: subtaskScrollToBottom,
	} = useContainerAutoScroll({ active: isRunning });

	// Cycle: preview <-> expanded
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
				ctx={{
					...ctx,
					sessionId: childSessionId ?? ctx.sessionId,
					isNestedSubtaskThread: true,
				}}
				collapseGroupedTools={getGroupedItemShouldCollapse(child)}
			/>
		);
	});

	const childTranscriptBlock = <div className="flex flex-col gap-2">{renderedGroupedChildren}</div>;

	const metaBlock =
		taskMetaItems.length > 0 ? (
			<div className="mb-2 ml-2 animate-fade-slide-in">
				<div className="flex items-center gap-(--gap-1) w-full min-w-0 overflow-hidden py-0.5 text-vscode-descriptionForeground select-none">
					<span className="shrink-0 flex items-center justify-center [&>svg]:w-[14px] [&>svg]:h-[14px]">
						<BotIcon size={14} />
					</span>
					<div className="flex flex-wrap items-center gap-(--gap-1) min-w-0">
						{taskMetaItems.map(item => (
							<span
								key={item.key}
								title={item.title}
								className="inline-flex items-center max-w-[180px] h-(--badge-height) px-(--gap-1-5) rounded-sm border border-(--border-subtle) bg-(--alpha-5) text-xs leading-none text-vscode-descriptionForeground truncate"
							>
								<span className="truncate text-vscode-foreground opacity-80">{item.value}</span>
							</span>
						))}
					</div>
				</div>
			</div>
		) : null;

	const taskResultCopyText = useMemo(
		() =>
			taskResultItems
				.map(item => extractCanonicalTaskResult(item.content).trim())
				.filter(Boolean)
				.join('\n\n'),
		[taskResultItems],
	);

	return (
		<ToolCard
			headerLeft={
				<>
					<span className="toolcard-leading-icon flex items-center justify-center w-5 h-5 shrink-0">
						{taskCardStatusIcon(effectiveStatus)}
					</span>
					{headerTitle && (
						<span className="text-sm text-vscode-foreground truncate min-w-0">{headerTitle}</span>
					)}
					{childCount > 0 && (
						<span className="inline-flex items-center text-xs font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground shrink-0">
							+{childCount} levels
						</span>
					)}
				</>
			}
			headerRight={
				<span className="flex items-center gap-3 text-sm text-vscode-descriptionForeground group-hover/subtask:opacity-100">
					{taskResultItems.length > 0 && (
						<div
							className={cn(
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover/subtask:opacity-100',
							)}
						>
							<CopyButton text={taskResultCopyText} title="Copy task result" />
						</div>
					)}
					{childTokens && (
						<span
							className="flex items-center gap-1"
							title={`Input: ${formatNumber(childTokens.input)} · Output: ${formatNumber(childTokens.output)}`}
						>
							<TokensIcon size={11} />
							{formatNumber(childTokens.total ?? 0)}
						</span>
					)}
					<SubtaskTimer
						isRunning={isRunning}
						startTime={message.startTime}
						fallbackMs={durationMs ?? 0}
					/>
				</span>
			}
			isCollapsible
			expanded
			showCollapseOverlay={expandState === 'expanded'}
			onToggle={cycleExpand}
			className={
				ctx.isNestedSubtaskThread
					? 'my-1.5 group/subtask ml-2 opacity-90 border-l border-vscode-widget-border pl-0'
					: 'my-2 group/subtask'
			}
			body={
				isPending &&
				!metaBlock &&
				toolSummary.length === 0 &&
				taskResultItems.length === 0 ? undefined : (
					<div className="relative bg-(--tool-bg-header)">
						<AnimatedCardBody
							expanded={expandState === 'expanded'}
							previewHeight={SUBTASK_STREAMING_PREVIEW_MAX_HEIGHT}
							expandedHeight={Math.min(
								SUBTASK_EXPANDED_MAX_HEIGHT,
								TOOL_CARD_EXPANDED_MAX_HEIGHT_PX,
							)}
						>
							<div
								ref={bodyRef}
								className="px-(--tool-content-padding) py-2 relative overflow-x-hidden overflow-y-auto"
								style={{ scrollbarWidth: 'none' }}
							>
								{metaBlock}
								{prompt && prompt !== description && (
									<SimpleTool
										icon={<WandIcon size={14} />}
										label="Prompt"
										meta={!promptExpanded ? prompt : undefined}
										expanded={promptExpanded}
										onToggle={() => setPromptExpanded(prev => !prev)}
										showCollapseOverlay
										className="mb-2"
									>
										<div className="text-sm text-vscode-descriptionForeground whitespace-pre-wrap">
											{prompt}
										</div>
									</SimpleTool>
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
										{taskResultItems.map(item => (
											<TaskResultLine key={item.id} message={item} />
										))}
									</>
								) : (
									childTranscriptBlock
								)}
								{isRunning && (
									<SubtaskGenerationStatus
										isRunning={isRunning}
										status={effectiveStatus}
										retryMessage={retryInfo?.message}
									/>
								)}
								{shouldRenderTranscript && pendingAccess && (
									<AccessGate
										requestId={pendingAccess.requestId}
										sessionId={ctx.sessionId}
										messageId={pendingAccess.id}
										tool={pendingAccess.tool}
										input={pendingAccess.input}
										pattern={pendingAccess.pattern}
										className="my-2"
									/>
								)}
							</div>
						</AnimatedCardBody>
						{isRunning && isPreviewMode && (
							<>
								<ScrollThumb scrollerRef={bodyObjectRef} autoHideDelay={800} />
								{showSubtaskScrollBtn && (
									<button
										type="button"
										onClick={subtaskScrollToBottom}
										aria-label="Scroll to bottom"
										className={SCROLL_TO_BOTTOM_BUTTON_CLASS_NAME}
										title="Scroll to bottom"
									>
										<ChevronDownIcon size={12} />
									</button>
								)}
							</>
						)}
					</div>
				)
			}
		/>
	);
});
TaskCardItem.displayName = 'TaskCardItem';

const SimpleToolGroup = React.memo<{
	messages: RenderNode[];
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
				const partsByMessageId = useChatStore.getState().parts;
				let skillName: string | undefined;
				for (const messageParts of Object.values(partsByMessageId)) {
					if (!Array.isArray(messageParts)) continue;
					for (const part of messageParts) {
						if (part.type !== 'tool') continue;
						const candidate = part as import('@opencode-ai/sdk/v2/client').ToolPart;
						if (candidate.callID !== msg.toolUseId) continue;
						const input =
							'input' in candidate.state &&
							candidate.state.input &&
							typeof candidate.state.input === 'object'
								? (candidate.state.input as { name?: string })
								: undefined;
						skillName = input?.name;
						break;
					}
					if (skillName) break;
				}
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

	/** Ordered list of renderable items: tool_use, task_result, and bridge messages (assistant/thinking) */
	const renderItems = useMemo(
		() =>
			messages.filter(
				m =>
					m.kind === 'tool_use' ||
					m.kind === 'task_result' ||
					m.kind === 'assistant' ||
					m.kind === 'thinking',
			),
		[messages],
	);

	const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
	const autoExpanded = isLive || !shouldCollapse;
	const expanded = manualExpanded ?? autoExpanded;
	const prevAutoExpandedRef = useRef(autoExpanded);
	const prevIsLiveRef = useRef(isLive);

	// Reset manual override when auto expansion policy changes so the group can
	// follow the latest auto-expanded/auto-collapsed state instead of getting stuck.
	useEffect(() => {
		if (prevAutoExpandedRef.current !== autoExpanded) {
			setManualExpanded(null);
		}
		prevAutoExpandedRef.current = autoExpanded;
	}, [autoExpanded]);

	// When live streaming ends, auto-collapse the trailing tool group unless the
	// user explicitly collapsed/expanded it after the stream already ended.
	useEffect(() => {
		if (prevIsLiveRef.current && !isLive && manualExpanded === null) {
			setManualExpanded(false);
		}
		prevIsLiveRef.current = isLive;
	}, [isLive, manualExpanded]);

	// Unified auto-scroll with detach support (mirrors main session behavior)
	const {
		scrollerRef: bodyRef,
		scrollerObjectRef: bodyObjectRef2,
		showScrollToBottom: showToolGroupScrollBtn,
		scrollToBottom: toolGroupScrollToBottom,
	} = useContainerAutoScroll({ active: isLive });

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
									maxHeight: STREAM_PREVIEW_MAX_HEIGHT,
									overflowX: 'hidden',
									overflowY: 'auto',
									scrollbarWidth: 'none' as const,
								}
							: undefined
					}
				>
					{renderItems.map((msg, idx) => {
						const previousMsg = idx > 0 ? renderItems[idx - 1] : undefined;
						if (msg.kind === 'task_result') {
							return <TaskResultLine key={msg.id} message={msg as RenderTaskResultNode} />;
						}
						if (msg.kind === 'assistant') {
							const content = (msg as RenderAssistantMessage).content || '';
							if (!content.trim()) return null;
							return (
								<div
									key={msg.id}
									className={cn(
										'pb-1 pl-2 opacity-90',
										previousMsg?.kind === 'thinking' ? 'pt-0' : 'pt-1',
									)}
								>
									<Markdown content={content} />
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
									inheritPreviewHeight
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
						<ScrollThumb scrollerRef={bodyObjectRef2} autoHideDelay={800} />
						{showToolGroupScrollBtn && (
							<button
								type="button"
								onClick={toolGroupScrollToBottom}
								aria-label="Scroll to bottom"
								className={SCROLL_TO_BOTTOM_BUTTON_CLASS_NAME}
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
	item: RenderNode | RenderNode[];
	ctx: MessageItemContext;
	collapseGroupedTools?: boolean;
}>(
	({ item, ctx, collapseGroupedTools = false }) => {
		if (Array.isArray(item)) {
			return (
				<SimpleToolGroup
					messages={item as RenderNode[]}
					shouldCollapse={collapseGroupedTools || getGroupedItemShouldCollapse(item)}
					sessionId={ctx.sessionId}
				/>
			);
		}

		switch (item.kind) {
			case 'task_result':
				return <TaskResultLine message={item} />;
			case 'system_event':
				return <SystemEventLine message={item} />;
			case 'tool_use': {
				return (
					<div className="mb-(--tool-block-margin)">
						<ToolCardMessage toolUse={item} sessionId={ctx.sessionId} />
					</div>
				);
			}
			case 'task_card':
				return <TaskCardItem message={item} ctx={ctx} />;
			case 'assistant': {
				if (item.agent === 'compaction') return null;
				const assistantContent = (item as RenderAssistantMessage).content || '';
				if (!assistantContent.trim()) return null;
				return (
					<div
						className="bg-transparent py-(--message-padding-y) mb-(--message-gap) text-(length:--font-size-base) leading-(--line-height-base) font-(family-name:--font-family-base)"
						style={{ color: 'var(--input-text-color)' }}
					>
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
