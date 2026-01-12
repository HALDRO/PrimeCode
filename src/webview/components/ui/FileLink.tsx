/**
 * @file FileLink - enhanced file link component
 * @description Displays file paths as interactive badges with hover tooltips showing path details.
 * Uses rounded pill-style design consistent with the app's UI language.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Tooltip } from './Tooltip';

interface FileLinkProps {
	path: string;
	line?: number;
	folder?: string;
	onClick?: (e?: React.MouseEvent) => void;
	isFolder?: boolean;
	/** Compact mode for inline display */
	compact?: boolean;
}

export const FileLink: React.FC<FileLinkProps> = ({
	path,
	line,
	folder,
	onClick,
	isFolder,
	compact = false,
}) => {
	const fileName = path.split(/[/\\]/).pop() || path;
	const tooltipContent = (
		<div className="flex flex-col gap-0.5">
			<span className="opacity-70 text-xs">
				{path}
				{line ? `:${line}` : ''}
			</span>
		</div>
	);

	if (compact) {
		return (
			<Tooltip content={tooltipContent} position="top" delay={300}>
				<button
					type="button"
					onClick={onClick}
					className={cn(
						'inline-flex items-center gap-1 p-0 m-0 text-(length:--font-size-sm) leading-tight cursor-pointer',
						'bg-none border-none text-vscode-foreground font-(family-name:--font-family-mono)',
						'opacity-90 hover:opacity-100 transition-opacity',
					)}
				>
					<FileTypeIcon name={fileName} size={12} isFolder={isFolder} />
					<span>{fileName}</span>
					{line && (
						<span className="text-vscode-descriptionForeground text-(length:--font-size-sm) opacity-70">
							:{line}
						</span>
					)}
				</button>
			</Tooltip>
		);
	}

	return (
		<Tooltip content={tooltipContent} position="top" delay={300}>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					'flex items-center gap-1.5 px-2 py-0.5 my-px w-full text-left',
					'text-sm leading-4 cursor-pointer rounded-xl',
					'bg-white/5 border border-white/10 text-vscode-foreground',
					'transition-all duration-150 ease-out',
					'hover:bg-white/10 hover:border-white/15',
				)}
			>
				<FileTypeIcon name={fileName} size={14} isFolder={isFolder} />

				<span className="font-medium text-vscode-foreground overflow-hidden text-ellipsis whitespace-nowrap">
					{fileName}
				</span>

				{folder && (
					<span className="text-vscode-descriptionForeground opacity-60 text-xs ml-1 overflow-hidden text-ellipsis whitespace-nowrap flex-1">
						{folder}
					</span>
				)}

				{line && (
					<span className="text-vscode-descriptionForeground ml-auto tabular-nums bg-white/5 px-1.5 rounded-lg text-xs">
						:{line}
					</span>
				)}
			</button>
		</Tooltip>
	);
};
