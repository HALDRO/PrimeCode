/**
 * @file ChangedFilesPanel - displays list of files changed during session
 * @description Collapsible panel showing files modified by AI with diff stats.
 *              Header layout mirrors FileRow structure for perfect alignment.
 *              Also displays current Todo list status when available.
 *              Session-specific changed files and todo state come from chatStore.
 *              Copy operations read directly from chatStore + navigator.clipboard.
 *              OPTIMIZED: Todo display extracted to separate component to isolate rerenders.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isMcpTool } from '../../constants';
import { cn } from '../../lib/cn';
import {
	projectRuntimeMessages,
	type RenderMessage,
	useChangedFilesState,
	useChatActions,
	useMcpServers,
	useTodoState,
} from '../../store';
import type { ChangedFile } from '../../store/chatStore';
import { useChatStore } from '../../store/chatStore';
import { useUIActions } from '../../store/uiStore';
import { useVSCode } from '../../utils/vscode';
import {
	AcceptIcon,
	ChevronIcon,
	CopyIcon,
	FileIcon,
	RejectIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from '../icons';
import { DropdownMenu, IconButton, PathChip, ScrollContainer, Tooltip } from '../ui';

interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

interface CopyMenuItem {
	label: string;
	action: () => void;
}

// ─── Copy helpers (shared logic, no duplication) ───

function getActiveMessages(): RenderMessage[] | undefined {
	const state = useChatStore.getState();
	const session = state.activeSessionId ? state.sessionsById[state.activeSessionId] : undefined;
	return session ? projectRuntimeMessages(session) : undefined;
}

function findLastUserIndex(msgs: RenderMessage[]): number {
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].kind === 'user') return i;
	}
	return -1;
}

/** Check if a tool_use should be included in copy output (MCP, WebSearch, WebFetch) */
function isCopyableToolResult(m: RenderMessage, mcpServerNames: string[]): boolean {
	if (m.kind !== 'tool_use') return false;
	const name = m.toolName?.toLowerCase() ?? '';
	if (name === 'websearch' || name === 'webfetch') return true;
	return isMcpTool(m.toolName, mcpServerNames);
}

function formatMessage(
	m: RenderMessage,
	mode: 'last' | 'all',
	mcpServerNames: string[],
): string | undefined {
	if (m.kind === 'user') return `## User\n${m.content}`;
	if (m.kind === 'assistant' && m.content) {
		return mode === 'all' ? `## Assistant\n${m.content}` : m.content;
	}
	if (m.kind === 'subtask' && m.result) {
		return mode === 'all' ? `## Agent: ${m.agent}\n${m.result}` : `[${m.agent}] ${m.result}`;
	}
	// Include completed tool output from MCP, WebSearch, WebFetch
	if (m.kind === 'tool_use' && isCopyableToolResult(m, mcpServerNames)) {
		const toolName = m.toolName ?? 'Tool';
		const content = m.resultContent ?? m.streamingOutput ?? '';
		if (!content.trim()) return undefined;
		const prefix = mode === 'all' ? `## ${toolName}\n` : '';
		return `${prefix}${content}`;
	}
	return undefined;
}

function formatMessages(
	msgs: RenderMessage[],
	mode: 'last' | 'all',
	mcpServerNames: string[],
): string {
	const parts: string[] = [];
	for (const m of msgs) {
		const text = formatMessage(m, mode, mcpServerNames);
		if (text) parts.push(text);
	}
	return parts.join('\n\n');
}

/**
 * Build copyable diffs from tool_result metadata.
 * Uses the same unified diff source as SimpleDiff component (metadata.diff).
 * Falls back to tool_use filePath header when no diff content available.
 */
function buildPatches(msgs: RenderMessage[]): string {
	// Build a map of toolUseId → tool metadata for quick lookup
	const resultMap = new Map<string, Record<string, unknown>>();
	for (const m of msgs) {
		if (m.kind === 'tool_use' && m.toolUseId && m.metadata) {
			resultMap.set(m.toolUseId, m.metadata as Record<string, unknown>);
		}
	}

	const patches: string[] = [];
	for (const m of msgs) {
		if (m.kind !== 'tool_use') continue;
		const meta = resultMap.get(m.toolUseId);
		if (!meta) continue;
		// Extract unified diff from metadata — same source as SimpleDiff
		const diff = meta.diff;
		if (typeof diff === 'string' && diff.trim()) {
			patches.push(diff.trim());
		}
		// No unified diff available — skip (no manual reconstruction)
	}
	return patches.join('\n\n');
}

const CopyDropdown = React.memo<{
	items: CopyMenuItem[];
	onClose: () => void;
}>(({ items, onClose }) => (
	<DropdownMenu
		items={items.map((item, idx) => ({
			id: `copy-${idx}`,
			label: item.label,
			data: item,
		}))}
		onSelect={(item: CopyMenuItem) => {
			item.action();
			onClose();
		}}
		onClose={onClose}
		position="top"
		align="right"
		minWidth={180}
		maxWidth={220}
		keyHints={{}}
	/>
));
CopyDropdown.displayName = 'CopyDropdown';

/** Status icon for todo items */
const TodoStatusIcon: React.FC<{ status: TodoItem['status'] }> = ({ status }) => {
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

/** Todo hover popup - adaptive positioning to stay within viewport */
const TodoHoverPopup = React.memo<{
	todos: TodoItem[];
	triggerRef: React.RefObject<HTMLDivElement | null>;
}>(({ todos, triggerRef }) => {
	const popupRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; maxWidth: number } | null>(null);
	const completedCount = todos.filter(t => t.status === 'completed').length;
	const totalCount = todos.length;

	useLayoutEffect(() => {
		const trigger = triggerRef.current;
		const popup = popupRef.current;
		if (!trigger || !popup) return;

		const triggerRect = trigger.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const padding = 8;

		// Desired width: 75vw but capped to available space
		const desiredWidth = viewportWidth * 0.75;
		const maxAvailable = viewportWidth - padding * 2;
		const finalWidth = Math.min(desiredWidth, maxAvailable);

		// Center popup relative to trigger, then clamp to viewport
		const triggerCenter = triggerRect.left + triggerRect.width / 2;
		let left = triggerCenter - finalWidth / 2;

		// Clamp: don't overflow left
		if (left < padding) left = padding;
		// Clamp: don't overflow right
		if (left + finalWidth > viewportWidth - padding) {
			left = viewportWidth - padding - finalWidth;
		}

		// Convert to position relative to trigger's left edge (since parent is relative)
		const relativeLeft = left - triggerRect.left;

		setPosition({ left: relativeLeft, maxWidth: finalWidth });
	}, [triggerRef]);

	return (
		<div
			ref={popupRef}
			className="absolute bottom-[calc(100%+8px)] z-100 pointer-events-none"
			style={{
				left: position ? `${position.left}px` : 0,
				width: position ? `${position.maxWidth}px` : '75vw',
			}}
		>
			<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden w-full pointer-events-auto">
				{/* Header */}
				<div className="flex items-center gap-1.5 h-(--tool-header-height) px-(--tool-header-padding) border-b border-(--border-subtle) bg-(--tool-bg-header)">
					<TodoListIcon size={14} className="text-vscode-foreground opacity-80 shrink-0" />
					<span className="text-sm text-vscode-foreground opacity-90">
						{completedCount} of {totalCount} Done
					</span>
				</div>
				{/* Content */}
				<div className="px-(--tool-header-padding) py-1 bg-(--tool-bg-header)">
					<div className="flex flex-col gap-(--gap-1)">
						{todos.map(todo => (
							<div key={todo.id || todo.content} className="flex items-start gap-1.5">
								<TodoStatusIcon status={todo.status} />
								<span
									className={cn(
										'text-sm break-words min-w-0 text-left',
										todo.status === 'completed'
											? 'text-vscode-foreground opacity-50'
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
				</div>
			</div>
		</div>
	);
});
TodoHoverPopup.displayName = 'TodoHoverPopup';

/**
 * Isolated Todo display component - subscribes to messages independently
 * so ChangedFilesPanel doesn't rerender on every message change
 */
const TodoSection: React.FC = React.memo(() => {
	const currentTodos = useTodoState();
	const [showTodoPopup, setShowTodoPopup] = useState(false);
	const triggerRef = useRef<HTMLDivElement>(null);

	if (!currentTodos || currentTodos.length === 0) {
		return null;
	}

	return (
		<div
			ref={triggerRef}
			className="relative flex"
			onMouseEnter={() => setShowTodoPopup(true)}
			onMouseLeave={() => setShowTodoPopup(false)}
		>
			<span className="flex items-center gap-(--gap-1-5) bg-transparent border-none px-(--gap-2) py-(--gap-1) rounded-sm cursor-default text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-vscode-list-hoverBackground hover:opacity-100 whitespace-nowrap">
				<TodoListIcon size={12} className="shrink-0" />
				<span>
					{currentTodos.filter(t => t.status === 'completed').length}/{currentTodos.length}
				</span>
			</span>
			{showTodoPopup && <TodoHoverPopup todos={currentTodos} triggerRef={triggerRef} />}
		</div>
	);
});
TodoSection.displayName = 'TodoSection';

function formatDiffCount(value: number, kind: 'added' | 'removed'): string {
	if (value <= 0) {
		return '0';
	}
	return kind === 'added' ? `+${value}` : `-${value}`;
}

const FileRow = React.memo<{
	file: ChangedFile;
	onOpenDiff: () => void;
	onAccept: () => void;
	onReject: () => void;
}>(({ file, onOpenDiff, onAccept, onReject }) => (
	<div className="flex items-center h-(--file-row-height) text-sm font-(family-name:--vscode-font-family) rounded-sm transition-colors hover:bg-(--alpha-5) box-border">
		{/* Spacer - same width as header chevron */}
		<span className="shrink-0 w-(--icon-md)" />

		{/* Stats - min-width for alignment, right-aligned text */}
		<span className="text-success opacity-90 whitespace-nowrap text-right min-w-8">
			{formatDiffCount(file.linesAdded, 'added')}
		</span>
		<span className="text-error opacity-90 whitespace-nowrap text-left min-w-8 ml-(--gap-4)">
			{formatDiffCount(file.linesRemoved, 'removed')}
		</span>

		<div className="flex-1 min-w-0">
			<PathChip
				path={file.filePath}
				onClick={onOpenDiff}
				title={file.filePath}
				className="max-w-full"
			/>
		</div>

		<Tooltip content="Accept changes" position="top" delay={200}>
			<button
				type="button"
				className="bg-transparent border-none p-0.5 rounded-sm cursor-pointer text-vscode-descriptionForeground flex items-center opacity-70 transition-all duration-100 ease-out font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100"
				onClick={onAccept}
			>
				<AcceptIcon />
			</button>
		</Tooltip>

		<span className="w-(--gap-1)" />

		<Tooltip content="Reject changes" position="top" delay={200}>
			<button
				type="button"
				className="bg-transparent border-none p-0.5 rounded-sm cursor-pointer text-vscode-descriptionForeground flex items-center opacity-70 transition-all duration-100 ease-out font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100"
				onClick={onReject}
			>
				<RejectIcon />
			</button>
		</Tooltip>
	</div>
));
FileRow.displayName = 'FileRow';

export const ChangedFilesPanel: React.FC = React.memo(() => {
	const { changedFiles, cumulativeDiffs } = useChangedFilesState();
	const hasCumulative = cumulativeDiffs.length > 0;
	// When cumulative diffs are available, they are authoritative — only show panel
	// if at least one file has non-zero stats. Before cumulative arrives, fall back
	// to changedFiles presence so the panel appears immediately on first edit.
	const hasFiles = hasCumulative
		? cumulativeDiffs.some(d => d.additions > 0 || d.deletions > 0)
		: changedFiles.length > 0;

	// When no changed files, keep the area above the input empty.
	if (!hasFiles) {
		return null;
	}

	// When changed files exist — show the full ChangedFilesPanel.
	return <ChangedFilesPanelContent />;
});
ChangedFilesPanel.displayName = 'ChangedFilesPanel';

const ChangedFilesPanelContent: React.FC = React.memo(() => {
	const { postMessage } = useVSCode();
	const { changedFiles, cumulativeDiffs } = useChangedFilesState();
	const { clearChangedFiles, removeChangedFile } = useChatActions();
	const { showConfirmDialog } = useUIActions();
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const [expanded, setExpanded] = useState(false);
	const [showCopyDropdown, setShowCopyDropdown] = useState(false);

	// Build a lookup map from cumulative diffs (original→current) when available
	const cumulativeMap = useMemo(() => {
		const map = new Map<string, { additions: number; deletions: number }>();
		for (const d of cumulativeDiffs) {
			map.set(d.file, { additions: d.additions, deletions: d.deletions });
		}
		return map;
	}, [cumulativeDiffs]);

	const hasCumulative = cumulativeMap.size > 0;

	// Build the file list for display.
	// When cumulativeDiffs are available (from CLI session.diff — git-level original→current),
	// they are the single source of truth for stats. Per-edit changedFiles[] are only used
	// to know which files were touched (for file list membership and metadata like toolUseId).
	// This eliminates the "double count" problem where per-edit sums showed wrong numbers
	// before the cumulative event arrived and corrected them.
	const groupedFiles = useMemo(() => {
		const fileMap = new Map<string, ChangedFile>();

		// Start with changedFiles grouped by path (for file list + metadata)
		for (const file of changedFiles) {
			const existing = fileMap.get(file.filePath);
			if (existing) {
				fileMap.set(file.filePath, {
					...existing,
					// Don't sum per-edit stats — they'll be overridden by cumulative
					linesAdded: existing.linesAdded + file.linesAdded,
					linesRemoved: existing.linesRemoved + file.linesRemoved,
					timestamp: Math.max(existing.timestamp, file.timestamp),
					toolUseId: file.toolUseId,
				});
			} else {
				fileMap.set(file.filePath, { ...file });
			}
		}

		if (hasCumulative) {
			// Override stats only for files that are already associated with this session.
			// Do not introduce files from session.diff alone: snapshot-level diffs can
			// include unrelated workspace edits that happened outside the assistant flow.
			for (const [filePath, entry] of fileMap) {
				const cumulative = cumulativeMap.get(filePath);
				if (cumulative) {
					entry.linesAdded = cumulative.additions;
					entry.linesRemoved = cumulative.deletions;
				} else {
					// File is in changedFiles but not in cumulativeDiffs — it was
					// reverted or the diff is zero. Reset to 0 to avoid stale per-edit sums.
					entry.linesAdded = 0;
					entry.linesRemoved = 0;
				}
			}
		}

		// Filter out files with zero additions and zero deletions (reverted edits)
		return Array.from(fileMap.values()).filter(f => f.linesAdded > 0 || f.linesRemoved > 0);
	}, [changedFiles, cumulativeMap, hasCumulative]);

	// Header totals: always derived from groupedFiles so they match the per-file rows exactly.
	// Previously this was computed separately from cumulativeDiffs, which could include files
	// not present in changedFiles — causing header vs per-file row discrepancies.
	const { totalAdded, totalRemoved } = useMemo(() => {
		let added = 0;
		let removed = 0;
		for (const f of groupedFiles) {
			added += f.linesAdded;
			removed += f.linesRemoved;
		}
		return { totalAdded: added, totalRemoved: removed };
	}, [groupedFiles]);

	// Count unique files for display
	const uniqueFileCount = groupedFiles.length;

	const handleOpenDiff = useCallback(
		(filePath: string) => {
			postMessage({ type: 'openFileDiff', filePath });
		},
		[postMessage],
	);

	const handleAcceptFile = useCallback(
		(filePath: string) => {
			postMessage({ type: 'acceptFile', filePath });
			removeChangedFile(filePath);
		},
		[postMessage, removeChangedFile],
	);

	const handleRejectFile = useCallback(
		(filePath: string) => {
			postMessage({ type: 'undoFileChanges', filePath });
		},
		[postMessage],
	);

	const handleUndoAll = useCallback(() => {
		postMessage({ type: 'undoAllChanges' });
	}, [postMessage]);

	const handleKeepAll = useCallback(() => {
		const filePaths = groupedFiles.map(f => f.filePath);
		postMessage({ type: 'acceptAllFiles', filePaths });
		clearChangedFiles();
	}, [groupedFiles, postMessage, clearChangedFiles]);

	// ─── Copy operations: read directly from chatStore + clipboard ───

	const handleCopyLastResponse = useCallback(() => {
		const msgs = getActiveMessages();
		if (!msgs) return;
		const lastUserIdx = findLastUserIndex(msgs);
		const slice = msgs.slice(Math.max(0, lastUserIdx));
		const text = formatMessages(slice, 'last', mcpServerNames);
		if (text) void navigator.clipboard.writeText(text);
	}, [mcpServerNames]);

	const handleCopyAllMessages = useCallback(() => {
		const msgs = getActiveMessages();
		if (!msgs) return;
		const text = formatMessages(msgs, 'all', mcpServerNames);
		if (text) void navigator.clipboard.writeText(text);
	}, [mcpServerNames]);

	const handleCopyLastDiffs = useCallback(() => {
		const msgs = getActiveMessages();
		if (!msgs) return;
		const lastUserIdx = findLastUserIndex(msgs);
		const text = buildPatches(msgs.slice(Math.max(0, lastUserIdx)));
		if (text) void navigator.clipboard.writeText(text);
	}, []);

	const handleCopyAllDiffs = useCallback(() => {
		const msgs = getActiveMessages();
		if (!msgs) return;
		const text = buildPatches(msgs);
		if (text) void navigator.clipboard.writeText(text);
	}, []);

	const copyMenuItems = useMemo<CopyMenuItem[]>(
		() => [
			{ label: 'Copy Last Response', action: handleCopyLastResponse },
			{ label: 'Copy All Messages', action: handleCopyAllMessages },
			{ label: 'Copy Diffs (Last Response)', action: handleCopyLastDiffs },
			{ label: 'Copy Diffs (All Session)', action: handleCopyAllDiffs },
		],
		[handleCopyLastResponse, handleCopyAllMessages, handleCopyLastDiffs, handleCopyAllDiffs],
	);

	// Always render - TodoSection will handle its own visibility
	// This prevents ChangedFilesPanel from subscribing to messages
	if (groupedFiles.length === 0) {
		return null;
	}

	return (
		<div className="w-full box-border relative bg-transparent">
			{showCopyDropdown && (
				<CopyDropdown items={copyMenuItems} onClose={() => setShowCopyDropdown(false)} />
			)}

			<div
				className={cn(
					'bg-(--panel-header-bg) rounded-t-lg border border-(--panel-header-border) border-b-0',
					'@container/panel',
				)}
			>
				{/* Header - only when files exist */}
				{groupedFiles.length > 0 && (
					<button
						type="button"
						tabIndex={0}
						onClick={() => setExpanded(!expanded)}
						onKeyDown={e => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setExpanded(!expanded);
							}
						}}
						className={cn(
							'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding)',
							'text-sm font-(family-name:--vscode-font-family)',
							'bg-transparent border-none cursor-pointer',
							expanded && 'rounded-b-lg',
						)}
					>
						{/* Left section - stats */}
						<span className="flex items-center overflow-hidden min-w-0 shrink-0">
							<span className="shrink-0 flex items-center justify-center w-(--icon-md)">
								<ChevronIcon expanded={expanded} size={10} />
							</span>
							<span className="text-success whitespace-nowrap text-right min-w-8">
								{formatDiffCount(totalAdded, 'added')}
							</span>
							<span className="text-error whitespace-nowrap text-left min-w-8 ml-(--gap-4)">
								{formatDiffCount(totalRemoved, 'removed')}
							</span>
							<span className="flex items-center gap-(--gap-1) text-sm text-vscode-foreground opacity-90">
								<FileIcon size={12} />
								<span className="hide-on-narrow">
									{uniqueFileCount} {uniqueFileCount === 1 ? 'File' : 'Files'}
								</span>
								<span className="show-on-narrow">{uniqueFileCount}</span>
							</span>
						</span>

						{/* Center section - Todo status */}
						<TodoSection />

						{/* Right section - action buttons */}
						<div className="flex items-center gap-1 ml-2 shrink-0">
							<IconButton
								icon={<CopyIcon size={12} />}
								onClick={e => {
									e.stopPropagation();
									setShowCopyDropdown(!showCopyDropdown);
								}}
								title="Copy options"
								size={20}
							/>

							<Tooltip content="Keep all changes" position="top" delay={200}>
								<button
									type="button"
									className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 whitespace-nowrap"
									onClick={e => {
										e.stopPropagation();
										showConfirmDialog({
											title: 'Keep All Changes',
											message: `This will accept all changes to ${uniqueFileCount} file${uniqueFileCount > 1 ? 's' : ''}.`,
											confirmLabel: 'Keep',
											cancelLabel: 'Cancel',
											onConfirm: handleKeepAll,
										});
									}}
								>
									Keep
								</button>
							</Tooltip>

							<Tooltip content="Undo all changes" position="top" delay={200}>
								<button
									type="button"
									className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 whitespace-nowrap"
									onClick={e => {
										e.stopPropagation();
										showConfirmDialog({
											title: 'Undo All Changes',
											message: `This will undo all changes to ${uniqueFileCount} file${uniqueFileCount > 1 ? 's' : ''}.`,
											confirmLabel: 'Undo',
											cancelLabel: 'Cancel',
											onConfirm: handleUndoAll,
										});
									}}
								>
									Undo
								</button>
							</Tooltip>
						</div>
					</button>
				)}

				{expanded && groupedFiles.length > 0 && (
					<div>
						<ScrollContainer className="px-(--tool-header-padding) max-h-[40vh]">
							{groupedFiles.map(file => (
								<FileRow
									key={file.filePath}
									file={file}
									onOpenDiff={() => handleOpenDiff(file.filePath)}
									onAccept={() => handleAcceptFile(file.filePath)}
									onReject={() => handleRejectFile(file.filePath)}
								/>
							))}
						</ScrollContainer>
					</div>
				)}
			</div>
		</div>
	);
});
ChangedFilesPanel.displayName = 'ChangedFilesPanel';
