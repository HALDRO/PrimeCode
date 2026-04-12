/**
 * @file Markdown renderer with syntax highlighting
 * @description Unified design system with minimal, consistent tokens.
 *              Contains optimized StreamableNode for flicker-free word animations.
 */

import hljs from 'highlight.js';
import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Стабильный массив плагинов. Мы больше не меняем его на лету!
// (Именно смена плагинов вызывала 100% перерисовку и моргание в конце)
const REMARK_PLUGINS = [remarkGfm];

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
// Streaming Context — tracks which words have already been animated
// so remounted spans get opacity:1 immediately (no flash)
// ----------------------------------------------------------------------

const StreamingContext = createContext<{
	isStreaming: boolean;
	animatedWords: Set<string>;
}>({
	isStreaming: false,
	animatedWords: new Set(),
});

// ----------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------

// File path detection — any word with path separators ending in .ext (1-10 chars)
const FILE_EXTENSIONS = /\.[a-zA-Z\d]{1,10}$/;

const CODE_KEYWORDS = /^(import|export|from|require|const|let|var|function|class|interface|type)\b/;

const isFilePath = (text: string): boolean => {
	if (!FILE_EXTENSIONS.test(text)) return false;
	if (text.includes(' ')) return false;
	if (text.length > 100) return false;
	if (CODE_KEYWORDS.test(text)) return false;
	// Must look like a path: has separator or starts with dot
	if (!/[/\\]/.test(text) && !text.startsWith('.')) return false;
	return true;
};

const FILE_PATH_IN_TEXT =
	/(?:(?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|[/\\])[\w.@-]+(?:[/\\][\w.@-]+)*|[\w.@-]+(?:[/\\][\w.@-]+)+)\.[a-zA-Z\d]{1,10}(?::(\d+))?(?=[)\s,;:!?'"]|$)/g;

const linkifyFilePaths = (text: string): React.ReactNode[] => {
	const parts: React.ReactNode[] = [];
	let lastIndex = 0;

	for (const m of text.matchAll(FILE_PATH_IN_TEXT)) {
		const matchStart = m.index;
		const fullMatch = m[0];
		const lineNum = m[1] ? Number.parseInt(m[1], 10) : undefined;
		const filePath = lineNum ? fullMatch.replace(`:${m[1]}`, '') : fullMatch;

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

// ----------------------------------------------------------------------
// Universal Streamable Node — word animations preserved
// ----------------------------------------------------------------------

const handleAnimationEnd = (e: React.AnimationEvent<HTMLSpanElement>) => {
	e.currentTarget.classList.remove('stream-word-new');
};

const renderTextContent = (
	content: string,
	isStreaming: boolean,
	prefixKey: string,
	animatedWords: Set<string>,
) => {
	const linked = linkifyFilePaths(content);

	let partOffset = 0;
	return linked.map(part => {
		const currentPartOffset = partOffset;
		if (typeof part === 'string') {
			partOffset += part.length;
			const words = part.split(/(\s+)/);
			let charOffset = currentPartOffset;
			return words.map(word => {
				const offset = charOffset;
				charOffset += word.length;
				if (word.trim().length === 0) return word;

				const wordKey = `${prefixKey}-${offset}`;

				if (!isStreaming) {
					return <span key={`w-${wordKey}`}>{word}</span>;
				}

				const isNew = !animatedWords.has(wordKey);
				if (isNew) animatedWords.add(wordKey);

				return (
					<span
						key={`w-${wordKey}`}
						className={isNew ? 'stream-word stream-word-new' : 'stream-word'}
						onAnimationEnd={isNew ? handleAnimationEnd : undefined}
					>
						{word}
					</span>
				);
			});
		}
		// PathChip — estimate length from the key prop
		const chipPath =
			part && typeof part === 'object' && 'key' in part
				? String((part as React.ReactElement).key)
				: '';
		partOffset += chipPath.length || 10;
		return part;
	});
};

const StreamableNode: React.FC<{ node: React.ReactNode; index?: number }> = ({
	node,
	index = 0,
}) => {
	const { isStreaming, animatedWords } = useContext(StreamingContext);

	if (typeof node === 'string') {
		return <>{renderTextContent(node, isStreaming, String(index), animatedWords)}</>;
	}
	if (Array.isArray(node)) {
		return (
			<>
				{node.map((child, childIdx) => {
					// Build a stable key from child content rather than array index
					const childKey =
						typeof child === 'string'
							? `sn-${index}-str-${child.length}-${child.slice(0, 8)}`
							: `sn-${index}-node-${childIdx}`;
					return <StreamableNode key={childKey} node={child} index={childIdx} />;
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
	const timerRef = useRef<ReturnType<typeof setTimeout>>(
		0 as unknown as ReturnType<typeof setTimeout>,
	);

	useEffect(() => {
		return () => clearTimeout(timerRef.current);
	}, []);

	const handleCopy = () => {
		try {
			navigator.clipboard.writeText(code);
			setCopied(true);
			clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => setCopied(false), 2000);
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

// ----------------------------------------------------------------------
// Highlighted Code Block — isolated component so hooks are at top level
// and innerHTML is set via ref instead of dangerouslySetInnerHTML
// ----------------------------------------------------------------------

const HighlightedCodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => {
	const codeRef = useRef<HTMLElement>(null);

	const highlightedHtml = useMemo(() => {
		try {
			if (language !== 'plaintext' && hljs.getLanguage(language)) {
				return hljs.highlight(code, { language }).value;
			}
			return hljs.highlightAuto(code).value;
		} catch {
			return null;
		}
	}, [code, language]);

	useEffect(() => {
		if (codeRef.current && highlightedHtml !== null) {
			codeRef.current.innerHTML = highlightedHtml;
		}
	}, [highlightedHtml]);

	return (
		<div className="group/codeblock isolate relative my-2 rounded-lg border border-(--tool-border-color) overflow-hidden bg-(--tool-bg-header)">
			<div className="absolute right-0 top-0 z-1 flex items-center gap-1 p-1 opacity-0 group-hover/codeblock:opacity-100 transition-opacity bg-(--tool-bg-header) rounded-bl">
				<span className="text-xs font-mono text-vscode-descriptionForeground/50 pointer-events-none select-none">
					{getLangDisplay(language)}
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
	a: ({ href, children }) => (
		<a
			href={href}
			className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground hover:underline transition-colors underline-offset-2"
			target="_blank"
			rel="noopener noreferrer"
		>
			<StreamableNode node={children} />
		</a>
	),
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

		if (isFilePath(codeContent)) {
			return (
				<PathChip
					path={codeContent}
					title={codeContent}
					className="align-text-bottom"
					onClick={() => vscode.postMessage({ type: 'openFile', filePath: codeContent })}
				/>
			);
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
			<StreamableNode node={children} />
		</th>
	),
	td: ({ children }) => (
		<td className="px-(--tool-content-padding) py-1.5 text-md border-r border-(--border-subtle) last:border-r-0">
			<StreamableNode node={children} />
		</td>
	),
};

// ----------------------------------------------------------------------
// Streaming throttle
// ----------------------------------------------------------------------
const BUFFER_CHARS = 40;
const MIN_CHARS_PER_FRAME = 2;
const MAX_CHARS_PER_FRAME = 8;
const RATE_WINDOW_MS = 2000;

function useThrottledContent(
	content: string,
	isStreaming: boolean,
): { text: string; isAnimating: boolean } {
	const [visibleLen, setVisibleLen] = useState(content.length);
	const rafRef = useRef(0);
	const contentRef = useRef(content);
	const visibleLenRef = useRef(content.length);
	const samplesRef = useRef<{ time: number; len: number }[]>([]);

	contentRef.current = content;

	const prevStreamingRef = useRef(isStreaming);
	useEffect(() => {
		if (isStreaming && !prevStreamingRef.current) {
			visibleLenRef.current = content.length;
			setVisibleLen(content.length);
			samplesRef.current = [];
		}
		prevStreamingRef.current = isStreaming;
	}, [isStreaming, content.length]);

	useEffect(() => {
		if (!isStreaming) return;
		const now = performance.now();
		const samples = samplesRef.current;
		samples.push({ time: now, len: content.length });
		const cutoff = now - RATE_WINDOW_MS;
		while (samples.length > 1 && samples[0].time < cutoff) {
			samples.shift();
		}
	}, [content.length, isStreaming]);

	const getCharsPerFrame = useCallback(() => {
		const samples = samplesRef.current;
		if (samples.length < 2) return MIN_CHARS_PER_FRAME;
		const first = samples[0];
		const last = samples[samples.length - 1];
		const elapsed = last.time - first.time;
		if (elapsed <= 0) return MIN_CHARS_PER_FRAME;
		const charsArrived = last.len - first.len;
		const charsPerMs = charsArrived / elapsed;
		const charsPerFrame = Math.round(charsPerMs * 16 * 1.2);
		return Math.max(MIN_CHARS_PER_FRAME, Math.min(MAX_CHARS_PER_FRAME, charsPerFrame));
	}, []);

	// Single RAF loop that runs while streaming OR while buffer hasn't caught up.
	// When isStreaming is true, we hold back BUFFER_CHARS from the end.
	// When isStreaming turns false, the loop keeps running without the buffer
	// offset, naturally draining remaining words with their fade-in animation.
	const isStreamingRef = useRef(isStreaming);
	isStreamingRef.current = isStreaming;

	useEffect(() => {
		// Run loop while streaming OR while there's buffered content to drain
		if (!isStreaming && visibleLenRef.current >= contentRef.current.length) return;

		let lastContentLen = contentRef.current.length;
		let stallStart = 0;

		const tick = () => {
			const contentLen = contentRef.current.length;
			const now = performance.now();
			const streaming = isStreamingRef.current;

			if (contentLen !== lastContentLen) {
				lastContentLen = contentLen;
				stallStart = now;
			}

			// While streaming: hold back BUFFER_CHARS. After streaming ends: target = full length.
			const isStalled = stallStart > 0 && now - stallStart > 200;
			const target = !streaming || isStalled ? contentLen : contentLen - BUFFER_CHARS;
			const current = visibleLenRef.current;

			if (current < target) {
				const step = getCharsPerFrame();
				const next = Math.min(current + step, target);
				visibleLenRef.current = next;
				setVisibleLen(next);
			}

			// Keep running until we've caught up to full content after streaming ends
			if (streaming || current < contentLen) {
				rafRef.current = requestAnimationFrame(tick);
			}
		};

		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isStreaming, getCharsPerFrame]);

	// If not streaming and loop has finished, return full content
	if (!isStreaming && visibleLenRef.current >= content.length)
		return { text: content, isAnimating: false };

	const rawSlice = content.slice(0, Math.max(0, visibleLen));

	// Word-boundary snapping so animations fire per-word
	const lastSpace = rawSlice.search(/\s\S*$/);
	if (lastSpace <= 0) return { text: rawSlice, isAnimating: true };
	return { text: rawSlice.slice(0, lastSpace), isAnimating: true };
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
		const { text: displayContent, isAnimating } = useThrottledContent(content, !!isStreaming);
		const processedContent = React.useMemo(
			() => preprocessContent(displayContent),
			[displayContent],
		);

		// Persistent Set of word keys that have already been animated.
		// Survives re-renders so remounted spans get opacity:1 immediately.
		// Cleared when animation finishes (not when streaming ends) so buffered words still animate.
		const animatedWordsRef = useRef(new Set<string>());
		const prevAnimatingRef = useRef(isAnimating);
		useEffect(() => {
			if (!isAnimating && prevAnimatingRef.current) {
				animatedWordsRef.current = new Set<string>();
			}
			prevAnimatingRef.current = isAnimating;
		}, [isAnimating]);

		const streamingCtx = React.useMemo(
			() => ({ isStreaming: isAnimating, animatedWords: animatedWordsRef.current }),
			[isAnimating],
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
