/**
 * @file ExpandButton - collapsible section toggle button
 * @description Reusable expand/collapse button with animated chevron icon. Used for toggling
 *              visibility of content sections in tool messages, file lists, and other collapsible
 *              UI elements. Supports full-width mode for section footers and inline mode for headers.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDownIcon } from '../icons';

interface ExpandButtonProps {
	/** Current expanded state */
	expanded: boolean;
	/** Toggle callback */
	onToggle: () => void;
	/** Button label (default: Expand/Collapse based on state) */
	label?: string;
	/** Show label text (default: true) */
	showLabel?: boolean;
	/** Full width button style for footers */
	fullWidth?: boolean;
	/** Icon size in pixels */
	iconSize?: number;
	/** Additional styles */
	style?: React.CSSProperties;
}

export const ExpandButton: React.FC<ExpandButtonProps> = ({
	expanded,
	onToggle,
	label,
	showLabel = true,
	fullWidth = false,
	iconSize = 12,
	style,
}) => {
	const displayLabel = label ?? (expanded ? 'Collapse' : 'Expand');

	if (fullWidth) {
		return (
			<button
				type="button"
				onClick={onToggle}
				className={cn(
					'w-full h-4 p-(--tool-header-padding) bg-transparent border-none cursor-pointer',
					'flex items-center justify-center gap-1 text-vscode-foreground opacity-60 text-xs font-(family-name:--vscode-font-family)',
					'transition-colors duration-150 rounded-none hover:bg-vscode-toolbar-hoverBackground hover:opacity-100',
				)}
				style={style}
			>
				<ChevronDownIcon
					size={iconSize}
					className={cn(
						'transition-transform duration-200 ease-out',
						expanded ? 'rotate-180' : 'rotate-0',
					)}
				/>
				{showLabel && <span>{displayLabel}</span>}
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={onToggle}
			className={cn(
				'inline-flex items-center justify-center gap-1 px-1.5 py-0.5',
				'bg-transparent border-none rounded-sm cursor-pointer',
				'text-vscode-foreground opacity-70 text-xs font-(family-name:--vscode-font-family)',
				'transition-all duration-150 ease-out',
				'hover:bg-vscode-toolbar-hoverBackground hover:opacity-100',
			)}
			style={style}
		>
			<ChevronDownIcon
				size={iconSize}
				className={cn(
					'transition-transform duration-200 ease-out',
					expanded ? 'rotate-180' : 'rotate-0',
				)}
			/>
			{showLabel && <span>{displayLabel}</span>}
		</button>
	);
};

/** Collapsible section wrapper with header and expandable content */
interface CollapsibleSectionProps {
	/** Section header content */
	header: React.ReactNode;
	/** Collapsible content */
	children: React.ReactNode;
	/** Initial expanded state */
	defaultExpanded?: boolean;
	/** Controlled expanded state */
	expanded?: boolean;
	/** Controlled toggle callback */
	onToggle?: () => void;
	/** Header styles */
	headerStyle?: React.CSSProperties;
	/** Content styles */
	contentStyle?: React.CSSProperties;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
	header,
	children,
	defaultExpanded = false,
	expanded: controlledExpanded,
	onToggle: controlledOnToggle,
	headerStyle,
	contentStyle,
}) => {
	const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);

	const isControlled = controlledExpanded !== undefined;
	const expanded = isControlled ? controlledExpanded : internalExpanded;
	const onToggle = isControlled ? controlledOnToggle : () => setInternalExpanded(prev => !prev);

	return (
		<div>
			<button
				type="button"
				onClick={onToggle}
				className="flex items-center gap-1.5 w-full bg-none border-none cursor-pointer text-vscode-foreground font-(family-name:--font-family-base) text-(length:--font-size-base) text-left leading-(--line-height-base)"
				style={headerStyle}
			>
				<ChevronDownIcon
					size={10}
					className={cn(
						'shrink-0 opacity-60 transition-transform duration-150 ease-out',
						expanded ? 'rotate-180' : 'rotate-0',
					)}
				/>
				{header}
			</button>

			{expanded && (
				<div className="pl-(--collapsible-indent)" style={contentStyle}>
					{children}
				</div>
			)}
		</div>
	);
};
