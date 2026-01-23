/**
 * @file ToolCard - minimal unified tool UI
 * @description Minimal, reusable card for displaying tool calls/results in the chat.
 * Keeps the existing visual style (same CSS variables/classes) while removing excessive per-tool branching.
 * Provides: header icon/label, optional meta text, optional body text, and optional diff body.
 */

import React, { type ReactNode, useMemo, useState } from 'react';
import { computeDiffStats } from '../../../common/diffStats';
import { FILE_EDIT_TOOLS, isMcpTool, isToolInList, isToolMatch } from '../../constants';
import { cn } from '../../lib/cn';
import { useMcpServers, useToolResultByToolId } from '../../store';
import type { Message as WebviewMessage } from '../../store/chatStore';
import { formatDuration, formatToolName, getShortFileName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import {
	BrainSideIcon,
	ChevronDownIcon,
	CopyIcon,
	McpIcon,
	TerminalIcon,
	TimerIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from '../icons';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Button, IconButton, Tooltip } from '../ui';
import { FileLink } from '../ui/FileLink';
import { getDiffContentHeight, SimpleDiff } from './SimpleDiff';

export const TOOL_CARD_CLASSES =
	'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden';

export const TOOL_CARD_HEADER_CLASSES =
	'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none';

const DEFAULT_TEXT_PREVIEW_LINES = 6;

type ToolUse = Extract<WebviewMessage, { type: 'tool_use' }>;

type ToolResult = Extract<WebviewMessage, { type: 'tool_result' }>;

const inlinePreview = (text: string, maxLines: number) => {
	const lines = text.split('\n');
	if (lines.length <= maxLines) return { preview: text, needsExpand: false };
	return { preview: lines.slice(-maxLines).join('\n'), needsExpand: true };
};

const ToolCardLeadingIcon: React.FC<{ children: ReactNode; className?: string }> = ({
	children,
	className,
}) => (
	<span
		className={cn(
			'toolcard-leading-icon flex items-center justify-center w-5 h-5 shrink-0',
			'transition-opacity duration-150 ease-out',
			className,
		)}
	>
		{children}
	</span>
);

export const InlineToolLine: React.FC<{
	toolName: string;
	rawInput: unknown;
	content: string;
	isError: boolean;
	defaultExpanded?: boolean;
}> = ({ toolName, rawInput, content, isError, defaultExpanded }) => {
	const { postMessage } = useVSCode();

	const normalized = toolName.toLowerCase();
	const isTodoWrite = normalized === 'todowrite';
	const isListDir = normalized === 'ls' || normalized === 'serena_list_dir';
	const isRead =
		normalized === 'read' || normalized === 'read_file' || normalized === 'serena_read_file';

	const label = (() => {
		if (isListDir) {
			return 'Listed';
		}
		if (isRead) {
			return 'Read';
		}
		return formatToolName(toolName);
	})();

	const meta = (() => {
		if (isListDir) {
			return (rawInput as { path?: string } | undefined)?.path || '';
		}
		if (isRead) {
			return (rawInput as { path?: string } | undefined)?.path || '';
		}
		if (normalized === 'glob' || normalized === 'grep') {
			return (rawInput as { pattern?: string } | undefined)?.pattern || '';
		}
		if (normalized === 'search') {
			return (rawInput as { query?: string } | undefined)?.query || '';
		}
		return '';
	})();

	const fullText = isRead ? '' : content || '';
	const hasBody = fullText.trim().length > 0;
	const [expanded, setExpanded] = useState(defaultExpanded ?? false);

	const lines = useMemo(() => (content || '').split('\n'), [content]);
	const nonEmptyLineCount = lines.filter(l => l.length > 0).length;

	const todos = useMemo(() => {
		if (!isTodoWrite) return [];
		const rawTodos = (rawInput as { todos?: unknown } | undefined)?.todos;
		return Array.isArray(rawTodos) ? (rawTodos as Array<{ content: string; status: string }>) : [];
	}, [isTodoWrite, rawInput]);

	const completedCount = todos.filter(t => t.status === 'completed').length;
	const totalCount = todos.length;

	const listEntries = useMemo(() => {
		if (!isListDir) return [];
		return lines
			.map(l => l.trim())
			.filter(Boolean)
			.filter(l => l !== meta);
	}, [isListDir, lines, meta]);

	const canToggle = Boolean(
		(isListDir && listEntries.length > 0) ||
			(isTodoWrite && totalCount > 0) ||
			(hasBody && !isRead && !isListDir) ||
			(meta && !isRead && !isListDir),
	);
	const fileRefFromListedLine = (line: string): { path: string; line?: number } | null => {
		const trimmed = line.trim();
		if (!trimmed) return null;
		if (!isListDir) return null;
		if (!meta) return null;

		// Direct full path from backend (already contains separators)
		if (/[\\/]/.test(trimmed)) {
			return { path: trimmed };
		}

		const base = meta.replace(/[\\/]+$/, '');
		return { path: `${base}/${trimmed}` };
	};

	const fileRefFromLine = (line: string): { path: string; line?: number } | null => {
		const trimmed = line.trim();
		if (!trimmed) return null;

		const match = /^([A-Za-z]:\\[^:]+|[^:\s][^:]*?)(?::(\d+))?(?::(\d+))?(?::\s|\s|$)/.exec(
			trimmed,
		);
		if (!match) return null;

		const candidate = match[1];
		if (!candidate) return null;
		if (!/[\\/]/.test(candidate)) return null;
		if (!/\.[a-zA-Z0-9]+$/.test(candidate)) return null;

		const lineNum = match[2] ? Number(match[2]) : undefined;
		return { path: candidate, line: Number.isFinite(lineNum) ? lineNum : undefined };
	};

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

	return (
		<div className={cn('mb-(--tool-utility-block-margin)', isRead && 'cursor-default')}>
			<div
				role={canToggle ? 'button' : undefined}
				tabIndex={canToggle ? 0 : undefined}
				onClick={canToggle ? () => setExpanded(prev => !prev) : undefined}
				onKeyDown={
					canToggle
						? e => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									setExpanded(prev => !prev);
								}
							}
						: undefined
				}
				className={cn(
					'group flex items-center gap-1.5 min-w-0 py-0.5',
					canToggle &&
						'cursor-pointer hover:bg-vscode-toolbar-hoverBackground rounded-md px-1 -mx-1',
				)}
			>
				<span className="text-vscode-foreground opacity-40 select-none">·</span>
				{normalized === 'thinking' ? (
					<ToolCardLeadingIcon>
						<span
							style={{ color: 'var(--color-thinking)' }}
							className="flex items-center justify-center"
						>
							<BrainSideIcon size={14} />
						</span>
					</ToolCardLeadingIcon>
				) : isTodoWrite ? (
					<ToolCardLeadingIcon>
						<TodoListIcon size={14} className="text-[#3b82f6] shrink-0" />
					</ToolCardLeadingIcon>
				) : null}
				{isRead && meta && (
					<FileLink
						compact
						path={meta}
						onClick={e => {
							e?.stopPropagation();
							postMessage('openFile', { filePath: meta });
						}}
					/>
				)}
				{isRead && (
					<span className="text-sm text-vscode-foreground opacity-60 whitespace-nowrap">
						{nonEmptyLineCount} lines
					</span>
				)}
				{normalized === 'ls' || normalized === 'serena_list_dir' ? (
					<div className="flex items-center gap-2 min-w-0">
						<span
							className={cn(
								'text-sm font-semibold leading-none',
								isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-70',
							)}
						>
							{label}
						</span>
						{meta && (
							<FileLink
								compact
								path={meta}
								onClick={e => {
									e?.stopPropagation();
									postMessage('openFile', { filePath: meta });
								}}
							/>
						)}
					</div>
				) : null}
				{!isRead && isTodoWrite && totalCount > 0 && (
					<>
						<span className="text-sm font-semibold text-vscode-foreground opacity-70">
							{completedCount} of {totalCount}
						</span>
						<span className="text-sm text-vscode-foreground opacity-60 truncate">
							{(() => {
								const inProgress = todos.find(t => t.status === 'in_progress');
								const pending = todos.find(t => t.status === 'pending');
								const lastDone = [...todos].reverse().find(t => t.status === 'completed');
								const activeTask = inProgress || pending || lastDone;
								return activeTask ? `- ${activeTask.content}` : '';
							})()}
						</span>
					</>
				)}
				{meta && !isRead && normalized !== 'ls' && normalized !== 'serena_list_dir' && (
					<FileLink
						compact
						path={meta}
						onClick={e => {
							e?.stopPropagation();
							postMessage('openFile', { filePath: meta });
						}}
					/>
				)}
				{normalized === 'thinking' &&
				(rawInput as { durationMs?: number } | undefined)?.durationMs ? (
					<span className="flex items-center gap-1 text-sm leading-none text-vscode-foreground opacity-60">
						<TimerIcon size={11} />
						{formatDuration((rawInput as { durationMs?: number } | undefined)?.durationMs ?? 0)}
					</span>
				) : null}
				{canToggle && !isRead && (
					<span
						className={cn(
							'flex items-center justify-center w-5 h-5 opacity-0 transition-opacity duration-150 ease-out',
							'group-hover:opacity-70 hover:opacity-100',
						)}
					>
						<ChevronDownIcon
							size={14}
							className={cn('transition-transform duration-150 ease-out', expanded && 'rotate-180')}
						/>
					</span>
				)}
			</div>

			{canToggle && expanded && (
				<div className="pl-(--collapsible-indent) border-l border-(--border-subtle) ml-(--gap-1) py-1">
					{isTodoWrite ? (
						<div className="flex flex-col gap-1">
							{todos.map(todo => (
								<div
									key={`${todo.status}-${todo.content}`}
									className="flex items-center gap-(--gap-2-5)"
								>
									<TodoStatusIcon status={todo.status} />
									<span
										className={cn(
											'text-sm truncate',
											todo.status === 'completed'
												? 'text-vscode-foreground opacity-50 line-through'
												: todo.status === 'cancelled'
													? 'text-vscode-foreground opacity-40 line-through'
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
								const ref = fileRefFromListedLine(entry) || fileRefFromLine(entry);
								if (!ref) {
									return (
										<pre
											// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
											key={idx}
											className={cn(
												'm-0 text-sm leading-(--line-height-code) whitespace-pre-wrap',
												isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-60',
											)}
										>
											{entry}
										</pre>
									);
								}

								return (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: static rendering
										key={idx}
										className="flex items-center min-w-0"
									>
										<FileLink
											path={ref.path}
											isFolder={ref.path.endsWith('/') || ref.path.endsWith('\\')}
											onClick={e => {
												e?.stopPropagation();
												postMessage('openFile', { filePath: ref.path, line: ref.line });
											}}
										/>
									</div>
								);
							})}
						</div>
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
												'm-0 text-sm leading-(--line-height-code) whitespace-pre-wrap',
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
										className="flex items-center gap-2 min-w-0"
									>
										<FileLink
											compact
											path={ref.path}
											line={ref.line}
											onClick={e => {
												e?.stopPropagation();
												postMessage('openFile', { filePath: ref.path, line: ref.line });
											}}
										/>
										<span className="text-sm text-vscode-foreground opacity-60 truncate">
											{line.replace(ref.path, '').trim()}
										</span>
									</div>
								);
							})}
						</div>
					) : null}
				</div>
			)}
		</div>
	);
};

export interface ToolCardProps {
	headerLeft: ReactNode;
	headerRight?: ReactNode;
	body?: ReactNode;
	isCollapsible?: boolean;
	expanded?: boolean;
	onToggle?: () => void;
	className?: string;
}

export const ToolCard: React.FC<ToolCardProps> = ({
	headerLeft,
	headerRight,
	body,
	isCollapsible = false,
	expanded = false,
	onToggle,
	className,
}) => {
	const canToggle = Boolean(isCollapsible && onToggle);
	return (
		<div className={cn(TOOL_CARD_CLASSES, 'group', className)}>
			<div
				role={canToggle ? 'button' : undefined}
				tabIndex={canToggle ? 0 : undefined}
				onClick={canToggle ? onToggle : undefined}
				onKeyDown={
					canToggle
						? e => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									onToggle?.();
								}
							}
						: undefined
				}
				className={cn(
					TOOL_CARD_HEADER_CLASSES,
					canToggle && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
					'group/toolcard-header',
				)}
			>
				<div className="relative flex items-center gap-1.5 min-w-0">
					{canToggle && (
						<div
							className={cn(
								'absolute left-0 top-1/2 -translate-y-1/2',
								'flex items-center justify-center w-5 h-5',
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover/toolcard-header:opacity-90',
							)}
						>
							<ChevronDownIcon
								size={14}
								className={cn(
									'transition-transform duration-150 ease-out',
									expanded && 'rotate-180',
								)}
							/>
						</div>
					)}
					<div
						className={cn(
							'flex items-center gap-1.5 min-w-0',
							canToggle && 'group-hover/toolcard-header:[&_.toolcard-leading-icon]:opacity-0',
						)}
					>
						{headerLeft}
					</div>
				</div>
				<div className="flex items-center gap-1.5 shrink-0 ml-auto">{headerRight}</div>
			</div>
			{body}
		</div>
	);
};

interface ToolCardMessageProps {
	message: ToolUse;
	toolResult?: ToolResult;
	defaultExpanded?: boolean;
}

export const ToolCardMessage: React.FC<ToolCardMessageProps> = React.memo(
	({ message, toolResult: providedToolResult, defaultExpanded }) => {
		const { postMessage } = useVSCode();
		const mcpServers = useMcpServers();
		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

		const { toolUseId, filePath, rawInput } = message;
		const toolName = message.toolName ?? '';
		const selectorToolResult = useToolResultByToolId(providedToolResult ? undefined : toolUseId);
		const toolResult = providedToolResult ?? selectorToolResult;

		const isError = toolResult?.isError ?? false;
		const content = toolResult?.content ?? '';

		const isMcp = isMcpTool(toolName, mcpServerNames);
		const isBash = isToolMatch(toolName, 'Bash');
		const isFileEditTool =
			isToolInList(toolName, FILE_EDIT_TOOLS) &&
			rawInput &&
			((rawInput as Record<string, unknown>).old_string !== undefined ||
				(rawInput as Record<string, unknown>).new_string !== undefined ||
				(rawInput as Record<string, unknown>).old_str !== undefined ||
				(rawInput as Record<string, unknown>).new_str !== undefined ||
				(rawInput as Record<string, unknown>).oldString !== undefined ||
				(rawInput as Record<string, unknown>).newString !== undefined ||
				(rawInput as Record<string, unknown>).content !== undefined);

		const [expanded, setExpanded] = useState(defaultExpanded ?? false);
		const [diffExpanded, setDiffExpanded] = useState(defaultExpanded ?? false);

		if (!toolName) return null;

		// Only these get a card: MCP, Bash, file-edit diff.
		if (!isMcp && !isBash && !isFileEditTool) {
			return (
				<InlineToolLine
					toolName={toolName}
					rawInput={rawInput}
					content={content}
					isError={isError}
					defaultExpanded={defaultExpanded}
				/>
			);
		}

		// 1) Diff-card for file edit tools
		if (isFileEditTool && rawInput) {
			const oldContent =
				String((rawInput as Record<string, unknown>).old_string ?? '') ||
				String((rawInput as Record<string, unknown>).old_str ?? '') ||
				String((rawInput as Record<string, unknown>).oldString ?? '') ||
				'';
			const newContent =
				String((rawInput as Record<string, unknown>).new_string ?? '') ||
				String((rawInput as Record<string, unknown>).new_str ?? '') ||
				String((rawInput as Record<string, unknown>).newString ?? '') ||
				String((rawInput as Record<string, unknown>).content ?? '') ||
				'';

			const stats = computeDiffStats(oldContent, newContent);
			const name = filePath ? getShortFileName(filePath) : 'unknown';
			const maxHeight = 120;
			const needsExpand = getDiffContentHeight(oldContent, newContent) > maxHeight;

			return (
				<ToolCard
					headerLeft={
						<>
							<ToolCardLeadingIcon>
								<FileTypeIcon name={name} size={14} />
							</ToolCardLeadingIcon>
							<Tooltip content="Open file in editor" position="top" delay={200}>
								<button
									type="button"
									onClick={e => {
										e.stopPropagation();
										if (filePath) postMessage('openFile', { filePath });
									}}
									className="text-sm cursor-pointer text-vscode-foreground bg-none border-none p-0 opacity-90 whitespace-nowrap overflow-hidden text-ellipsis"
								>
									{name}
								</button>
							</Tooltip>
							{stats.added > 0 && <span className="text-success">+{stats.added}</span>}
							{stats.removed > 0 && <span className="text-error">−{stats.removed}</span>}
						</>
					}
					headerRight={
						<Button
							variant="tool"
							size="sm"
							height={20}
							onClick={e => {
								e.stopPropagation();
								if (filePath) postMessage('openFileDiff', { filePath, oldContent, newContent });
							}}
							title="Open in diff editor"
							className="font-bold uppercase tracking-wider text-xs text-vscode-foreground opacity-100 px-1"
						>
							Diff
						</Button>
					}
					isCollapsible={needsExpand}
					expanded={diffExpanded}
					onToggle={() => setDiffExpanded(prev => !prev)}
					body={
						<div className="relative">
							<SimpleDiff
								original={oldContent}
								modified={newContent}
								maxHeight={maxHeight}
								expanded={diffExpanded}
							/>
							<div
								className={cn(
									'absolute right-(--tool-content-padding) bottom-0',
									'opacity-0 transition-opacity duration-150 ease-out',
									'group-hover:opacity-100',
								)}
							>
								<IconButton
									icon={<CopyIcon size={14} />}
									onClick={e => {
										e.stopPropagation();
										navigator.clipboard.writeText(newContent);
									}}
									title="Copy"
									size={20}
								/>
							</div>
						</div>
					}
				/>
			);
		}

		// 2) Tool cards are reserved for MCP/Bash only.
		const icon = isMcp ? (
			<ToolCardLeadingIcon>
				<McpIcon size={14} className="text-[#3b82f6] shrink-0" />
			</ToolCardLeadingIcon>
		) : isBash ? (
			<ToolCardLeadingIcon>
				<TerminalIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : null;
		const label = isMcp ? 'MCP' : formatToolName(toolName);
		const meta = (() => {
			if (isBash) return (rawInput as { command?: string } | undefined)?.command || '';
			if (isMcp) return rawInput ? JSON.stringify(rawInput) : '';
			return '';
		})();

		const fullText = content || '';
		const { preview, needsExpand } = inlinePreview(fullText, DEFAULT_TEXT_PREVIEW_LINES);
		const shownText = expanded || !needsExpand ? fullText : preview;

		// No result yet: render only header
		const hasBody = shownText.trim().length > 0;

		return (
			<ToolCard
				headerLeft={
					<>
						{icon}
						<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap">
							{label}
						</span>
						{meta && (
							<span className="text-sm text-vscode-foreground opacity-70 truncate">{meta}</span>
						)}
					</>
				}
				headerRight={
					hasBody ? (
						<div
							className={cn(
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover:opacity-100',
							)}
						>
							<IconButton
								icon={<CopyIcon size={14} />}
								onClick={e => {
									e.stopPropagation();
									navigator.clipboard.writeText(fullText);
								}}
								title="Copy"
								size={20}
							/>
						</div>
					) : undefined
				}
				isCollapsible={needsExpand && hasBody}
				expanded={expanded}
				onToggle={() => setExpanded(prev => !prev)}
				body={
					hasBody ? (
						<div className="p-(--tool-content-padding) bg-(--tool-bg-header)">
							<pre
								className={cn(
									'm-0 text-sm leading-(--line-height-code) whitespace-pre',
									isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-90',
								)}
							>
								{shownText}
							</pre>
						</div>
					) : undefined
				}
			/>
		);
	},
);

ToolCardMessage.displayName = 'ToolCardMessage';

export const ToolCardGroup: React.FC<{ messages: WebviewMessage[] }> = ({ messages }) => {
	const toolUseMessages = useMemo(
		() => messages.filter(m => m.type === 'tool_use') as ToolUse[],
		[messages],
	);

	const localToolResults = useMemo(() => {
		const results: Record<string, ToolResult | undefined> = {};
		for (const msg of messages) {
			if (msg.type === 'tool_result' && msg.toolUseId) {
				results[msg.toolUseId] = msg as ToolResult;
			}
		}
		return results;
	}, [messages]);

	if (toolUseMessages.length === 0) return null;

	return (
		<>
			{toolUseMessages.map(msg => (
				<div key={msg.id} className="mb-(--tool-block-margin)">
					<ToolCardMessage message={msg} toolResult={localToolResults[msg.toolUseId]} />
				</div>
			))}
		</>
	);
};
