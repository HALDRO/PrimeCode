/**
 * @file diffStats - compute line-level diff statistics for webview
 * @description Shared, dependency-free diff utilities used by chat UI and state.
 * Exposes `computeDiffStats` for `ChangedFilesPanel` aggregation without importing TSX.
 * The algorithm matches the `SimpleDiff` line classifier to keep UI and stats consistent.
 */

export type DiffLineType = 'added' | 'removed' | 'unchanged';

export interface DiffStats {
	added: number;
	removed: number;
	unchanged: number;
}

interface DiffLine {
	type: DiffLineType;
	content: string;
	oldLineNumber?: number;
	newLineNumber?: number;
}

export function computeDiffStats(original: string, modified: string): DiffStats {
	const diffLines = computeDiff(original, modified);
	let added = 0;
	let removed = 0;
	let unchanged = 0;
	for (const line of diffLines) {
		switch (line.type) {
			case 'added':
				added++;
				break;
			case 'removed':
				removed++;
				break;
			default:
				unchanged++;
				break;
		}
	}
	return { added, removed, unchanged };
}

export function computeDiff(original: string, modified: string): DiffLine[] {
	const normalize = (str: string): string[] =>
		str ? str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n') : [];

	const oldLines = normalize(original);
	const newLines = normalize(modified);
	return myersDiff(oldLines, newLines);
}

function myersDiff(oldLines: string[], newLines: string[]): DiffLine[] {
	const n = oldLines.length;
	const m = newLines.length;
	const max = n + m;

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

	const trace: Map<number, number>[] = [];
	let lastV = new Map<number, number>([[0, 0]]);

	outer: for (let d = 0; d <= max; d++) {
		const v = new Map<number, number>();
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (lastV.get(k - 1) ?? -1) < (lastV.get(k + 1) ?? -1))) {
				x = lastV.get(k + 1) ?? 0;
			} else {
				x = (lastV.get(k - 1) ?? -1) + 1;
			}
			let y = x - k;
			while (x < n && y < m && oldLines[x] === newLines[y]) {
				x++;
				y++;
			}
			v.set(k, x);
			if (x >= n && y >= m) {
				trace.push(v);
				lastV = v;
				break outer;
			}
		}
		trace.push(v);
		lastV = v;
	}

	const edits: Array<{ type: 'insert' | 'delete' | 'equal'; oldIdx?: number; newIdx?: number }> =
		[];
	let x = n;
	let y = m;

	for (let d = trace.length - 1; d >= 0; d--) {
		const v = trace[d];
		const vPrev = d > 0 ? trace[d - 1] : new Map<number, number>([[0, 0]]);
		const k = x - y;

		let prevK: number;
		if (k === -d || (k !== d && (vPrev.get(k - 1) ?? -1) < (vPrev.get(k + 1) ?? -1))) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}

		const prevX = vPrev.get(prevK) ?? 0;
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			x--;
			y--;
			edits.unshift({ type: 'equal', oldIdx: x, newIdx: y });
		}

		if (d > 0) {
			const currentX = v.get(k) ?? 0;
			const currentY = currentX - k;
			if (currentX === prevX && currentY !== prevY) {
				y--;
				edits.unshift({ type: 'insert', newIdx: y });
			} else {
				x--;
				edits.unshift({ type: 'delete', oldIdx: x });
			}
		}
	}

	const result: DiffLine[] = [];
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
			continue;
		}
		if (edit.type === 'delete' && edit.oldIdx !== undefined) {
			result.push({
				type: 'removed',
				content: oldLines[edit.oldIdx],
				oldLineNumber: oldLineNum++,
			});
			continue;
		}
		if (edit.type === 'insert' && edit.newIdx !== undefined) {
			result.push({
				type: 'added',
				content: newLines[edit.newIdx],
				newLineNumber: newLineNum++,
			});
		}
	}

	return result;
}
