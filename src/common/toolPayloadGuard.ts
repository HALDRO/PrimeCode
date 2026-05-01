import { resolveToolName } from './toolRegistry';

const APPLY_PATCH_DIFF_LIMIT = 16_384;
const APPLY_PATCH_FILE_PATCH_LIMIT = 8_192;
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

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
	return typeof value === 'object' && value !== null;
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

function truncateString(value: string, limit: number, label: string): string {
	if (value.length <= limit) return value;
	const truncated = value.slice(0, limit);
	return `${truncated}\n\n[primecode truncated ${label}: ${value.length} chars]`;
}

function sanitizeApplyPatchMetadata(metadata: unknown): { value: unknown; changed: boolean } {
	if (!isRecord(metadata)) {
		return { value: metadata, changed: false };
	}

	let changed = false;
	const next: AnyRecord = { ...metadata };

	if (typeof next.diff === 'string') {
		const truncated = truncateString(next.diff, APPLY_PATCH_DIFF_LIMIT, 'diff');
		if (truncated !== next.diff) {
			next.diff = truncated;
			changed = true;
		}
	}

	if (Array.isArray(next.files)) {
		const files = next.files.map(file => {
			if (!isRecord(file)) return file;
			const filePath =
				typeof file.filePath === 'string'
					? file.filePath
					: typeof file.relativePath === 'string'
						? file.relativePath
						: typeof file.path === 'string'
							? file.path
							: '';
			const patch = typeof file.patch === 'string' ? file.patch : '';
			const shouldDropPatch =
				(Boolean(filePath) && isBinaryFilePath(filePath)) || containsBinaryContent(patch);

			if (shouldDropPatch) {
				changed = true;
				const sanitized = { ...file };
				delete sanitized.patch;
				delete sanitized.oldContent;
				delete sanitized.newContent;
				sanitized.binary = true;
				return sanitized;
			}

			if (!patch) return file;

			const truncatedPatch = truncateString(patch, APPLY_PATCH_FILE_PATCH_LIMIT, 'patch');
			if (truncatedPatch === patch) return file;

			changed = true;
			return {
				...file,
				patch: truncatedPatch,
			};
		});

		if (changed) {
			next.files = files;
		}
	}

	if (typeof metadata.diff === 'string') {
		const diff = metadata.diff;
		const hasFiles = Array.isArray(metadata.files) && metadata.files.length > 0;
		if (hasFiles || containsBinaryContent(diff)) {
			delete next.diff;
			changed = true;
		} else {
			const truncated = truncateString(diff, APPLY_PATCH_DIFF_LIMIT, 'diff');
			if (truncated !== diff) {
				next.diff = truncated;
				changed = true;
			}
		}
	}

	if (!changed) {
		return { value: metadata, changed: false };
	}

	return {
		value: {
			...next,
			truncated: true,
		},
		changed: true,
	};
}

export function sanitizeToolPartForUi<T>(part: T): T {
	if (!isRecord(part) || part.type !== 'tool' || typeof part.tool !== 'string') {
		return part;
	}

	const toolName = resolveToolName(part.tool) ?? part.tool;
	const state = isRecord(part.state) ? part.state : undefined;
	if (!state) {
		return part;
	}

	if (toolName === 'read' || toolName === 'skill') {
		if (!('output' in state) || typeof state.output !== 'string' || state.output.length === 0) {
			return part;
		}
		return {
			...part,
			state: {
				...state,
				output: '',
			},
		} as T;
	}

	if (toolName === 'grep' || toolName === 'glob') {
		if (!('output' in state) || typeof state.output !== 'string') {
			return part;
		}
		const compacted = compactSearchOutput(state.output);
		if (compacted === state.output) {
			return part;
		}
		return {
			...part,
			state: {
				...state,
				output: compacted,
			},
		} as T;
	}

	if (toolName !== 'apply_patch') {
		const metadata = (part.metadata ??
			('metadata' in state
				? ((state as { metadata?: Record<string, unknown> }).metadata ?? undefined)
				: undefined)) as Record<string, unknown> | undefined;
		const isTruncated = metadata?.truncated === true;
		const outputPath = typeof metadata?.outputPath === 'string' ? metadata.outputPath : undefined;
		if (!isTruncated || !outputPath || !('output' in state) || typeof state.output !== 'string') {
			return part;
		}

		return {
			...part,
			state: {
				...state,
				output: '',
				...(metadata && 'metadata' in state
					? {
							metadata: {
								...metadata,
								...(typeof metadata.output === 'string' ? { output: '' } : {}),
							},
						}
					: {}),
			},
		} as T;
	}

	const partMetadata = sanitizeApplyPatchMetadata('metadata' in part ? part.metadata : undefined);
	const stateMetadata = sanitizeApplyPatchMetadata(state.metadata);

	if (!partMetadata.changed && !stateMetadata.changed) {
		return part;
	}

	return {
		...part,
		...(partMetadata.changed ? { metadata: partMetadata.value } : {}),
		...(state && stateMetadata.changed
			? {
					state: {
						...state,
						metadata: stateMetadata.value,
					},
				}
			: {}),
	} as T;
}
