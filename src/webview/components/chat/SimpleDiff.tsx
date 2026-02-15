/**
 * @file SimpleDiff - All diff logic in one place
 * @description Diff data resolution, stats, and rendering.
 * ToolCard imports helpers from here — it never touches diff internals.
 */

import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type React from 'react';
import { Fragment, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { getShortFileName } from '../../utils/format';

const LINE_HEIGHT = 19;
const CONTEXT_LINES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LineType = 'added' | 'removed' | 'unchanged';

interface DiffLine {
	type: LineType;
	content: string;
}

interface DisplayLine extends DiffLine {
	/** Number of hidden unchanged lines before this line */
	hiddenBefore?: number;
}

// ---------------------------------------------------------------------------
// Simple line diff (no Myers)
// ---------------------------------------------------------------------------

function splitLines(s: string): string[] {
	return s ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') : [];
}

/**
 * Build LCS table and backtrack to produce a line-level diff.
 * O(n*m) but with early-outs for trivial cases (new file, delete, identical).
 */
function diffLines(oldText: string, newText: string): DiffLine[] {
	const oldL = splitLines(oldText);
	const newL = splitLines(newText);

	if (oldL.length === 0 && newL.length === 0) return [];
	if (oldL.length === 0) return newL.map(c => ({ type: 'added', content: c }));
	if (newL.length === 0) return oldL.map(c => ({ type: 'removed', content: c }));

	// Quick check: identical
	if (oldText === newText) return oldL.map(c => ({ type: 'unchanged', content: c }));

	const n = oldL.length;
	const m = newL.length;

	// LCS DP (space-optimised to two rows)
	let prev = new Uint16Array(m + 1);
	let curr = new Uint16Array(m + 1);

	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			curr[j] = oldL[i - 1] === newL[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
		}
		[prev, curr] = [curr, prev];
		curr.fill(0);
	}

	// Backtrack through full table to recover edit script
	// We need the full table for backtracking, rebuild it
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			dp[i][j] =
				oldL[i - 1] === newL[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}

	const result: DiffLine[] = [];
	let i = n;
	let j = m;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldL[i - 1] === newL[j - 1]) {
			result.push({ type: 'unchanged', content: oldL[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			result.push({ type: 'added', content: newL[j - 1] });
			j--;
		} else {
			result.push({ type: 'removed', content: oldL[i - 1] });
			i--;
		}
	}

	result.reverse();
	return result;
}

// ---------------------------------------------------------------------------
// Hunk collapsing
// ---------------------------------------------------------------------------

function collapseUnchanged(lines: DiffLine[], ctx = CONTEXT_LINES): DisplayLine[] {
	if (lines.length === 0) return [];

	const changed: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].type !== 'unchanged') changed.push(i);
	}
	if (changed.length === 0) return [];

	// Build visible ranges (changed ± context)
	const ranges: { start: number; end: number }[] = [];
	for (const idx of changed) {
		const start = Math.max(0, idx - ctx);
		const end = Math.min(lines.length - 1, idx + ctx);
		const last = ranges[ranges.length - 1];
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	const out: DisplayLine[] = [];
	let prevEnd = -1;

	for (const r of ranges) {
		for (let i = r.start; i <= r.end; i++) {
			const dl: DisplayLine = { ...lines[i] };
			if (i === r.start && prevEnd >= 0 && r.start > prevEnd + 1) {
				dl.hiddenBefore = r.start - prevEnd - 1;
			}
			out.push(dl);
		}
		prevEnd = r.end;
	}

	return out;
}

// ---------------------------------------------------------------------------
// Public helpers (used by ToolCard)
// ---------------------------------------------------------------------------

export function getDiffContentHeight(
	original: string,
	modified: string,
	options?: { collapseUnchanged?: boolean },
): number {
	const raw = diffLines(original, modified);
	const display = options?.collapseUnchanged === false ? raw : collapseUnchanged(raw);
	const separators = (display as DisplayLine[]).filter(l => l.hiddenBefore).length;
	return (display.length + separators) * LINE_HEIGHT;
}

/**
 * Best-effort parse for unified diff hunks ("@@ ... @@") into old/new snapshots.
 */
function parseUnifiedDiffSnapshots(
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
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue;
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
			const c = line.slice(1);
			oldLines.push(c);
			newLines.push(c);
		}
	}

	if (!inHunk || (!sawChange && oldLines.length === 0 && newLines.length === 0)) return null;
	return { oldContent: oldLines.join('\n'), newContent: newLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Diff data resolution (used by ToolCard)
// ---------------------------------------------------------------------------

type ResolvedDiffData = {
	oldContent: string;
	newContent: string;
	effectiveFilePath: string;
	name: string;
	hasDeleteChange: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const getString = (
	rec: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined => {
	if (!rec) return undefined;
	for (const k of keys) {
		const v = rec[k];
		if (typeof v === 'string' && v.length > 0) return v;
	}
	return undefined;
};

/**
 * Resolve old/new content from various sources (actionType, toolResult metadata, accessRequest).
 * Single entry point — ToolCard just passes raw data, SimpleDiff figures out the diff.
 */
export function resolveDiffData(params: {
	actionType: unknown;
	toolResultMetadata?: unknown;
	accessRequestRaw?: unknown;
	fallbackFilePath?: string;
}): ResolvedDiffData {
	let oldContent = '';
	let newContent = '';
	let effectiveFilePath = '';
	let hasDeleteChange = false;

	// 1. ActionType (FileEdit from NormalizedEntry)
	const actionRec = asRecord(params.actionType);
	if (actionRec?.type === 'FileEdit') {
		effectiveFilePath = typeof actionRec.path === 'string' ? actionRec.path : '';
		const changesRaw = actionRec.changes;
		const change = Array.isArray(changesRaw) ? asRecord(changesRaw[0]) : undefined;
		if (change) {
			hasDeleteChange = change.type === 'Delete';
			if (change.type === 'Write' && typeof change.content === 'string') {
				newContent = change.content;
			} else if (change.type === 'Edit' && typeof change.unifiedDiff === 'string') {
				newContent = change.unifiedDiff;
			} else if (change.type === 'Replace') {
				oldContent = typeof change.oldContent === 'string' ? change.oldContent : '';
				newContent = typeof change.newContent === 'string' ? change.newContent : '';
			}
		}
	}

	// 2. Tool result metadata (filediff, diff)
	const meta = asRecord(params.toolResultMetadata);
	const metaPath = getString(meta, ['filepath', 'filePath', 'path']);

	const fileDiffRaw = meta?.filediff;
	const fileDiff = Array.isArray(fileDiffRaw)
		? asRecord(fileDiffRaw.find(item => item && typeof item === 'object'))
		: asRecord(fileDiffRaw);

	if (fileDiff) {
		const before = getString(fileDiff, ['before']);
		const after = getString(fileDiff, ['after']);
		if (before !== undefined || after !== undefined) {
			oldContent = before ?? '';
			newContent = after ?? '';
		}
		const fdPath = getString(fileDiff, ['filepath', 'filePath', 'path']);
		if (!effectiveFilePath && fdPath) effectiveFilePath = fdPath;
	}

	if (!newContent && !oldContent) {
		const unifiedDiff = getString(meta, ['diff']);
		if (unifiedDiff) {
			const parsed = parseUnifiedDiffSnapshots(unifiedDiff);
			if (parsed) {
				oldContent = parsed.oldContent;
				newContent = parsed.newContent;
			} else {
				newContent = unifiedDiff;
			}
		}
	}

	// 3. Access request metadata
	if (!newContent && !oldContent) {
		const accRec = asRecord(params.accessRequestRaw);
		const accMeta = asRecord(accRec?.metadata);
		const diffText = getString(accMeta, ['diff']);
		if (diffText) {
			const parsed = parseUnifiedDiffSnapshots(diffText);
			if (parsed) {
				oldContent = parsed.oldContent;
				newContent = parsed.newContent;
			} else {
				newContent = diffText;
			}
			const accPath = getString(accMeta, ['filepath', 'filePath', 'path']);
			if (!effectiveFilePath && accPath) effectiveFilePath = accPath;
		}
	}

	if (!effectiveFilePath && metaPath) effectiveFilePath = metaPath;
	if (!effectiveFilePath && params.fallbackFilePath) effectiveFilePath = params.fallbackFilePath;

	return {
		oldContent,
		newContent,
		effectiveFilePath,
		name: effectiveFilePath ? getShortFileName(effectiveFilePath) : 'unknown',
		hasDeleteChange,
	};
}

/** Simple line-count based stats for +N / -N display */
export function computeSimpleStats(oldContent: string, newContent: string) {
	const oldLines = oldContent ? oldContent.split('\n').length : 0;
	const newLines = newContent ? newContent.split('\n').length : 0;
	return { added: Math.max(0, newLines - oldLines), removed: Math.max(0, oldLines - newLines) };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SimpleDiffProps {
	original: string;
	modified: string;
	maxHeight?: number;
	expanded?: boolean;
	collapseUnchanged?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SimpleDiff: React.FC<SimpleDiffProps> = ({
	original,
	modified,
	maxHeight = 120,
	expanded = false,
	collapseUnchanged: collapse = true,
}) => {
	const displayLines = useMemo(() => {
		const raw = diffLines(original, modified);
		return collapse ? collapseUnchanged(raw) : raw.map<DisplayLine>(l => ({ ...l }));
	}, [original, modified, collapse]);

	if (displayLines.length === 0) {
		return (
			<div className="bg-(--tool-bg-header) text-vscode-descriptionForeground text-sm px-3 py-2 italic">
				No changes
			</div>
		);
	}

	const first = displayLines[0];
	const last = displayLines[displayLines.length - 1];

	return (
		<OverlayScrollbarsComponent
			style={{ maxHeight: expanded ? undefined : `${maxHeight}px` }}
			className="bg-(--tool-bg-header)"
			options={{
				scrollbars: {
					theme: 'os-theme-dark',
					autoHide: 'scroll',
					autoHideDelay: 800,
					clickScroll: true,
				},
				overflow: { x: 'scroll', y: 'scroll' },
			}}
			defer
		>
			<div className="min-w-fit relative">
				{/* Top rounded cap */}
				<div
					className={cn(
						'absolute top-0 left-0 w-(--border-indicator) h-1.5 rounded-tr-(--gap-1) z-1',
						first.type === 'added'
							? 'bg-success'
							: first.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>
				{/* Bottom rounded cap */}
				<div
					className={cn(
						'absolute bottom-0 left-0 w-(--border-indicator) h-1.5 rounded-br-(--gap-1) z-1',
						last.type === 'added'
							? 'bg-success'
							: last.type === 'removed'
								? 'bg-error'
								: 'bg-transparent',
					)}
				/>

				{displayLines.map((line, idx) => (
					<Fragment key={`${idx}-${line.type}-${line.content.length}`}>
						{line.hiddenBefore != null && line.hiddenBefore > 0 && (
							<div className="flex items-center h-(--line-height-diff) px-2 text-xs text-vscode-descriptionForeground select-none bg-(--tool-bg-header)">
								<span className="opacity-70">— {line.hiddenBefore} hidden lines —</span>
							</div>
						)}
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
