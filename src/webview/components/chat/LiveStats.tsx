/**
 * @file LiveStats — isolated live-data components that tick/subscribe
 * independently, keeping heavy parents (UserMessage, SubtaskItem) stable.
 *
 * SubtaskTimer  — elapsed timer for subtask headerRight
 * LiveMessageStats — tokens + duration + time for UserMessage footer
 */

import React from 'react';
import { useElapsedTimer } from '../../hooks/useElapsedTimer';
import { useMessageTurnTokens } from '../../store';
import { formatDuration, formatTime, formatTokens } from '../../utils/format';
import type { SectionStats } from '../../utils/groupSections';
import { ClockIcon, TimerIcon, TokensIcon } from '../icons';
import type { StatItem } from '../ui';
import { StatsDisplay } from '../ui';

/* ── SubtaskItem timer ─────────────────────────────────────────────── */

interface SubtaskTimerProps {
	isRunning: boolean;
	startTime?: string | number;
	fallbackMs: number;
}

/**
 * Renders `<TimerIcon> + formatted duration` for SubtaskItem's headerRight.
 * While running — ticks live via useElapsedTimer.
 * When stopped — shows the static fallbackMs.
 */
export const SubtaskTimer = React.memo<SubtaskTimerProps>(
	({ isRunning, startTime, fallbackMs }) => {
		const liveElapsed = useElapsedTimer(isRunning, startTime);
		const displayDuration = isRunning ? liveElapsed : fallbackMs;

		if (displayDuration <= 0) return null;

		return (
			<span className="flex items-center gap-1">
				<TimerIcon size={11} />
				{formatDuration(displayDuration)}
			</span>
		);
	},
);
SubtaskTimer.displayName = 'SubtaskTimer';

/* ── UserMessage live stats (tokens + duration + time) ─────────────── */

interface LiveMessageStatsProps {
	/** Message ID for useMessageTurnTokens subscription */
	messageId: string;
	/** Whether the assistant is currently processing this message */
	isProcessing: boolean;
	/** Pre-computed section stats (static, from groupMessagesIntoSections) */
	stats: Pick<SectionStats, 'tokenCount' | 'durationMs' | 'nextUserMessageTs' | 'lastResponseTs'>;
	/** Message timestamp ISO string */
	messageTimestamp: string;
}

/**
 * Isolated right-side stats for UserMessage footer.
 * Subscribes to live token data + elapsed timer internally,
 * so UserMessage doesn't re-render on every tick or token update.
 */
export const LiveMessageStats = React.memo<LiveMessageStatsProps>(
	({ messageId, isProcessing, stats, messageTimestamp }) => {
		// Live subscriptions — isolated here
		const liveTurnTokens = useMessageTurnTokens(messageId);
		const liveElapsed = useElapsedTimer(isProcessing);

		const tokenCount = liveTurnTokens?.total ?? stats.tokenCount;

		// Duration priority chain
		const durationText = getDurationText(
			liveTurnTokens?.durationMs,
			stats.durationMs ?? undefined,
			stats.nextUserMessageTs ?? undefined,
			stats.lastResponseTs ?? undefined,
			messageTimestamp,
			isProcessing,
			liveElapsed,
		);

		const rightItems: StatItem[] = [];

		if (tokenCount) {
			rightItems.push({
				key: 'tokens',
				icon: <TokensIcon size={12} />,
				value: formatTokens(tokenCount),
				tooltip: 'Estimated tokens used',
			});
		}

		if (durationText) {
			rightItems.push({
				key: 'duration',
				icon: <TimerIcon size={12} />,
				value: durationText,
				tooltip: 'Processing time',
				variant: 'success',
			});
		}

		rightItems.push({
			key: 'time',
			icon: <ClockIcon size={12} />,
			value: formatTime(messageTimestamp),
			tooltip: 'Time sent',
		});

		return <StatsDisplay mode="message" items={rightItems} className="shrink-0" />;
	},
);
LiveMessageStats.displayName = 'LiveMessageStats';

/* ── helpers ───────────────────────────────────────────────────────── */

function getDurationText(
	liveDurationMs: number | undefined,
	statsDurationMs: number | undefined,
	nextUserMessageTs: number | undefined,
	lastResponseTs: number | undefined,
	messageTimestamp: string,
	isProcessing: boolean,
	liveElapsed: number,
): string | null {
	if (liveDurationMs && liveDurationMs > 0) return formatDuration(liveDurationMs);
	if (statsDurationMs && statsDurationMs > 0) return formatDuration(statsDurationMs);

	const ts = new Date(messageTimestamp).getTime();
	if (nextUserMessageTs) return formatDuration(nextUserMessageTs - ts);
	if (lastResponseTs) return formatDuration(lastResponseTs - ts);
	if (isProcessing && liveElapsed > 0) return formatDuration(liveElapsed);

	return null;
}
