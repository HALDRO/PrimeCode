import type React from 'react';
import { type ReactNode, useId, useMemo, useState } from 'react';
// @ts-expect-error - normalizedEvents path issue in webview tsconfig
import type { NormalizedEntry } from '../../../../common/normalizedEvents';
import { isMcpTool, isToolInList, NON_GROUPABLE_TOOLS } from '../../constants';
import { cn } from '../../lib/cn';
import type { Message } from '../../store/chatStore';
import { formatDuration, formatToolName } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { useVSCode } from '../../utils/vscode';
import {
	BrainSideIcon,
	FileTextIcon,
	FolderOpenIcon,
	SearchIcon,
	TimerIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
	WandIcon,
} from '../icons';
import { Badge, PathChip } from '../ui';

export interface SimpleToolProps {
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
		<div className={cn('mb-(--tool-utility-block-margin) ml-2', className)}>
			<button
				type="button"
				onClick={toggle}
				aria-expanded={hasContent ? expanded : undefined}
				aria-controls={hasContent ? contentId : undefined}
				className={cn(
					'group flex items-center gap-2 w-full text-left bg-transparent border-none p-0',
					'cursor-pointer hover:bg-vscode-toolbar-hoverBackground rounded px-1 -mx-1 py-0.5 select-none',
					'outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
					!hasContent && 'cursor-default hover:bg-transparent',
				)}
			>
				<span
					className={cn(
						'shrink-0 flex h-7 w-7 items-center justify-center rounded-sm border bg-(--surface-raised)',
						isError
							? 'border-(--color-error) text-error'
							: 'border-(--border-subtle) text-vscode-foreground opacity-80',
						/* keep badge a bit larger, but match ToolCard header icon scale */
						'[&>svg]:w-[14px] [&>svg]:h-[14px]',
					)}
				>
					{icon}
				</span>

				<span
					className={cn(
						'text-sm font-medium opacity-90 whitespace-nowrap',
						isError && 'text-error',
					)}
				>
					{label}
				</span>

				{meta && (
					<span className="min-w-0 overflow-hidden flex items-center shrink">
						{typeof meta === 'string' || typeof meta === 'number' ? (
							<span className="text-xs opacity-60 truncate">{meta}</span>
						) : (
							meta
						)}
					</span>
				)}

				{rightContent && <span className="text-xs opacity-60 shrink-0">{rightContent}</span>}
			</button>

			{expanded && hasContent && (
				<div
					id={contentId}
					className={cn(
						'pl-3 ml-1 border-l border-(--border-subtle) mt-1 py-1 text-sm opacity-90 overflow-x-auto',
						contentClassName,
					)}
				>
					{children}
				</div>
			)}
		</div>
	);
};

interface ThinkingMessageProps {
	content: string;
	durationMs?: number;
	isStreaming?: boolean;
	defaultExpanded?: boolean;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({
	content,
	durationMs,
	isStreaming,
	defaultExpanded,
}) => {
	const preview = content.split('\n')[0]?.trim();

	return (
		<SimpleTool
			icon={<BrainSideIcon size={17} className="text-(--color-thinking)" />}
			label="Thinking"
			meta={preview}
			defaultExpanded={defaultExpanded ?? isStreaming}
			rightContent={
				durationMs !== undefined && (
					<span className="flex items-center gap-1 text-xs opacity-50">
						<TimerIcon size={11} />
						{formatDuration(durationMs)}
					</span>
				)
			}
		>
			{content && <Markdown content={content} />}
		</SimpleTool>
	);
};

// -----------------------------------------------------------------------------
// Simple tool grouping helpers (UI-side)
// -----------------------------------------------------------------------------

export const MIN_SIMPLE_TOOL_GROUP_SIZE = 3;

export const isGroupableTool = (msg: Message, mcpServerNames: string[]): boolean => {
	if (msg.type !== 'tool_use' && msg.type !== 'tool_result') {
		return false;
	}
	const toolName = msg.toolName || '';

	if (isMcpTool(toolName, mcpServerNames)) {
		return false;
	}

	return !isToolInList(toolName, NON_GROUPABLE_TOOLS);
};

const getToolUseCount = (msgs: Message[]): number =>
	msgs.reduce((count, msg) => count + (msg.type === 'tool_use' ? 1 : 0), 0);

/**
 * Group consecutive lightweight tool runs.
 *
 * Trailing simple-tool runs are NOT grouped until a boundary message appears.
 */
export const groupToolMessages = (
	msgs: Message[],
	mcpServerNames: string[],
): (Message | Message[])[] => {
	const result: (Message | Message[])[] = [];
	let currentToolGroup: Message[] = [];

	const flushGroup = (reason: 'boundary' | 'final') => {
		if (currentToolGroup.length === 0) return;

		const toolUseCount = getToolUseCount(currentToolGroup);
		const canGroup = reason === 'boundary' && toolUseCount >= MIN_SIMPLE_TOOL_GROUP_SIZE;

		if (canGroup) {
			result.push(currentToolGroup);
		} else {
			result.push(...currentToolGroup);
		}

		currentToolGroup = [];
	};

	for (const msg of msgs) {
		if (
			(msg.type === 'tool_use' || msg.type === 'tool_result') &&
			isGroupableTool(msg, mcpServerNames)
		) {
			currentToolGroup.push(msg);
			continue;
		}

		flushGroup('boundary');
		result.push(msg);
	}

	flushGroup('final');
	return result;
};

export const shouldTriggerCollapse = (msg: Message): boolean => {
	if (msg.type === 'assistant' || msg.type === 'thinking') {
		return true;
	}

	if (msg.type === 'tool_use') {
		const toolName = msg.toolName || '';
		return isToolInList(toolName, NON_GROUPABLE_TOOLS);
	}

	return false;
};

type GroupedResponseItem = Message | Message[];

const itemTriggersCollapse = (item: GroupedResponseItem): boolean => {
	if (Array.isArray(item)) {
		return item.some(msg => shouldTriggerCollapse(msg));
	}
	return shouldTriggerCollapse(item);
};

export const shouldCollapseGroupedItem = (items: GroupedResponseItem[], index: number): boolean => {
	const current = items[index];
	if (!Array.isArray(current)) return false;
	if (getToolUseCount(current) < MIN_SIMPLE_TOOL_GROUP_SIZE) return false;

	for (let i = index + 1; i < items.length; i++) {
		if (itemTriggersCollapse(items[i])) {
			return true;
		}
	}

	return false;
};

// -----------------------------------------------------------------------------
// Inline / lightweight tool rendering
// -----------------------------------------------------------------------------

const getLeafName = (value: string) => {
	const trimmed = value.trim().replace(/[\\/]+$/, '');
	if (!trimmed) return '';
	const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || trimmed;
};

const cleanPathToken = (value: string) =>
	value
		.trim()
		.replace(/^[`"'([{<]+/, '')
		.replace(/[>"'`)\]}.,;!?]+$/, '');

const isLikelyPathToken = (value: string) => {
	const candidate = value.trim();
	if (!candidate) return false;
	if (/^https?:\/\//i.test(candidate)) return false;
	if (candidate === '.' || candidate === '..') return false;
	if (candidate.includes('*')) return false;

	const startsLikePath =
		candidate.startsWith('/') ||
		candidate.startsWith('./') ||
		candidate.startsWith('../') ||
		/^[A-Za-z]:[\\/]/.test(candidate);
	const hasSeparator = /[\\/]/.test(candidate);
	const hasExtension = /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9_-]+$/.test(candidate);
	const isWellKnownNoExtFile =
		/^(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG|\.env(?:\.[\w.-]+)?|\.gitignore|\.gitattributes)$/i.test(
			candidate,
		);
	const isFolderLike = /[\\/]$/.test(candidate);

	return startsLikePath || hasSeparator || hasExtension || isWellKnownNoExtFile || isFolderLike;
};

const fileRefFromLine = (
	line: string,
): { path: string; line?: number; detail?: string; isFolder?: boolean } | null => {
	const trimmed = line.trim();
	if (!trimmed) return null;

	const withLine = /^(.+?):(\d+)(?::\d+)?:\s*(.*)$/.exec(trimmed);
	if (withLine) {
		const pathCandidate = cleanPathToken(withLine[1]);
		if (isLikelyPathToken(pathCandidate)) {
			const lineNum = Number(withLine[2]);
			return {
				path: pathCandidate,
				line: Number.isFinite(lineNum) ? lineNum : undefined,
				detail: withLine[3]?.trim() || '',
				isFolder: /[\\/]$/.test(pathCandidate),
			};
		}
	}

	const withColon = /^(.+):\s+(.+)$/.exec(trimmed);
	if (withColon) {
		const pathCandidate = cleanPathToken(withColon[1]);
		if (isLikelyPathToken(pathCandidate)) {
			return {
				path: pathCandidate,
				detail: withColon[2]?.trim() || '',
				isFolder: /[\\/]$/.test(pathCandidate),
			};
		}
	}

	const pathCandidate = cleanPathToken(trimmed);
	if (!isLikelyPathToken(pathCandidate)) return null;

	return {
		path: pathCandidate,
		detail: '',
		isFolder: /[\\/]$/.test(pathCandidate),
	};
};

export interface InlineToolLineProps {
	toolName: string;
	rawInput: unknown;
	content: string;
	isError: boolean;
	defaultExpanded?: boolean;
	normalizedEntry?: NormalizedEntry;
}

export const InlineToolLine: React.FC<InlineToolLineProps> = ({
	toolName,
	rawInput,
	content,
	isError,
	defaultExpanded,
	normalizedEntry,
}) => {
	const { postMessage } = useVSCode();
	const toolLower = toolName.toLowerCase();

	const { label, meta, metaDisplay, isListDir, isTodoWrite, isRead, isSearch } = useMemo(() => {
		const action =
			normalizedEntry?.entryType &&
			typeof normalizedEntry.entryType === 'object' &&
			'actionType' in normalizedEntry.entryType
				? normalizedEntry.entryType.actionType
				: null;

		const isLs = toolLower === 'ls' || toolLower === 'list_dir' || toolLower === 'serena_list_dir';
		const isRead = action?.type === 'FileRead' || toolLower.includes('read');
		const isTodo = action?.type === 'TodoManagement' || toolLower === 'todowrite';
		const isSearch =
			action?.type === 'Search' ||
			toolLower === 'grep' ||
			toolLower === 'glob' ||
			toolLower === 'search' ||
			toolLower === 'semanticsearch';

		let label = formatToolName(toolName);
		let meta = '';

		if (action) {
			if (action.type === 'FileRead') {
				label = 'Read';
				meta = action.path;
			} else if (action.type === 'CommandRun') {
				label = 'Run';
				meta = action.command;
			} else if (action.type === 'Search') {
				label = 'Search';
				meta = action.query;
			} else if (action.type === 'WebFetch') {
				label = 'Fetch';
				meta = action.url;
			} else if (action.type === 'TaskCreate') {
				label = 'Task';
				meta = action.description;
			} else if (isLs) {
				label = 'Listed';
				const args =
					'arguments' in action && typeof action.arguments === 'object'
						? (action.arguments as Record<string, unknown>)
						: null;
				meta = (args?.path as string) || (rawInput as { path?: string })?.path || '';
			}
		} else {
			if (isLs) {
				label = 'Listed';
				meta = (rawInput as { path?: string })?.path || '';
			} else if (isRead) {
				label = 'Read';
				meta = (rawInput as { path?: string })?.path || '';
			} else if (toolLower === 'grep') {
				label = 'Grep';
				meta = (rawInput as { pattern?: string })?.pattern || '';
			} else if (toolLower === 'glob') {
				label = 'Glob';
				const i = rawInput as { glob_pattern?: string; pattern?: string };
				meta = i?.glob_pattern || i?.pattern || '';
			}
		}

		let metaDisplay = meta;
		if (isRead || isLs) {
			metaDisplay = getLeafName(meta);
		}

		return { label, meta, metaDisplay, isListDir: isLs, isTodoWrite: isTodo, isRead, isSearch };
	}, [normalizedEntry, rawInput, toolLower, toolName]);

	const metaNode = useMemo(() => {
		if (!meta) return undefined;

		if (isRead) {
			const isFolder = /[\\/]$/.test(meta);
			return (
				<PathChip
					path={meta}
					isFolder={isFolder}
					onClick={!isFolder ? () => postMessage({ type: 'openFile', filePath: meta }) : undefined}
					title={meta}
					className="max-w-full min-w-0 shrink"
				/>
			);
		}

		if (isListDir) {
			return (
				<PathChip path={meta} isFolder={true} title={meta} className="max-w-full min-w-0 shrink" />
			);
		}

		return <Badge label={metaDisplay} title={meta} className="max-w-full min-w-0 shrink" />;
	}, [isListDir, isRead, meta, metaDisplay, postMessage]);

	const fullText = content || '';
	const hasBody = !isRead && fullText.trim().length > 0;

	const lines = useMemo(() => (content || '').split('\n'), [content]);
	const nonEmptyLineCount = lines.filter(l => l.length > 0).length;

	const todos = useMemo((): Array<{ content: string; status: string }> => {
		if (!isTodoWrite) return [];
		if (
			normalizedEntry?.entryType &&
			typeof normalizedEntry.entryType === 'object' &&
			'actionType' in normalizedEntry.entryType
		) {
			const action = normalizedEntry.entryType.actionType;
			if (action.type === 'TodoManagement') return action.todos;
		}
		const rawTodos = (rawInput as { todos?: unknown } | undefined)?.todos;
		return Array.isArray(rawTodos) ? (rawTodos as Array<{ content: string; status: string }>) : [];
	}, [isTodoWrite, normalizedEntry, rawInput]);

	const completedCount = todos.filter(t => t.status === 'completed').length;
	const totalCount = todos.length;

	const listEntries = useMemo(() => {
		if (!isListDir) return [];
		return lines
			.map(l => l.trim())
			.filter(Boolean)
			.filter(l => l !== meta);
	}, [isListDir, lines, meta]);

	const searchEntries = useMemo(() => {
		if (!isSearch)
			return [] as Array<{ path: string; line?: number; detail?: string; isFolder?: boolean }>;
		return lines.reduce<
			Array<{ path: string; line?: number; detail?: string; isFolder?: boolean }>
		>((acc, line) => {
			const ref = fileRefFromLine(line);
			if (ref) acc.push(ref);
			return acc;
		}, []);
	}, [isSearch, lines]);

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

	const ToolIcon = useMemo(() => {
		if (toolName === 'thinking') return BrainSideIcon;
		if (isTodoWrite) return TodoListIcon;
		if (isRead) return FileTextIcon;
		if (isListDir) return FolderOpenIcon;
		if (
			toolName.toLowerCase() === 'grep' ||
			toolName.toLowerCase() === 'glob' ||
			toolName.toLowerCase() === 'search' ||
			toolName.toLowerCase() === 'semanticsearch'
		)
			return SearchIcon;
		return WandIcon;
	}, [toolName, isTodoWrite, isRead, isListDir]);

	return (
		<SimpleTool
			icon={<ToolIcon size={18} />}
			label={label}
			meta={metaNode}
			isError={isError}
			defaultExpanded={defaultExpanded}
			rightContent={
				<>
					{isRead && (
						<span className="text-sm text-vscode-foreground opacity-60 whitespace-nowrap">
							{nonEmptyLineCount} lines
						</span>
					)}
					{!isRead && isTodoWrite && totalCount > 0 && (
						<>
							<span className="text-sm font-medium text-vscode-foreground opacity-90 leading-none whitespace-nowrap">
								{completedCount} of {totalCount}
							</span>
							<span className="text-sm text-vscode-foreground opacity-60 truncate">
								{(() => {
									const active =
										todos.find(t => t.status === 'in_progress') ||
										todos.find(t => t.status === 'pending') ||
										[...todos].reverse().find(t => t.status === 'completed');
									return active ? `- ${active.content}` : '';
								})()}
							</span>
						</>
					)}
					{toolName === 'thinking' && (rawInput as { durationMs?: number })?.durationMs && (
						<span className="flex items-center gap-1 text-sm leading-none text-vscode-foreground opacity-60">
							<TimerIcon size={11} />
							{formatDuration((rawInput as { durationMs?: number })?.durationMs ?? 0)}
						</span>
					)}
				</>
			}
		>
			{isTodoWrite ? (
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
									'text-sm truncate',
									todo.status === 'completed'
										? 'text-vscode-foreground opacity-50 line-through'
										: 'text-vscode-foreground opacity-90',
								)}
							>
								{todo.content}
							</span>
						</div>
					))}
				</div>
			) : isListDir ? (
				<div className="flex flex-col gap-1">
					{listEntries.map((entry, idx) => {
						const trimmedEntry = entry.trim();
						const isFolder = trimmedEntry.endsWith('/');
						const path = meta ? `${meta.replace(/[\\/]+$/, '')}/${trimmedEntry}` : trimmedEntry;
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: static list
								key={idx}
								className="flex items-center min-w-0"
							>
								<PathChip
									path={path}
									isFolder={isFolder}
									onClick={
										!isFolder ? () => postMessage({ type: 'openFile', filePath: path }) : undefined
									}
									title={path}
								/>
							</div>
						);
					})}
				</div>
			) : isSearch ? (
				searchEntries.length > 0 ? (
					<div className="flex flex-col gap-1">
						{searchEntries.map((ref, idx) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
								key={idx}
								className="flex items-center min-w-0"
							>
								<PathChip
									path={ref.path}
									isFolder={ref.isFolder}
									line={ref.line}
									onClick={
										!ref.isFolder
											? () => postMessage({ type: 'openFile', filePath: ref.path, line: ref.line })
											: undefined
									}
									title={ref.path}
								/>
							</div>
						))}
					</div>
				) : null
			) : hasBody ? (
				<div className="flex flex-col gap-1">
					{lines.map((line, idx) => {
						const ref = fileRefFromLine(line);
						if (!ref) {
							return (
								<pre
									// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
									key={idx}
									className={cn(
										'm-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap',
										isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-60',
									)}
								>
									{line}
								</pre>
							);
						}

						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
								key={idx}
								className="flex items-center gap-2 min-w-0 px-1 py-0.5 rounded-sm hover:bg-vscode-toolbar-hoverBackground"
							>
								<PathChip
									path={ref.path}
									isFolder={ref.isFolder}
									line={ref.line}
									onClick={
										!ref.isFolder
											? () => postMessage({ type: 'openFile', filePath: ref.path, line: ref.line })
											: undefined
									}
									title={ref.path}
								/>
								{ref.detail && (
									<span className="text-sm text-vscode-foreground opacity-60 truncate">
										{ref.detail}
									</span>
								)}
							</div>
						);
					})}
				</div>
			) : null}
		</SimpleTool>
	);
};
