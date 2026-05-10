/**
 * @file Markdown renderer with syntax highlighting
 * @description Unified design system with minimal, consistent tokens.
 *              Contains optimized StreamableNode for suffix-only stream animations.
 */

import hljs from 'highlight.js';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Стабильный массив плагинов. Мы больше не меняем его на лету!
// (Именно смена плагинов вызывала 100% перерисовку и моргание в конце)
const REMARK_PLUGINS = [remarkGfm];

import { CheckIcon, CopyIcon } from '../components/icons';
import { IconButton, PathChip } from '../components/ui';
import { cn } from '../lib/cn';
import { copyTextToClipboard } from './clipboard';
import {
	findPathReferences,
	type ParsedPathReference,
	parsePathReferenceToken,
} from './pathReferences';
import { vscode } from './vscode';

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

interface MarkdownProps {
	content: string;
	className?: string;
	isStreaming?: boolean;
}

// ----------------------------------------------------------------------
// Streaming Context — exposes only the newly appended suffix boundary
// so remounted older markdown nodes do not animate again.
// ----------------------------------------------------------------------

const StreamingContext = createContext<{
	isStreaming: boolean;
	animateFromOffset: number;
}>({
	isStreaming: false,
	animateFromOffset: Number.POSITIVE_INFINITY,
});

// ----------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------

const URL_IN_TEXT = /https?:\/\/[^\s)<\]}"']+/gi;
const EXACT_EXTERNAL_URL = /^https?:\/\/[^\s)<\]}"']+$/i;
const MAX_INLINE_REFERENCE_SCAN_LENGTH = 4000;
const MAX_HIGHLIGHT_CODE_LENGTH = 20000;

const inlineReferenceCache = new Map<string, React.ReactNode[]>();

const mayContainInlineReferences = (text: string): boolean => {
	if (!text || text.length > MAX_INLINE_REFERENCE_SCAN_LENGTH) return false;
	return (
		text.includes('http://') ||
		text.includes('https://') ||
		text.includes('file://') ||
		text.includes('/') ||
		text.includes('\\') ||
		/\.[a-zA-Z]{1,10}(?::\d+(?:-\d+)?)?/.test(text)
	);
};

const openExternalLink = (url: string) => {
	vscode.postMessage({ type: 'openExternal', url });
};

const openPathReference = (reference: ParsedPathReference) => {
	vscode.postMessage({
		type: 'openFile',
		filePath: reference.filePath,
		...(reference.line !== undefined ? { line: reference.line } : {}),
		...(reference.startLine !== undefined ? { startLine: reference.startLine } : {}),
		...(reference.endLine !== undefined ? { endLine: reference.endLine } : {}),
	});
};

const renderExternalLink = (url: string, key: string, className?: string) => (
	<a
		key={key}
		href={url}
		onClick={event => {
			event.preventDefault();
			event.stopPropagation();
			openExternalLink(url);
		}}
		className={cn(
			'text-vscode-textLink-foreground underline decoration-vscode-textLink-foreground/60 underline-offset-3',
			'transition-colors hover:text-vscode-textLink-activeForeground hover:decoration-vscode-textLink-activeForeground',
			'focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
			className,
		)}
		target="_blank"
		rel="noopener noreferrer"
		title={url}
	>
		{url}
	</a>
);

const renderPathReferenceChip = (reference: ParsedPathReference, key: string) => (
	<PathChip
		key={key}
		path={reference.filePath}
		line={reference.line}
		startLine={reference.startLine}
		endLine={reference.endLine}
		title={reference.rawText}
		className="relative z-[1] translate-y-[1px] align-text-bottom [.inline-code_&]:bg-[var(--surface-base)]"
		onClick={() => openPathReference(reference)}
	/>
);

type InlineReferenceMatch =
	| { type: 'externalUrl'; index: number; rawText: string; url: string }
	| ({ type: 'pathReference' } & ReturnType<typeof findPathReferences>[number]);

const collectInlineReferenceMatches = (text: string): InlineReferenceMatch[] => {
	const matches: InlineReferenceMatch[] = [];

	for (const match of text.matchAll(URL_IN_TEXT)) {
		matches.push({
			type: 'externalUrl',
			index: match.index ?? 0,
			rawText: match[0],
			url: match[0],
		});
	}

	const urlRanges = matches.map(match => ({
		start: match.index,
		end: match.index + match.rawText.length,
	}));

	for (const match of findPathReferences(text)) {
		const isInsideUrl = urlRanges.some(
			range => match.index >= range.start && match.index < range.end,
		);
		if (!isInsideUrl) {
			matches.push({ type: 'pathReference', ...match });
		}
	}

	return matches.sort((left, right) => left.index - right.index);
};

const renderInlineReferences = (text: string): React.ReactNode[] => {
	if (!mayContainInlineReferences(text)) return [text];

	const cached = inlineReferenceCache.get(text);
	if (cached) return cached;

	const parts: React.ReactNode[] = [];
	let lastIndex = 0;
	const matches = collectInlineReferenceMatches(text);

	for (const match of matches) {
		const matchStart = match.index;
		const fullMatch = match.rawText;

		if (matchStart > lastIndex) {
			parts.push(text.slice(lastIndex, matchStart));
		}

		if (match.type === 'externalUrl') {
			parts.push(renderExternalLink(match.url, `url-${matchStart}`));
		} else {
			parts.push(renderPathReferenceChip(match, `path-ref-${matchStart}`));
		}

		lastIndex = matchStart + fullMatch.length;
	}

	if (lastIndex === 0) {
		inlineReferenceCache.set(text, [text]);
		return [text];
	}
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}
	inlineReferenceCache.set(text, parts);
	if (inlineReferenceCache.size > 200) {
		const firstKey = inlineReferenceCache.keys().next().value;
		if (firstKey) inlineReferenceCache.delete(firstKey);
	}
	return parts;
};

const getInlinePartLength = (part: React.ReactNode): number => {
	if (typeof part === 'string') return part.length;
	if (
		React.isValidElement(part) &&
		part.props &&
		typeof part.props === 'object' &&
		'title' in part.props
	) {
		return String(part.props.title ?? '').length;
	}
	return 10;
};

const renderStreamingTextPart = (
	text: string,
	startOffset: number,
	animateFromOffset: number,
): React.ReactNode[] => {
	const words = text.split(/(\s+)/);
	let charOffset = startOffset;
	return words.map(word => {
		const wordStartOffset = charOffset;
		charOffset += word.length;
		const wordEndOffset = charOffset;
		if (word.trim().length === 0) return word;

		const wordKey = `w-${wordStartOffset}-${word.length}`;
		const isNew = wordEndOffset > animateFromOffset;

		return (
			<span key={wordKey} className={isNew ? 'stream-word stream-word-new' : 'stream-word'}>
				{word}
			</span>
		);
	});
};

const renderStaticTextContent = (
	content: string,
	renderInlineReferencesEnabled: boolean,
): React.ReactNode[] =>
	renderInlineReferencesEnabled ? renderInlineReferences(content) : [content];

const renderStreamingTextContent = (
	content: string,
	animateFromOffset: number,
	renderInlineReferencesEnabled: boolean,
): React.ReactNode[] => {
	const linked = renderInlineReferencesEnabled ? renderInlineReferences(content) : [content];
	let partOffset = 0;

	return linked.map(part => {
		const currentPartOffset = partOffset;
		if (typeof part === 'string') {
			partOffset += part.length;
			return renderStreamingTextPart(part, currentPartOffset, animateFromOffset);
		}

		partOffset += getInlinePartLength(part);
		return part;
	});
};

// ----------------------------------------------------------------------
// Universal text node renderer with explicit static/streaming paths
// ----------------------------------------------------------------------

const StaticTextNode: React.FC<{
	content: string;
	renderInlineReferencesEnabled: boolean;
}> = ({ content, renderInlineReferencesEnabled }) => (
	<>{renderStaticTextContent(content, renderInlineReferencesEnabled)}</>
);

const StreamingTextNode: React.FC<{
	content: string;
	animateFromOffset: number;
	renderInlineReferencesEnabled: boolean;
}> = ({ content, animateFromOffset, renderInlineReferencesEnabled }) => (
	<>{renderStreamingTextContent(content, animateFromOffset, renderInlineReferencesEnabled)}</>
);

const StreamableNode: React.FC<{
	node: React.ReactNode;
	index?: number;
	renderInlineReferencesEnabled?: boolean;
}> = ({ node, index = 0, renderInlineReferencesEnabled = true }) => {
	const { isStreaming, animateFromOffset } = useContext(StreamingContext);

	if (typeof node === 'string') {
		return isStreaming ? (
			<StreamingTextNode
				content={node}
				animateFromOffset={animateFromOffset}
				renderInlineReferencesEnabled={renderInlineReferencesEnabled}
			/>
		) : (
			<StaticTextNode
				content={node}
				renderInlineReferencesEnabled={renderInlineReferencesEnabled}
			/>
		);
	}
	if (Array.isArray(node)) {
		return (
			<>
				{node.map((child, childIdx) => {
					// Build a stable key from child content rather than array index
					const childKey =
						typeof child === 'string'
							? `sn-${index}-str-${childIdx}-${child.length}-${child.slice(0, 8)}`
							: `sn-${index}-node-${childIdx}`;
					return (
						<StreamableNode
							key={childKey}
							node={child}
							index={childIdx}
							renderInlineReferencesEnabled={renderInlineReferencesEnabled}
						/>
					);
				})}
			</>
		);
	}
	return <>{node}</>;
};

// ----------------------------------------------------------------------
// Helper Components
// ----------------------------------------------------------------------

const CopyButton: React.FC<{ code: string; className?: string }> = ({ code, className }) => {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	const handleCopy = async () => {
		try {
			await copyTextToClipboard(code);
			setCopied(true);
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
		} catch {
			// Clipboard API unavailable in some contexts
		}
	};

	return (
		<IconButton
			icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
			onClick={handleCopy}
			title={copied ? 'Copied!' : 'Copy'}
			aria-label={copied ? 'Copied' : 'Copy code'}
			size={20}
			className={cn(copied && 'text-success', className)}
		/>
	);
};

const getTextContent = (children: React.ReactNode): string => {
	if (typeof children === 'string') return children;
	if (typeof children === 'number') return String(children);
	if (Array.isArray(children)) return children.map(getTextContent).join('');
	if (children && typeof children === 'object' && 'props' in (children as React.ReactElement)) {
		return getTextContent(
			(children as React.ReactElement<{ children?: React.ReactNode }>).props.children,
		);
	}
	return '';
};

const LANG_DISPLAY: Record<string, string> = {
	typescript: 'TS',
	javascript: 'JS',
	python: 'Python',
	bash: 'Terminal',
	sh: 'Terminal',
	json: 'JSON',
	html: 'HTML',
	css: 'CSS',
	yaml: 'YAML',
	sql: 'SQL',
	rust: 'Rust',
	go: 'Go',
};

const getLangDisplay = (lang: string) => LANG_DISPLAY[lang] || lang.toUpperCase();

const normalizeLanguage = (language: string): string | null => {
	const normalized = language.trim().toLowerCase();
	if (!normalized || normalized === 'plaintext' || normalized === 'text') return null;
	return hljs.getLanguage(normalized) ? normalized : null;
};

// ----------------------------------------------------------------------
// Highlighted Code Block — isolated component so hooks are at top level
// and innerHTML is set via ref instead of dangerouslySetInnerHTML
// ----------------------------------------------------------------------

const HighlightedCodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => {
	const codeRef = useRef<HTMLElement>(null);
	const normalizedLanguage = useMemo(() => normalizeLanguage(language), [language]);

	const highlightedHtml = useMemo(() => {
		try {
			if (!normalizedLanguage || code.length > MAX_HIGHLIGHT_CODE_LENGTH) {
				return null;
			}
			return hljs.highlight(code, { language: normalizedLanguage }).value;
		} catch {
			return null;
		}
	}, [code, normalizedLanguage]);

	useEffect(() => {
		if (!codeRef.current) return;

		if (highlightedHtml !== null) {
			codeRef.current.innerHTML = highlightedHtml;
			return;
		}

		codeRef.current.textContent = code;
	}, [code, highlightedHtml]);

	return (
		<div className="group/codeblock isolate relative my-2 rounded-lg border border-(--tool-border-color) overflow-hidden bg-(--tool-bg-header)">
			<div className="absolute right-0 top-0 z-1 flex items-center gap-1 p-1 opacity-0 group-hover/codeblock:opacity-100 transition-opacity bg-(--tool-bg-header) rounded-bl">
				<span className="text-xs font-mono text-vscode-descriptionForeground/50 pointer-events-none select-none">
					{getLangDisplay(normalizedLanguage ?? (language || 'text'))}
				</span>
				<CopyButton code={code} />
			</div>
			<div className="overflow-x-auto">
				<code
					ref={codeRef}
					className={cn(
						'block p-(--tool-content-padding) font-mono text-md leading-(--line-height-code) whitespace-pre hljs',
						'text-vscode-editor-foreground bg-(--tool-bg-header) w-fit min-w-full',
					)}
				>
					{highlightedHtml === null ? code : undefined}
				</code>
			</div>
		</div>
	);
};

// ----------------------------------------------------------------------
// Markdown Components
// ----------------------------------------------------------------------

const components: Components = {
	a: ({ href, children }) => {
		const safeHref = typeof href === 'string' ? href.trim() : '';
		const isExternal = /^https?:\/\//i.test(safeHref);
		const pathReference = parsePathReferenceToken(safeHref);

		if (!safeHref) {
			return <StreamableNode node={children} renderInlineReferencesEnabled={false} />;
		}

		if (pathReference) {
			return renderPathReferenceChip(pathReference, `link-path-ref-${safeHref}`);
		}

		return (
			<a
				href={safeHref}
				onClick={event => {
					if (!isExternal) return;
					event.preventDefault();
					event.stopPropagation();
					openExternalLink(safeHref);
				}}
				className={cn(
					'rounded-sm text-vscode-textLink-foreground underline decoration-vscode-textLink-foreground/60 underline-offset-3',
					'transition-colors hover:text-vscode-textLink-activeForeground hover:decoration-vscode-textLink-activeForeground',
					'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-offset-1 focus-visible:ring-offset-transparent',
				)}
				target={isExternal ? '_blank' : undefined}
				rel={isExternal ? 'noopener noreferrer' : undefined}
				title={safeHref}
			>
				<StreamableNode node={children} renderInlineReferencesEnabled={false} />
			</a>
		);
	},
	p: ({ children }) => (
		<p>
			<StreamableNode node={children} />
		</p>
	),
	li: ({ children }) => (
		<li>
			<StreamableNode node={children} />
		</li>
	),
	strong: ({ children }) => (
		<strong>
			<StreamableNode node={children} />
		</strong>
	),
	em: ({ children }) => (
		<em>
			<StreamableNode node={children} />
		</em>
	),
	h1: ({ children }) => (
		<h1>
			<StreamableNode node={children} />
		</h1>
	),
	h2: ({ children }) => (
		<h2>
			<StreamableNode node={children} />
		</h2>
	),
	h3: ({ children }) => (
		<h3>
			<StreamableNode node={children} />
		</h3>
	),
	h4: ({ children }) => (
		<h4>
			<StreamableNode node={children} />
		</h4>
	),
	h5: ({ children }) => (
		<h5>
			<StreamableNode node={children} />
		</h5>
	),
	h6: ({ children }) => (
		<h6>
			<StreamableNode node={children} />
		</h6>
	),

	pre: ({ children }) => <>{children}</>,

	code: ({ className, children, ...props }) => {
		const match = /language-(\w+)/.exec(className || '');
		const codeContent = getTextContent(children);
		const isMultiline = codeContent.includes('\n');
		const isCodeBlock = match || className?.includes('hljs') || isMultiline;

		if (isCodeBlock) {
			const language = match ? match[1] : 'plaintext';
			return <HighlightedCodeBlock code={codeContent} language={language} />;
		}

		const pathReference = parsePathReferenceToken(codeContent);
		if (pathReference) {
			return renderPathReferenceChip(pathReference, `inline-path-ref-${pathReference.rawText}`);
		}

		if (EXACT_EXTERNAL_URL.test(codeContent.trim())) {
			return renderExternalLink(codeContent.trim(), `inline-url-${codeContent.trim()}`);
		}

		return (
			<code
				className="inline-code px-1 py-px mx-0.5 rounded-sm bg-(--alpha-10) text-md font-mono"
				{...props}
			>
				<StreamableNode node={children} />
			</code>
		);
	},

	img: ({ src, alt }) => (
		<img
			src={src}
			alt={alt || 'Image'}
			className="my-2 max-w-full h-auto rounded border border-vscode-panel-border"
			loading="lazy"
		/>
	),
	table: ({ children }) => (
		<div className="my-2 overflow-hidden rounded-lg border border-(--tool-border-color) bg-(--tool-bg-header)">
			<table className="w-full text-md border-collapse">{children}</table>
		</div>
	),
	thead: ({ children }) => (
		<thead className="bg-(--tool-bg-header) text-vscode-editor-foreground font-medium border-b border-(--border-subtle)">
			{children}
		</thead>
	),
	tbody: ({ children }) => (
		<tbody className="text-vscode-editor-foreground/90 bg-(--tool-bg-header)">{children}</tbody>
	),
	tr: ({ children }) => (
		<tr className="border-b border-(--border-subtle) last:border-b-0 hover:bg-(--alpha-5) transition-colors">
			{children}
		</tr>
	),
	th: ({ children }) => (
		<th className="align-top px-(--tool-content-padding) py-1.5 text-left font-semibold text-sm text-vscode-editor-foreground border-r border-(--border-subtle) last:border-r-0">
			<StreamableNode node={children} />
		</th>
	),
	td: ({ children }) => (
		<td className="align-top px-(--tool-content-padding) py-1.5 text-md border-r border-(--border-subtle) last:border-r-0 break-words">
			<StreamableNode node={children} />
		</td>
	),
};

const COPY_FEEDBACK_MS = 2000;

function useStreamingSuffixBoundary(content: string, isStreaming: boolean): number {
	const previousContentRef = useRef(content);
	const previousContent = previousContentRef.current;
	const animateFromOffset = !isStreaming
		? Number.POSITIVE_INFINITY
		: content.startsWith(previousContent)
			? previousContent.length
			: content.length;
	previousContentRef.current = content;
	return animateFromOffset;
}

// ----------------------------------------------------------------------
// Preprocessing
// ----------------------------------------------------------------------

const preprocessContent = (content: string): string => {
	const codeBlockMatches = content.match(/```/g);
	const count = codeBlockMatches ? codeBlockMatches.length : 0;
	if (count % 2 !== 0) {
		return `${content}\n\`\`\``;
	}
	return content;
};

// ----------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------

export const Markdown: React.FC<MarkdownProps> = React.memo(
	({ content, className, isStreaming }) => {
		const animateFromOffset = useStreamingSuffixBoundary(content, !!isStreaming);
		const processedContent = useMemo(() => preprocessContent(content), [content]);
		const streamingCtx = useMemo(
			() => ({ isStreaming: !!isStreaming, animateFromOffset }),
			[animateFromOffset, isStreaming],
		);

		return (
			<StreamingContext.Provider value={streamingCtx}>
				<div className={cn('markdown-body', isStreaming && 'streaming', className)}>
					<ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
						{processedContent}
					</ReactMarkdown>
				</div>
			</StreamingContext.Provider>
		);
	},
	(prevProps, nextProps) =>
		prevProps.content === nextProps.content &&
		prevProps.className === nextProps.className &&
		prevProps.isStreaming === nextProps.isStreaming,
);
