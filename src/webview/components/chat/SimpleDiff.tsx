/**
 * @file SimpleDiff - Advanced diff viewer component with LCS algorithm
 * @description Renders code diff with colored line indicators (green for added, red for removed).
 * Uses Myers diff algorithm (LCS-based) for accurate line-by-line comparison.
 * Supports unified diff format export and inline character-level highlighting.
 * Uses OverlayScrollbars for consistent scrollbar styling across the app.
 */

import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type React from 'react';
import { Fragment, useMemo } from 'react';
import { computeDiff } from '../../../common/diffStats';
import { cn } from '../../lib/cn';

const LINE_HEIGHT = 19;
const DEFAULT_HUNK_CONTEXT_LINES = 2;

interface SimpleDiffProps {
	original: string;
	modified: string;
	maxHeight?: number;
	expanded?: boolean;
	showLineNumbers?: boolean;
	/**
	 * When true (default), collapse large unchanged regions and keep only hunks
	 * around changed lines.
	 */
	collapseUnchanged?: boolean;
	/** Number of unchanged context lines to keep around each changed line (only when collapsing). */
	contextLines?: number;
}

type BaseDiffLine = ReturnType<typeof computeDiff>[number];

type DisplayDiffLine = BaseDiffLine & {
	/** If present, render a separator before this line showing skipped unchanged lines */
	separatorBefore?: number;
};

/**
 * Best-effort parse for unified diff hunks ("@@ ... @@") into old/new content snapshots.
 * Returns null when input does not look like a valid unified diff with hunks.
 */
export function parseUnifiedDiffSnapshots(
	diffText: string,
): { oldContent: string; newContent: string } | null {
	const lines = diffText.split('\n');
	let inHunk = false;
	let sawChange = false;
	const oldLines: string[] = [];
	const newLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith('@@')) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;

		// Skip headers if they appear inside parsed chunk
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('\\')) continue; // e.g. "\\ No newline at end of file"

		if (line.startsWith('+')) {
			newLines.push(line.slice(1));
			sawChange = true;
			continue;
		}
		if (line.startsWith('-')) {
			oldLines.push(line.slice(1));
			sawChange = true;
			continue;
		}
		if (line.startsWith(' ')) {
			const ctx = line.slice(1);
			oldLines.push(ctx);
			newLines.push(ctx);
		}
	}

	if (!inHunk) return null;
	if (!sawChange && oldLines.length === 0 && newLines.length === 0) return null;

	return {
		oldContent: oldLines.join('\n'),
		newContent: newLines.join('\n'),
	};
}

function groupIntoHunks(diffLines: BaseDiffLine[], contextLines = 1): DisplayDiffLine[] {
	if (diffLines.length === 0) return [];

	// Find indices of all changed lines
	const changedIndices: number[] = [];
	for (let i = 0; i < diffLines.length; i++) {
		if (diffLines[i].type !== 'unchanged') {
			changedIndices.push(i);
		}
	}

	// If no changes, return empty
	if (changedIndices.length === 0) {
		return [];
	}

	// Build ranges that should be included (changed lines + context)
	const includedRanges: Array<{ start: number; end: number }> = [];

	for (const idx of changedIndices) {
		const start = Math.max(0, idx - contextLines);
		const end = Math.min(diffLines.length - 1, idx + contextLines);

		// Merge with previous range if overlapping or adjacent
		if (includedRanges.length > 0) {
			const lastRange = includedRanges[includedRanges.length - 1];
			if (start <= lastRange.end + 1) {
				lastRange.end = Math.max(lastRange.end, end);
				continue;
			}
		}

		includedRanges.push({ start, end });
	}

	// Build the display lines with separatorBefore markers
	const result: DisplayDiffLine[] = [];
	let lastEnd = -1;

	for (const range of includedRanges) {
		for (let i = range.start; i <= range.end; i++) {
			const line: DisplayDiffLine = { ...diffLines[i] };

			// Add separator marker on first line of hunk if there's a gap
			// Skip separator for the very first hunk - no need to show "hidden lines" at the top
			if (i === range.start) {
				if (lastEnd >= 0 && range.start > lastEnd + 1) {
					// Gap between hunks - show hidden lines count
					line.separatorBefore = range.start - lastEnd - 1;
				}
			}

			result.push(line);
		}

		lastEnd = range.end;
	}

	return result;
}

/**
 * Calculate content height based on displayed lines count (hunks with context)
 */
export function getDiffContentHeight(
	original: string,
	modified: string,
	options?: { collapseUnchanged?: boolean; contextLines?: number },
): number {
	const diffLines = computeDiff(original, modified);
	const collapseUnchanged = options?.collapseUnchanged ?? true;
	const contextLines = options?.contextLines ?? DEFAULT_HUNK_CONTEXT_LINES;
	const displayLines: DisplayDiffLine[] = collapseUnchanged
		? groupIntoHunks(diffLines, contextLines)
		: diffLines.map(l => ({ ...l }));
	// Count separators (lines with separatorBefore) as additional height
	const separatorCount = displayLines.filter(l => l.separatorBefore !== undefined).length;
	return (displayLines.length + separatorCount) * LINE_HEIGHT;
}

/**
 * Format diff as unified diff string (for copying)
 */
export function formatAsUnifiedDiff(original: string, modified: string, fileName?: string): string {
	const diffLines = computeDiff(original, modified);
	const result: string[] = [];

	if (fileName) {
		result.push(`--- a/${fileName}`);
		result.push(`+++ b/${fileName}`);
	}

	// Group changes into hunks
	const hunks: Array<{ start: number; lines: BaseDiffLine[] }> = [];
	let currentHunk: BaseDiffLine[] = [];
	let hunkStart = 0;
	let contextBefore = 0;

	for (let i = 0; i < diffLines.length; i++) {
		const line = diffLines[i];

		if (line.type !== 'unchanged') {
			// Start new hunk if needed
			if (currentHunk.length === 0) {
				// Add up to 3 lines of context before
				const contextStart = Math.max(0, i - 3);
				hunkStart = contextStart;
				for (let j = contextStart; j < i; j++) {
					currentHunk.push(diffLines[j]);
				}
			}
			currentHunk.push(line);
			contextBefore = 0;
		} else if (currentHunk.length > 0) {
			currentHunk.push(line);
			contextBefore++;

			// End hunk after 3 lines of context
			if (contextBefore >= 3) {
				hunks.push({ start: hunkStart, lines: currentHunk });
				currentHunk = [];
				contextBefore = 0;
			}
		}
	}

	// Don't forget the last hunk
	if (currentHunk.length > 0) {
		hunks.push({ start: hunkStart, lines: currentHunk });
	}

	// Format hunks
	for (const hunk of hunks) {
		const oldStart = hunk.lines[0]?.oldLineNumber || 1;
		const newStart = hunk.lines[0]?.newLineNumber || 1;
		const oldCount = hunk.lines.filter(l => l.type !== 'added').length;
		const newCount = hunk.lines.filter(l => l.type !== 'removed').length;

		result.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);

		for (const line of hunk.lines) {
			const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
			result.push(`${prefix}${line.content}`);
		}
	}

	return result.join('\n');
}

export const SimpleDiff: React.FC<SimpleDiffProps> = ({
	original,
	modified,
	maxHeight = 120,
	expanded = false,
	showLineNumbers = false,
	collapseUnchanged = true,
	contextLines = DEFAULT_HUNK_CONTEXT_LINES,
}) => {
	const diffLines = useMemo(() => computeDiff(original, modified), [original, modified]);
	const displayLines = useMemo(
		(): DisplayDiffLine[] =>
			collapseUnchanged ? groupIntoHunks(diffLines, contextLines) : diffLines.map(l => ({ ...l })),
		[diffLines, collapseUnchanged, contextLines],
	);

	const maxHeightStyle = expanded ? undefined : `${maxHeight}px`;

	// Find first and last line for rounded corners
	const firstLine = displayLines[0];
	const lastLine = displayLines[displayLines.length - 1];

	// Calculate max line number width for alignment
	const maxLineNum = Math.max(
		...displayLines.map(l => Math.max(l.oldLineNumber || 0, l.newLineNumber || 0)),
		1,
	);
	const lineNumWidth = showLineNumbers ? `${String(maxLineNum).length * 8 + 8}px` : '0px';

	if (displayLines.length === 0) {
		return (
			<div className="bg-(--tool-bg-header) text-vscode-descriptionForeground text-sm px-3 py-2 italic">
				No changes
			</div>
		);
	}

	return (
		<OverlayScrollbarsComponent
			style={{ maxHeight: maxHeightStyle }}
			className="bg-(--tool-bg-header)"
			options={{
				scrollbars: {
					theme: 'os-theme-dark',
					autoHide: 'scroll',
					autoHideDelay: 800,
					clickScroll: true,
				},
				overflow: {
					x: 'scroll',
					y: 'scroll',
				},
			}}
			defer
		>
			<div className="min-w-fit relative">
				{/* Rounded cap at top */}
				<div
					className={cn(
						'absolute top-0 left-0 w-(--border-indicator) h-1.5 rounded-tr-(--gap-1) z-1',
						firstLine?.type === 'added'
							? 'bg-success'
							: firstLine?.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>
				{/* Rounded cap at bottom */}
				<div
					className={cn(
						'absolute bottom-0 left-0 w-(--border-indicator) h-1.5 rounded-br-(--gap-1) z-1',
						lastLine?.type === 'added'
							? 'bg-success'
							: lastLine?.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>
				{displayLines.map((line, idx) => (
					<Fragment
						key={`${idx}-${line.type}-${line.oldLineNumber ?? ''}-${line.newLineNumber ?? ''}`}
					>
						{/* Hidden lines separator - styled like reference screenshot */}
						{line.separatorBefore !== undefined && line.separatorBefore > 0 && (
							<div className="flex items-center h-(--line-height-diff) px-2 text-xs text-vscode-descriptionForeground select-none bg-(--tool-bg-header)">
								<span className="opacity-70">— {line.separatorBefore} hidden lines —</span>
							</div>
						)}
						{/* Actual diff line */}
						<div
							className={cn(
								'flex items-stretch min-h-(--line-height-diff) leading-(--line-height-diff) text-sm',
								line.type === 'added'
									? 'bg-success/12'
									: line.type === 'removed'
										? 'bg-error/12'
										: '',
							)}
						>
							{/* Color indicator */}
							<div
								className={cn(
									'w-(--border-indicator) shrink-0',
									line.type === 'added'
										? 'bg-success'
										: line.type === 'removed'
											? 'bg-error'
											: 'bg-transparent',
								)}
							/>

							{/* Line numbers */}
							{showLineNumbers && (
								<div
									className="shrink-0 text-right pr-2 text-vscode-descriptionForeground opacity-50 select-none"
									style={{ width: lineNumWidth }}
								>
									{line.type === 'removed'
										? line.oldLineNumber
										: line.type === 'added'
											? line.newLineNumber
											: line.oldLineNumber}
								</div>
							)}

							{/* Content */}
							<pre
								className={cn(
									'm-0 px-2 whitespace-pre text-vscode-foreground flex-1',
									line.type === 'removed' ? 'opacity-70' : 'opacity-100',
								)}
							>
								{line.content || ' '}
							</pre>
						</div>
					</Fragment>
				))}
			</div>
		</OverlayScrollbarsComponent>
	);
};

export default SimpleDiff;
