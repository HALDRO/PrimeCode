/**
 * @file SimpleDiff - All diff logic in one place
 * @description Diff data resolution, stats, and rendering.
 * Parses unified diffs from the backend directly into display lines — O(N).
 * No LCS. The backend always sends metadata.diff with unified diff hunks.
 * ToolCard imports helpers from here — it never touches diff internals.
 */

import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type React from 'react';
import { Fragment, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { getShortFileName } from '../../utils/format';

const LINE_HEIGHT = 19;
const CONTEXT_LINES = 2;

const scrollToBottom = (instance: OverlayScrollbars) => {
	const viewport = instance.elements().viewport;
	if (viewport) viewport.scrollTop = viewport.scrollHeight;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LineType = 'added' | 'removed' | 'unchanged';

export interface DiffLine {
	type: LineType;
	content: string;
}

interface DisplayLine extends DiffLine {
	hiddenBefore?: number;
}

// ---------------------------------------------------------------------------
// O(N) unified diff parser
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff string (with @@ hunks) directly into DiffLine[].
 * O(N) where N = number of lines in the diff.
 * Returns null if the input doesn't look like a valid unified diff.
 */
function parseUnifiedDiff(diffText: string): DiffLine[] | null {
	const lines = diffText.split('\n');
	let inHunk = false;
	let sawChange = false;
	const result: DiffLine[] = [];

	for (const line of lines) {
		if (line.startsWith('@@')) {
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue;
		if (line.startsWith('+')) {
			result.push({ type: 'added', content: line.slice(1) });
			sawChange = true;
		} else if (line.startsWith('-')) {
			result.push({ type: 'removed', content: line.slice(1) });
			sawChange = true;
		} else if (line.startsWith(' ')) {
			result.push({ type: 'unchanged', content: line.slice(1) });
		}
	}

	if (!inHunk || !sawChange) return null;
	return result;
}

/**
 * Convert raw text content into "all added" or "all removed" DiffLine[].
 * Used for Write (new file) and Delete cases where there's no before/after pair.
 */
function textToLines(text: string, type: 'added' | 'removed'): DiffLine[] {
	if (!text) return [];
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n')
		.map(content => ({ type, content }));
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

export function getDiffContentHeight(lines: DiffLine[]): number {
	const display = collapseUnchanged(lines);
	const separators = display.filter(l => l.hiddenBefore).length;
	return (display.length + separators) * LINE_HEIGHT;
}

export function computeStats(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (line.type === 'added') added++;
		else if (line.type === 'removed') removed++;
	}
	return { added, removed };
}

// ---------------------------------------------------------------------------
// Diff data resolution (used by ToolCard)
// ---------------------------------------------------------------------------

export type ResolvedDiffData = {
	lines: DiffLine[];
	effectiveFilePath: string;
	name: string;
	hasDeleteChange: boolean;
	stats: { added: number; removed: number };
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
 * Resolve diff data from various sources and parse into DiffLine[].
 * Priority: metadata.diff (unified diff, O(N)) > filediff.additions/deletions > actionType content.
 */
export function resolveDiffData(params: {
	actionType: unknown;
	toolResultMetadata?: unknown;
	accessRequestRaw?: unknown;
	fallbackFilePath?: string;
}): ResolvedDiffData {
	let lines: DiffLine[] = [];
	let effectiveFilePath = '';
	let hasDeleteChange = false;

	// 1. Extract path and detect delete from ActionType
	const actionRec = asRecord(params.actionType);
	if (actionRec?.type === 'FileEdit') {
		effectiveFilePath = typeof actionRec.path === 'string' ? actionRec.path : '';
		const changesRaw = actionRec.changes;
		const change = Array.isArray(changesRaw) ? asRecord(changesRaw[0]) : undefined;
		if (change) {
			hasDeleteChange = change.type === 'Delete';
		}
	}

	// 2. Tool result metadata — try unified diff (O(N))
	const meta = asRecord(params.toolResultMetadata);
	const metaPath = getString(meta, ['filepath', 'filePath', 'path']);

	const unifiedDiff = getString(meta, ['diff']);
	if (unifiedDiff) {
		const parsed = parseUnifiedDiff(unifiedDiff);
		if (parsed) lines = parsed;
	}

	// 3. If no unified diff, try filediff path extraction
	if (lines.length === 0) {
		const fileDiffRaw = meta?.filediff;
		const fileDiff = Array.isArray(fileDiffRaw)
			? asRecord(fileDiffRaw.find(item => item && typeof item === 'object'))
			: asRecord(fileDiffRaw);
		if (fileDiff) {
			const fdPath = getString(fileDiff, ['filepath', 'filePath', 'path', 'file']);
			if (!effectiveFilePath && fdPath) effectiveFilePath = fdPath;
		}
	}

	// 4. If still nothing, fall back to actionType content
	if (lines.length === 0 && actionRec?.type === 'FileEdit') {
		const changesRaw = actionRec.changes;
		const change = Array.isArray(changesRaw) ? asRecord(changesRaw[0]) : undefined;
		if (change) {
			if (change.type === 'Write' && typeof change.content === 'string') {
				lines = textToLines(change.content, 'added');
			} else if (change.type === 'Edit' && typeof change.unifiedDiff === 'string') {
				const parsed = parseUnifiedDiff(change.unifiedDiff as string);
				if (parsed) lines = parsed;
				else lines = textToLines(change.unifiedDiff as string, 'added');
			} else if (change.type === 'Replace') {
				const old = typeof change.oldContent === 'string' ? change.oldContent : '';
				const neu = typeof change.newContent === 'string' ? change.newContent : '';
				lines = [...textToLines(old, 'removed'), ...textToLines(neu, 'added')];
			}
		}
	}

	// 5. Access request metadata (last resort)
	if (lines.length === 0) {
		const accRec = asRecord(params.accessRequestRaw);
		const accMeta = asRecord(accRec?.metadata);
		const diffText = getString(accMeta, ['diff']);
		if (diffText) {
			const parsed = parseUnifiedDiff(diffText);
			if (parsed) lines = parsed;
			else lines = textToLines(diffText, 'added');
			const accPath = getString(accMeta, ['filepath', 'filePath', 'path']);
			if (!effectiveFilePath && accPath) effectiveFilePath = accPath;
		}
	}

	if (!effectiveFilePath && metaPath) effectiveFilePath = metaPath;
	if (!effectiveFilePath && params.fallbackFilePath) effectiveFilePath = params.fallbackFilePath;

	return {
		lines,
		effectiveFilePath,
		name: effectiveFilePath ? getShortFileName(effectiveFilePath) : 'unknown',
		hasDeleteChange,
		stats: computeStats(lines),
	};
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SimpleDiffProps {
	lines: DiffLine[];
	maxHeight?: number;
	expanded?: boolean;
}

export const SimpleDiff: React.FC<SimpleDiffProps> = ({
	lines,
	maxHeight = 120,
	expanded = false,
}) => {
	const displayLines = useMemo(() => collapseUnchanged(lines), [lines]);

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
			events={{ initialized: scrollToBottom }}
			defer
		>
			<div className="min-w-fit relative">
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

				{displayLines.map((line: DisplayLine, idx: number) => (
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
