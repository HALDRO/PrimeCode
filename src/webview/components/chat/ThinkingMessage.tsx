/**
 * @file ThinkingMessage - displays Claude's thinking/reasoning process
 * @description Enhanced collapsible block showing Claude's internal reasoning with support for
 * structured thinking data (Azure OpenAI, Copilot API, Anthropic formats). Features markdown
 * rendering, token count display, thinking duration timer, and copy functionality.
 * Auto-expands during streaming and collapses after completion; user can manually toggle.
 * Uses consistent styling with other tool messages.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import type { Message } from '../../store/chatStore';
import { formatDuration } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { BrainSideIcon, CheckIcon, CopyIcon, ExpandCollapseIcon, TimerIcon } from '../icons';
import { CollapseOverlay, IconButton } from '../ui';

interface ThinkingMessageProps {
	message: Extract<Message, { type: 'thinking' }>;
	/** Whether this thinking block is currently streaming */
	isStreaming?: boolean;
}

/**
 * Parse thinking content to extract structured data if present
 */
function parseThinkingContent(content: string): {
	text: string;
	title?: string;
	tokens?: number;
} {
	// Check for structured format: **Title**\n\nContent
	const titleMatch = content.match(/^\*\*([^*]+)\*\*\s*\n\n([\s\S]*)$/);
	if (titleMatch) {
		return {
			title: titleMatch[1].trim(),
			text: titleMatch[2].trim(),
		};
	}

	// Check for token count in content (e.g., "[123 tokens]")
	const tokenMatch = content.match(/\[(\d+)\s*tokens?\]/i);
	const tokens = tokenMatch ? parseInt(tokenMatch[1], 10) : undefined;

	// Remove token count from display text
	const cleanText = content.replace(/\s*\[\d+\s*tokens?\]\s*/gi, '').trim();

	return {
		text: cleanText,
		tokens,
	};
}

/**
 * Get a preview of the thinking content (first meaningful line)
 */
function getPreview(text: string, maxLength: number = 80): string {
	// Get first non-empty line
	const firstLine = text
		.split('\n')
		.map(l => l.trim())
		.find(l => l.length > 0);

	if (!firstLine) {
		return 'Thinking...';
	}

	// Remove markdown formatting for preview
	const cleanLine = firstLine
		.replace(/\*\*([^*]+)\*\*/g, '$1') // Bold
		.replace(/\*([^*]+)\*/g, '$1') // Italic
		.replace(/`([^`]+)`/g, '$1') // Code
		.replace(/^#+\s*/, ''); // Headers

	if (cleanLine.length <= maxLength) {
		return cleanLine;
	}
	return `${cleanLine.slice(0, maxLength - 3)}...`;
}

export const ThinkingMessage: React.FC<ThinkingMessageProps> = ({ message, isStreaming }) => {
	const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
	const [copied, setCopied] = useState(false);
	const [elapsedMs, setElapsedMs] = useState(0);
	const { content, durationMs } = message;

	// Use isStreaming from prop or message - default to false for historical messages
	const isCurrentlyStreaming = isStreaming ?? message.isStreaming ?? false;

	// Auto-expand during streaming, collapse after completion
	// User can override with manual toggle (manualExpanded)
	const expanded = manualExpanded !== null ? manualExpanded : isCurrentlyStreaming;

	// Reset manual override when streaming starts (new thinking block)
	useEffect(() => {
		if (isCurrentlyStreaming) {
			setManualExpanded(null);
		}
	}, [isCurrentlyStreaming]);

	const parsed = useMemo(() => parseThinkingContent(content || ''), [content]);
	const preview = useMemo(() => getPreview(parsed.text), [parsed.text]);

	// Stateless timer: derive elapsed time from startTime/durationMs
	useEffect(() => {
		// If finalized duration, just show it (no timer needed)
		if (durationMs && durationMs > 0) {
			setElapsedMs(durationMs);
			return undefined;
		}

		// If streaming and we have a start time, update elapsed time periodically
		if (isCurrentlyStreaming && message.startTime) {
			// Initial update
			setElapsedMs(Date.now() - message.startTime);

			// Update UI every 100ms
			const interval = setInterval(() => {
				if (message.startTime) {
					setElapsedMs(Date.now() - message.startTime);
				}
			}, 100);

			return () => clearInterval(interval);
		}

		// Fallback for historical/static messages without duration
		setElapsedMs(0);
		return undefined;
	}, [isCurrentlyStreaming, durationMs, message.startTime]);

	if (!content) {
		return null;
	}

	const handleCopy = (e: React.MouseEvent) => {
		e.stopPropagation();
		navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	// Get duration: prefer durationMs from backend, then elapsed from timer
	const displayDuration = durationMs || elapsedMs;

	return (
		<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
			{/* Header */}
			<div
				className={cn(
					'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding)',
					'bg-(--tool-bg-header) border-none text-inherit select-none',
					'hover:bg-vscode-toolbar-hoverBackground transition-colors',
					expanded && 'border-b-0',
				)}
			>
				{/* Left side: clickable area */}
				<button
					type="button"
					className="flex items-center gap-(--gap-3) min-w-0 flex-1 bg-transparent border-none cursor-pointer p-0 text-left"
					onClick={() => setManualExpanded(!expanded)}
				>
					<span
						className="flex items-center justify-center shrink-0"
						style={{ color: 'var(--color-thinking)' }}
					>
						<BrainSideIcon size={14} />
					</span>
					<div className="flex items-center min-w-0 flex-1">
						<span className="text-sm text-vscode-foreground opacity-90 shrink-0">
							{parsed.title || 'Thinking'}
						</span>

						{/* Preview when collapsed */}
						{!expanded && (
							<span className="text-sm text-vscode-foreground opacity-90 truncate">
								&nbsp;— {preview}
							</span>
						)}
					</div>
				</button>

				{/* Right side: stats + actions + expand icon */}
				<div className="flex items-center gap-(--gap-2) shrink-0">
					{/* Duration badge */}
					{displayDuration > 0 && (
						<span className="flex items-end gap-(--gap-1) text-sm leading-none text-vscode-foreground opacity-90">
							<TimerIcon size={11} />
							{formatDuration(displayDuration)}
						</span>
					)}

					<IconButton
						icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
						onClick={handleCopy}
						title="Copy"
						size={20}
						className="opacity-90 hover:opacity-100"
					/>

					<button
						type="button"
						className="flex items-center justify-center w-5 h-5 opacity-90 shrink-0 bg-transparent border-none cursor-pointer p-0"
						onClick={() => setManualExpanded(!expanded)}
						aria-label={expanded ? 'Collapse' : 'Expand'}
					>
						<ExpandCollapseIcon
							size={14}
							className={cn('transition-transform duration-150 ease-out', expanded && 'rotate-180')}
						/>
					</button>
				</div>
			</div>

			{/* Content */}
			{expanded && (
				<div className="relative p-(--tool-content-padding) text-base leading-relaxed text-vscode-foreground/85">
					<div className="thinking-content">
						<Markdown content={parsed.text} />
					</div>
					<CollapseOverlay visible={expanded} onCollapse={() => setManualExpanded(false)} />
				</div>
			)}
		</div>
	);
};

export default ThinkingMessage;
