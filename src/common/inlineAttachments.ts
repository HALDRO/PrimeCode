export interface InlineSnippetAttachment {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

export interface InlineAttachmentMatch {
	raw: string;
	start: number;
	end: number;
	path: string;
	displayPath: string;
	isDirectory: boolean;
	startLine?: number;
	endLine?: number;
	kind: 'file' | 'snippet';
}

const INLINE_ATTACHMENT_RE = /@\[(.+?)\](?:#L(\d+)(?:-L?(\d+))?)?/g;
const WINDOWS_ROOT_RE = /^[A-Za-z]:[\\/]?$/;

function normalizeAttachmentPath(rawPath: string): {
	path: string;
	displayPath: string;
	isDirectory: boolean;
} {
	const trimmed = rawPath.trim();
	const isDirectory = /[\\/]$/.test(trimmed) && !WINDOWS_ROOT_RE.test(trimmed);
	const path = isDirectory ? trimmed.replace(/[\\/]+$/, '') : trimmed;
	return {
		path: path || trimmed,
		displayPath: trimmed,
		isDirectory,
	};
}

export function extractInlineAttachmentMatches(text: string): InlineAttachmentMatch[] {
	if (!text) return [];

	const matches: InlineAttachmentMatch[] = [];
	for (const match of text.matchAll(INLINE_ATTACHMENT_RE)) {
		const raw = match[0];
		const index = match.index ?? -1;
		const rawPath = match[1]?.trim();
		if (index < 0 || !rawPath) continue;

		const { path, displayPath, isDirectory } = normalizeAttachmentPath(rawPath);
		const startLine = match[2] ? Number(match[2]) : undefined;
		const endLine = match[3] ? Number(match[3]) : startLine;
		const hasLines =
			typeof startLine === 'number' &&
			Number.isFinite(startLine) &&
			startLine > 0 &&
			typeof endLine === 'number' &&
			Number.isFinite(endLine) &&
			endLine > 0;

		matches.push({
			raw,
			start: index,
			end: index + raw.length,
			path,
			displayPath,
			isDirectory,
			startLine: hasLines ? startLine : undefined,
			endLine: hasLines ? endLine : undefined,
			kind: hasLines ? 'snippet' : 'file',
		});
	}

	return matches;
}

export function formatInlineFileReference(path: string, isDirectory = false): string {
	const trimmed = path.trim();
	if (!trimmed) return '';
	const displayPath =
		isDirectory && !/[\\/]$/.test(trimmed) && !WINDOWS_ROOT_RE.test(trimmed)
			? `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}`
			: trimmed;
	return `@[${displayPath}]`;
}

export function formatInlineSnippetReference(snippet: {
	filePath: string;
	startLine: number;
	endLine?: number;
}): string {
	const filePath = snippet.filePath.trim();
	if (!filePath) return '';
	const startLine = Math.max(1, snippet.startLine || 1);
	const endLine = Math.max(startLine, snippet.endLine || startLine);
	return `@[${filePath}]#L${startLine}${endLine !== startLine ? `-L${endLine}` : ''}`;
}

function appendUnique(values: string[], next: string): void {
	if (!next || values.includes(next)) return;
	values.push(next);
}

export function extractInlineAttachmentPayload(text: string): {
	files: string[];
	codeSnippets: InlineSnippetAttachment[];
	matches: InlineAttachmentMatch[];
} {
	const matches = extractInlineAttachmentMatches(text);
	const files: string[] = [];
	const codeSnippets: InlineSnippetAttachment[] = [];
	const snippetKeys = new Set<string>();

	for (const match of matches) {
		if (match.kind === 'snippet' && match.startLine !== undefined && match.endLine !== undefined) {
			const key = `${match.path}:${match.startLine}-${match.endLine}`;
			if (snippetKeys.has(key)) continue;
			snippetKeys.add(key);
			codeSnippets.push({
				filePath: match.path,
				startLine: match.startLine,
				endLine: match.endLine,
				content: '',
			});
			continue;
		}

		appendUnique(files, match.path);
	}

	return { files, codeSnippets, matches };
}

export function prependInlineAttachmentReferences(
	text: string,
	files: string[] = [],
	codeSnippets: Array<{ filePath: string; startLine: number; endLine: number }> = [],
): string {
	const existing = extractInlineAttachmentPayload(text);
	const refs: string[] = [];
	for (const filePath of files) {
		if (existing.files.includes(filePath)) continue;
		const ref = formatInlineFileReference(filePath, /[\\/]$/.test(filePath));
		if (ref && !refs.includes(ref)) refs.push(ref);
	}
	for (const snippet of codeSnippets) {
		if (
			existing.codeSnippets.some(
				inline =>
					inline.filePath === snippet.filePath &&
					inline.startLine === snippet.startLine &&
					inline.endLine === snippet.endLine,
			)
		) {
			continue;
		}
		const ref = formatInlineSnippetReference(snippet);
		if (ref && !refs.includes(ref)) refs.push(ref);
	}
	if (refs.length === 0) return text;
	const trimmed = text.trim();
	return trimmed ? `${refs.join(' ')}\n\n${trimmed}` : refs.join(' ');
}
