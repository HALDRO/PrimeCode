const CODE_KEYWORDS = /^(import|export|from|require|const|let|var|function|class|interface|type)\b/;
const LINE_SUFFIX = /:(\d+)(?:-(\d+))?$/;
const EXTENSION_SUFFIX = /\.([a-zA-Z][a-zA-Z\d]{0,9})$/;
const FILE_URI_PREFIX = 'file://';

const FILE_PATH_SOURCE =
	'(?:' +
	String.raw`(?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|[/\\])[\w.@-]+(?:[/\\][\w.@-]+)*` +
	String.raw`|[\w.@-]+(?:[/\\][\w.@-]+)+` +
	String.raw`|[\w.@-]+\.[a-zA-Z][a-zA-Z\d]{0,9}` +
	')';

const FILE_REFERENCE_IN_TEXT = new RegExp(
	String.raw`(?:${FILE_PATH_SOURCE}|file:\/\/[^\s)\],;!?'"\x60]+)(?::(\d+)(?:-(\d+))?)?(?=[)\]\s,;!?'"\x60]|$)`,
	'g',
);

const EXACT_FILE_REFERENCE = new RegExp(
	String.raw`^(?:${FILE_PATH_SOURCE}|file:\/\/\S+?)(?::(\d+)(?:-(\d+))?)?$`,
);

const BARE_FILENAME_EXTENSIONS = new Set([
	'c',
	'cc',
	'cpp',
	'cs',
	'css',
	'go',
	'h',
	'hpp',
	'html',
	'java',
	'js',
	'json',
	'jsx',
	'kt',
	'less',
	'lua',
	'md',
	'mjs',
	'php',
	'ps1',
	'py',
	'rb',
	'rs',
	'sass',
	'scss',
	'sh',
	'sql',
	'swift',
	'toml',
	'ts',
	'tsx',
	'txt',
	'xml',
	'yaml',
	'yml',
	'zsh',
]);

export interface ParsedPathReference {
	filePath: string;
	line?: number;
	startLine?: number;
	endLine?: number;
	rawText: string;
}

export interface PathReferenceMatch extends ParsedPathReference {
	index: number;
}

const hasPathSeparators = (value: string) => /[/\\]/.test(value);

const isExplicitPath = (value: string) =>
	value.startsWith('.') ||
	value.startsWith('/') ||
	value.startsWith('\\') ||
	/^[a-zA-Z]:[/\\]/.test(value);

const parseLineData = (rawText: string) => {
	const match = rawText.match(LINE_SUFFIX);
	if (!match) {
		return { filePath: rawText, hasLineInfo: false as const };
	}

	const startLine = Number.parseInt(match[1], 10);
	const endLine = match[2] ? Number.parseInt(match[2], 10) : undefined;

	return {
		filePath: rawText.slice(0, match.index),
		startLine,
		endLine,
		hasLineInfo: true as const,
	};
};

const hasAlpha = (value: string) => /[a-zA-Z]/.test(value);

const isBareFilenameAllowed = (filePath: string, hasLineInfo: boolean): boolean => {
	const extensionMatch = filePath.match(EXTENSION_SUFFIX);
	if (!extensionMatch) return false;

	const extension = extensionMatch[1].toLowerCase();
	const basename = filePath.slice(0, -extensionMatch[0].length);
	if (!hasAlpha(basename)) return false;

	if (hasLineInfo) return true;
	return BARE_FILENAME_EXTENSIONS.has(extension);
};

const buildParsedReference = (
	filePath: string,
	rawText: string,
	startLine?: number,
	endLine?: number,
): ParsedPathReference => {
	if (startLine === undefined) {
		return { filePath, rawText };
	}

	if (endLine !== undefined && endLine >= startLine) {
		return { filePath, startLine, endLine, rawText };
	}

	return { filePath, line: startLine, startLine, endLine: startLine, rawText };
};

const parseReference = (rawText: string): ParsedPathReference | null => {
	const text = rawText.trim();
	if (!text || text.includes(' ') || text.length > 160) return null;
	if (CODE_KEYWORDS.test(text)) return null;
	if (!EXACT_FILE_REFERENCE.test(text)) return null;

	const lineData = parseLineData(text);
	if (lineData.filePath.startsWith(FILE_URI_PREFIX)) {
		const uriExtension = lineData.filePath.match(EXTENSION_SUFFIX);
		if (!uriExtension) return null;
		return buildParsedReference(
			lineData.filePath,
			text,
			lineData.hasLineInfo ? lineData.startLine : undefined,
			lineData.hasLineInfo ? lineData.endLine : undefined,
		);
	}

	const extensionMatch = lineData.filePath.match(EXTENSION_SUFFIX);
	if (!extensionMatch) return null;

	const allowed =
		hasPathSeparators(lineData.filePath) || isExplicitPath(lineData.filePath)
			? true
			: isBareFilenameAllowed(lineData.filePath, lineData.hasLineInfo);
	if (!allowed) return null;

	return buildParsedReference(
		lineData.filePath,
		text,
		lineData.hasLineInfo ? lineData.startLine : undefined,
		lineData.hasLineInfo ? lineData.endLine : undefined,
	);
};

export const parsePathReferenceToken = (value: string): ParsedPathReference | null =>
	parseReference(value);

export const findPathReferences = (text: string): PathReferenceMatch[] => {
	const matches: PathReferenceMatch[] = [];

	for (const match of text.matchAll(FILE_REFERENCE_IN_TEXT)) {
		const rawText = match[0];
		const parsed = parseReference(rawText);
		if (!parsed) continue;

		const prevChar = match.index && match.index > 0 ? text[match.index - 1] : '';
		if (prevChar && /[\w./-]/.test(prevChar)) continue;

		matches.push({
			...parsed,
			index: match.index ?? 0,
		});
	}

	return matches;
};
