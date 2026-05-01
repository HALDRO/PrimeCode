/**
 * @file HistoryDropdown - Conversation history selector
 * @description Uses universal DropdownMenu for consistent styling. Provides conversation data
 *              with sections grouped by date. Supports search, rename (F2), and delete (Del).
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openCodeRuntime } from '../../services/opencodeRuntime';
import {
	type ConversationIndexEntry,
	useActiveSessionId,
	useChatStore,
	useHistoryDropdownState,
} from '../../store';
import { useUIActions } from '../../store/uiStore';
import { formatRelativeTime } from '../../utils/format';
import { MessageIcon, PencilIcon, TrashIcon } from '../icons';
import {
	Button,
	DropdownMenu,
	type DropdownMenuItem,
	type DropdownMenuSection,
	IconButton,
} from '../ui';

/** Group conversations by date */
const groupByDate = (
	conversations: ConversationIndexEntry[],
): DropdownMenuSection<ConversationIndexEntry>[] => {
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
	const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

	const groups: { title: string; items: ConversationIndexEntry[] }[] = [
		{ title: 'Today', items: [] },
		{ title: 'Yesterday', items: [] },
		{ title: 'This Week', items: [] },
		{ title: 'Older', items: [] },
	];

	for (const conv of conversations) {
		// Use endTime (lastModified) for grouping — consistent with sort order
		const date = new Date(conv.endTime || conv.startTime);
		if (date >= today) {
			groups[0].items.push(conv);
		} else if (date >= yesterday) {
			groups[1].items.push(conv);
		} else if (date >= weekAgo) {
			groups[2].items.push(conv);
		} else {
			groups[3].items.push(conv);
		}
	}

	return groups
		.filter(g => g.items.length > 0)
		.map(g => ({
			title: g.title,
			items: g.items.map(conv => ({
				id: conv.filename,
				label: conv.customTitle || conv.firstUserMessage || 'Untitled',
				icon: <MessageIcon size={14} />,
				meta: formatRelativeTime(conv.endTime || conv.startTime),
				data: conv,
			})),
		}));
};

export const HistoryDropdown: React.FC = () => {
	const { conversationList, setShowHistoryDropdown } = useHistoryDropdownState();
	const activeSessionId = useActiveSessionId();
	const sessionOrder = useChatStore(state => state.sessionOrder);
	const { showConfirmDialog } = useUIActions();
	const [isLoading, setIsLoading] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState('');
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const anchorElementRef = useRef<HTMLDivElement>(null);
	const [panelLayout, setPanelLayout] = useState<{
		left: number;
		right: number;
		top: number;
		width: number;
		height: number;
	} | null>(null);

	useEffect(() => {
		const computePanelLayout = () => {
			const header = document.querySelector('header');
			const headerBottom =
				header instanceof HTMLElement ? header.getBoundingClientRect().bottom : 44;
			const bottomInset = 10;
			const rootStyles = getComputedStyle(document.documentElement);
			const contentPadding = Number.parseFloat(rootStyles.getPropertyValue('--content-padding-x'));
			const left = Number.isFinite(contentPadding) ? Math.round(contentPadding) : 8;
			const right = left;
			// DropdownMenu adds a 4px floating offset, so shift the anchor up by 4px
			// to make the panel sit flush against the header.
			const top = Math.min(window.innerHeight - 24, Math.max(0, headerBottom - 4));
			const width = Math.max(window.innerWidth - left - right, 320);
			const height = Math.max(window.innerHeight - top - bottomInset, 240);
			setPanelLayout({
				left,
				right,
				top,
				width,
				height,
			});
		};

		computePanelLayout();
		window.addEventListener('resize', computePanelLayout);
		return () => window.removeEventListener('resize', computePanelLayout);
	}, []);

	const openSessionNumbers = useMemo(() => {
		return new Map(sessionOrder.map((sessionId, index) => [sessionId, index + 1]));
	}, [sessionOrder]);

	const onClose = useCallback(() => {
		setShowHistoryDropdown(false);
	}, [setShowHistoryDropdown]);

	// Re-fetch the conversation list when the dropdown mounts (opens).
	// Show loading spinner only when the list is empty; otherwise show stale data
	// while the fresh list loads in the background.
	useEffect(() => {
		if (conversationList.length === 0) {
			setIsLoading(true);
		}
		void openCodeRuntime.refreshConversationList().finally(() => setIsLoading(false));
		const timeout = setTimeout(() => setIsLoading(false), 2000);
		return () => clearTimeout(timeout);
	}, [conversationList.length]);

	// Clear loading as soon as the conversation list is populated
	useEffect(() => {
		if (conversationList.length > 0) {
			setIsLoading(false);
		}
	}, [conversationList.length]);

	useEffect(() => {
		if (editingId && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editingId]);

	const handleSelect = useCallback(
		(conv: ConversationIndexEntry) => {
			if (editingId) {
				return;
			}
			void openCodeRuntime.loadConversation(conv.sessionId);
			onClose();
		},
		[onClose, editingId],
	);

	const handleRename = useCallback((conv: ConversationIndexEntry) => {
		setEditingId(conv.filename);
		setEditValue(conv.customTitle || conv.firstUserMessage || '');
	}, []);

	const handleRenameSubmit = useCallback(
		(conv: ConversationIndexEntry) => {
			if (editValue.trim()) {
				void openCodeRuntime.renameConversation(conv.sessionId, editValue.trim());
			}
			setEditingId(null);
			setEditValue('');
		},
		[editValue],
	);

	const handleDelete = useCallback((conv: ConversationIndexEntry) => {
		void openCodeRuntime.deleteConversation(conv.sessionId);
	}, []);

	// Handle edit mode keyboard
	useEffect(() => {
		if (!editingId) {
			return;
		}
		const conv = conversationList.find(c => c.filename === editingId);
		if (!conv) {
			return;
		}

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				setEditingId(null);
				setEditValue('');
			} else if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				handleRenameSubmit(conv);
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [editingId, conversationList, handleRenameSubmit]);

	const handleClearAll = useCallback(() => {
		// Close dropdown first, then show confirmation dialog
		onClose();
		// Use setTimeout to ensure dropdown is closed before showing dialog
		setTimeout(() => {
			showConfirmDialog({
				title: 'Clear All Chats',
				message:
					'This will permanently delete all conversation history and close all sessions. This action cannot be undone.',
				confirmLabel: 'Clear All',
				cancelLabel: 'Cancel',
				onConfirm: () => {
					void openCodeRuntime.clearAllConversations();
				},
			});
		}, 50);
	}, [showConfirmDialog, onClose]);

	const sections = useMemo(() => groupByDate(conversationList), [conversationList]);

	// Custom render for inline editing and hover actions
	const renderItem = (
		item: DropdownMenuItem<ConversationIndexEntry>,
		{
			selected,
			onSelect,
			onHover,
		}: { selected: boolean; hovered: boolean; onSelect: () => void; onHover: () => void },
	) => {
		const isEditing = editingId === item.id;
		const isHovered = hoveredId === item.id;
		const isActive = item.id === activeSessionId;
		const openSessionNumber = openSessionNumbers.get(item.id);

		return (
			<div
				key={item.id}
				onClick={isEditing ? undefined : onSelect}
				onMouseEnter={() => {
					onHover();
					setHoveredId(item.id);
				}}
				onMouseLeave={() => setHoveredId(null)}
				className={`flex items-center px-(--gap-3) py-(--gap-2) gap-(--gap-3) min-h-(--h-md) text-md relative rounded-md transition-colors hover:bg-(--alpha-8) ${isEditing ? 'cursor-default' : 'cursor-pointer'} ${selected || isHovered ? 'bg-vscode-list-hoverBackground' : isActive ? 'bg-(--alpha-5)' : 'bg-transparent'}`}
			>
				{isEditing ? (
					<input
						ref={inputRef}
						type="text"
						value={editValue}
						onChange={e => setEditValue(e.target.value)}
						onBlur={() => handleRenameSubmit(item.data)}
						onClick={e => e.stopPropagation()}
						className="flex-1 bg-(--input-bg) border border-vscode-focusBorder rounded-sm text-vscode-foreground text-md px-(--gap-3) py-(--gap-1) outline-none"
					/>
				) : (
					<>
						<span className="opacity-50 flex shrink-0">{item.icon}</span>
						{openSessionNumber ? (
							<span
								className={`inline-flex min-w-5 h-5 items-center justify-center rounded-md px-1 text-xs font-medium shrink-0 ${isActive ? 'bg-vscode-focusBorder/15 text-vscode-focusBorder' : 'bg-(--alpha-8) text-vscode-descriptionForeground'}`}
								title={`Open in header as chat ${openSessionNumber}`}
							>
								{openSessionNumber}
							</span>
						) : null}
						<span
							className={`overflow-hidden text-ellipsis whitespace-nowrap ${isActive ? 'text-vscode-focusBorder' : 'text-vscode-foreground'}`}
						>
							{item.label}
						</span>

						{item.meta && <span className="text-xs text-(--alpha-40) shrink-0">{item.meta}</span>}

						{isHovered && (
							<div className="absolute right-(--gap-2) top-0 bottom-0 flex gap-(--gap-1) items-center pl-(--gap-4) pr-(--gap-1) z-1 bg-gradient-to-l from-vscode-list-hoverBackground from-70% to-transparent rounded-r-md">
								<IconButton
									icon={<PencilIcon size={12} />}
									onClick={e => {
										e.stopPropagation();
										handleRename(item.data);
									}}
									title="Rename"
									size="sm"
								/>
								<IconButton
									icon={<TrashIcon size={12} />}
									onClick={e => {
										e.stopPropagation();
										handleDelete(item.data);
									}}
									title="Delete"
									size="sm"
									danger
								/>
							</div>
						)}
					</>
				)}
			</div>
		);
	};

	if (!panelLayout) {
		return null;
	}

	return (
		<>
			<div
				ref={anchorElementRef}
				aria-hidden="true"
				className="fixed pointer-events-none"
				style={{ left: panelLayout.left, top: panelLayout.top, width: 1, height: 1 }}
			/>
			<DropdownMenu
				title="History"
				titleBeforeSearch
				sections={sections}
				searchable
				searchPlaceholder="Search..."
				searchAutoFocus
				onSelect={handleSelect}
				onClose={onClose}
				onRename={handleRename}
				onDelete={handleDelete}
				keyHints={{ rename: true, delete: true }}
				loading={isLoading}
				emptyMessage="No conversations yet"
				position="bottom"
				align="left"
				anchorElement={anchorElementRef.current}
				anchorRect={{
					left: panelLayout.left,
					right: window.innerWidth - panelLayout.right,
					top: panelLayout.top,
					bottom: panelLayout.top,
					width: panelLayout.width,
					height: 0,
				}}
				width={panelLayout.width}
				minWidth={panelLayout.width}
				maxWidth={panelLayout.width}
				maxHeight={panelLayout.height}
				maxHeightVh={95}
				viewportPadding={8}
				renderItem={renderItem}
				footer={
					<div className="flex items-center justify-center gap-(--gap-5) px-(--gap-5) py-(--gap-1)">
						<Button
							variant="ghost"
							size="xs"
							onClick={handleClearAll}
							className="text-sm text-(--alpha-60) hover:text-(--alpha-90) hover:bg-(--alpha-5) h-(--btn-height-sm) w-full"
						>
							Clear All Chats
						</Button>
					</div>
				}
			/>
		</>
	);
};
