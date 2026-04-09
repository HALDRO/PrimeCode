/**
 * @file GenerationStatus - animated status indicator during model generation
 * @description Premium visual indicator showing current model activity status.
 *              Normalizes incoming status text (removes trailing dots/ellipsis) and
 *              renders animated typing dots to avoid duplicate static punctuation.
 *              Displays pulsing glow effects and status text.
 *              Shows tool-specific activity (e.g. "Writing file: foo.ts") even during
 *              active streaming, so the user always knows what's happening.
 *              Uses CSS animations for smooth, performant visual feedback without layout shifts.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import {
	useChatStatus,
	useIsLastMessageStreaming,
	useIsProcessing,
	useStreamingToolId,
	useToolActivity,
} from '../../store';

/**
 * Animated typing dots indicator
 */
const TypingDots: React.FC = () => (
	<span className="inline-flex items-center gap-1 ml-2">
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '0ms', animationDuration: '600ms' }}
		/>
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '150ms', animationDuration: '600ms' }}
		/>
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '300ms', animationDuration: '600ms' }}
		/>
	</span>
);

/**
 * Pulsing glow ring animation
 */
const PulseRing: React.FC<{ color: string }> = ({ color }) => (
	<span
		className="absolute inset-0 rounded-full animate-ping opacity-30"
		style={{ backgroundColor: color }}
	/>
);

/**
 * Status icon with glow effect
 */
const StatusIcon: React.FC<{ isThinking: boolean }> = ({ isThinking }) => {
	const color = isThinking ? 'var(--color-thinking)' : 'var(--color-accent)';
	const glowColor = isThinking ? 'var(--glow-thinking)' : 'var(--glow-accent)';

	return (
		<span className="relative inline-flex items-center justify-center w-2.5 h-2.5">
			<PulseRing color={glowColor} />
			<span
				className="relative w-1.5 h-1.5 rounded-full z-10"
				style={{
					backgroundColor: color,
					boxShadow: `0 0 6px ${glowColor}, 0 0 12px ${glowColor}`,
				}}
			/>
		</span>
	);
};

/**
 * Format status text for display
 */
const formatStatus = (status: string): string => {
	if (!status || status === 'Ready') return '';

	const cleaned = status.trim();
	if (!cleaned) return '';

	// Remove trailing dot punctuation. We render animated dots separately.
	const withoutTrailingDots = cleaned.replace(/[.\u2026]+\s*$/, '').trim();
	if (!withoutTrailingDots) return '';

	return withoutTrailingDots.charAt(0).toUpperCase() + withoutTrailingDots.slice(1);
};

/**
 * Determine if status indicates thinking/reasoning
 */
const isThinkingStatus = (status: string): boolean => {
	const lower = status.toLowerCase();
	return (
		lower.includes('think') ||
		lower.includes('reason') ||
		lower.includes('analyz') ||
		lower.includes('process')
	);
};

/**
 * Derive the best display text from tool activity and session status.
 * Tool activity takes priority when available (more specific).
 */
function deriveStatusText(
	toolActivity: { toolName: string; label: string; filePath?: string } | null,
	status: string,
): string {
	if (toolActivity?.label) {
		return formatStatus(toolActivity.label);
	}
	const formatted = formatStatus(status);
	return formatted || 'Generating';
}

// Shared shimmer style
const shimmerStyle = {
	background:
		'linear-gradient(90deg, var(--vscode-descriptionForeground) 0%, var(--vscode-foreground) 50%, var(--vscode-descriptionForeground) 100%)',
	backgroundSize: '200% 100%',
	backgroundClip: 'text',
	WebkitBackgroundClip: 'text',
	color: 'transparent',
	animation: 'shimmer 3s linear infinite',
} as const;

// ---------------------------------------------------------------------------
// SubtaskGenerationStatus — props-driven variant for subtask cards.
// Reads status from the subtask message instead of the global session store.
// ---------------------------------------------------------------------------

interface SubtaskGenerationStatusProps {
	isRunning: boolean;
	status?: string;
	retryMessage?: string;
}

export const SubtaskGenerationStatus: React.FC<SubtaskGenerationStatusProps> = ({
	isRunning,
	status,
	retryMessage,
}) => {
	const [visible, setVisible] = useState(false);
	const [displayStatus, setDisplayStatus] = useState('');

	useEffect(() => {
		if (isRunning) {
			const timer = setTimeout(() => setVisible(true), 100);
			return () => clearTimeout(timer);
		}
		const timer = setTimeout(() => setVisible(false), 300);
		return () => clearTimeout(timer);
	}, [isRunning]);

	useEffect(() => {
		const raw = retryMessage || status || '';
		if (raw && raw !== 'Ready') {
			const timer = setTimeout(() => setDisplayStatus(formatStatus(raw)), 50);
			return () => clearTimeout(timer);
		}
		setDisplayStatus('');
		return undefined;
	}, [status, retryMessage]);

	if (!visible || !isRunning) return null;

	const isRetrying = !!retryMessage;
	const isThinking = !isRetrying && isThinkingStatus(displayStatus || status || '');
	const showStatus = displayStatus || 'Generating';

	return (
		<div
			className={cn(
				'flex items-center justify-start gap-1.5 py-2',
				'transition-all duration-300 ease-out',
				visible && isRunning ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
			)}
		>
			<StatusIcon isThinking={isThinking} />
			<span
				className={cn('text-xs relative inline-block', isRetrying && 'text-warning')}
				style={isRetrying ? undefined : shimmerStyle}
			>
				{showStatus}
				<TypingDots />
			</span>
		</div>
	);
};
SubtaskGenerationStatus.displayName = 'SubtaskGenerationStatus';

export const GenerationStatus: React.FC = () => {
	const isProcessing = useIsProcessing();
	const status = useChatStatus();
	const streamingToolId = useStreamingToolId();
	const isTextStreaming = useIsLastMessageStreaming();
	const toolActivity = useToolActivity();
	const [visible, setVisible] = useState(false);
	const [displayStatus, setDisplayStatus] = useState('');

	// Active stream means tool output or text is being streamed to the user.
	const hasActiveStream = !!streamingToolId || isTextStreaming;

	// Show the indicator when:
	// 1. Processing with no active stream (waiting between tool calls, model thinking)
	// 2. Processing with tool activity info (even during streams — shows what tool is running)
	const shouldShow = isProcessing && (!hasActiveStream || !!toolActivity);

	// Smooth show/hide with slight delay to prevent flicker
	useEffect(() => {
		if (shouldShow) {
			const timer = setTimeout(() => setVisible(true), 100);
			return () => clearTimeout(timer);
		}
		// Fade out with delay
		const timer = setTimeout(() => setVisible(false), 300);
		return () => clearTimeout(timer);
	}, [shouldShow]);

	// Update display status — tool activity takes priority over generic session status
	useEffect(() => {
		const text = deriveStatusText(toolActivity, status);
		if (text) {
			const timer = setTimeout(() => setDisplayStatus(text), 50);
			return () => clearTimeout(timer);
		}
		setDisplayStatus('');
		return undefined;
	}, [toolActivity, status]);

	// Don't render if not visible or not processing
	if (!visible || !isProcessing) {
		return null;
	}

	const isThinking = isThinkingStatus(displayStatus || status);
	const showStatus = displayStatus || (isProcessing ? 'Generating' : '');

	// When there's an active stream but we have tool activity, show a compact inline indicator
	const isCompact = hasActiveStream && !!toolActivity;

	return (
		<div
			className={cn(
				'flex items-center justify-start gap-1.5',
				isCompact ? 'py-1' : 'py-2',
				'transition-all duration-300 ease-out',
				visible && isProcessing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
				isCompact && 'opacity-70',
			)}
		>
			<StatusIcon isThinking={isThinking} />
			<span
				className={cn('text-xs relative inline-block', isCompact && 'text-[10px]')}
				style={shimmerStyle}
			>
				{showStatus}
				<TypingDots />
			</span>
			<style>
				{`
					@keyframes shimmer {
						0% { background-position: 200% 0; }
						100% { background-position: -200% 0; }
					}
				`}
			</style>
		</div>
	);
};

GenerationStatus.displayName = 'GenerationStatus';
