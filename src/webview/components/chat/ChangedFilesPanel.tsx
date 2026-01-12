/**
 * @file ChangedFilesPanel - displays list of files changed during session
 * @description Collapsible panel showing files modified by Claude with diff stats.
 *              Header layout mirrors FileRow structure for perfect alignment.
 *              Also displays current Todo list status when available.
 *              Session-specific data (changedFiles, totalStats) now comes from chatStore.
 *              OPTIMIZED: Copy operations delegated to extension to avoid messages subscription.
 *              OPTIMIZED: Todo display extracted to separate component to isolate rerenders.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { useChangedFilesState, useChatActions, useTodoState } from '../../store';
import type { ChangedFile } from '../../store/chatStore';
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
import {
	DropdownMenu,
	FileLink,
	IconButton,
	ScrollContainer,
	SessionStatsDisplay,
	Tooltip,
} from '../ui';

interface TodoItem {
	id?: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

interface CopyMenuItem {
	label: string;
	action: () => void;
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

/** Todo hover popup - same design as in chat */
const TodoHoverPopup = React.memo<{ todos: TodoItem[] }>(({ todos }) => {
	const completedCount = todos.filter(t => t.status === 'completed').length;
	const totalCount = todos.length;

	return (
		<div className="absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 z-100 pointer-events-none">
			<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden min-w-(--popup-min-width) max-w-(--popup-max-width) pointer-events-auto">
				{/* Header */}
				<div className="flex items-center gap-1.5 h-(--tool-header-height) px-(--tool-header-padding) border-b border-white/5 bg-(--tool-bg-header)">
					<TodoListIcon size={14} className="text-vscode-foreground opacity-80 shrink-0" />
					<span className="text-sm text-vscode-foreground opacity-90">
						{completedCount} of {totalCount} Done
					</span>
				</div>
				{/* Content */}
				<div className="px-(--tool-header-padding) py-1 bg-(--tool-bg-header)">
					<div className="flex flex-col gap-(--gap-1)">
						{todos.map(todo => (
							<div key={todo.id || todo.content} className="flex items-center gap-(--gap-2-5)">
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
const TodoSection: React.FC<{ hasFiles: boolean }> = React.memo(({ hasFiles }) => {
	const currentTodos = useTodoState();
	const [showTodoPopup, setShowTodoPopup] = useState(false);

	if (!currentTodos || currentTodos.length === 0) {
		return null;
	}

	return (
		<div
			className={cn('relative flex justify-center', !hasFiles ? 'flex-1' : '')}
			onMouseEnter={() => setShowTodoPopup(true)}
			onMouseLeave={() => setShowTodoPopup(false)}
		>
			<span className="flex items-center gap-(--gap-1-5) bg-transparent border-none px-(--gap-2) py-(--gap-1) rounded-sm cursor-default text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 whitespace-nowrap">
				<TodoListIcon size={12} className="shrink-0" />
				<span>
					{currentTodos.filter(t => t.status === 'completed').length}/{currentTodos.length}
				</span>
			</span>
			{showTodoPopup && <TodoHoverPopup todos={currentTodos} />}
		</div>
	);
});
TodoSection.displayName = 'TodoSection';

const FileRow = React.memo<{
	file: ChangedFile;
	onOpenDiff: () => void;
	onAccept: () => void;
	onReject: () => void;
}>(({ file, onOpenDiff, onAccept, onReject }) => (
	<div className="flex items-center h-(--file-row-height) text-sm font-(family-name:--vscode-font-family) rounded-sm transition-colors hover:bg-white/5 box-border">
		{/* Spacer - same width as header chevron */}
		<span className="shrink-0 w-(--icon-md)" />

		{/* Stats - min-width for alignment, right-aligned text */}
		<span className="text-success opacity-90 whitespace-nowrap text-right min-w-8">
			+{file.linesAdded}
		</span>
		<span className="text-error opacity-90 whitespace-nowrap text-left min-w-8 ml-(--gap-4)">
			-{file.linesRemoved}
		</span>

		<div className="flex-1 min-w-0">
			<FileLink path={file.filePath} onClick={onOpenDiff} compact />
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
	const { changedFiles } = useChangedFilesState();
	const currentTodos = useTodoState();

	const hasFiles = changedFiles.length > 0;
	const hasTodos = Boolean(currentTodos && currentTodos.length > 0);

	// Do not render the panel until there are changed files or a todo list.
	if (!hasFiles && !hasTodos) {
		return null;
	}

	return <ChangedFilesPanelContent />;
});
ChangedFilesPanel.displayName = 'ChangedFilesPanel';

const ChangedFilesPanelContent: React.FC = React.memo(() => {
	const { postMessage } = useVSCode();
	const { changedFiles } = useChangedFilesState();
	const hasFiles = changedFiles.length > 0;
	const { clearChangedFiles, removeChangedFile } = useChatActions();
	const { showConfirmDialog } = useUIActions();
	const [expanded, setExpanded] = useState(false);
	const [showCopyDropdown, setShowCopyDropdown] = useState(false);

	const { totalAdded, totalRemoved } = useMemo(
		() => ({
			totalAdded: changedFiles.reduce((sum, f) => sum + f.linesAdded, 0),
			totalRemoved: changedFiles.reduce((sum, f) => sum + f.linesRemoved, 0),
		}),
		[changedFiles],
	);

	// Group changedFiles by filePath for display (aggregate stats per file)
	const groupedFiles = useMemo(() => {
		const fileMap = new Map<string, ChangedFile>();
		for (const file of changedFiles) {
			const existing = fileMap.get(file.filePath);
			if (existing) {
				// Aggregate stats for same file
				fileMap.set(file.filePath, {
					...existing,
					linesAdded: existing.linesAdded + file.linesAdded,
					linesRemoved: existing.linesRemoved + file.linesRemoved,
					timestamp: Math.max(existing.timestamp, file.timestamp),
					toolUseId: file.toolUseId, // Keep latest toolUseId
				});
			} else {
				fileMap.set(file.filePath, { ...file });
			}
		}
		return Array.from(fileMap.values());
	}, [changedFiles]);

	// Count unique files for display
	const uniqueFileCount = groupedFiles.length;

	const handleOpenDiff = useCallback(
		(filePath: string) => {
			postMessage('openFileDiff', { filePath });
		},
		[postMessage],
	);

	const handleAcceptFile = useCallback(
		(filePath: string) => {
			removeChangedFile(filePath);
		},
		[removeChangedFile],
	);

	const handleRejectFile = useCallback(
		(filePath: string) => {
			postMessage('undoFileChanges', { filePath });
		},
		[postMessage],
	);

	const handleUndoAll = useCallback(() => {
		postMessage('undoAllChanges');
	}, [postMessage]);

	const handleKeepAll = useCallback(() => {
		clearChangedFiles();
	}, [clearChangedFiles]);

	// Copy operations delegated to extension side to avoid messages subscription
	const handleCopyLastResponse = useCallback(() => {
		postMessage('copyLastResponse');
	}, [postMessage]);

	const handleCopyAllMessages = useCallback(() => {
		postMessage('copyAllMessages');
	}, [postMessage]);

	const handleCopyLastDiffs = useCallback(() => {
		postMessage('copyLastDiffs');
	}, [postMessage]);

	const handleCopyAllDiffs = useCallback(() => {
		postMessage('copyAllDiffs');
	}, [postMessage]);

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
				{/* Header - clickable to toggle expand */}
				<div
					role={hasFiles ? 'button' : undefined}
					tabIndex={hasFiles ? 0 : -1}
					onClick={() => hasFiles && setExpanded(!expanded)}
					onKeyDown={e => {
						if (!hasFiles) {
							return;
						}
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setExpanded(!expanded);
						}
					}}
					className={cn(
						'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding)',
						'text-sm font-(family-name:--vscode-font-family)',
						'bg-transparent border-none',
						expanded && hasFiles && 'rounded-b-lg',
						hasFiles && 'cursor-pointer',
						!hasFiles && 'cursor-default',
					)}
				>
					{/* Left section - stats (only when files exist) */}
					{hasFiles && (
						<span className="flex items-center overflow-hidden min-w-0 shrink-0">
							{/* Chevron */}
							<span className="shrink-0 flex items-center justify-center w-(--icon-md)">
								<ChevronIcon expanded={expanded} size={10} />
							</span>

							{/* Stats - min-width for alignment, right-aligned text */}
							<span className="text-success whitespace-nowrap text-right min-w-8">
								+{totalAdded}
							</span>
							<span className="text-error whitespace-nowrap text-left min-w-8 ml-(--gap-4)">
								-{totalRemoved}
							</span>

							{/* Files count */}
							<span className="flex items-center gap-(--gap-1) text-sm text-vscode-foreground opacity-90">
								<FileIcon size={12} />
								<span className="hide-on-narrow">
									{uniqueFileCount} {uniqueFileCount === 1 ? 'File' : 'Files'}
								</span>
								<span className="show-on-narrow">{uniqueFileCount}</span>
							</span>

							{/* Total Model Duration */}
							{/* moved to SessionStatsDisplay footer */}
						</span>
					)}

					{/* Center section - Todo status (isolated component) */}
					<TodoSection hasFiles={hasFiles} />

					{/* Right section - action buttons (only when files exist) */}
					{hasFiles && (
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

							<Tooltip content="Undo all changes" position="top" delay={200}>
								<button
									type="button"
									className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 whitespace-nowrap"
									onClick={e => {
										e.stopPropagation();
										showConfirmDialog({
											title: 'Undo All Changes',
											message: `This will undo all changes to ${uniqueFileCount} file${uniqueFileCount > 1 ? 's' : ''}.`,
											confirmLabel: 'Undo All',
											cancelLabel: 'Cancel',
											onConfirm: handleUndoAll,
										});
									}}
								>
									Undo All
								</button>
							</Tooltip>

							<Tooltip content="Keep all changes" position="top" delay={200}>
								<button
									type="button"
									className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 whitespace-nowrap"
									onClick={e => {
										e.stopPropagation();
										showConfirmDialog({
											title: 'Keep All Changes',
											message: `This will accept all changes to ${uniqueFileCount} file${uniqueFileCount > 1 ? 's' : ''}.`,
											confirmLabel: 'Keep All',
											cancelLabel: 'Cancel',
											onConfirm: handleKeepAll,
										});
									}}
								>
									Keep All
								</button>
							</Tooltip>
						</div>
					)}
				</div>

				{expanded && hasFiles && (
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
						<SessionStatsDisplay mode="footer" />
					</div>
				)}
			</div>
		</div>
	);
});
ChangedFilesPanel.displayName = 'ChangedFilesPanel';
