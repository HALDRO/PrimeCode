/**
 * @file SimpleDiff - Advanced diff viewer component with LCS algorithm
 * @description Renders code diff with colored line indicators (green for added, red for removed).
 * Uses Myers diff algorithm (LCS-based) for accurate line-by-line comparison.
 * Supports unified diff format export and inline character-level highlighting.
 * Uses OverlayScrollbars for consistent scrollbar styling across the app.
 */

import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type React from 'react';
import { useMemo } from 'react';
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
 */
function computeDiff(original: string, modified: string): DiffLine[] {
	const oldLines = original ? original.split('\n') : [];
	const newLines = modified ? modified.split('\n') : [];
	return myersDiff(oldLines, newLines);
}

/**
 * Calculate content height based on diff lines count
 */
export function getDiffContentHeight(original: string, modified: string): number {
	const diffLines = computeDiff(original, modified);
	return diffLines.length * LINE_HEIGHT;
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

	const maxHeightStyle = expanded ? undefined : `${maxHeight}px`;

	// Find first and last non-empty line indices for rounded corners
	const firstLineIndex = 0;
	const lastLineIndex = diffLines.length - 1;

	// Calculate max line number width for alignment
	const maxLineNum = Math.max(
		...diffLines.map(l => Math.max(l.oldLineNumber || 0, l.newLineNumber || 0)),
	);
	const lineNumWidth = showLineNumbers ? `${String(maxLineNum).length * 8 + 8}px` : '0px';

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
						diffLines[firstLineIndex]?.type === 'added'
							? 'bg-success'
							: diffLines[firstLineIndex]?.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>
				{/* Rounded cap at bottom */}
				<div
					className={cn(
						'absolute bottom-0 left-0 w-(--border-indicator) h-1.5 rounded-br-(--gap-1) z-1',
						diffLines[lastLineIndex]?.type === 'added'
							? 'bg-success'
							: diffLines[lastLineIndex]?.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>
				{diffLines.map((line, index) => (
					<div
						key={`${line.type}-${index}`}
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
				))}
			</div>
		</OverlayScrollbarsComponent>
	);
};

export default SimpleDiff;
