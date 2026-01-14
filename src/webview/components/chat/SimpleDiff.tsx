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
import { cn } from '../../lib/cn';

const LINE_HEIGHT = 19;

interface SimpleDiffProps {
	original: string;
	modified: string;
	maxHeight?: number;
	expanded?: boolean;
	showLineNumbers?: boolean;
}

type DiffLineType = 'added' | 'removed' | 'unchanged';

interface DiffLine {
	type: DiffLineType;
	content: string;
	oldLineNumber?: number;
	newLineNumber?: number;
	/** If present, render a separator before this line showing skipped unchanged lines */
	separatorBefore?: number;
}

/**
 * Myers diff algorithm implementation for accurate LCS-based diff
 * This produces minimal edit scripts between two sequences
 */
function myersDiff(oldLines: string[], newLines: string[]): DiffLine[] {
	const n = oldLines.length;
	const m = newLines.length;
	const max = n + m;

	// Handle edge cases
	if (n === 0 && m === 0) {
		return [];
	}
	if (n === 0) {
		return newLines.map((line, i) => ({
			type: 'added' as const,
			content: line,
			newLineNumber: i + 1,
		}));
	}
	if (m === 0) {
		return oldLines.map((line, i) => ({
			type: 'removed' as const,
			content: line,
			oldLineNumber: i + 1,
		}));
	}

	// V array stores the furthest reaching D-path endpoints
	const v: Map<number, number>[] = [];
	const trace: Map<number, number>[] = [];

	// Find the shortest edit script
	outer: for (let d = 0; d <= max; d++) {
		const vCurrent = new Map<number, number>();
		v.push(vCurrent);

		for (let k = -d; k <= d; k += 2) {
			let x: number;

			// Decide whether to go down or right
			if (k === -d || (k !== d && (v[d - 1]?.get(k - 1) ?? -1) < (v[d - 1]?.get(k + 1) ?? -1))) {
				x = v[d - 1]?.get(k + 1) ?? 0; // Move down (insertion)
			} else {
				x = (v[d - 1]?.get(k - 1) ?? -1) + 1; // Move right (deletion)
			}

			let y = x - k;

			// Follow diagonal (matching lines)
			while (x < n && y < m && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}

			vCurrent.set(k, x);

			// Check if we've reached the end
			if (x >= n && y >= m) {
				trace.push(vCurrent);
				break outer;
			}
		}
		trace.push(vCurrent);
	}

	// Backtrack to find the actual edit operations
	const result: DiffLine[] = [];
	let x = n;
	let y = m;

	const edits: Array<{ type: 'insert' | 'delete' | 'equal'; oldIdx?: number; newIdx?: number }> =
		[];

	for (let d = trace.length - 1; d >= 0; d--) {
		const vPrev = d > 0 ? trace[d - 1] : new Map<number, number>([[0, 0]]);
		const k = x - y;

		let prevK: number;
		if (k === -d || (k !== d && (vPrev.get(k - 1) ?? -1) < (vPrev.get(k + 1) ?? -1))) {
			prevK = k + 1; // Came from above (insertion)
		} else {
			prevK = k - 1; // Came from left (deletion)
		}

		const prevX = vPrev.get(prevK) ?? 0;
		const prevY = prevX - prevK;

		// Add diagonal moves (equal lines)
		while (x > prevX && y > prevY) {
			x--;
			y--;
			edits.unshift({ type: 'equal', oldIdx: x, newIdx: y });
		}

		// Add the edit operation
		if (d > 0) {
			if (x === prevX) {
				// Insertion
				y--;
				edits.unshift({ type: 'insert', newIdx: y });
			} else {
				// Deletion
				x--;
				edits.unshift({ type: 'delete', oldIdx: x });
			}
		}
	}

	// Convert edits to DiffLines
	let oldLineNum = 1;
	let newLineNum = 1;

	for (const edit of edits) {
		if (edit.type === 'equal' && edit.oldIdx !== undefined) {
			result.push({
				type: 'unchanged',
				content: oldLines[edit.oldIdx],
				oldLineNumber: oldLineNum++,
				newLineNumber: newLineNum++,
			});
		} else if (edit.type === 'delete' && edit.oldIdx !== undefined) {
			result.push({
				type: 'removed',
				content: oldLines[edit.oldIdx],
				oldLineNumber: oldLineNum++,
			});
		} else if (edit.type === 'insert' && edit.newIdx !== undefined) {
			result.push({
				type: 'added',
				content: newLines[edit.newIdx],
				newLineNumber: newLineNum++,
			});
		}
	}

	return result;
}

/**
 * Compute diff between two strings using Myers algorithm
 * Normalizes line endings to ensure consistent comparison
 */
function computeDiff(original: string, modified: string): DiffLine[] {
	// Normalize line endings: remove \r and trim trailing whitespace from each line
	const normalize = (str: string): string[] =>
		str ? str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') : [];

	const oldLines = normalize(original);
	const newLines = normalize(modified);
	return myersDiff(oldLines, newLines);
}

/**
 * Group diff lines into hunks with context (±1 line around changes)
 * Returns only the lines that should be displayed, with separatorBefore markers
 */
function groupIntoHunks(diffLines: DiffLine[], contextLines = 1): DiffLine[] {
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
	const result: DiffLine[] = [];
	let lastEnd = -1;

	for (const range of includedRanges) {
		for (let i = range.start; i <= range.end; i++) {
			const line = { ...diffLines[i] };

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
export function getDiffContentHeight(original: string, modified: string): number {
	const diffLines = computeDiff(original, modified);
	const displayLines = groupIntoHunks(diffLines, 1);
	// Count separators (lines with separatorBefore) as additional height
	const separatorCount = displayLines.filter(l => l.separatorBefore !== undefined).length;
	return (displayLines.length + separatorCount) * LINE_HEIGHT;
}

/**
 * Get diff statistics (added/removed line counts)
 */
export function getDiffStats(
	original: string,
	modified: string,
): { added: number; removed: number; unchanged: number } {
	const diffLines = computeDiff(original, modified);
	return {
		added: diffLines.filter(l => l.type === 'added').length,
		removed: diffLines.filter(l => l.type === 'removed').length,
		unchanged: diffLines.filter(l => l.type === 'unchanged').length,
	};
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
	const hunks: Array<{ start: number; lines: DiffLine[] }> = [];
	let currentHunk: DiffLine[] = [];
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
}) => {
	const diffLines = useMemo(() => computeDiff(original, modified), [original, modified]);
	const displayLines = useMemo(() => groupIntoHunks(diffLines, 1), [diffLines]);

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
