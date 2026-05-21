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
/** Small debounce before committing a new status to avoid flicker between rapid tool phases. */
const STATUS_COMMIT_DELAY_MS = 200;

// ─── Sub-components ──────────────────────────────────────────────────────────

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Format status text for display — trims and capitalizes. */
const formatStatus = (status: string): string => {
	if (!status || status === 'Ready') return '';
	const cleaned = status.trim();
	if (!cleaned) return '';
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

const statusTextBaseStyle = {
	color: 'var(--vscode-descriptionForeground)',
	filter: 'saturate(0.92)',
} as const;

const CharacterWaveText: React.FC<{ text: string; isRetrying?: boolean }> = ({
	text,
	isRetrying = false,
}) => {
	const chars = Array.from(text);
	const charCount = chars.length;
	// Scale animation duration based on text length so the wave traverses evenly.
	// Each character gets a staggered delay; total duration = wave travel time + single char highlight time.
	const perCharDelay = 70; // ms between each character's animation start
	const highlightDuration = 600; // ms for a single character's highlight phase
	const totalDuration = charCount * perCharDelay + highlightDuration;

	const occurrenceByChar = new Map<string, number>();
	return (
		<>
			{chars.map((char, index) => {
				const nextOccurrence = (occurrenceByChar.get(char) ?? 0) + 1;
				occurrenceByChar.set(char, nextOccurrence);
				return (
					<span
						key={`${char}-${nextOccurrence}`}
						className={cn(
							'relative inline-block whitespace-pre',
							!isRetrying && 'animate-[statusCharWave_ease-in-out_infinite]',
						)}
						style={
							isRetrying
								? undefined
								: {
										animationDuration: `${totalDuration}ms`,
										animationDelay: `${index * perCharDelay}ms`,
										willChange: 'color, opacity, text-shadow',
									}
						}
					>
						{char}
					</span>
				);
			})}
		</>
	);
};

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
	/** Monotonic version used to remount animated text consistently on committed changes. */
	version: number;
}

function useAggregatedStatus(rawText: string, isActive: boolean): AggregatedStatusState {
	const [state, setState] = useState<AggregatedStatusState>({
		text: '',
		isFadingIn: false,
		version: 0,
	});
	const currentTextRef = useRef('');
	const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const versionRef = useRef(0);

	useEffect(() => {
		if (!isActive) {
			// Reset when not active
			currentTextRef.current = '';
			setState(prev => ({ ...prev, text: '', isFadingIn: false }));
			if (fadeTimerRef.current) {
				clearTimeout(fadeTimerRef.current);
				fadeTimerRef.current = null;
			}
			if (commitTimerRef.current) {
				clearTimeout(commitTimerRef.current);
				commitTimerRef.current = null;
			}
			return;
		}

		const target = rawText.trim();
		if (!target) {
			if (commitTimerRef.current) {
				clearTimeout(commitTimerRef.current);
				commitTimerRef.current = null;
			}
			return;
		}

		// Deduplicate — same text means same tool invoked again, skip animation
		if (target === currentTextRef.current) return;

		if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
		commitTimerRef.current = setTimeout(() => {
			commitTimerRef.current = null;
			currentTextRef.current = target;
			versionRef.current += 1;

			// Commit with fade-in animation and bumped version to force text remount.
			setState({ text: target, isFadingIn: true, version: versionRef.current });

			// Clear previous fade timer
			if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
			fadeTimerRef.current = setTimeout(() => {
				fadeTimerRef.current = null;
				setState(prev => (prev.text === target ? { ...prev, isFadingIn: false } : prev));
			}, CROSSFADE_DURATION_MS);
		}, STATUS_COMMIT_DELAY_MS);
	}, [rawText, isActive]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
			if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
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

	const {
		text: displayStatus,
		isFadingIn,
		version,
	} = useAggregatedStatus(rawStatusText, isRunning);

	if (!visible || !isRunning) return null;

	const isRetrying = !!retryMessage;
	const showStatus = displayStatus || 'Generating';

	return (
		<div
			className={cn(
				'flex items-center justify-start gap-2 py-2 mt-[16px]',
				'transition-all duration-300 ease-out',
				visible && isRunning ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
			)}
		>
			<span
				className={cn(
					'text-sm font-medium relative inline-flex items-center leading-none',
					isRetrying && 'text-warning',
					isFadingIn && 'animate-[statusFadeIn_200ms_ease-out]',
				)}
				style={isRetrying ? undefined : statusTextBaseStyle}
			>
				<CharacterWaveText
					key={`${showStatus}:${version}`}
					text={showStatus}
					isRetrying={isRetrying}
				/>
			</span>
		</div>
	);
};
SubtaskGenerationStatus.displayName = 'SubtaskGenerationStatus';

export const GenerationStatus: React.FC<{
	sessionId?: string;
	className?: string;
}> = ({ sessionId, className }) => {
	const { isProcessing, phase, status } = useGenerationStatusSnapshot(sessionId);
	const [visible, setVisible] = useState(false);
	const showTimestampRef = useRef(0);

	const shouldShow = isProcessing && phase !== 'idle';

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
	const rawStatusText = useMemo(() => formatStatus(status), [status]);
	const {
		text: displayStatus,
		isFadingIn,
		version,
	} = useAggregatedStatus(rawStatusText, shouldShow);

	const isActive = visible && shouldShow;
	const showStatus = displayStatus || rawStatusText || 'Working';

	return (
		<div
			className={cn(
				'flex h-5 items-center justify-start gap-2 overflow-hidden whitespace-nowrap',
				'transition-opacity duration-200 ease-out',
				isActive ? 'opacity-100' : 'opacity-0 pointer-events-none',
				className,
			)}
			style={{ visibility: isActive ? 'visible' : 'hidden' }}
			aria-hidden={!isActive}
		>
			<span
				className={cn(
					'text-sm font-medium relative inline-flex items-center leading-none',
					isFadingIn && 'animate-[statusFadeIn_200ms_ease-out]',
				)}
				style={statusTextBaseStyle}
			>
				<CharacterWaveText key={`${showStatus}:${version}`} text={showStatus} />
			</span>
			<style>
				{`
					@keyframes statusCharWave {
						0%, 18%, 100% {
							color: var(--vscode-descriptionForeground);
							opacity: 0.88;
							text-shadow: none;
						}
						32% {
							color: color-mix(in srgb, var(--vscode-foreground) 50%, var(--vscode-descriptionForeground) 50%);
							opacity: 1;
							text-shadow: 0 0 8px color-mix(in srgb, var(--vscode-foreground) 12%, transparent 88%);
						}
						48% {
							color: color-mix(in srgb, var(--vscode-foreground) 24%, var(--vscode-descriptionForeground) 76%);
							opacity: 0.96;
							text-shadow: 0 0 4px color-mix(in srgb, var(--vscode-foreground) 8%, transparent 92%);
						}
						62%, 82% {
							color: var(--vscode-descriptionForeground);
							opacity: 0.88;
							text-shadow: none;
						}
					}
					@keyframes statusFadeIn {
						from { opacity: 0; transform: translateY(1px); }
						to { opacity: 1; transform: translateY(0); }
					}
				`}
			</style>
		</div>
	);
};

GenerationStatus.displayName = 'GenerationStatus';
