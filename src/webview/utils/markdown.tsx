/**
 * @file Markdown renderer with syntax highlighting
 * @description Standard markdown renderer using react-markdown with rehype-highlight.
 *              Uses plain CSS for styling instead of fighting Tailwind prose plugin.
 *              Code blocks have language badges, copy button, and horizontal scroll.
 *              Inline code that looks like file paths becomes clickable.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

// Stable plugin arrays — prevents ReactMarkdown from re-initializing on every render
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS_FULL = [rehypeHighlight];
const REHYPE_PLUGINS_STREAMING: typeof REHYPE_PLUGINS_FULL = [];

import { CheckIcon, CopyIcon } from '../components/icons';
import { IconButton, PathChip } from '../components/ui';
import { cn } from '../lib/cn';
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
// Helper Functions
// ----------------------------------------------------------------------

const FILE_EXTENSIONS =
	/\.(tsx?|jsx?|json|md|css|scss|less|html|xml|yaml|yml|toml|ini|conf|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|sql|graphql|vue|svelte|astro)$/i;

const isFilePath = (text: string): boolean => {
	if (!FILE_EXTENSIONS.test(text)) return false;
	if (text.includes(' ')) return false;
	if (text.length > 100) return false;
	if (/^(import|export|from|require|const|let|var|function|class|interface|type)\b/.test(text))
		return false;
	return true;
};

/**
 * Regex to detect file paths with optional :line suffix in plain text.
 * Requires at least one `/` or `\` separator to distinguish from bare filenames.
 * Matches: `src/utils/markdown.tsx`, `./components/App.tsx:42`, `C:\foo\bar.ts`, `/usr/bin/foo.py`
 * Does NOT match: `foo.ts` (no separator — handled by inline code detection instead)
 */
const FILE_PATH_IN_TEXT =
	/(?:(?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|[/\\])[\w.@-]+(?:[/\\][\w.@-]+)*|[\w.@-]+(?:[/\\][\w.@-]+)+)\.(tsx?|jsx?|json|md|css|scss|less|html|xml|yaml|yml|toml|ini|conf|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|sql|graphql|vue|svelte|astro)(?::(\d+))?(?=[)\s,;:!?'"]|$)/g;

/**
 * Scans a text string for file paths and returns an array of React nodes
 * where file paths are replaced with clickable PathChip components.
 */
const linkifyFilePaths = (text: string): React.ReactNode[] => {
	const parts: React.ReactNode[] = [];
	let lastIndex = 0;

	for (const m of text.matchAll(FILE_PATH_IN_TEXT)) {
		const matchStart = m.index;
		const fullMatch = m[0];
		const lineNum = m[2] ? Number.parseInt(m[2], 10) : undefined;
		const filePath = lineNum ? fullMatch.replace(`:${m[2]}`, '') : fullMatch;

		if (matchStart > lastIndex) {
			parts.push(text.slice(lastIndex, matchStart));
		}

		parts.push(
			<PathChip
				key={`fp-${matchStart}`}
				path={filePath}
				line={lineNum}
				title={fullMatch}
				className="align-text-bottom"
				onClick={() => vscode.postMessage({ type: 'openFile', filePath, line: lineNum })}
			/>,
		);

		lastIndex = matchStart + fullMatch.length;
	}

	if (lastIndex === 0) return [text];
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}
	return parts;
};

/**
 * Recursively processes React children, replacing plain text file paths
 * with PathChip components. Leaves non-string children untouched.
 */
const processChildren = (children: React.ReactNode): React.ReactNode => {
	if (typeof children === 'string') {
		const linked = linkifyFilePaths(children);
		return linked.length === 1 && typeof linked[0] === 'string' ? children : linked;
	}
	if (Array.isArray(children)) {
		return children.map((child, i) => {
			const key = typeof child === 'string' ? `t-${i}-${child.slice(0, 8)}` : `n-${i}`;
			return <React.Fragment key={key}>{processChildren(child)}</React.Fragment>;
		});
	}
	return children;
};

// ----------------------------------------------------------------------
// Helper Components
// ----------------------------------------------------------------------

const CopyButton: React.FC<{ code: string; className?: string }> = ({ code, className }) => {
	const [copied, setCopied] = useState(false);

	const handleCopy = () => {
		navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<IconButton
			icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
			onClick={handleCopy}
			title={copied ? 'Copied!' : 'Copy'}
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

// ----------------------------------------------------------------------
// Language display names
// ----------------------------------------------------------------------

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

// ----------------------------------------------------------------------
// Markdown Components
// ----------------------------------------------------------------------

const components: Components = {
	a: ({ href, children }) => (
		<a
			href={href}
			className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground hover:underline transition-colors underline-offset-2"
			target="_blank"
			rel="noopener noreferrer"
		>
			{children}
		</a>
	),

	p: ({ children }) => <p>{processChildren(children)}</p>,
	li: ({ children }) => <li>{processChildren(children)}</li>,
	strong: ({ children }) => <strong>{processChildren(children)}</strong>,
	em: ({ children }) => <em>{processChildren(children)}</em>,

	pre: ({ children }) => <>{children}</>,

	code: ({ className, children, ...props }) => {
		const match = /language-(\w+)/.exec(className || '');
		const codeContent = getTextContent(children);
		const isMultiline = codeContent.includes('\n');
		const isCodeBlock = match || className?.includes('hljs') || isMultiline;

		if (isCodeBlock) {
			const language = match ? match[1] : 'text';
			return (
				<div className="group/codeblock isolate relative my-2 rounded-lg border border-(--tool-border-color) overflow-hidden bg-(--tool-bg-header)">
					<div className="absolute right-0 top-0 z-1 flex items-center gap-1 p-1 opacity-0 group-hover/codeblock:opacity-100 transition-opacity bg-(--tool-bg-header) rounded-bl">
						<span className="text-xs font-mono text-vscode-descriptionForeground/50 pointer-events-none select-none">
							{getLangDisplay(language)}
						</span>
						<CopyButton code={codeContent} />
					</div>
					<div className="overflow-x-auto">
						<code
							className={cn(
								'block p-(--tool-content-padding) font-mono text-md leading-(--line-height-code) whitespace-pre',
								'text-vscode-editor-foreground bg-(--tool-bg-header) w-fit min-w-full',
								className,
							)}
							{...props}
						>
							{children}
						</code>
					</div>
				</div>
			);
		}

		// Inline code — file path detection
		const codeText = getTextContent(children);
		if (isFilePath(codeText)) {
			return (
				<PathChip
					path={codeText}
					title={codeText}
					className="align-text-bottom"
					onClick={() => vscode.postMessage({ type: 'openFile', filePath: codeText })}
				/>
			);
		}

		// Regular inline code
		return (
			<code
				className="inline-code px-1 py-px mx-0.5 rounded-sm bg-(--alpha-10) text-md font-mono"
				{...props}
			>
				{children}
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
		<div className="my-2 bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
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
		<th className="px-(--tool-content-padding) py-1.5 text-left font-medium text-sm text-vscode-editor-foreground border-r border-(--border-subtle) last:border-r-0">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="px-(--tool-content-padding) py-1.5 text-md border-r border-(--border-subtle) last:border-r-0">
			{children}
		</td>
	),
};

// ----------------------------------------------------------------------
// Streaming throttle — llm-ui inspired character-level smoothing
// ----------------------------------------------------------------------

/**
 * Buffers incoming content and releases it character-by-character at the
 * display's frame rate. This eliminates the "flicker" caused by React
 * re-rendering the full markdown tree on every token.
 *
 * When `isStreaming` is false the full content is returned immediately.
 *
 * Approach (borrowed from llm-ui's throttleBasic):
 *  - Keep a "visible length" that trails behind the real content length
 *  - Each RAF tick, advance visible length by `charsPerFrame`
 *  - `charsPerFrame` is auto-tuned: we measure how fast new chars arrive
 *    and set the display rate slightly above that so we never fall behind
 *  - A small read-ahead buffer (BUFFER_CHARS) is withheld so we can
 *    smooth out pauses between LLM tokens
 */
const BUFFER_CHARS = 8; // chars to withhold while streaming
const MIN_CHARS_PER_FRAME = 1;
const MAX_CHARS_PER_FRAME = 6;
const RATE_WINDOW_MS = 3000; // window for measuring arrival rate

function useThrottledContent(content: string, isStreaming: boolean): string {
	const [visibleLen, setVisibleLen] = useState(content.length);
	const rafRef = useRef(0);
	const contentRef = useRef(content);
	const visibleLenRef = useRef(content.length);

	// Track arrival rate: timestamps of content length changes
	const samplesRef = useRef<{ time: number; len: number }[]>([]);

	// Keep contentRef in sync
	contentRef.current = content;

	// When streaming starts on new content (e.g. new message), reset
	const prevStreamingRef = useRef(isStreaming);
	useEffect(() => {
		if (isStreaming && !prevStreamingRef.current) {
			// Streaming just started — snap to current length so we don't
			// re-animate already-visible text
			visibleLenRef.current = content.length;
			setVisibleLen(content.length);
			samplesRef.current = [];
		}
		prevStreamingRef.current = isStreaming;
	}, [isStreaming, content.length]);

	// Record arrival samples
	useEffect(() => {
		if (!isStreaming) return;
		const now = performance.now();
		const samples = samplesRef.current;
		samples.push({ time: now, len: content.length });
		// Prune old samples
		const cutoff = now - RATE_WINDOW_MS;
		while (samples.length > 1 && samples[0].time < cutoff) {
			samples.shift();
		}
	}, [content.length, isStreaming]);

	// Compute chars per frame from arrival rate
	const getCharsPerFrame = useCallback(() => {
		const samples = samplesRef.current;
		if (samples.length < 2) return MIN_CHARS_PER_FRAME;
		const first = samples[0];
		const last = samples[samples.length - 1];
		const elapsed = last.time - first.time;
		if (elapsed <= 0) return MIN_CHARS_PER_FRAME;
		const charsArrived = last.len - first.len;
		// chars per ms → chars per frame (assuming ~16ms per frame)
		const charsPerMs = charsArrived / elapsed;
		const charsPerFrame = Math.round(charsPerMs * 16 * 1.2); // 1.2x to stay ahead
		return Math.max(MIN_CHARS_PER_FRAME, Math.min(MAX_CHARS_PER_FRAME, charsPerFrame));
	}, []);

	// RAF loop: advance visible length toward target
	useEffect(() => {
		if (!isStreaming) {
			// Not streaming — show everything immediately
			cancelAnimationFrame(rafRef.current);
			visibleLenRef.current = content.length;
			setVisibleLen(content.length);
			return;
		}

		const tick = () => {
			const target = contentRef.current.length - BUFFER_CHARS;
			const current = visibleLenRef.current;

			if (current < target) {
				const step = getCharsPerFrame();
				const next = Math.min(current + step, target);
				visibleLenRef.current = next;
				setVisibleLen(next);
			}

			rafRef.current = requestAnimationFrame(tick);
		};

		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
	}, [isStreaming, getCharsPerFrame, content.length]);

	// When streaming finishes, flush remaining buffer
	useEffect(() => {
		if (!isStreaming && visibleLenRef.current < content.length) {
			visibleLenRef.current = content.length;
			setVisibleLen(content.length);
		}
	}, [isStreaming, content.length]);

	// During streaming return the throttled slice; otherwise full content
	if (!isStreaming) return content;
	return content.slice(0, Math.max(0, visibleLen));
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
// Main Component — uses plain CSS (.markdown-body) instead of Tailwind prose
// ----------------------------------------------------------------------

export const Markdown: React.FC<MarkdownProps> = React.memo(
	({ content, className, isStreaming }) => {
		// Character-level throttling: buffers incoming tokens and releases them
		// at the display's frame rate for smooth, flicker-free streaming.
		const displayContent = useThrottledContent(content, !!isStreaming);
		const processedContent = React.useMemo(
			() => preprocessContent(displayContent),
			[displayContent],
		);

		// Skip expensive syntax highlighting during streaming — the most costly
		// rehype plugin. Full highlighting kicks in once streaming completes.
		const rehypePlugins = isStreaming ? REHYPE_PLUGINS_STREAMING : REHYPE_PLUGINS_FULL;

		return (
			<div className={cn('markdown-body', isStreaming && 'streaming', className)}>
				<ReactMarkdown
					remarkPlugins={REMARK_PLUGINS}
					rehypePlugins={rehypePlugins}
					components={components}
					urlTransform={url => url}
				>
					{processedContent}
				</ReactMarkdown>
			</div>
		);
	},
	(prevProps, nextProps) =>
		prevProps.content === nextProps.content &&
		prevProps.className === nextProps.className &&
		prevProps.isStreaming === nextProps.isStreaming,
);
