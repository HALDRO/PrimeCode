import type { Part, ToolPart } from '@opencode-ai/sdk/v2/client';

const BINARY_FILE_EXTENSIONS = new Set([
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.bin',
	'.dat',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.bmp',
	'.ico',
	'.pdf',
	'.zip',
	'.gz',
	'.tar',
	'.7z',
	'.rar',
	'.jar',
	'.wasm',
	'.woff',
	'.woff2',
	'.ttf',
	'.otf',
	'.eot',
]);

function getToolMetadata(toolPart: ToolPart): Record<string, unknown> | undefined {
	return (toolPart.metadata ??
		('metadata' in toolPart.state
			? ((toolPart.state as { metadata?: Record<string, unknown> }).metadata ?? undefined)
			: undefined)) as Record<string, unknown> | undefined;
}

function compactSearchOutput(output: string): string {
	const lines = output.split(/\r?\n/);
	const kept: string[] = [];
	const seen = new Set<string>();
	let currentFile = '';

	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		if (/^Found \d+ matches/.test(trimmed) || /^\(.*truncated.*\)$/i.test(trimmed)) {
			kept.push(trimmed);
			continue;
		}
		if (/^.+:$/.test(trimmed) && !trimmed.startsWith('Line ')) {
			currentFile = trimmed.slice(0, -1);
			if (!seen.has(currentFile)) {
				seen.add(currentFile);
				kept.push(currentFile);
			}
			continue;
		}
		const lineMatch = trimmed.match(/^Line (\d+):/);
		if (lineMatch && currentFile) {
			const key = `${currentFile}:${lineMatch[1]}`;
			if (!seen.has(key)) {
				seen.add(key);
				kept.push(`${currentFile}:${lineMatch[1]}`);
			}
			continue;
		}
		if ((/[\\/]/.test(trimmed) || /\.\w{1,10}$/.test(trimmed)) && !seen.has(trimmed)) {
			seen.add(trimmed);
			kept.push(trimmed);
		}
	}

	return kept.join('\n');
}

function getFileExtension(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
	const dotIndex = fileName.lastIndexOf('.');
	return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function containsBinaryContent(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
			return true;
		}
	}
	return false;
}

function isBinaryFilePath(filePath: string): boolean {
	return BINARY_FILE_EXTENSIONS.has(getFileExtension(filePath));
}

function sanitizeApplyPatchMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...metadata };
	const rawFiles = Array.isArray(metadata.files) ? metadata.files : undefined;

	if (rawFiles) {
		next.files = rawFiles.map(file => {
			if (!file || typeof file !== 'object') return file;
			const record = file as Record<string, unknown>;
			const filePath =
				typeof record.filePath === 'string'
					? record.filePath
					: typeof record.relativePath === 'string'
						? record.relativePath
						: typeof record.path === 'string'
							? record.path
							: '';
			const patch = typeof record.patch === 'string' ? record.patch : '';
			const shouldDropPatch =
				(Boolean(filePath) && isBinaryFilePath(filePath)) || containsBinaryContent(patch);

			if (!shouldDropPatch) return file;

			const sanitized = { ...record };
			delete sanitized.patch;
			delete sanitized.oldContent;
			delete sanitized.newContent;
			sanitized.binary = true;
			return sanitized;
		});
	}

	if (typeof metadata.diff === 'string') {
		const diff = metadata.diff;
		if ((rawFiles && rawFiles.length > 0) || containsBinaryContent(diff)) {
			delete next.diff;
		}
	}

	return next;
}

export function sanitizePartForHistory(part: Part): Part {
	if (part.type !== 'tool') return part;

	const toolPart = part as ToolPart;
	const metadata = getToolMetadata(toolPart);
	const toolName = toolPart.tool.toLowerCase();

	if (toolName === 'read' || toolName === 'skill') {
		if (!('output' in toolPart.state)) return part;
		return {
			...toolPart,
			state: {
				...toolPart.state,
				output: '',
			},
		};
	}

	if (toolName === 'grep' || toolName === 'glob') {
		if (!('output' in toolPart.state) || typeof toolPart.state.output !== 'string') return part;
		return {
			...toolPart,
			state: {
				...toolPart.state,
				output: compactSearchOutput(toolPart.state.output),
			},
		};
	}

	if (toolName === 'apply_patch' && metadata) {
		const sanitizedMetadata = sanitizeApplyPatchMetadata(metadata);
		return {
			...toolPart,
			...(toolPart.metadata ? { metadata: sanitizedMetadata } : {}),
			state: {
				...toolPart.state,
				...('metadata' in toolPart.state ? { metadata: sanitizedMetadata } : {}),
			},
		};
	}

	const isTruncated = metadata?.truncated === true;
	const outputPath = typeof metadata?.outputPath === 'string' ? metadata.outputPath : undefined;
	if (!isTruncated || !outputPath || !('output' in toolPart.state)) return part;

	return {
		...toolPart,
		state: {
			...toolPart.state,
			output: '',
			...(metadata && 'metadata' in toolPart.state
				? {
						metadata: {
							...metadata,
							...(typeof metadata.output === 'string' ? { output: '' } : {}),
						},
					}
				: {}),
		},
	};
}
