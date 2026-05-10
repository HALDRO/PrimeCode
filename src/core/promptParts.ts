/**
 * @file Prompt request part builders for OpenCode message sends.
 * @description Converts plain text plus normalized attachments into SDK-ready prompt parts.
 * Generates stable metadata for optimistic rendering, preserves source references for files and
 * snippets, and defensively drops malformed attachment paths so pasted code or regex-like text
 * cannot be misclassified as a real file attachment and crash message sending.
 */
import type { Part } from '@opencode-ai/sdk/v2/client';
import {
	formatInlineFileReference,
	formatInlineSnippetReference,
	isLikelyInlineAttachmentPath,
} from '../common/inlineAttachments';
import { getPathBaseName, toFileUri } from '../utils/path';

export interface PromptAttachments {
	files?: string[];
	codeSnippets?: Array<{
		filePath: string;
		content?: string;
		startLine?: number;
		endLine?: number;
	}>;
	images?: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
}

type PromptTextPart = {
	id?: string;
	type: 'text';
	text: string;
	sessionID?: string;
	messageID?: string;
};

type PromptFilePart = {
	id?: string;
	type: 'file';
	mime: string;
	url: string;
	filename?: string;
	source?: {
		type: 'file';
		text: { value: string; start: number; end: number };
		path: string;
	};
	sessionID?: string;
	messageID?: string;
};

export type PromptRequestPart = PromptTextPart | PromptFilePart;

function toPromptFileUrl(filePath: string): string | null {
	if (!isLikelyInlineAttachmentPath(filePath)) return null;
	try {
		return toFileUri(filePath);
	} catch {
		return null;
	}
}

function lineQuery(filePath: string, startLine?: number, endLine?: number): string | null {
	const baseUrl = toPromptFileUrl(filePath);
	if (!baseUrl) return null;

	try {
		const url = new URL(baseUrl);
		if (startLine) url.searchParams.set('start', String(startLine));
		if (endLine) url.searchParams.set('end', String(endLine));
		return url.toString();
	} catch {
		return null;
	}
}

function sourceForReference(text: string, value: string, path: string): PromptFilePart['source'] {
	const start = text.indexOf(value);
	if (start < 0) return undefined;
	return {
		type: 'file',
		text: {
			value,
			start,
			end: start + value.length,
		},
		path,
	};
}

function normalizeSnippet(snippet: NonNullable<PromptAttachments['codeSnippets']>[number]): {
	filePath: string;
	startLine: number;
	endLine: number;
} {
	const startLine = Math.max(1, snippet.startLine ?? 1);
	return {
		filePath: snippet.filePath,
		startLine,
		endLine: Math.max(startLine, snippet.endLine ?? startLine),
	};
}

function dedupeStrings(values: string[]): string[] {
	return values.reduce<string[]>((deduped, value) => {
		if (!value || deduped.includes(value)) return deduped;
		deduped.push(value);
		return deduped;
	}, []);
}

function dedupeSnippets(
	snippets: Array<{ filePath: string; startLine: number; endLine: number }>,
): Array<{ filePath: string; startLine: number; endLine: number }> {
	const seen = new Set<string>();
	return snippets.filter(snippet => {
		const key = `${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function dedupeImages(
	images: NonNullable<PromptAttachments['images']>,
): NonNullable<PromptAttachments['images']> {
	const seen = new Set<string>();
	return images.filter(image => {
		const key = image.dataUrl || image.path || `${image.name}:${image.id}`;
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function buildPromptParts(input: {
	text: string;
	attachments?: PromptAttachments;
	sessionId?: string;
	messageId?: string;
}): PromptRequestPart[] {
	const files = dedupeStrings(input.attachments?.files ?? []);
	const codeSnippets = dedupeSnippets(
		(input.attachments?.codeSnippets ?? []).map(normalizeSnippet),
	);
	const images = dedupeImages(input.attachments?.images ?? []);
	const text = input.text;
	const withIds = Boolean(input.messageId && input.sessionId);
	const messageFields = input.sessionId
		? { sessionID: input.sessionId, ...(input.messageId ? { messageID: input.messageId } : {}) }
		: {};

	const parts: PromptRequestPart[] = [
		{
			...(withIds ? { id: `${input.messageId}-text` } : {}),
			type: 'text',
			text,
			...messageFields,
		},
	];

	for (let index = 0; index < files.length; index++) {
		const filePath = files[index];
		const url = toPromptFileUrl(filePath);
		if (!url) continue;
		const value = formatInlineFileReference(filePath, /[\\/]$/.test(filePath));
		const source = value ? sourceForReference(text, value, filePath) : undefined;
		parts.push({
			...(withIds ? { id: `${input.messageId}-file-${index}` } : {}),
			type: 'file',
			mime: 'text/plain',
			url,
			filename: getPathBaseName(filePath) || filePath,
			...(source ? { source } : {}),
			...messageFields,
		});
	}

	for (let index = 0; index < codeSnippets.length; index++) {
		const snippet = codeSnippets[index];
		const url = lineQuery(snippet.filePath, snippet.startLine, snippet.endLine);
		if (!url) continue;
		const value = formatInlineSnippetReference({
			filePath: snippet.filePath,
			startLine: snippet.startLine ?? 1,
			endLine: snippet.endLine ?? snippet.startLine ?? 1,
		});
		const source = value ? sourceForReference(text, value, snippet.filePath) : undefined;
		parts.push({
			...(withIds ? { id: `${input.messageId}-snippet-${index}` } : {}),
			type: 'file',
			mime: 'text/plain',
			url,
			filename: getPathBaseName(snippet.filePath) || snippet.filePath,
			...(source ? { source } : {}),
			...messageFields,
		});
	}

	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		const mime = image.dataUrl.match(/^data:([^;]+)/)?.[1] || 'image/png';
		parts.push({
			...(withIds ? { id: `${input.messageId}-image-${image.id || index}` } : {}),
			type: 'file',
			mime,
			url: image.dataUrl,
			filename: image.name,
			...messageFields,
		});
	}

	return parts;
}

export function buildOptimisticPromptParts(input: {
	text: string;
	attachments?: PromptAttachments;
	sessionId: string;
	messageId: string;
}): Part[] {
	return buildPromptParts(input) as Part[];
}
