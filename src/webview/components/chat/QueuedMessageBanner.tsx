/**
 * @file QueuedMessageBanner
 * @description Panel above ChatInput showing queued messages (up to 3) during generation.
 *              Styled like ChangedFilesPanel. Supports drag-and-drop reorder, cancel
 *              (returns text to input), and force-send (stop + send).
 */

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useQueuedMessages } from '../../store';
import { useSessionMessage } from '../../utils/vscode';

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const QueueIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<circle cx="12" cy="12" r="10" />
		<polyline points="12 6 12 12 16 14" />
	</svg>
);

const DragIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<circle cx="9" cy="6" r="1.5" />
		<circle cx="15" cy="6" r="1.5" />
		<circle cx="9" cy="12" r="1.5" />
		<circle cx="15" cy="12" r="1.5" />
		<circle cx="9" cy="18" r="1.5" />
		<circle cx="15" cy="18" r="1.5" />
	</svg>
);

const ForceSendIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path
			fillRule="evenodd"
			d="M3.291 3.309a.75.75 0 0 0-.976.996l3.093 6.945H13a.75.75 0 0 1 0 1.5H5.408l-3.093 6.945a.75.75 0 0 0 .976.996l19-8a.75.75 0 0 0 0-1.382z"
			clipRule="evenodd"
		/>
	</svg>
);

const CancelIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2.5}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<line x1="18" y1="6" x2="6" y2="18" />
		<line x1="6" y1="6" x2="18" y2="18" />
	</svg>
);

const ChevronIcon: React.FC<{ expanded: boolean; size?: number }> = ({ expanded, size = 10 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth={2}
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		className={cn('transition-transform duration-150', expanded ? 'rotate-90' : 'rotate-0')}
	>
		<polyline points="9 18 15 12 9 6" />
	</svg>
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const QueuedMessageBanner: React.FC = () => {
	const queuedMessages = useQueuedMessages();
	const { postSessionMessage } = useSessionMessage();
	const [expanded, setExpanded] = useState(true);
	const [dragIdx, setDragIdx] = useState<number | null>(null);
	const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
	const dragItemRef = useRef<number | null>(null);

	const handleCancel = useCallback(
		(queueId: string, sessionId: string) => {
			postSessionMessage({ type: 'cancelQueuedMessage', queueId, sessionId });
		},
		[postSessionMessage],
	);

	const handleForceSend = useCallback(
		(queueId: string, sessionId: string) => {
			postSessionMessage({ type: 'forceQueuedMessage', queueId, sessionId });
		},
		[postSessionMessage],
	);

	const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
		dragItemRef.current = idx;
		setDragIdx(idx);
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', String(idx));
	}, []);

	const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		// Only update state if index actually changed to avoid unnecessary re-renders
		setDragOverIdx(prev => (prev === idx ? prev : idx));
	}, []);

	const handleDragEnd = useCallback(() => {
		setDragIdx(null);
		setDragOverIdx(null);
		dragItemRef.current = null;
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent, dropIdx: number) => {
			e.preventDefault();
			const fromIdx = dragItemRef.current;
			if (fromIdx === null || fromIdx === dropIdx) {
				handleDragEnd();
				return;
			}
			const ids = queuedMessages.map(m => m.queueId);
			const [moved] = ids.splice(fromIdx, 1);
			ids.splice(dropIdx, 0, moved);
			const sessionId = queuedMessages[0]?.sessionId;
			if (sessionId) {
				postSessionMessage({ type: 'reorderQueue', sessionId, queueIds: ids });
			}
			handleDragEnd();
		},
		[queuedMessages, postSessionMessage, handleDragEnd],
	);

	if (queuedMessages.length === 0) return null;

	const count = queuedMessages.length;

	return (
		<div className="w-full box-border relative bg-transparent animate-fade-in mb-px">
			<div
				className={cn('bg-(--panel-header-bg) rounded-lg border border-(--panel-header-border)')}
			>
				{/* Header */}
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
						!expanded && 'rounded-b-lg',
					)}
				>
					<span className="flex items-center gap-(--gap-2) min-w-0">
						<span className="shrink-0 flex items-center justify-center w-(--icon-md)">
							<ChevronIcon expanded={expanded} size={10} />
						</span>
						<span className="shrink-0 text-vscode-textLink-foreground opacity-80">
							<QueueIcon size={14} />
						</span>
						<span className="text-vscode-foreground opacity-90">Queued messages</span>
						<span className="text-vscode-descriptionForeground opacity-60">({count})</span>
					</span>
				</button>

				{/* Message list */}
				{expanded && (
					<ul
						aria-live="polite"
						aria-label={`${count} message${count > 1 ? 's' : ''} queued`}
						className="flex flex-col list-none m-0 p-0"
					>
						{queuedMessages.map((entry, idx) => {
							const truncated =
								entry.text.length > 100 ? `${entry.text.slice(0, 100)}\u2026` : entry.text;
							const isDragging = dragIdx === idx;
							const isDragOver = dragOverIdx === idx && dragIdx !== idx;

							return (
								<li
									key={entry.queueId}
									draggable={count > 1}
									onDragStart={e => handleDragStart(e, idx)}
									onDragOver={e => handleDragOver(e, idx)}
									onDragEnd={handleDragEnd}
									onDrop={e => handleDrop(e, idx)}
									className={cn(
										'flex items-center gap-(--gap-2) px-(--tool-header-padding) py-(--gap-1-5)',
										'border-t border-(--panel-header-border)',
										'text-xs transition-all duration-100',
										isDragging && 'opacity-40',
										isDragOver && 'bg-vscode-textLink-foreground/8',
									)}
								>
									{/* Drag handle */}
									{count > 1 && (
										<span
											className="shrink-0 cursor-grab active:cursor-grabbing text-vscode-descriptionForeground opacity-40 hover:opacity-80"
											title="Drag to reorder"
										>
											<DragIcon size={12} />
										</span>
									)}

									{/* Order number */}
									<span className="shrink-0 w-4 text-center text-vscode-descriptionForeground opacity-50 text-[10px] font-medium">
										{idx + 1}
									</span>

									{/* Message text */}
									<span
										className="flex-1 min-w-0 truncate text-vscode-foreground opacity-80"
										title={entry.text}
									>
										{truncated}
									</span>

									{/* Force send */}
									<button
										type="button"
										onClick={e => {
											e.stopPropagation();
											handleForceSend(entry.queueId, entry.sessionId);
										}}
										aria-label="Stop current generation and send this message now"
										className={cn(
											'shrink-0 flex items-center gap-1 px-(--gap-1-5) py-(--gap-0-5)',
											'rounded text-[11px] font-medium',
											'text-vscode-textLink-foreground',
											'hover:bg-vscode-textLink-foreground/10',
											'focus-visible:outline focus-visible:outline-2 focus-visible:outline-vscode-focusBorder',
											'transition-colors duration-150 cursor-pointer',
											'border-none bg-transparent',
										)}
										title="Stop generation and send this message now"
									>
										<ForceSendIcon size={10} />
										<span>Send</span>
									</button>

									{/* Cancel */}
									<button
										type="button"
										onClick={e => {
											e.stopPropagation();
											handleCancel(entry.queueId, entry.sessionId);
										}}
										aria-label="Cancel queued message and return text to input"
										className={cn(
											'shrink-0 flex items-center justify-center',
											'w-5 h-5 rounded',
											'text-vscode-foreground opacity-50 hover:opacity-100',
											'hover:bg-(--alpha-10)',
											'focus-visible:outline focus-visible:outline-2 focus-visible:outline-vscode-focusBorder',
											'transition-all duration-150 cursor-pointer',
											'border-none bg-transparent',
										)}
										title="Cancel and return text to input"
									>
										<CancelIcon size={10} />
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
};
QueuedMessageBanner.displayName = 'QueuedMessageBanner';
