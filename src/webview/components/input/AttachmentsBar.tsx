/**
 * @file AttachmentsBar — Displays attached images, files, and code snippets
 * @description Extracted from ChatInput. Pure presentational component, memoized.
 *              Supports read-only mode when onRemove* callbacks are omitted
 *              (used in UserMessage to display message attachments).
 */

import React from 'react';
import { cn } from '../../lib/cn';
import { getShortFileName } from '../../utils/format';
import { PathChip } from '../ui';

export interface AttachedImage {
	id: string;
	name: string;
	dataUrl: string;
	path?: string;
}

export interface CodeSnippet {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

interface AttachmentsBarProps {
	images: AttachedImage[];
	files: string[];
	codeSnippets: CodeSnippet[];
	/** Omit onRemove* callbacks for read-only mode (e.g. in UserMessage) */
	onRemoveImage?: (id: string) => void;
	onRemoveFile?: (path: string) => void;
	onRemoveSnippet?: (id: string) => void;
	onPreviewImage?: (img: { name: string; dataUrl: string }) => void;
	onOpenFile?: (path: string, startLine?: number, endLine?: number) => void;
	/** Display inline (no padding/margin) for embedding inside message text */
	inline?: boolean;
}

export const AttachmentsBar: React.FC<AttachmentsBarProps> = React.memo(
	({
		images,
		files,
		codeSnippets,
		onRemoveImage,
		onRemoveFile,
		onRemoveSnippet,
		onPreviewImage,
		onOpenFile,
		inline,
	}) => {
		const readOnly = !onRemoveImage && !onRemoveFile && !onRemoveSnippet;

		return (
			<div
				className={cn(
					'flex flex-wrap gap-(--gap-1-5)',
					inline
						? 'inline-flex align-middle mr-1'
						: 'items-start px-(--gap-3) py-(--gap-1-5) m-(--gap-1-5)_(--gap-3)',
				)}
			>
				{/* Images */}
				{images.map(img => (
					<div key={img.id} className="relative shrink-0 group/img">
						<button
							type="button"
							onClick={() => onPreviewImage?.({ name: img.name, dataUrl: img.dataUrl })}
							onMouseDown={e => {
								if (e.button === 1 && onRemoveImage) {
									e.preventDefault();
									onRemoveImage(img.id);
								}
							}}
							className="cursor-pointer bg-transparent border-none p-0 m-0 block"
						>
							<img
								src={img.dataUrl}
								alt={img.name}
								className="w-10 h-(--header-height) object-cover rounded-sm border border-(--alpha-10) transition-all duration-150 hover:border-vscode-focusBorder hover:shadow-[0_0_0_1px_var(--vscode-focusBorder)]"
							/>
						</button>
						{onRemoveImage && (
							<button
								type="button"
								aria-label="Remove image"
								onClick={e => {
									e.stopPropagation();
									onRemoveImage(img.id);
								}}
								className="absolute top-0.5 right-0.5 bg-bg-overlay hover:bg-(--alpha-medium) rounded-[3px] w-4.5 h-4.5 flex items-center justify-center cursor-pointer text-vscode-foreground text-[11px] opacity-0 group-hover/img:opacity-100 transition-opacity duration-150"
							>
								&times;
							</button>
						)}
					</div>
				))}
				{/* Files */}
				{files.map(filePath => (
					<PathChip
						key={filePath}
						path={filePath}
						onRemove={onRemoveFile ? () => onRemoveFile(filePath) : undefined}
						onClick={onOpenFile ? () => onOpenFile(filePath) : undefined}
						title={filePath}
					/>
				))}
				{/* Code snippets */}
				{codeSnippets.map(snippet => (
					<PathChip
						key={
							readOnly ? `${snippet.filePath}:${snippet.startLine}-${snippet.endLine}` : snippet.id
						}
						path={snippet.filePath}
						label={`${getShortFileName(snippet.filePath)} (${snippet.startLine}-${snippet.endLine})`}
						iconName={snippet.filePath}
						onRemove={onRemoveSnippet ? () => onRemoveSnippet(snippet.id) : undefined}
						onClick={
							onOpenFile
								? () => onOpenFile(snippet.filePath, snippet.startLine, snippet.endLine)
								: undefined
						}
						title={`${snippet.filePath}:${snippet.startLine}-${snippet.endLine}${onOpenFile ? ' (click to open)' : ''}`}
						backgroundColor="color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent)"
					/>
				))}
			</div>
		);
	},
);
AttachmentsBar.displayName = 'AttachmentsBar';
