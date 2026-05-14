/**
 * @file GenerationStatus - animated status indicator during model generation
 * @description Premium visual indicator showing current model activity status with smooth
 *              crossfade transitions between status texts. Uses a minimum display duration
 *              per status (STATUS_MIN_DISPLAY_MS) to prevent rapid flickering during fast
 *              tool transitions. All ref mutations happen inside useEffect (never during render)
 *              to prevent React error #185 (maximum update depth exceeded). The component
 *              stays visible throughout the entire processing window regardless of whether
 *              text or tool output is actively streaming.
 */

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useGenerationStatusSnapshot } from '../../store';

// ─── Configuration ───────────────────────────────────────────────────────────

/** Small delay before showing to prevent micro-flicker on fast transitions. */
const SHOW_DELAY_MS = 100;
/** Minimum time the indicator stays visible after processing ends. */
const SHOW_GRACE_PERIOD_MS = 600;
/** Delay before hiding after processing ends (respects grace period). */
const HIDE_DELAY_MS = 300;
/** Duration of the crossfade animation between status texts. */
const CROSSFADE_DURATION_MS = 200;

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Animated typing dots indicator */
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

/** Pulsing glow ring animation */
const PulseRing: React.FC<{ color: string }> = ({ color }) => (
	<span
		className="absolute inset-0 rounded-full animate-ping opacity-30"
		style={{ backgroundColor: color }}
	/>
);

/** Status icon with glow effect */
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

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Format status text for display — strips trailing dots, capitalizes. */
const formatStatus = (status: string): string => {
	if (!status || status === 'Ready') return '';
	const cleaned = status.trim();
	if (!cleaned) return '';
	const withoutTrailingDots = cleaned.replace(/[.\u2026]+\s*$/, '').trim();
	if (!withoutTrailingDots) return '';
	return withoutTrailingDots.charAt(0).toUpperCase() + withoutTrailingDots.slice(1);
};

/** Determine if status indicates thinking/reasoning */
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
// useAggregatedStatus — immediate status updates with crossfade animation.
// Deduplicates identical consecutive statuses to prevent re-render flicker
// when the same tool is invoked multiple times (e.g. two consecutive reads).
// ---------------------------------------------------------------------------

interface AggregatedStatusState {
	/** Currently displayed text */
	text: string;
	/** Whether the text is fading in (for crossfade) */
	isFadingIn: boolean;
}

function useAggregatedStatus(rawText: string, isActive: boolean): AggregatedStatusState {
	const [state, setState] = useState<AggregatedStatusState>({ text: '', isFadingIn: false });
	const currentTextRef = useRef('');
	const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!isActive) {
			// Reset when not active
			currentTextRef.current = '';
			setState({ text: '', isFadingIn: false });
			if (fadeTimerRef.current) {
				clearTimeout(fadeTimerRef.current);
				fadeTimerRef.current = null;
			}
			return;
		}

		const target = rawText || 'Generating';

		// Deduplicate — same text means same tool invoked again, skip animation
		if (target === currentTextRef.current) return;

		currentTextRef.current = target;

		// Commit with fade-in animation
		setState({ text: target, isFadingIn: true });

		// Clear previous fade timer
		if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
		fadeTimerRef.current = setTimeout(() => {
			fadeTimerRef.current = null;
			setState(prev => (prev.text === target ? { ...prev, isFadingIn: false } : prev));
		}, CROSSFADE_DURATION_MS);
	}, [rawText, isActive]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
		};
	}, []);

	return state;
}

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

	useEffect(() => {
		if (isRunning) {
			const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
			return () => clearTimeout(timer);
		}
		const timer = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [isRunning]);

	const rawStatusText = useMemo(() => {
		const raw = retryMessage || status || '';
		if (!raw || raw === 'Ready') return '';
		return formatStatus(raw);
	}, [status, retryMessage]);

	const { text: displayStatus, isFadingIn } = useAggregatedStatus(rawStatusText, isRunning);

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
				className={cn(
					'text-xs relative inline-block',
					isRetrying && 'text-warning',
					isFadingIn && 'animate-[statusFadeIn_200ms_ease-out]',
				)}
				style={isRetrying ? undefined : shimmerStyle}
			>
				{showStatus}
				<TypingDots />
			</span>
		</div>
	);
};
SubtaskGenerationStatus.displayName = 'SubtaskGenerationStatus';

export const GenerationStatus: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
	const { isProcessing, status, streamingToolId, isTextStreaming, toolActivity } =
		useGenerationStatusSnapshot(sessionId);
	const [visible, setVisible] = useState(false);
	const showTimestampRef = useRef(0);

	// ── Stabilize tool activity via useEffect (NEVER mutate refs during render) ──
	const lastToolActivityRef = useRef<typeof toolActivity>(null);
	useEffect(() => {
		if (toolActivity) {
			lastToolActivityRef.current = toolActivity;
		} else if (isTextStreaming && !streamingToolId) {
			lastToolActivityRef.current = null;
		}
	}, [toolActivity, isTextStreaming, streamingToolId]);

	// Derive stable tool activity — use current or last known during processing
	const stableToolActivity = useMemo(() => {
		if (!isProcessing) return null;
		return toolActivity ?? lastToolActivityRef.current;
	}, [isProcessing, toolActivity]);

	// Hide during pure text streaming — the model is just typing, no status needed.
	// Show only when: processing AND (not text-streaming OR has active tool).
	const shouldShow = isProcessing && (!isTextStreaming || !!streamingToolId);

	// ── Visibility with grace period ─────────────────────────────────────────
	useEffect(() => {
		if (shouldShow) {
			const timer = setTimeout(() => {
				showTimestampRef.current = Date.now();
				setVisible(true);
			}, SHOW_DELAY_MS);
			return () => clearTimeout(timer);
		}
		const elapsed = Date.now() - showTimestampRef.current;
		const remainingGrace = Math.max(0, SHOW_GRACE_PERIOD_MS - elapsed);
		const hideDelay = Math.max(HIDE_DELAY_MS, remainingGrace);
		const timer = setTimeout(() => setVisible(false), hideDelay);
		return () => clearTimeout(timer);
	}, [shouldShow]);

	// ── Aggregated status text with minimum display duration ──────────────────
	const rawStatusText = useMemo(
		() => deriveStatusText(stableToolActivity, status),
		[stableToolActivity, status],
	);
	const { text: displayStatus, isFadingIn } = useAggregatedStatus(rawStatusText, shouldShow);

	const isActive = visible && shouldShow;
	const isThinking = isThinkingStatus(displayStatus || status);
	const showStatus = displayStatus || (isProcessing ? 'Generating' : '');

	return (
		<div
			className={cn(
				'flex items-center justify-start gap-1.5',
				'transition-all duration-300 ease-out',
				isActive ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1 pointer-events-none',
			)}
			style={{ visibility: isActive ? 'visible' : 'hidden' }}
			aria-hidden={!isActive}
		>
			<StatusIcon isThinking={isThinking} />
			<span
				className={cn(
					'text-xs relative inline-block',
					isFadingIn && 'animate-[statusFadeIn_200ms_ease-out]',
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
					@keyframes statusFadeIn {
						from { opacity: 0; transform: translateY(2px); }
						to { opacity: 1; transform: translateY(0); }
					}
				`}
			</style>
		</div>
	);
};

GenerationStatus.displayName = 'GenerationStatus';
