/**
 * @file Markdown renderer with syntax highlighting
 * @description Compact markdown renderer using react-markdown with rehype-highlight.
 *              Optimized for chat UI with minimal spacing and VS Code-like appearance.
 *              Includes enhanced code blocks with language badges, copy functionality, and horizontal scrolling for long lines.
 *              Code block detection uses language class, hljs highlighting, or multiline content (for tree structures, ASCII art, etc.).
 *              Inline code that looks like file paths becomes clickable to open in editor.
 */

import React, { useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { CheckIcon, CopyIcon } from '../components/icons';
import { FileTypeIcon } from '../components/icons/FileTypeIcon';
import { IconButton, Tooltip } from '../components/ui';
import { cn } from '../lib/cn';
import { vscode } from './vscode';

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

export interface MarkdownProps {
	content: string;
	className?: string;
}

// ----------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------

/** Common file extensions for detection */
const FILE_EXTENSIONS =
	/\.(tsx?|jsx?|json|md|css|scss|less|html|xml|yaml|yml|toml|ini|conf|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|sql|graphql|vue|svelte|astro)$/i;

/** Check if text looks like a file path */
const isFilePath = (text: string): boolean => {
	// Must have a file extension
	if (!FILE_EXTENSIONS.test(text)) {
		return false;
	}
	// Should not contain spaces (usually code, not paths)
	if (text.includes(' ')) {
		return false;
	}
	// Should not be too long (likely not a simple file reference)
	if (text.length > 100) {
		return false;
	}
	// Should not start with common code patterns
	if (/^(import|export|from|require|const|let|var|function|class|interface|type)\b/.test(text)) {
		return false;
	}
	return true;
};

/** Extract file name from path */
const getFileName = (path: string): string => path.split(/[/\\]/).pop() || path;

// ----------------------------------------------------------------------
// Helper Components
// ----------------------------------------------------------------------

/** Copy button for code blocks with visual feedback */
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

/**
 * Recursive function to extract raw text from React children.
 * Useful for getting the code string from syntax-highlighted nodes.
 */
const getTextContent = (children: React.ReactNode): string => {
	if (typeof children === 'string') {
		return children;
	}
	if (typeof children === 'number') {
		return String(children);
	}
	if (Array.isArray(children)) {
		return children.map(getTextContent).join('');
	}
	if (children && typeof children === 'object' && 'props' in (children as React.ReactElement)) {
		return getTextContent(
			(children as React.ReactElement<{ children?: React.ReactNode }>).props.children,
		);
	}
	return '';
};

// ----------------------------------------------------------------------
// Styles
// ----------------------------------------------------------------------

// VS Code Dark+ inspired syntax highlighting colors map to Tailwind classes via arbitrary values
// Using descendant selectors ([&_...]) to target the token spans inside the code block
const syntaxHighlightStyles = cn(
	'[&_.hljs-comment]:text-[#6A9955]',
	'[&_.hljs-quote]:text-[#6A9955]',
	'[&_.hljs-variable]:text-[#9CDCFE]',
	'[&_.hljs-template-variable]:text-[#9CDCFE]',
	'[&_.hljs-tag]:text-[#9CDCFE]',
	'[&_.hljs-name]:text-[#9CDCFE]',
	'[&_.hljs-selector-id]:text-[#9CDCFE]',
	'[&_.hljs-selector-class]:text-[#9CDCFE]',
	'[&_.hljs-regexp]:text-[#9CDCFE]',
	'[&_.hljs-link]:text-[#9CDCFE]',
	'[&_.hljs-number]:text-[#B5CEA8]',
	'[&_.hljs-meta]:text-[#569CD6]',
	'[&_.hljs-built_in]:text-[#4EC9B0]',
	'[&_.hljs-builtin-name]:text-[#4EC9B0]',
	'[&_.hljs-literal]:text-[#569CD6]',
	'[&_.hljs-type]:text-[#4EC9B0]',
	'[&_.hljs-params]:text-[#9CDCFE]',
	'[&_.hljs-string]:text-[#CE9178]',
	'[&_.hljs-symbol]:text-[#CE9178]',
	'[&_.hljs-bullet]:text-[#CE9178]',
	'[&_.hljs-title]:text-[#DCDCAA]',
	'[&_.hljs-section]:text-[#DCDCAA]',
	'[&_.hljs-keyword]:text-[#C586C0]',
	'[&_.hljs-selector-tag]:text-[#C586C0]',
	'[&_.hljs-emphasis]:italic',
	'[&_.hljs-strong]:font-bold',
);

// ----------------------------------------------------------------------
// Markdown Components
// ----------------------------------------------------------------------

const components: Components = {
	// Headings
	h1: ({ children }) => (
		<h1 className="text-sm font-bold text-white/90 mt-1.5 mb-0.5 first:mt-0 pb-0.5 border-b border-white/10">
			{children}
		</h1>
	),
	h2: ({ children }) => (
		<h2 className="text-sm font-semibold text-white/90 mt-1.5 mb-0.5 first:mt-0">{children}</h2>
	),
	h3: ({ children }) => (
		<h3 className="text-base font-semibold text-white/90 mt-1 mb-0.5 first:mt-0">{children}</h3>
	),
	h4: ({ children }) => (
		<h4 className="text-base font-medium text-white/90 mt-1 mb-0.5 first:mt-0">{children}</h4>
	),
	h5: ({ children }) => (
		<h5 className="text-md font-bold text-white/80 mt-1 mb-0.5 first:mt-0 uppercase tracking-wide">
			{children}
		</h5>
	),
	h6: ({ children }) => (
		<h6 className="text-md font-semibold text-white/70 mt-1 mb-0.5 first:mt-0">{children}</h6>
	),

	// Paragraphs
	p: ({ children }) => (
		<p className="text-base leading-relaxed text-white/80 mb-0.5 last:mb-0">{children}</p>
	),

	// Lists
	ul: ({ children }) => (
		<ul className="list-disc list-inside pl-(--gap-4) mb-0.5 text-base text-white/80 marker:text-white/50 space-y-0 [&>li::marker]:text-[1.2em]">
			{children}
		</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal list-inside pl-(--gap-4) mb-0.5 text-base text-white/80 marker:text-white/50 space-y-0">
			{children}
		</ol>
	),
	li: ({ children }) => <li className="my-0 pl-(--gap-1)">{children}</li>,

	// Links
	a: ({ href, children }) => (
		<a
			href={href}
			className="text-blue-400 hover:text-blue-300 hover:underline transition-colors decoration-blue-400/30 underline-offset-2"
			target="_blank"
			rel="noopener noreferrer"
		>
			{children}
		</a>
	),

	// Blockquotes
	blockquote: ({ children }) => (
		<blockquote className="border-l-2 border-blue-500/50 bg-blue-500/5 px-2 py-0.5 my-0.5 rounded-r text-white/70 italic text-base">
			{children}
		</blockquote>
	),

	// Horizontal Rule
	hr: () => <hr className="border-none h-px bg-white/10 my-0.5" />,

	// Formatting
	strong: ({ children }) => <strong className="font-semibold text-white/95">{children}</strong>,
	em: ({ children }) => <em className="italic text-white/80">{children}</em>,
	del: ({ children }) => <del className="line-through opacity-70">{children}</del>,

	// Code Blocks & Inline Code
	pre: ({ children }) => <>{children}</>,

	code: ({ className, children, ...props }) => {
		// Check if this is a block code (has language class, hljs class, or is multiline)
		const match = /language-(\w+)/.exec(className || '');
		const codeContent = getTextContent(children);
		// Detect code blocks: has language, has hljs highlighting, or contains newlines (multiline)
		const isMultiline = codeContent.includes('\n');
		const isCodeBlock = match || className?.includes('hljs') || isMultiline;

		if (isCodeBlock) {
			const language = match ? match[1] : 'text';

			const displayName =
				language === 'typescript'
					? 'TS'
					: language === 'javascript'
						? 'JS'
						: language === 'python'
							? 'Python'
							: language === 'bash' || language === 'sh'
								? 'Terminal'
								: language === 'json'
									? 'JSON'
									: language.toUpperCase();

			return (
				<div className="group/codeblock isolate relative my-0.5 rounded-lg border border-(--tool-border-color) overflow-hidden bg-(--tool-bg-header)">
					{/* Floating controls - absolute positioned, z-index scoped by isolate */}
					<div className="absolute right-0 top-0 z-1 flex items-center gap-1 p-1 opacity-0 group-hover/codeblock:opacity-100 transition-opacity bg-(--tool-bg-header) rounded-bl">
						<span className="text-xs font-mono text-white/30 pointer-events-none select-none">
							{displayName}
						</span>
						<CopyButton code={codeContent} />
					</div>

					<div className="overflow-x-auto">
						<code
							className={cn(
								'block p-(--tool-content-padding) font-mono text-md leading-(--line-height-code) whitespace-pre',
								'text-[#d4d4d4] bg-(--tool-bg-header) w-fit min-w-full',
								syntaxHighlightStyles,
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

		// Inline Code
		const codeText = getTextContent(children);

		// Check if it looks like a file path - make it clickable
		if (isFilePath(codeText)) {
			const fileName = getFileName(codeText);
			const handleClick = () => {
				vscode.postMessage({ type: 'openFile', path: codeText });
			};

			return (
				<Tooltip content={`Open ${codeText}`} position="top" delay={300}>
					<button
						type="button"
						onClick={handleClick}
						className={cn(
							'inline-flex items-center gap-1 px-1 py-px mx-0.5 rounded-sm',
							'bg-transparent hover:bg-white/10 text-blue-400 hover:text-blue-300',
							'text-md font-mono',
							'transition-colors duration-150 cursor-pointer',
							'hover:underline underline-offset-2 decoration-blue-400/50',
						)}
					>
						<FileTypeIcon name={fileName} size={11} />
						<span>{fileName}</span>
					</button>
				</Tooltip>
			);
		}

		// Regular inline code - styled like a hovered link
		return (
			<code
				className="px-1 py-px mx-0.5 rounded-sm bg-white/10 text-blue-300 text-md font-mono"
				{...props}
			>
				{children}
			</code>
		);
	},

	// Images
	img: ({ src, alt }) => (
		<div className="my-0.5">
			<img
				src={src}
				alt={alt || 'Image'}
				className="max-w-full h-auto rounded border border-white/10"
				loading="lazy"
			/>
		</div>
	),

	// Tables - styled like ToolResultMessage
	table: ({ children }) => (
		<div className="my-0.5 bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
			<table className="w-full text-md border-collapse">{children}</table>
		</div>
	),
	thead: ({ children }) => (
		<thead className="bg-(--tool-bg-header) text-vscode-foreground font-medium border-b border-white/5">
			{children}
		</thead>
	),
	tbody: ({ children }) => (
		<tbody className="text-vscode-foreground/90 bg-(--tool-bg-header)">{children}</tbody>
	),
	tr: ({ children }) => (
		<tr className="border-b border-white/5 last:border-b-0 hover:bg-white/2 transition-colors">
			{children}
		</tr>
	),
	th: ({ children }) => (
		<th className="px-(--tool-content-padding) py-1.5 text-left font-medium text-sm text-vscode-descriptionForeground border-r border-white/5 last:border-r-0">
			{children}
		</th>
	),
	td: ({ children }) => (
		<td className="px-(--tool-content-padding) py-1.5 text-md border-r border-white/5 last:border-r-0">
			{children}
		</td>
	),
};

// ----------------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------------

/**
 * Memoized Markdown renderer - prevents expensive re-renders when content hasn't changed.
 * Markdown parsing with syntax highlighting is CPU-intensive, so we skip re-renders
 * when props are identical.
 */
export const Markdown: React.FC<MarkdownProps> = React.memo(
	({ content, className }) => {
		return (
			<div
				className={cn(
					'markdown-body max-w-full text-vscode-foreground wrap-break-word overflow-x-clip',
					className,
				)}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					rehypePlugins={[rehypeHighlight]}
					components={components}
					urlTransform={url => url}
				>
					{content}
				</ReactMarkdown>
			</div>
		);
	},
	(prevProps, nextProps) =>
		prevProps.content === nextProps.content && prevProps.className === nextProps.className,
);
