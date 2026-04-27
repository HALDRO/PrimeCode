import type { Part } from '@opencode-ai/sdk/v2/client';
import {
	extractInlineAttachmentPayload,
	formatInlineFileReference,
	formatInlineSnippetReference,
	prependInlineAttachmentReferences,
} from '../../common/inlineAttachments';

export interface ReconstructedCodeSnippet {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

export interface ReconstructedImage {
	id: string;
	name: string;
	dataUrl: string;
	path?: string;
}

export interface ReconstructedPrompt {
	text: string;
	files: string[];
	codeSnippets: ReconstructedCodeSnippet[];
	images: ReconstructedImage[];
}

export function getPrimaryUserText(parts: Part[] | undefined): string {
	if (!parts || parts.length === 0) return '';

	const textParts = parts.filter(
		(part): part is Part & { text: string; synthetic?: boolean; ignored?: boolean } =>
			part.type === 'text' &&
			'text' in part &&
			!(part as { synthetic?: boolean }).synthetic &&
			!(part as { ignored?: boolean }).ignored,
	);
	if (textParts.length === 0) return '';

	return textParts.reduce((best, part) => (part.text.length > best.text.length ? part : best)).text;
}

interface TextSource {
	value: string;
	start: number;
	end: number;
}

interface FileSource {
	text?: TextSource;
	path?: string;
}

function appendUnique<T>(items: T[], next: T, isSame: (left: T, right: T) => boolean): void {
	if (items.some(item => isSame(item, next))) return;
	items.push(next);
}

function ensureInlineReferences(
	text: string,
	files: string[],
	codeSnippets: ReconstructedCodeSnippet[],
): string {
	if (extractInlineAttachmentPayload(text).matches.length === 0) {
		return prependInlineAttachmentReferences(text, files, codeSnippets);
	}

	const payload = extractInlineAttachmentPayload(text);
	const missingFiles = files.filter(filePath => !payload.files.includes(filePath));
	const missingSnippets = codeSnippets.filter(
		snippet =>
			!payload.codeSnippets.some(
				inline =>
					inline.filePath === snippet.filePath &&
					inline.startLine === snippet.startLine &&
					inline.endLine === snippet.endLine,
			),
	);
	const refs = [
		...missingFiles.map(filePath => formatInlineFileReference(filePath)).filter(Boolean),
		...missingSnippets.map(snippet => formatInlineSnippetReference(snippet)).filter(Boolean),
	];
	if (refs.length === 0) return text;
	const trimmed = text.trim();
	return trimmed ? `${refs.join(' ')}\n\n${trimmed}` : refs.join(' ');
}

function parseFileUrl(url: string): { path: string; startLine?: number; endLine?: number } | null {
	try {
		if (url.startsWith('data:')) return null;
		const parsed = new URL(url);
		const pathname = parsed.pathname || '';
		const decodedPath = decodeURIComponent(pathname.replace(/^\//, ''));
		const normalizedPath = /^[A-Za-z]:/.test(decodedPath)
			? decodedPath
			: `${parsed.hostname}${decodedPath ? `/${decodedPath}` : ''}`;
		const startRaw = parsed.searchParams.get('start');
		const endRaw = parsed.searchParams.get('end');
		const startLine = startRaw ? Number(startRaw) : undefined;
		const endLine = endRaw ? Number(endRaw) : undefined;
		return {
			path: normalizedPath.replace(/\//g, '\\'),
			startLine: Number.isFinite(startLine) ? startLine : undefined,
			endLine: Number.isFinite(endLine) ? endLine : undefined,
		};
	} catch {
		return null;
	}
}

export function extractPromptFromParts(parts: Part[] | undefined): ReconstructedPrompt {
	if (!parts || parts.length === 0) {
		return { text: '', files: [], codeSnippets: [], images: [] };
	}

	const text = getPrimaryUserText(parts);

	const files: string[] = [];
	const codeSnippets: ReconstructedCodeSnippet[] = [];
	const images: ReconstructedImage[] = [];

	for (const part of parts) {
		if (part.type !== 'file') continue;
		const filePart = part as Part & {
			url?: string;
			filename?: string;
			mime?: string;
			source?: FileSource;
		};
		if (!filePart.url) continue;

		if (filePart.url.startsWith('data:')) {
			images.push({
				id: part.id,
				name: filePart.filename ?? 'image',
				dataUrl: filePart.url,
			});
			continue;
		}

		const parsed = parseFileUrl(filePart.url);
		if (!parsed?.path) continue;
		const sourceText = filePart.source?.text;
		const sourcePath = filePart.source?.path;
		const displayPath = sourcePath ?? parsed.path;
		const hasSelection = typeof parsed.startLine === 'number' || typeof parsed.endLine === 'number';

		if (sourceText && hasSelection) {
			appendUnique(
				codeSnippets,
				{
					filePath: displayPath,
					startLine: parsed.startLine ?? 1,
					endLine: parsed.endLine ?? parsed.startLine ?? 1,
					content: sourceText.value,
				},
				(left, right) =>
					left.filePath === right.filePath &&
					left.startLine === right.startLine &&
					left.endLine === right.endLine,
			);
			continue;
		}

		if (sourceText) {
			appendUnique(files, displayPath, (left, right) => left === right);
			continue;
		}

		if (hasSelection) {
			appendUnique(
				codeSnippets,
				{
					filePath: displayPath,
					startLine: parsed.startLine ?? 1,
					endLine: parsed.endLine ?? parsed.startLine ?? 1,
					content: '',
				},
				(left, right) =>
					left.filePath === right.filePath &&
					left.startLine === right.startLine &&
					left.endLine === right.endLine,
			);
			continue;
		}

		appendUnique(files, displayPath, (left, right) => left === right);
	}

	return {
		text: ensureInlineReferences(text, files, codeSnippets),
		files,
		codeSnippets,
		images,
	};
}
