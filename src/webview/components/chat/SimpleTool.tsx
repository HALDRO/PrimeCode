import React, { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { cn } from '../../lib/cn';
import { CollapseOverlay } from '../ui';

/** Max search results shown inline before collapsing with "+N more" */
const SEARCH_PREVIEW_LIMIT = 10;

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
} from '../icons';
import { Badge, PathChip } from '../ui';

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
						className={cn(
							'pl-3 ml-1 border-l border-(--border-subtle) mt-1 py-1 text-sm overflow-x-auto',
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
	defaultExpanded?: boolean;
}

import { useElapsedTimer } from '../../hooks/useElapsedTimer';
// Re-export from shared hook for backward compatibility
export { useElapsedTimer };

export const ThinkingMessage = React.memo<ThinkingMessageProps>(
	({ content, durationMs, isStreaming, defaultExpanded }) => {
		const preview = useMemo(() => content.split('\n')[0]?.trim(), [content]);
		const [expanded, setExpanded] = useState(defaultExpanded ?? isStreaming ?? false);
		const wasStreamingRef = useRef(isStreaming);
		const liveElapsed = useElapsedTimer(isStreaming ?? false);

		useEffect(() => {
			if (isStreaming) {
				setExpanded(true);
			} else if (wasStreamingRef.current && !isStreaming) {
				setExpanded(false);
			}
			wasStreamingRef.current = isStreaming;
		}, [isStreaming]);

		const displayDuration = isStreaming ? liveElapsed : durationMs;

		return (
			<SimpleTool
				icon={<BrainSideIcon size={17} className="text-vscode-descriptionForeground" />}
				label="Thinking"
				meta={preview}
				expanded={expanded}
				onToggle={() => setExpanded(prev => !prev)}
				rightContent={
					displayDuration !== undefined &&
					displayDuration > 0 && (
						<span className="flex items-center gap-1 text-sm font-bold text-vscode-descriptionForeground">
							<TimerIcon size={11} />
							{formatDuration(displayDuration)}
						</span>
					)
				}
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
	groupToolMessages,
	liveToolGroups,
	precomputeCollapseFlags,
	shouldCollapseGroupedItem,
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

		const {
			label,
			meta,
			metaDisplay,
			isListDir,
			isTodoWrite,
			isRead,
			isSearch,
			isTaskResult,
			readOffset,
			readLimit,
		} = useMemo(() => {
			const action =
				normalizedEntry?.entryType &&
				typeof normalizedEntry.entryType === 'object' &&
				'actionType' in normalizedEntry.entryType
					? normalizedEntry.entryType.actionType
					: null;

			const isLs =
				toolLower === 'ls' || toolLower === 'list_dir' || toolLower === 'serena_list_dir';
			const isRead = action?.type === 'FileRead' || toolLower.includes('read');
			const isTodo = action?.type === 'TodoManagement' || toolLower === 'todowrite';
			const isTaskResult = action?.type === 'TaskResult';
			const isSearch =
				action?.type === 'Search' ||
				action?.type === 'WebSearch' ||
				action?.type === 'CodeSearch' ||
				toolLower === 'grep' ||
				toolLower === 'glob' ||
				toolLower === 'search' ||
				toolLower === 'semanticsearch' ||
				toolLower === 'websearch' ||
				toolLower === 'codesearch';

			let label = formatToolName(toolName);
			let meta = '';

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
					label = 'Search';
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
					const ri = rawInput as {
						path?: string;
						file_path?: string;
						filePath?: string;
						offset?: number;
						limit?: number;
					};
					meta = ri?.path || ri?.file_path || ri?.filePath || '';
					readOffset = typeof ri?.offset === 'number' ? ri.offset : undefined;
					readLimit = typeof ri?.limit === 'number' ? ri.limit : undefined;
				} else if (isTodo) {
					label = 'Todo';
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

			return {
				label,
				meta,
				metaDisplay,
				isListDir: isLs,
				isTodoWrite: isTodo,
				isRead,
				isSearch,
				isTaskResult,
				readOffset,
				readLimit,
			};
		}, [normalizedEntry, rawInput, toolLower, toolName]);

		const metaNode = useMemo(() => {
			if (!meta) return undefined;

			if (isRead) {
				const isFolder = /[\\/]$/.test(meta);
				return (
					<PathChip
						path={meta}
						isFolder={isFolder}
						onClick={
							!isFolder ? () => postMessage({ type: 'openFile', filePath: meta }) : undefined
						}
						title={meta}
						className="max-w-full min-w-0 shrink"
					/>
				);
			}

			if (isListDir) {
				return (
					<PathChip
						path={meta}
						isFolder={true}
						title={meta}
						className="max-w-full min-w-0 shrink"
					/>
				);
			}

			return <Badge label={metaDisplay} title={meta} className="max-w-full min-w-0 shrink" />;
		}, [isListDir, isRead, meta, metaDisplay, postMessage]);

		// For TaskResult, prefer the result text from the actionType over the raw content prop
		const taskResultText = useMemo(() => {
			if (!isTaskResult) return '';
			const entry = normalizedEntry;
			if (
				entry?.entryType &&
				typeof entry.entryType === 'object' &&
				'actionType' in entry.entryType &&
				entry.entryType.actionType.type === 'TaskResult'
			) {
				return entry.entryType.actionType.result || '';
			}
			return '';
		}, [isTaskResult, normalizedEntry]);

		const fullText = isTaskResult ? taskResultText || content || '' : content || '';
		const hasBody = !isRead && fullText.trim().length > 0;

		const lines = useMemo((): string[] => fullText.split('\n'), [fullText]);
		const nonEmptyLineCount = lines.filter((l: string) => l.length > 0).length;

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
			return Array.isArray(rawTodos)
				? (rawTodos as Array<{ content: string; status: string }>)
				: [];
		}, [isTodoWrite, normalizedEntry, rawInput]);

		const completedCount = todos.filter(t => t.status === 'completed').length;
		const totalCount = todos.length;

		// Todo always starts collapsed. User can manually toggle to expand.
		const [todoExpanded, setTodoExpanded] = useState(false);

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

		const ToolIcon = useMemo(() => {
			if (toolName === 'thinking') return BrainSideIcon;
			if (isTaskResult) return CheckCircleIcon;
			if (isTodoWrite) return TodoListIcon;
			if (isRead) return FileTextIcon;
			if (isListDir) return FolderOpenIcon;
			if (isSearch) return SearchIcon;
			return WandIcon;
		}, [toolName, isTodoWrite, isRead, isListDir, isTaskResult, isSearch]);

		return (
			<SimpleTool
				icon={<ToolIcon size={18} />}
				label={label}
				meta={metaNode}
				isError={isError}
				{...(isTodoWrite
					? { expanded: todoExpanded, onToggle: () => setTodoExpanded(prev => !prev) }
					: { defaultExpanded })}
				showCollapseOverlay={showCollapseOverlay}
				rightContent={
					<>
						{isRead && (
							<span className="text-sm whitespace-nowrap text-vscode-descriptionForeground">
								{readOffset !== undefined || readLimit !== undefined
									? `${readOffset ?? 1}–${readLimit !== undefined ? (readOffset ?? 1) + readLimit - 1 : '...'} lines`
									: `${nonEmptyLineCount} lines`}
							</span>
						)}
						{!isRead && isSearch && nonEmptyLineCount > 0 && (
							<span className="text-sm whitespace-nowrap text-vscode-descriptionForeground">
								{nonEmptyLineCount} results
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
											!isFolder
												? () => postMessage({ type: 'openFile', filePath: path })
												: undefined
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
							{searchEntries.slice(0, SEARCH_PREVIEW_LIMIT).map((ref, idx) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
									key={idx}
									className="flex items-center gap-2 min-w-0"
								>
									<PathChip
										path={ref.path}
										isFolder={ref.isFolder}
										line={ref.line}
										onClick={
											!ref.isFolder
												? () =>
														postMessage({ type: 'openFile', filePath: ref.path, line: ref.line })
												: undefined
										}
										title={ref.path}
									/>
									{ref.detail && (
										<span className="text-sm text-vscode-foreground opacity-50 truncate">
											{ref.detail}
										</span>
									)}
								</div>
							))}
							{searchEntries.length > SEARCH_PREVIEW_LIMIT && (
								<span className="text-sm text-vscode-foreground opacity-50 pl-1">
									+{searchEntries.length - SEARCH_PREVIEW_LIMIT} more
								</span>
							)}
						</div>
					) : fullText.trim().length > 0 ? (
						<pre className="m-0 px-1 py-0.5 rounded-sm text-sm leading-(--line-height-code) whitespace-pre-wrap text-vscode-foreground opacity-60">
							{fullText}
						</pre>
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
												? () =>
														postMessage({ type: 'openFile', filePath: ref.path, line: ref.line })
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
	},
);
InlineToolLine.displayName = 'InlineToolLine';
