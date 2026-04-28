import React, { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { TOOL_CARD_EXPANDED_MAX_HEIGHT } from '../../constants';
import { cn } from '../../lib/cn';
import { formatDuration, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { useVSCode } from '../../utils/vscode';
import {
	BrainSideIcon,
	CheckCircleIcon,
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
}) => {
	const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
	const contentId = useId();
	const hasContent = Boolean(children);

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
		<div className={cn('mb-(--tool-utility-block-margin) ml-2 animate-fade-slide-in', className)}>
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
			{expanded && hasContent && (
				<div className="relative group">
					<div
						id={contentId}
						style={{ maxHeight: maxExpandedHeight }}
						className={cn(
							'pl-3 ml-1 border-l border-(--border-subtle) mt-1 py-1 text-sm overflow-x-auto overflow-y-auto',
							contentClassName,
						)}
					>
						{children}
					</div>
					{showCollapseOverlay && <CollapseOverlay visible={true} onCollapse={toggle} />}
				</div>
			)}
		</div>
	);
};

interface ThinkingMessageProps {
	content: string;
	durationMs?: number;
	isStreaming?: boolean;
	startTime?: string | number;
	defaultExpanded?: boolean;
}

import { useElapsedTimer } from '../../hooks/useElapsedTimer';

// Re-export from shared hook for backward compatibility
export { useElapsedTimer };

export const ThinkingMessage = React.memo<ThinkingMessageProps>(
	({ content, durationMs, isStreaming, startTime, defaultExpanded }) => {
		const preview = useMemo(
			() =>
				content
					.split('\n')
					.find(line => line.trim().length > 0)
					?.trim() ?? '',
			[content],
		);
		const [expanded, setExpanded] = useState(defaultExpanded ?? isStreaming ?? false);
		const wasStreamingRef = useRef(isStreaming);
		const autoExpandedRef = useRef(Boolean(defaultExpanded ?? isStreaming));
		const liveElapsed = useElapsedTimer(isStreaming ?? false, startTime);

		useEffect(() => {
			if (isStreaming) {
				setExpanded(true);
				autoExpandedRef.current = true;
			} else if (wasStreamingRef.current && !isStreaming) {
				if (autoExpandedRef.current) {
					setExpanded(false);
				}
				autoExpandedRef.current = false;
			} else if (!isStreaming) {
				// On restore/replay the component can mount or be reused in an expanded
				// state without seeing a clean streaming->idle transition. Thinking blocks
				// should default to collapsed whenever they are not actively streaming.
				setExpanded(false);
				autoExpandedRef.current = false;
			}
			wasStreamingRef.current = isStreaming;
		}, [isStreaming]);

		// Use durationMs when available (final value from store), otherwise
		// fall back to liveElapsed which keeps the frozen value after streaming stops.
		// This prevents the timer from disappearing when durationMs is not yet computed.
		const displayDuration = isStreaming ? liveElapsed : (durationMs ?? liveElapsed);

		// Combine preview and timer into a single meta ReactNode so they share
		// the same flex container and the timer doesn't push the preview out.
		const combinedMeta = (
			<span className="flex items-center gap-1 w-full min-w-0">
				{preview && (
					<span className="truncate text-sm text-vscode-descriptionForeground">{preview}</span>
				)}
				{displayDuration != null && displayDuration > 0 && (
					<span className="ml-auto shrink-0 flex items-center gap-1 text-sm font-bold text-vscode-descriptionForeground">
						<TimerIcon size={11} />
						{formatDuration(displayDuration)}
					</span>
				)}
			</span>
		);

		return (
			<SimpleTool
				icon={<BrainSideIcon size={17} className="text-vscode-descriptionForeground" />}
				label="Thinking"
				meta={combinedMeta}
				expanded={expanded}
				onToggle={() => {
					autoExpandedRef.current = false;
					setExpanded(prev => !prev);
				}}
				className="mb-(--message-gap)"
			>
				{content && (
					<Markdown
						content={content}
						isStreaming={isStreaming}
						className="[&_p]:!text-sm [&_p]:!text-vscode-descriptionForeground [&_li]:!text-sm [&_li]:!text-vscode-descriptionForeground [&_ul]:!text-sm [&_ol]:!text-sm !text-vscode-descriptionForeground"
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

interface InlineToolLineProps {
	toolName: string;
	rawInput: unknown;
	content: string;
	isError: boolean;
	defaultExpanded?: boolean;
	normalizedEntry?: NormalizedEntry;
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
		showCollapseOverlay,
	}) => {
		const { postMessage } = useVSCode();
		const toolLower = toolName.toLowerCase();
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

			const resolvedSkillPath = skillPath;

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
		}, [action, rawInput, toolLower, toolName]);

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
						onClick={
							skillPath ? () => postMessage({ type: 'openFile', filePath: skillPath }) : undefined
						}
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

		// Parse search results into structured entries: { filePath, line }
		// Grep format: "Found N matches\n/path/file.ts:\n  Line 10: content\n  Line 25: content"
		// Glob format: "/path/file1.ts\n/path/file2.ts"
		const searchEntries = useMemo(() => {
			if (!isSearch || !fullText.trim()) return [];
			const entries: Array<{ filePath: string; line?: number }> = [];
			const seen = new Set<string>();
			let currentFile = '';
			for (const raw of lines) {
				const trimmed = raw.trim();
				if (!trimmed) continue;
				// Skip summary lines like "Found N matches" or "(Results truncated...)"
				if (/^Found \d+ matches/.test(trimmed) || /^\(/.test(trimmed)) continue;
				// Grep file header: "/absolute/path/file.ts:"
				if (/^.+:$/.test(trimmed) && !trimmed.startsWith('Line ')) {
					currentFile = trimmed.slice(0, -1);
					continue;
				}
				// Grep match line: "  Line 42: content"
				const lineMatch = trimmed.match(/^Line (\d+):/);
				if (lineMatch && currentFile) {
					const key = `${currentFile}:${lineMatch[1]}`;
					if (seen.has(key)) continue;
					seen.add(key);
					entries.push({ filePath: currentFile, line: Number(lineMatch[1]) });
					continue;
				}
				// Glob: any path-like entry, including relative files with spaces.
				if (
					!trimmed.startsWith('Line ') &&
					(/[\\/]/.test(trimmed) || /\.\w{1,10}$/.test(trimmed))
				) {
					if (seen.has(trimmed)) continue;
					seen.add(trimmed);
					entries.push({ filePath: trimmed });
				}
			}
			return entries;
		}, [isSearch, fullText, lines]);

		const searchResultCount = searchEntries.length;

		const rawInputText = useMemo(() => {
			if (!rawInput || isRead || isSearch || isTodoWrite || isTaskResult) return '';
			try {
				return JSON.stringify(rawInput, null, 2);
			} catch {
				return String(rawInput);
			}
		}, [isRead, isSearch, isTaskResult, isTodoWrite, rawInput]);
		const genericRawBody = rawInputText.trim();
		const hasBody = !isRead && (fullText.trim().length > 0 || genericRawBody.length > 0);

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
				) : isSearch && searchEntries.length > 0 ? (
					<div className="flex flex-wrap gap-1">
						{searchEntries.map((entry, idx) => (
							<PathChip
								// biome-ignore lint/suspicious/noArrayIndexKey: static list
								key={idx}
								path={entry.filePath}
								line={entry.line}
								title={entry.filePath}
								onClick={() =>
									postMessage({
										type: 'openFile',
										filePath: entry.filePath,
										...(entry.line !== undefined ? { line: entry.line } : {}),
									})
								}
								className="shrink-0"
							/>
						))}
					</div>
				) : isSearch && hasBody ? (
					<pre className="m-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap text-vscode-descriptionForeground opacity-80">
						{fullText}
					</pre>
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
