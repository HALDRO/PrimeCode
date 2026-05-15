/**
 * @file ChangedFilesPanel - displays list of files changed during session
 * @description Collapsible panel showing files modified by AI with diff stats.
 *              Header layout mirrors FileRow structure for perfect alignment.
 *              Also displays current Todo list status when available.
 *              Session-specific changed files and todo state come from chatStore.
 *              OPTIMIZED: Todo display extracted to separate component to isolate rerenders.
 */

import {
	autoUpdate,
	flip,
	offset,
	safePolygon,
	shift,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useRole,
	useTransitionStyles,
} from '@floating-ui/react';
import { AnimatePresence, motion } from 'framer-motion';
import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { UI_MOTION_DURATION_MS, UI_MOTION_FRAMER_TRANSITION } from '../../constants';
import { cn } from '../../lib/cn';
import {
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
	floatingRef: (node: HTMLDivElement | null) => void;
	floatingStyles: React.CSSProperties;
	transitionStyles: React.CSSProperties;
	getFloatingProps: ReturnType<typeof useInteractions>['getFloatingProps'];
}>(({ todos, floatingRef, floatingStyles, transitionStyles, getFloatingProps }) => {
	const completedCount = todos.filter(t => t.status === 'completed').length;
	const totalCount = todos.length;

	return createPortal(
		<div
			ref={floatingRef}
			className="z-[10000] w-[min(400px,75vw)] overflow-hidden rounded-lg border border-(--tool-border-color) bg-(--tool-bg-header)/88 font-(family-name:--vscode-font-family) text-vscode-foreground shadow-[0_12px_36px_color-mix(in_srgb,var(--vscode-editor-background)_72%,transparent)] backdrop-blur-md"
			style={{
				...floatingStyles,
				...transitionStyles,
			}}
			{...getFloatingProps()}
		>
			<div className="flex items-center gap-1.5 border-b border-(--border-subtle) bg-(--tool-bg-header)/92 px-(--tool-header-padding) h-(--tool-header-height)">
				<TodoListIcon size={14} className="text-vscode-foreground opacity-80 shrink-0" />
				<span className="text-sm text-vscode-foreground opacity-90">
					{completedCount} of {totalCount} Done
				</span>
			</div>
			<div className="bg-(--tool-bg-header)/72 px-(--tool-header-padding) py-1.5">
				<div className="flex flex-col gap-(--gap-1)">
					{todos.map(todo => (
						<div key={todo.content} className="flex items-start gap-1.5">
							<TodoStatusIcon status={todo.status} />
							<span
								className={cn(
									'text-sm break-words min-w-0 text-left leading-relaxed',
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
	const { refs, floatingStyles, context } = useFloating({
		open: showTodoPopup,
		onOpenChange: setShowTodoPopup,
		placement: 'top',
		strategy: 'fixed',
		transform: false,
		whileElementsMounted: autoUpdate,
		middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
	});
	const hover = useHover(context, {
		move: false,
		delay: { open: 160, close: 0 },
		handleClose: safePolygon({ buffer: 1 }),
	});
	const focus = useFocus(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: 'dialog' });
	const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
	const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
		duration: UI_MOTION_DURATION_MS,
		initial: { opacity: 0 },
	});

	if (!currentTodos || currentTodos.length === 0) {
		return null;
	}

	return (
		<div ref={refs.setReference} className="relative flex" {...getReferenceProps()}>
			<span className="flex items-center gap-(--gap-1-5) bg-transparent border-none px-(--gap-2) py-(--gap-1) rounded-sm cursor-default text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-vscode-list-hoverBackground hover:opacity-100 whitespace-nowrap">
				<TodoListIcon size={12} className="shrink-0" />
				<span>
					{currentTodos.filter(t => t.status === 'completed').length}/{currentTodos.length}
				</span>
			</span>
			{isMounted && (
				<TodoHoverPopup
					todos={currentTodos}
					floatingRef={refs.setFloating}
					floatingStyles={floatingStyles}
					transitionStyles={transitionStyles}
					getFloatingProps={getFloatingProps}
				/>
			)}
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
				className="bg-transparent border-none p-0.5 rounded-sm cursor-pointer text-vscode-descriptionForeground flex items-center opacity-70 transition-all duration-100 ease-out font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 active:scale-95"
				onClick={onAccept}
			>
				<AcceptIcon />
			</button>
		</Tooltip>

		<span className="w-(--gap-1)" />

		<Tooltip content="Reject changes" position="top" delay={200}>
			<button
				type="button"
				className="bg-transparent border-none p-0.5 rounded-sm cursor-pointer text-vscode-descriptionForeground flex items-center opacity-70 transition-all duration-100 ease-out font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 active:scale-95"
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
	const isChild = useIsActiveChildSession();

	// Child sessions don't own file changes — diffs belong to the parent session.
	if (isChild) return null;

	const hasFiles = files.length > 0;

	if (!hasFiles) {
		return null;
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
								className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 active:scale-95 whitespace-nowrap"
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
								className="bg-transparent border-none px-1.5 py-0.5 rounded-sm cursor-pointer text-vscode-foreground opacity-70 transition-all duration-100 ease-out text-sm font-(family-name:--vscode-font-family) hover:bg-white/10 hover:opacity-100 active:scale-95 whitespace-nowrap"
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

				<AnimatePresence initial={false}>
					{expanded && (
						<motion.div
							initial={{ height: 0, opacity: 0 }}
							animate={{ height: 'auto', opacity: 1 }}
							exit={{ height: 0, opacity: 0 }}
							transition={UI_MOTION_FRAMER_TRANSITION}
							className="overflow-hidden"
						>
							<motion.div
								initial={{ y: -2 }}
								animate={{ y: 0 }}
								exit={{ y: -2 }}
								transition={UI_MOTION_FRAMER_TRANSITION}
							>
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
							</motion.div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
});
ChangedFilesPanelContent.displayName = 'ChangedFilesPanelContent';
