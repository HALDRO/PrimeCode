/**
 * @file Badge - compact label component with optional remove action
 * @description Displays a small badge with text, optional file icon, and remove button.
 * Used for file attachments, tags, and other removable items in the UI.
 * Supports middle-click and double-click interactions. Uses custom Tooltip for hover hints.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { FileTypeIcon, SmallCloseIcon } from '../icons';
import { Tooltip } from './Tooltip';

interface BadgeProps {
	label: string;
	onRemove?: () => void;
	onClick?: () => void;
	iconName?: string;
	title?: string;
	color?: string;
	backgroundColor?: string;
}

export const Badge: React.FC<BadgeProps> = ({
	label,
	onRemove,
	onClick,
	iconName,
	title,
	color = 'var(--vscode-foreground)',
	backgroundColor = 'rgba(64, 165, 255, 0.12)',
}) => {
	const badgeContent = (
		<div
			className={cn(
				'inline-flex items-center gap-(--gap-0-5) pl-(--gap-1) pr-(--gap-0-5) py-0 h-(--badge-height) rounded shrink-0 group/badge',
				'text-xs border border-transparent transition-all duration-75 ease-out',
				onClick ? 'cursor-pointer' : 'cursor-default',
			)}
			style={{
				backgroundColor: backgroundColor,
				color: color,
			}}
			onClick={onClick}
			onMouseDown={e => {
				if (e.button === 1 && onRemove) {
					e.preventDefault();
					onRemove();
				}
			}}
		>
			<div className="relative flex items-center justify-center w-(--icon-sm) h-(--icon-sm) shrink-0">
				{iconName && (
					<div
						className={cn(
							'transition-all duration-75 flex items-center justify-center',
							onRemove && 'group-hover/badge:opacity-0 group-hover/badge:scale-50',
						)}
					>
						<FileTypeIcon name={iconName} size={14} />
					</div>
				)}
				{onRemove && (
					<button
						type="button"
						className={cn(
							'absolute inset-0 flex items-center justify-center opacity-0 transition-all duration-75 scale-50',
							'group-hover/badge:opacity-70 group-hover/badge:scale-100',
							'bg-transparent border-none p-0 rounded-sm cursor-pointer text-vscode-descriptionForeground',
							'hover:bg-(--alpha-10) hover:opacity-100!',
						)}
						onClick={e => {
							e.stopPropagation();
							onRemove();
						}}
					>
						<SmallCloseIcon size={12} />
					</button>
				)}
			</div>

			<span className="opacity-90 overflow-hidden text-ellipsis whitespace-nowrap leading-none mb-px">
				{label}
			</span>
		</div>
	);

	if (title) {
		return (
			<Tooltip content={title} position="top" delay={200}>
				{badgeContent}
			</Tooltip>
		);
	}

	return badgeContent;
};
