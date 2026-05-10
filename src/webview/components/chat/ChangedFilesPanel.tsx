/**
 * @file ChangedFilesPanel - displays list of files changed during session
 * @description Collapsible panel showing files modified by AI with diff stats.
 *              Header layout mirrors FileRow structure for perfect alignment.
 *              Also displays current Todo list status when available.
 *              Session-specific changed files and todo state come from chatStore.
 *              OPTIMIZED: Todo display extracted to separate component to isolate rerenders.
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import {
	useHasTodos,
	useIsActiveChildSession,
	useSessionDiffFiles,
	useSessionDiffSummary,
	useTodoState,
} from '../../store';
import type { SessionDiffEntry } from '../../store/selectors';
import { useUIActions } from '../../store/uiStore';
import { useVSCode } from '../../utils/vscode';
import {
	AcceptIcon,
	ChevronIcon,
	FileIcon,
	RejectIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from '../icons';
import { PathChip, ScrollContainer, Tooltip } from '../ui';

interface TodoItem {
	content: string;
	status: string;
	priority: string;
}

/** Status icon for todo items */
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

/** Todo hover popup - adaptive positioning to stay within viewport */
const TodoHoverPopup = React.memo<{
	todos: TodoItem[];
	triggerRef: React.RefObject<HTMLDivElement | null>;
}>(({ todos, triggerRef }) => {
	const popupRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number } | null>(
		null,
	);
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

		const top = Math.max(padding, triggerRect.top - popup.offsetHeight - padding);

		setPosition({ left, top, maxWidth: finalWidth });
	}, [triggerRef]);

	return createPortal(
		<div
			ref={popupRef}
			className="fixed z-10000 pointer-events-none"
			style={{
				left: position ? `${position.left}px` : 0,
				top: position ? `${position.top}px` : 0,
				width: position ? `${position.maxWidth}px` : '75vw',
				visibility: position ? 'visible' : 'hidden',
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
							<div key={todo.content} className="flex items-start gap-1.5">
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
		</div>,
		document.body,
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

/** Centered todo block shown when there are todos but no changed files yet */
const StandaloneTodoPanel: React.FC = React.memo(() => (
	<div className="w-full box-border relative bg-transparent">
		<div className="@container/panel relative h-(--tool-header-height) px-(--tool-header-padding) text-(--changed-files-font-size) font-(family-name:--vscode-font-family)">
			<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
				<div className="pointer-events-auto">
					<TodoSection />
				</div>
			</div>
		</div>
	</div>
));
StandaloneTodoPanel.displayName = 'StandaloneTodoPanel';

function formatDiffCount(value: number, kind: 'added' | 'removed'): string {
	if (value <= 0) {
		return '0';
	}
	return kind === 'added' ? `+${value}` : `-${value}`;
}

const FileRow = React.memo<{
	file: SessionDiffEntry;
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

		<div className="flex-1 min-w-0 ml-(--gap-2)">
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
	const files = useSessionDiffFiles();
	const hasTodos = useHasTodos();
	const isChild = useIsActiveChildSession();

	// Child sessions don't own file changes — diffs belong to the parent session.
	if (isChild) return null;

	const hasFiles = files.length > 0;

	if (!hasFiles && !hasTodos) {
		return null;
	}

	if (!hasFiles) {
		return <StandaloneTodoPanel />;
	}

	return <ChangedFilesPanelContent />;
});
ChangedFilesPanel.displayName = 'ChangedFilesPanel';

const ChangedFilesPanelContent: React.FC = React.memo(() => {
	const { postMessage } = useVSCode();
	const files = useSessionDiffFiles();
	const { added: totalAdded, removed: totalRemoved } = useSessionDiffSummary();
	const { showConfirmDialog } = useUIActions();
	const [expanded, setExpanded] = useState(false);

	// Count unique files for display
	const uniqueFileCount = files.length;

	const handleOpenDiff = useCallback(
		(filePath: string) => {
			postMessage({ type: 'openFileDiff', filePath });
		},
		[postMessage],
	);

	const handleAcceptFile = useCallback(
		(filePath: string) => {
			postMessage({ type: 'acceptFile', filePath });
		},
		[postMessage],
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
		const filePaths = files.map(f => f.filePath);
		postMessage({ type: 'acceptAllFiles', filePaths });
	}, [files, postMessage]);

	if (files.length === 0) {
		return null;
	}

	return (
		<div className="w-full box-border relative bg-transparent">
			<div
				className={cn(
					'bg-(--panel-header-bg) rounded-t-lg border border-(--panel-header-border) border-b-0',
					'@container/panel',
				)}
			>
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
						'relative flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding)',
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
						<span className="flex items-center gap-(--gap-1) text-sm text-vscode-foreground opacity-90 ml-(--gap-2)">
							<FileIcon size={12} />
							<span className="hide-on-narrow">
								{uniqueFileCount} {uniqueFileCount === 1 ? 'File' : 'Files'}
							</span>
							<span className="show-on-narrow">{uniqueFileCount}</span>
						</span>
					</span>

					{/* Center section - Todo status */}
					<span className="absolute inset-0 flex items-center justify-center pointer-events-none">
						<span className="pointer-events-auto">
							<TodoSection />
						</span>
					</span>

					{/* Right section - action buttons */}
					<div className="flex items-center gap-1 ml-2 shrink-0">
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

				{expanded && (
					<div>
						<ScrollContainer className="px-(--tool-header-padding) max-h-[40vh]">
							{files.map(file => (
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
ChangedFilesPanelContent.displayName = 'ChangedFilesPanelContent';
