/**
 * @file PathChip - unified file/folder pill UI
 * @description Reusable compact chip for representing a file or folder reference.
 * Used in: chat input attachments, user message attachments, and inline tool output.
 * Displays only the leaf name (no full path), with optional line indicator and remove action.
 */

import type React from 'react';
import type { InlineAttachmentMatch } from '../../../common/inlineAttachments';
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
	/** Optional start line, rendered as :start or :start-end */
	startLine?: number;
	/** Optional end line, rendered as :start-end when different from start */
	endLine?: number;
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
	startLine,
	endLine,
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
	const resolvedStartLine = startLine ?? line;
	const resolvedEndLine = endLine ?? line;
	const lineSuffix =
		resolvedStartLine !== undefined
			? resolvedEndLine !== undefined && resolvedEndLine !== resolvedStartLine
				? `:${resolvedStartLine}-${resolvedEndLine}`
				: `:${resolvedStartLine}`
			: null;

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

			{lineSuffix && (
				<span className="text-vscode-descriptionForeground opacity-70 tabular-nums leading-none mb-px">
					{lineSuffix}
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

interface InlineAttachmentChipProps {
	match: InlineAttachmentMatch;
	onOpen: (filePath: string, startLine?: number, endLine?: number) => void;
	className?: string;
}

export const InlineAttachmentChip: React.FC<InlineAttachmentChipProps> = ({
	match,
	onOpen,
	className,
}) => (
	<span className={cn('inline-flex align-middle mx-(--gap-0-5) max-w-full', className)}>
		<PathChip
			path={match.path}
			isFolder={match.isDirectory}
			startLine={match.startLine}
			endLine={match.endLine}
			title={match.displayPath}
			onClick={() => onOpen(match.path, match.startLine, match.endLine)}
		/>
	</span>
);
