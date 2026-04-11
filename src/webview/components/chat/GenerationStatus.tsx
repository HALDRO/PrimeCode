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
import { useEffect, useRef, useState } from 'react';
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
	const prevStatusRef = useRef('');

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
			const formatted = formatStatus(raw);
			if (formatted === prevStatusRef.current) return undefined;
			const delay = prevStatusRef.current ? 120 : 50;
			const timer = setTimeout(() => {
				prevStatusRef.current = formatted;
				setDisplayStatus(formatted);
			}, delay);
			return () => clearTimeout(timer);
		}
		prevStatusRef.current = '';
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
	const prevStatusRef = useRef('');

	// Active stream means tool output or text is being streamed to the user.
	const hasActiveStream = !!streamingToolId || isTextStreaming;

	// Show the indicator when:
	// 1. Processing with no active stream (waiting between tool calls, model thinking)
	// 2. Processing with tool activity info (even during streams — shows what tool is running)
	const shouldShow = isProcessing && (!hasActiveStream || !!toolActivity);

	// Grace period: once shown, keep visible for a minimum duration to prevent
	// rapid show→hide→show flickering during tool→text transitions.
	// The ref tracks when we last transitioned to "shown" state.
	const showTimestampRef = useRef(0);
	const SHOW_GRACE_PERIOD_MS = 600;
	const SHOW_DELAY_MS = 100;
	const HIDE_DELAY_MS = 300;

	useEffect(() => {
		if (shouldShow) {
			const timer = setTimeout(() => {
				showTimestampRef.current = Date.now();
				setVisible(true);
			}, SHOW_DELAY_MS);
			return () => clearTimeout(timer);
		}
		// When hiding, respect the grace period — ensure the status was visible
		// for at least SHOW_GRACE_PERIOD_MS before allowing it to hide.
		const elapsed = Date.now() - showTimestampRef.current;
		const remainingGrace = Math.max(0, SHOW_GRACE_PERIOD_MS - elapsed);
		const hideDelay = Math.max(HIDE_DELAY_MS, remainingGrace);
		const timer = setTimeout(() => setVisible(false), hideDelay);
		return () => clearTimeout(timer);
	}, [shouldShow]);

	// Update display status — tool activity takes priority over generic session status.
	// Debounce rapid status transitions to avoid visual flickering.
	useEffect(() => {
		const text = deriveStatusText(toolActivity, status);
		if (text) {
			// If status text is the same, skip the update to avoid unnecessary re-renders.
			if (text === prevStatusRef.current) return undefined;
			const delay = prevStatusRef.current ? 120 : 50;
			const timer = setTimeout(() => {
				prevStatusRef.current = text;
				setDisplayStatus(text);
			}, delay);
			return () => clearTimeout(timer);
		}
		prevStatusRef.current = '';
		setDisplayStatus('');
		return undefined;
	}, [toolActivity, status]);

	const isActive = visible && isProcessing;
	const isThinking = isThinkingStatus(displayStatus || status);
	const showStatus = displayStatus || (isProcessing ? 'Generating' : '');

	// When there's an active stream but we have tool activity, show a compact inline indicator
	const isCompact = hasActiveStream && !!toolActivity;

	// Always render the container to reserve layout space and prevent layout
	// shifts when the status appears/disappears. Use opacity + visibility to
	// hide without removing from the flow.
	return (
		<div
			className={cn(
				'flex items-center justify-start gap-1.5 py-2',
				'transition-all duration-300 ease-out',
				isActive ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none',
				isActive && isCompact && 'opacity-70',
			)}
			style={{ visibility: isActive ? 'visible' : 'hidden' }}
			aria-hidden={!isActive}
		>
			<StatusIcon isThinking={isThinking} />
			<span
				className={cn(
					'text-xs relative inline-block transition-opacity duration-200 ease-out',
					isCompact && 'text-[10px]',
				)}
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
