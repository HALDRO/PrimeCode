import { AnimatePresence, motion } from 'framer-motion';
import React, { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NormalizedEntry } from '../../../common/normalizedTypes';
import {
	resolveToolName,
	STREAM_PREVIEW_MAX_HEIGHT,
	TOOL_CARD_EXPANDED_MAX_HEIGHT,
	UI_CARD_EXPAND_ANIMATE,
	UI_CARD_EXPAND_EXIT,
	UI_CARD_EXPAND_INITIAL,
	UI_CARD_EXPAND_OFFSET_ANIMATE,
	UI_CARD_EXPAND_OFFSET_EXIT,
	UI_CARD_EXPAND_OFFSET_INITIAL,
	UI_CARD_MOUNT_ANIMATE,
	UI_CARD_MOUNT_INITIAL,
	UI_MOTION_FRAMER_TRANSITION,
} from '../../constants';
import { useContainerAutoScroll } from '../../hooks/useContainerAutoScroll';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { formatDuration, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { useVSCode } from '../../utils/vscode';
import {
	BrainSideIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	FileTextIcon,
	FolderOpenIcon,
	SearchIcon,
	TimerIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
	WandIcon,
	ZapIcon,
} from '../icons';
import { Badge, CollapseOverlay, PathChip } from '../ui';
import { ScrollThumb } from '../ui/ScrollContainer';

/** Module-level component — avoids full DOM remount on every parent render */
const TodoStatusIcon: React.FC<{ status: string }> = ({ status }) => {
	switch (status) {
		case 'completed':
			return <TodoCheckIcon size={14} className="text-success shrink-0" />;
		case 'in_progress':
			return <TodoProgressIcon size={14} className="text-warning shrink-0" />;
		case 'cancelled':
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-40 shrink-0" />;
		default:
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-60 shrink-0" />;
	}
};

export const THINKING_TEXT_CLASS_NAME =
	'[&_p]:!text-sm [&_p]:!text-vscode-descriptionForeground [&_li]:!text-sm [&_li]:!text-vscode-descriptionForeground [&_ul]:!text-sm [&_ol]:!text-sm !text-vscode-descriptionForeground';

interface SimpleToolProps {
	icon: ReactNode;
	label: string;
	meta?: ReactNode;
	rightContent?: ReactNode;
	children?: ReactNode;
	defaultExpanded?: boolean;
	/** Controlled expanded state (optional). When provided, internal state is not used. */
	expanded?: boolean;
	/** Toggle handler for controlled expanded state. */
	onToggle?: () => void;
	isError?: boolean;
	className?: string;
	/** Optional override for the expandable content wrapper styling. */
	contentClassName?: string;
	/** Show a CollapseOverlay at the bottom of expanded content. */
	showCollapseOverlay?: boolean;
	maxExpandedHeight?: string;
	autoScrollActive?: boolean;
}

export const SimpleTool: React.FC<SimpleToolProps> = ({
	icon,
	label,
	meta,
	rightContent,
	children,
	defaultExpanded = false,
	expanded: controlledExpanded,
	onToggle,
	isError,
	className,
	contentClassName,
	showCollapseOverlay = false,
	maxExpandedHeight = TOOL_CARD_EXPANDED_MAX_HEIGHT,
	autoScrollActive = false,
}) => {
	const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
	const contentId = useId();
	const hasContent = Boolean(children);
	const { scrollerRef, scrollerObjectRef, showScrollToBottom, scrollToBottom } =
		useContainerAutoScroll({ active: autoScrollActive });

	const isControlled = controlledExpanded !== undefined;
	const expanded = isControlled ? controlledExpanded : uncontrolledExpanded;

	const toggle = () => {
		if (!hasContent) return;
		if (isControlled) {
			onToggle?.();
			return;
		}
		setUncontrolledExpanded(prev => !prev);
	};

	return (
		<motion.div
			className={cn('mb-(--tool-utility-block-margin) ml-2', className)}
			initial={UI_CARD_MOUNT_INITIAL}
			animate={UI_CARD_MOUNT_ANIMATE}
			transition={UI_MOTION_FRAMER_TRANSITION}
		>
			<button
				type="button"
				onClick={toggle}
				aria-expanded={hasContent ? expanded : undefined}
				aria-controls={hasContent ? contentId : undefined}
				className={cn(
					'group flex items-center gap-2 w-full min-w-0 overflow-hidden text-left bg-transparent border-none p-0',
					'cursor-pointer hover:bg-vscode-toolbar-hoverBackground rounded px-1 -mx-1 py-0.5 select-none',
					'outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
					!hasContent && 'cursor-default hover:bg-transparent',
				)}
			>
				<span
					className={cn(
						'shrink-0 flex items-center justify-center text-vscode-descriptionForeground',
						isError ? 'text-error' : '',
						'[&>svg]:w-[14px] [&>svg]:h-[14px]',
					)}
				>
					{icon}
				</span>

				<span
					className={cn(
						'text-sm font-medium whitespace-nowrap text-vscode-foreground opacity-80',
						isError && 'text-error !opacity-100',
					)}
				>
					{label}
				</span>

				{meta && (
					<>
						<span className="text-sm text-vscode-descriptionForeground">·</span>
						<span className="min-w-0 overflow-hidden flex items-center shrink">
							{typeof meta === 'string' || typeof meta === 'number' ? (
								<span className="text-sm truncate text-vscode-descriptionForeground">{meta}</span>
							) : (
								meta
							)}
						</span>
					</>
				)}

				{rightContent && (
					<span className="flex items-center gap-2 text-sm shrink-0 min-w-0 text-vscode-descriptionForeground">
						{rightContent}
					</span>
				)}
			</button>
			<AnimatePresence initial={false}>
				{expanded && hasContent && (
					<motion.div
						className="relative group"
						initial={UI_CARD_EXPAND_INITIAL}
						animate={UI_CARD_EXPAND_ANIMATE}
						exit={UI_CARD_EXPAND_EXIT}
						transition={UI_MOTION_FRAMER_TRANSITION}
					>
						<motion.div
							id={contentId}
							initial={UI_CARD_EXPAND_OFFSET_INITIAL}
							animate={UI_CARD_EXPAND_OFFSET_ANIMATE}
							exit={UI_CARD_EXPAND_OFFSET_EXIT}
							transition={UI_MOTION_FRAMER_TRANSITION}
							className={cn(
								'pl-3 ml-1 border-l border-(--border-subtle) mt-1 py-1 text-sm overflow-hidden',
								contentClassName,
							)}
						>
							<div className="relative">
								<div
									ref={scrollerRef}
									style={{ maxHeight: maxExpandedHeight, scrollbarWidth: 'none' }}
									className="overflow-x-auto overflow-y-auto animate-fade-in"
								>
									{children}
								</div>
								{autoScrollActive && (
									<>
										<ScrollThumb scrollerRef={scrollerObjectRef} autoHideDelay={800} />
										{showScrollToBottom && (
											<button
												type="button"
												onClick={scrollToBottom}
												aria-label="Scroll to bottom"
												className="absolute bottom-1 left-1/2 z-10 flex size-[22px] -translate-x-1/2 items-center justify-center rounded-full cursor-pointer bg-vscode-editor-background/80 text-vscode-foreground backdrop-blur-md transition-all duration-200 border border-[color-mix(in_srgb,var(--vscode-foreground)_10%,transparent)] shadow-[0_4px_12px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_50%,transparent)] hover:bg-vscode-editor-background/95 hover:shadow-[0_6px_16px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_60%,transparent)] active:scale-95"
												title="Scroll to bottom"
											>
												<ChevronDownIcon size={12} />
											</button>
										)}
									</>
								)}
							</div>
						</motion.div>
						{showCollapseOverlay && <CollapseOverlay visible={true} onCollapse={toggle} />}
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
};

interface ThinkingMessageProps {
	content: string;
	durationMs?: number;
	isStreaming?: boolean;
	startTime?: string | number;
	defaultExpanded?: boolean;
	inheritPreviewHeight?: boolean;
}

import { useElapsedTimer } from '../../hooks/useElapsedTimer';

// Re-export from shared hook for backward compatibility
export { useElapsedTimer };

export const ThinkingMessage = React.memo<ThinkingMessageProps>(
	({
		content,
		durationMs,
		isStreaming,
		startTime,
		defaultExpanded,
		inheritPreviewHeight = false,
	}) => {
		const [manualExpanded, setManualExpanded] = useState<boolean | null>(defaultExpanded ?? null);
		const wasStreamingRef = useRef(Boolean(isStreaming));
		const liveElapsed = useElapsedTimer(isStreaming ?? false, startTime, durationMs);
		const expanded = manualExpanded ?? Boolean(isStreaming);
		const previewMaxHeight = isStreaming
			? inheritPreviewHeight
				? 'none'
				: `${STREAM_PREVIEW_MAX_HEIGHT}px`
			: undefined;

		useEffect(() => {
			if (wasStreamingRef.current && !isStreaming && manualExpanded === null) {
				setManualExpanded(false);
			} else if (!isStreaming && manualExpanded === null) {
				// On restore/replay the component can mount or be reused without seeing
				// a live transition. Default completed thinking blocks to collapsed.
				setManualExpanded(false);
			}
			wasStreamingRef.current = Boolean(isStreaming);
		}, [isStreaming, manualExpanded]);

		const displayDuration = liveElapsed;

		// Keep the header minimal: just the timer next to the Thinking label.
		const combinedMeta = (
			<span className="flex items-center gap-1 w-full min-w-0">
				{displayDuration != null && displayDuration > 0 && (
					<span
						className={cn(
							'shrink-0 flex items-center gap-1 text-sm font-bold transition-colors duration-300',
							isStreaming
								? 'text-vscode-textLink-foreground animate-pulse'
								: 'text-vscode-descriptionForeground',
						)}
					>
						<TimerIcon size={11} />
						{formatDuration(displayDuration)}
					</span>
				)}
			</span>
		);

		return (
			<SimpleTool
				icon={
					<BrainSideIcon
						size={17}
						className={cn(
							'transition-colors duration-300',
							isStreaming
								? 'text-vscode-textLink-foreground animate-pulse'
								: 'text-vscode-descriptionForeground',
						)}
					/>
				}
				label="Thinking"
				meta={combinedMeta}
				expanded={expanded}
				maxExpandedHeight={previewMaxHeight}
				autoScrollActive={Boolean(isStreaming) && expanded}
				onToggle={() => {
					setManualExpanded(prev => !(prev ?? Boolean(isStreaming)));
				}}
				className="mb-(--tool-utility-block-margin)"
			>
				{content && (
					<Markdown
						content={content}
						isStreaming={isStreaming}
						className={THINKING_TEXT_CLASS_NAME}
					/>
				)}
			</SimpleTool>
		);
	},
);
ThinkingMessage.displayName = 'ThinkingMessage';

// -----------------------------------------------------------------------------
// Simple tool grouping helpers — re-exported from dedicated utility module
// -----------------------------------------------------------------------------

export {
	type GroupedResponseItem,
	getGroupedItemShouldCollapse,
	groupToolMessages,
	precomputeCollapseFlags,
	shouldCollapseGroupedItem,
	type ToolGroup,
} from './toolGrouping';

// -----------------------------------------------------------------------------
// Inline / lightweight tool rendering
// -----------------------------------------------------------------------------

const getLeafName = (value: string) => {
	const trimmed = value.trim().replace(/[\\/]+$/, '');
	if (!trimmed) return '';
	const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || trimmed;
};

const getObjectInput = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const getInputString = (
	input: Record<string, unknown> | null,
	...keys: string[]
): string | undefined => {
	for (const key of keys) {
		const value = input?.[key];
		if (typeof value === 'string' && value.trim()) return value;
	}
	return undefined;
};

const getSkillMeta = (input: Record<string, unknown> | null) => ({
	name: getInputString(input, 'name'),
	path: getInputString(input, 'location', 'filePath', 'file_path', 'path'),
});

const GREP_SUMMARY_LINE =
	/^Found (\d+) match(?:es|\(es\))(?: in \d+ file\(s\))?(?: \(showing first \d+\))?$/;

const SEARCH_FILE_LINE =
	/^(?<path>(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\r\n]*?(?:\.[A-Za-z0-9_-]{1,16}|[\\/][^\\/.:\r\n]+))(?::)?$/;
const SEARCH_MATCH_LINE = /^\s+(?:Line\s+)?(?<line>\d+):\s?(?<text>.*)$/;
const SEARCH_PARSER_STOP_LINE = /^(?:\[Agent Usage Reminder\]|```)/;

interface InlineToolLineProps {
	toolName: string;
	rawInput: unknown;
	content: string;
	isError: boolean;
	defaultExpanded?: boolean;
	normalizedEntry?: NormalizedEntry;
	toolMetadata?: Record<string, unknown>;
	showCollapseOverlay?: boolean;
}

export const InlineToolLine = React.memo<InlineToolLineProps>(
	({
		toolName,
		rawInput,
		content,
		isError,
		defaultExpanded,
		normalizedEntry,
		toolMetadata,
		showCollapseOverlay,
	}) => {
		const { postMessage } = useVSCode();
		const availableSkills = useSettingsStore(state => state.resources.skill.items);
		const toolLower = toolName.toLowerCase();
		const canonicalToolName = resolveToolName(toolName);
		const isKnownTool = Boolean(canonicalToolName);
		const action =
			normalizedEntry?.entryType &&
			typeof normalizedEntry.entryType === 'object' &&
			'actionType' in normalizedEntry.entryType
				? normalizedEntry.entryType.actionType
				: null;

		const {
			label,
			meta,
			metaDisplay,
			skillName,
			skillPath,
			isListDir,
			isTodoWrite,
			isRead,
			isSearch,
			isTaskResult,
			isSkill,
			readOffset,
			readLimit,
		} = useMemo(() => {
			const isLs =
				toolLower === 'list' ||
				toolLower === 'ls' ||
				toolLower === 'list_dir' ||
				toolLower === 'serena_list_dir';
			const isRead = action?.type === 'FileRead' || (!action && toolLower.includes('read'));
			const isTodo = action?.type === 'TodoManagement' || toolLower === 'todowrite';
			const isTaskResult = action?.type === 'TaskResult';
			const isSkill =
				toolLower === 'skill' || (action?.type === 'Tool' && action.toolName === 'skill');
			const isSearch =
				action?.type === 'Search' ||
				action?.type === 'WebSearch' ||
				action?.type === 'CodeSearch' ||
				(!action &&
					(toolLower === 'grep' ||
						toolLower === 'glob' ||
						toolLower === 'websearch' ||
						toolLower === 'codesearch'));

			let label = formatToolName(toolName);
			let meta = '';
			let skillName: string | undefined;
			let skillPath: string | undefined;
			const input = getObjectInput(rawInput);

			let readOffset: number | undefined;
			let readLimit: number | undefined;

			if (action) {
				if (action.type === 'FileRead') {
					label = 'Read';
					meta = action.path;
					readOffset = action.offset;
					readLimit = action.limit;
				} else if (action.type === 'CommandRun') {
					label = 'Run';
					meta = action.command;
				} else if (action.type === 'Search') {
					label = toolLower === 'grep' ? 'Grep' : toolLower === 'glob' ? 'Glob' : 'Search';
					meta = action.query;
				} else if (action.type === 'WebSearch') {
					label = 'Web Search';
					meta = action.query;
				} else if (action.type === 'CodeSearch') {
					label = 'Code Search';
					meta = action.query;
				} else if (action.type === 'WebFetch') {
					label = 'Fetch';
					meta = action.url;
				} else if (action.type === 'TaskCreate') {
					label = 'Task';
					meta = action.description;
				} else if (action.type === 'TaskResult') {
					label = action.status === 'error' ? 'Task Failed' : 'Task Done';
					meta = action.description;
				} else if (action.type === 'TodoManagement') {
					label = 'Todo';
				} else if (action.type === 'Tool' && action.toolName === 'skill') {
					({ name: skillName, path: skillPath } = getSkillMeta(input));
					label = 'Skill';
					meta = skillPath || skillName || '';
				} else if (action.type === 'Tool' && action.toolName === 'list') {
					label = 'Listed';
					meta = getInputString(input, 'path') || '';
				}
			} else {
				if (isSkill) {
					({ name: skillName, path: skillPath } = getSkillMeta(input));
					label = 'Skill';
					meta = skillPath || skillName || '';
				} else if (isLs) {
					label = 'Listed';
					meta = getInputString(input, 'path') || '';
				} else if (isRead) {
					label = 'Read';
					meta = getInputString(input, 'path', 'file_path', 'filePath') || '';
					readOffset = typeof input?.offset === 'number' ? input.offset : undefined;
					readLimit = typeof input?.limit === 'number' ? input.limit : undefined;
				} else if (isTodo) {
					label = 'Todo';
				} else if (toolLower === 'grep') {
					label = 'Grep';
					meta = getInputString(input, 'pattern') || '';
				} else if (toolLower === 'glob') {
					label = 'Glob';
					meta = getInputString(input, 'glob_pattern', 'pattern') || '';
				}
			}

			let metaDisplay = meta;
			if (isRead || isLs) {
				metaDisplay = getLeafName(meta);
			}

			const resolvedSkillPath =
				skillPath ||
				(skillName
					? (
							availableSkills.find(skill => skill.name === skillName) ||
							availableSkills.find(
								skill => skillName.includes(':') && skill.name === skillName.split(':').pop(),
							)
						)?.path
					: undefined);

			return {
				label,
				meta: isSkill ? resolvedSkillPath || skillName || meta : meta,
				metaDisplay,
				skillName,
				skillPath: resolvedSkillPath,
				isListDir: isLs,
				isTodoWrite: isTodo,
				isRead,
				isSearch,
				isTaskResult,
				isSkill,
				readOffset,
				readLimit,
			};
		}, [action, availableSkills, rawInput, toolLower, toolName]);

		const metaNode = useMemo(() => {
			if (!meta) return undefined;

			if (isSkill) {
				if (!skillPath && !skillName) return undefined;
				const skillTargetPath = skillPath || skillName || meta;
				const displayName = skillName || metaDisplay || 'Skill';
				return (
					<PathChip
						path={skillTargetPath}
						label={displayName}
						iconName={skillPath || `${displayName}.md`}
						onClick={() => postMessage({ type: 'openFile', filePath: skillTargetPath })}
						title={skillPath || skillName || meta}
						className="max-w-full min-w-0 shrink animate-content-reveal"
					/>
				);
			}

			if (isRead) {
				const isFolder = /[\\/]$/.test(meta);
				const startLine = typeof readOffset === 'number' && readOffset > 0 ? readOffset : undefined;
				const endLine =
					startLine !== undefined && typeof readLimit === 'number' && readLimit > 0
						? startLine + readLimit - 1
						: undefined;
				return (
					<PathChip
						path={meta}
						isFolder={isFolder}
						onClick={
							!isFolder
								? () =>
										postMessage({
											type: 'openFile',
											filePath: meta,
											...(startLine !== undefined ? { startLine } : {}),
											...(endLine !== undefined ? { endLine } : {}),
										})
								: undefined
						}
						title={meta}
						className="max-w-full min-w-0 shrink animate-content-reveal"
					/>
				);
			}

			if (isListDir) {
				return (
					<PathChip
						path={meta}
						isFolder={true}
						title={meta}
						className="max-w-full min-w-0 shrink animate-content-reveal"
					/>
				);
			}

			return (
				<Badge
					label={metaDisplay}
					title={meta}
					className="max-w-full min-w-0 shrink animate-content-reveal"
				/>
			);
		}, [
			isListDir,
			isRead,
			isSkill,
			meta,
			metaDisplay,
			postMessage,
			readLimit,
			readOffset,
			skillName,
			skillPath,
		]);

		// For TaskResult, prefer the result text from the actionType over the raw content prop
		const taskResultText = useMemo(
			() => (isTaskResult && action?.type === 'TaskResult' ? action.result || '' : ''),
			[action, isTaskResult],
		);

		const fullText = isTaskResult ? taskResultText || content || '' : content || '';

		const lines = useMemo((): string[] => fullText.split('\n'), [fullText]);
		const nonEmptyLineCount = lines.filter((l: string) => l.length > 0).length;

		const searchResultCount = useMemo(() => {
			if (!isSearch) return 0;
			const metadataCount =
				typeof toolMetadata?.matches === 'number'
					? toolMetadata.matches
					: typeof toolMetadata?.count === 'number'
						? toolMetadata.count
						: undefined;
			if (typeof metadataCount === 'number' && metadataCount >= 0) return metadataCount;
			const firstNonEmptyLine = lines.find(line => line.trim().length > 0)?.trim();
			const summaryMatch = firstNonEmptyLine?.match(GREP_SUMMARY_LINE);
			return summaryMatch ? Number(summaryMatch[1]) : 0;
		}, [isSearch, lines, toolMetadata]);

		const rawInputText = useMemo(() => {
			if (!rawInput || isKnownTool || isRead || isSearch || isTodoWrite || isTaskResult) return '';
			try {
				return JSON.stringify(rawInput, null, 2);
			} catch {
				return String(rawInput);
			}
		}, [isKnownTool, isRead, isSearch, isTaskResult, isTodoWrite, rawInput]);
		const genericRawBody = rawInputText.trim();
		const hasBody = !isRead && (fullText.trim().length > 0 || genericRawBody.length > 0);

		const renderedSearchLines = useMemo(() => {
			if (!isSearch || !hasBody) return [] as React.ReactNode[];
			let currentFilePath: string | null = null;
			let parsingEnabled = true;
			return lines.map((line, index) => {
				const lineKey = `${index}:${line}`;
				const trimmed = line.trim();
				if (!trimmed) {
					return <div key={lineKey} className="h-[0.5lh]" />;
				}

				if (SEARCH_PARSER_STOP_LINE.test(trimmed)) {
					parsingEnabled = false;
					currentFilePath = null;
				}

				if (!parsingEnabled) {
					return (
						<div
							key={lineKey}
							className="text-sm leading-(--line-height-code) text-vscode-descriptionForeground opacity-80 whitespace-pre-wrap"
						>
							{line}
						</div>
					);
				}

				const fileMatch = line.match(SEARCH_FILE_LINE);
				if (
					fileMatch?.groups?.path &&
					!trimmed.startsWith('Found ') &&
					!trimmed.startsWith('(') &&
					!trimmed.startsWith('[')
				) {
					currentFilePath = fileMatch.groups.path.replace(/:$/, '');
					return (
						<div key={lineKey} className="my-0.5">
							<PathChip
								path={currentFilePath}
								title={currentFilePath}
								onClick={() => postMessage({ type: 'openFile', filePath: currentFilePath ?? '' })}
								className="max-w-full min-w-0"
							/>
						</div>
					);
				}

				const lineMatch = line.match(SEARCH_MATCH_LINE);
				if (lineMatch?.groups?.line && currentFilePath) {
					const filePath = currentFilePath;
					const lineNumber = Number(lineMatch.groups.line);
					const matchText = lineMatch.groups.text ?? '';
					return (
						<div key={lineKey} className="flex items-start gap-2 py-[1px]">
							<PathChip
								path={filePath}
								label={getLeafName(filePath)}
								line={lineNumber}
								title={`${filePath}:${lineNumber}`}
								onClick={() =>
									postMessage({
										type: 'openFile',
										filePath,
										startLine: lineNumber,
										endLine: lineNumber,
									})
								}
								className="shrink-0"
							/>
							<span className="text-sm leading-(--line-height-code) text-vscode-descriptionForeground opacity-80 break-all">
								{matchText}
							</span>
						</div>
					);
				}

				return (
					<div
						key={lineKey}
						className="text-sm leading-(--line-height-code) text-vscode-descriptionForeground opacity-80 whitespace-pre-wrap"
					>
						{line}
					</div>
				);
			});
		}, [hasBody, isSearch, lines, postMessage]);

		const todos = useMemo((): Array<{ content: string; status: string }> => {
			if (!isTodoWrite) return [];
			if (action?.type === 'TodoManagement') return action.todos;
			const rawTodos = (rawInput as { todos?: unknown } | undefined)?.todos;
			return Array.isArray(rawTodos)
				? (rawTodos as Array<{ content: string; status: string }>)
				: [];
		}, [action, isTodoWrite, rawInput]);

		const completedCount = todos.filter(t => t.status === 'completed').length;
		const totalCount = todos.length;

		// Todo always starts collapsed. User can manually toggle to expand.
		const [todoExpanded, setTodoExpanded] = useState(false);

		// Search starts collapsed. User can manually toggle to expand.
		const [searchExpanded, setSearchExpanded] = useState(false);

		const ToolIcon = useMemo(() => {
			if (toolName === 'thinking') return BrainSideIcon;
			if (isSkill) return ZapIcon;
			if (isTaskResult) return CheckCircleIcon;
			if (isTodoWrite) return TodoListIcon;
			if (isRead) return FileTextIcon;
			if (isListDir) return FolderOpenIcon;
			if (isSearch) return SearchIcon;
			return WandIcon;
		}, [toolName, isSkill, isTodoWrite, isRead, isListDir, isTaskResult, isSearch]);

		return (
			<SimpleTool
				icon={<ToolIcon size={18} />}
				label={label}
				meta={metaNode}
				isError={isError}
				{...(isTodoWrite
					? { expanded: todoExpanded, onToggle: () => setTodoExpanded(prev => !prev) }
					: isSearch
						? { expanded: searchExpanded, onToggle: () => setSearchExpanded(prev => !prev) }
						: { defaultExpanded })}
				showCollapseOverlay={showCollapseOverlay}
				rightContent={
					<>
						{isRead && (
							<span className="text-sm whitespace-nowrap text-vscode-descriptionForeground animate-content-reveal">
								{readOffset !== undefined || readLimit !== undefined
									? `${readOffset ?? 1}–${readLimit !== undefined ? (readOffset ?? 1) + readLimit - 1 : '...'} lines`
									: `${nonEmptyLineCount} lines`}
							</span>
						)}
						{!isRead && isSearch && (searchResultCount > 0 || hasBody) && (
							<span className="text-sm whitespace-nowrap text-vscode-descriptionForeground animate-content-reveal">
								{searchResultCount} results
							</span>
						)}
						{!isRead && !isSearch && isTodoWrite && totalCount > 0 && (
							<>
								<span className="text-sm text-vscode-descriptionForeground">·</span>
								<span className="text-sm font-medium leading-none whitespace-nowrap text-vscode-descriptionForeground">
									{completedCount} of {totalCount}
								</span>
								<span className="text-sm truncate text-vscode-descriptionForeground">
									{(() => {
										const active =
											todos.find(t => t.status === 'in_progress') ||
											todos.find(t => t.status === 'pending') ||
											[...todos].reverse().find(t => t.status === 'completed');
										return active ? `— ${active.content}` : '';
									})()}
								</span>
							</>
						)}
						{toolName === 'thinking' && (rawInput as { durationMs?: number })?.durationMs && (
							<span className="flex items-center gap-1 text-sm leading-none text-vscode-descriptionForeground">
								<TimerIcon size={11} />
								{formatDuration((rawInput as { durationMs?: number })?.durationMs ?? 0)}
							</span>
						)}
					</>
				}
			>
				{isTaskResult && fullText.trim() ? (
					<Markdown
						content={fullText}
						className="[&_p]:!text-sm [&_p]:!text-vscode-descriptionForeground [&_li]:!text-sm [&_li]:!text-vscode-descriptionForeground [&_ul]:!text-sm [&_ol]:!text-sm !text-vscode-descriptionForeground"
					/>
				) : isSearch && hasBody ? (
					<div className="m-0 px-1 py-0.5 rounded-sm">{renderedSearchLines}</div>
				) : isTodoWrite ? (
					<div className="flex flex-col gap-1">
						{todos.map((todo, idx) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: static list
								key={idx}
								className="flex items-center gap-(--gap-2-5)"
							>
								<TodoStatusIcon status={todo.status} />
								<span
									className={cn(
										'text-sm truncate text-vscode-descriptionForeground',
										todo.status === 'completed' && 'opacity-50',
									)}
								>
									{todo.content}
								</span>
							</div>
						))}
					</div>
				) : isError && fullText.trim() ? (
					<pre className="m-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap text-error opacity-100">
						{fullText}
					</pre>
				) : genericRawBody ? (
					<div className="flex flex-col gap-2">
						{fullText.trim() && (
							<pre className="m-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap text-vscode-descriptionForeground opacity-80">
								{fullText}
							</pre>
						)}
						<pre className="m-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap text-vscode-descriptionForeground opacity-80">
							{genericRawBody}
						</pre>
					</div>
				) : null}
			</SimpleTool>
		);
	},
);
InlineToolLine.displayName = 'InlineToolLine';
