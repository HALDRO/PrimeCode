/**
 * @file PathChip - unified file/folder pill UI
 * @description Reusable compact chip for representing a file or folder reference.
 * Used in: chat input attachments, user message attachments, and inline tool output.
 * Displays only the leaf name (no full path), with optional line indicator and remove action.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { FileTypeIcon, SmallCloseIcon } from '../icons';
import { Tooltip } from './Tooltip';

interface PathChipProps {
	path: string;
	/** Override displayed label (default: leaf name of `path`) */
	label?: string;
	/** Override the value used for file type icon selection (default: displayed label) */
	iconName?: string;
	/** Treat the path as a folder (affects icon) */
	isFolder?: boolean;
	/** Optional line number, rendered as :line */
	line?: number;
	/** Optional tooltip text (e.g. full path). If omitted, no tooltip is shown. */
	title?: string;
	onClick?: () => void;
	onRemove?: () => void;
	className?: string;
	color?: string;
	backgroundColor?: string;
}

const getLeafName = (value: string) => {
	const trimmed = value.trim().replace(/[\\/]+$/, '');
	if (!trimmed) return '';
	const parts = trimmed.replace(/\\/g, '/').split('/').filter(Boolean);
	return parts[parts.length - 1] || trimmed;
};

export const PathChip: React.FC<PathChipProps> = ({
	path,
	label,
	iconName,
	isFolder,
	line,
	title,
	onClick,
	onRemove,
	className,
	color = 'var(--vscode-foreground)',
	backgroundColor = 'transparent',
}) => {
	const displayLabel = (label ?? getLeafName(path)) || path;
	const effectiveIconName = iconName ?? displayLabel;
	const effectiveTitle = title;
	const canClick = Boolean(onClick);

	const chip = (
		<span
			className={cn(
				'inline-flex items-center gap-(--gap-0-5) px-(--gap-1-5) py-0 h-(--badge-height) rounded-sm shrink-0 group/pathchip',
				'text-xs border border-(--border-subtle) bg-transparent transition-colors duration-75 ease-out',
				canClick ? 'cursor-pointer hover:border-vscode-focusBorder' : 'cursor-default',
				onRemove && 'select-none',
				className,
			)}
			style={{ backgroundColor, color }}
			onClick={
				canClick
					? e => {
							e.stopPropagation();
							onClick?.();
						}
					: undefined
			}
			onMouseDown={e => {
				if (e.button === 1 && onRemove) {
					e.preventDefault();
					e.stopPropagation();
					onRemove();
				}
			}}
		>
			<span className="relative flex items-center justify-center w-(--icon-sm) h-(--icon-sm) shrink-0">
				<span
					className={cn(
						'transition-all duration-75 flex items-center justify-center',
						onRemove && 'group-hover/pathchip:opacity-0 group-hover/pathchip:scale-50',
					)}
				>
					<FileTypeIcon
						name={effectiveIconName}
						size={14}
						isFolder={isFolder ?? /[\\/]$/.test(path)}
					/>
				</span>
				{onRemove && (
					<button
						type="button"
						className={cn(
							'absolute inset-0 flex items-center justify-center opacity-0 transition-all duration-75 scale-50',
							'group-hover/pathchip:opacity-70 group-hover/pathchip:scale-100',
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
			</span>

			<span className="opacity-90 overflow-hidden text-ellipsis whitespace-nowrap leading-none mb-px">
				{displayLabel}
			</span>

			{line !== undefined && (
				<span className="text-vscode-descriptionForeground opacity-70 tabular-nums leading-none mb-px">
					:{line}
				</span>
			)}
		</span>
	);

	if (effectiveTitle) {
		return (
			<Tooltip content={effectiveTitle} position="top" delay={200} className={className}>
				{chip}
			</Tooltip>
		);
	}

	return chip;
};
