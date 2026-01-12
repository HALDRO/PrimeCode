/**
 * @file HistoryDropdown - Conversation history selector
 * @description Uses universal DropdownMenu for consistent styling. Provides conversation data
 *              with sections grouped by date. Supports search, rename (F2), and delete (Del).
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ConversationIndexEntry, useHistoryDropdownState } from '../../store';
import { useUIActions } from '../../store/uiStore';
import { formatRelativeTime } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
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
		const date = new Date(conv.startTime);
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
				meta: formatRelativeTime(conv.startTime),
				data: conv,
			})),
		}));
};

export const HistoryDropdown: React.FC = () => {
	const { postMessage } = useVSCode();
	const { conversationList, setShowHistoryDropdown } = useHistoryDropdownState();
	const { showConfirmDialog } = useUIActions();
	const [isLoading, setIsLoading] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editValue, setEditValue] = useState('');
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const onClose = useCallback(() => {
		setShowHistoryDropdown(false);
	}, [setShowHistoryDropdown]);

	useEffect(() => {
		setIsLoading(true);
		postMessage('getConversationList');

		const messageHandler = (event: MessageEvent) => {
			const message = event.data;
			if (message.type === 'conversationList') {
				setIsLoading(false);
			}
		};

		window.addEventListener('message', messageHandler);

		const timeout = setTimeout(() => setIsLoading(false), 2000);

		return () => {
			clearTimeout(timeout);
			window.removeEventListener('message', messageHandler);
		};
	}, [postMessage]);

	useEffect(() => {
		if (conversationList.length > 0) {
			setIsLoading(false);
		}
	}, [conversationList]);

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
			postMessage('loadConversation', { filename: conv.filename });
			onClose();
		},
		[postMessage, onClose, editingId],
	);

	const handleRename = useCallback((conv: ConversationIndexEntry) => {
		setEditingId(conv.filename);
		setEditValue(conv.customTitle || conv.firstUserMessage || '');
	}, []);

	const handleRenameSubmit = useCallback(
		(conv: ConversationIndexEntry) => {
			if (editValue.trim()) {
				postMessage('renameConversation', {
					filename: conv.filename,
					newTitle: editValue.trim(),
				});
			}
			setEditingId(null);
			setEditValue('');
		},
		[editValue, postMessage],
	);

	const handleDelete = useCallback(
		(conv: ConversationIndexEntry) => {
			postMessage('deleteConversation', { filename: conv.filename });
		},
		[postMessage],
	);

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
					postMessage('clearAllConversations');
				},
			});
		}, 50);
	}, [showConfirmDialog, postMessage, onClose]);

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

		return (
			<div
				key={item.id}
				onClick={isEditing ? undefined : onSelect}
				onMouseEnter={() => {
					onHover();
					setHoveredId(item.id);
				}}
				onMouseLeave={() => setHoveredId(null)}
				className={`flex items-center p-(--gap-2) pl-(--gap-4) mx-(--gap-2) gap-(--gap-3) min-h-(--h-md) text-md relative rounded-(--radius-sm) ${isEditing ? 'cursor-default' : 'cursor-pointer'} ${selected || isHovered ? 'bg-vscode-list-hoverBackground' : 'bg-transparent'}`}
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
						<span className="overflow-hidden text-ellipsis whitespace-nowrap text-vscode-foreground">
							{item.label}
						</span>

						{item.meta && <span className="text-xs text-(--alpha-40) shrink-0">{item.meta}</span>}

						{isHovered && (
							<div className="absolute right-(--gap-2) top-1/2 -translate-y-1/2 flex gap-(--gap-1) bg-(--header-item-hover) h-full items-center pl-(--gap-2) z-1">
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

	return (
		<DropdownMenu
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
			align="right"
			minWidth={320}
			maxWidth={400}
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
	);
};
