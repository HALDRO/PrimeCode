/**
 * @file StatsDisplay - unified statistics display component
 * @description Single component for displaying session/message statistics.
 *              Accepts array of stat items and renders them with consistent styling.
 *              Supports modes: 'message', 'panel', 'footer', 'tooltip'.
 */

import type React from 'react';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { cn } from '../../lib/cn';
import {
	useDerivedSessionStats,
	useModelContextWindow,
	useSessionContextMetrics,
	useSubagentTokenTotals,
} from '../../store';
import { formatCost, formatDuration, formatNumber } from '../../utils/format';
import { BotIcon, HashIcon, TagIcon, TimerIcon, TokensIcon } from '../icons';
import { Tooltip } from './Tooltip';

export interface StatItem {
	key: string;
	value: ReactNode;
	icon?: ReactNode;
	tooltip?: string;
	variant?: 'default' | 'success' | 'added' | 'removed';
	hideOnNarrow?: boolean;
	onClick?: () => void;
}

interface StatsDisplayProps {
	items: StatItem[];
	mode?: 'message' | 'panel' | 'footer' | 'tooltip';
	style?: CSSProperties;
	className?: string;
	restoreButton?: ReactNode;
}

const CONTAINER_CLASSES: Record<NonNullable<StatsDisplayProps['mode']>, string> = {
	message:
		'flex items-center justify-end gap-(--gap-3) text-sm px-(--gap-3) h-(--input-toolbar-height) mt-auto',
	panel: 'flex items-center gap-(--gap-3) text-(--changed-files-font-size)',
	footer:
		'flex items-center justify-center gap-(--gap-3) h-(--tool-header-height) px-(--gap-3) text-(--changed-files-font-size) font-(family-name:--vscode-font-family)',
	tooltip: 'flex items-center h-full gap-(--gap-6) text-xs whitespace-nowrap',
};

const VARIANT_CLASSES: Record<string, string> = {
	default:
		'flex items-center gap-(--gap-1) text-sm leading-none text-vscode-foreground opacity-90 min-w-0',
	success: 'flex items-center gap-(--gap-1) text-sm leading-none text-success opacity-100 min-w-0',
	added: 'flex items-center gap-(--gap-1) text-sm leading-none text-success opacity-100 min-w-0',
	removed: 'flex items-center gap-(--gap-1) text-sm leading-none text-error opacity-100 min-w-0',
};

const StatItemRenderer: React.FC<{ item: StatItem }> = ({ item }) => {
	const className = VARIANT_CLASSES[item.variant || 'default'];
	const fullClassName = cn(className, item.hideOnNarrow && 'hide-on-narrow');

	const content = (
		<span
			className={fullClassName}
			style={item.onClick ? { cursor: 'pointer' } : undefined}
			onClick={item.onClick}
			onKeyDown={item.onClick ? e => e.key === 'Enter' && item.onClick?.() : undefined}
			role={item.onClick ? 'button' : undefined}
			tabIndex={item.onClick ? 0 : undefined}
		>
			{item.icon}
			{item.value}
		</span>
	);

	if (item.tooltip) {
		return (
			<Tooltip content={item.tooltip} position="top" delay={200}>
				{content}
			</Tooltip>
		);
	}

	return content;
};

export const StatsDisplay: React.FC<StatsDisplayProps> = ({
	items,
	mode = 'message',
	style,
	className,
	restoreButton,
}) => {
	if (mode !== 'footer' && items.length === 0 && !restoreButton) {
		return null;
	}

	return (
		<div className={cn(CONTAINER_CLASSES[mode], className)} style={style}>
			{restoreButton}
			{items.map(item => (
				<StatItemRenderer key={item.key} item={item} />
			))}
		</div>
	);
};
StatsDisplay.displayName = 'StatsDisplay';

export const SessionStatsDisplay: React.FC<{
	mode: 'footer' | 'tooltip';
	style?: CSSProperties;
	className?: string;
	leftContent?: ReactNode;
}> = ({ mode, style, className, leftContent }) => {
	const derivedStats = useDerivedSessionStats();
	const contextLimit = useModelContextWindow();
	const subagentTokensTotal = useSubagentTokenTotals();
	const sessionMetrics = useSessionContextMetrics();

	const items = useMemo<StatItem[]>(() => {
		// Session token snapshot from the latest assistant message.
		const context = sessionMetrics.context;
		const windowUsed = context?.total ?? 0;
		const inputTokens = context?.input ?? 0;
		const cacheRead = context?.cacheRead ?? 0;
		const percentage = Math.min((windowUsed / contextLimit) * 100, 100);

		const tokenParts = [`${formatNumber(windowUsed)} / ${formatNumber(contextLimit)}`];
		tokenParts.push(`(${percentage.toFixed(1)}%)`);

		// Show cache hit rate inline when cache data is consistent
		// (cacheRead must be <= inputTokens to be from the same snapshot)
		if (cacheRead > 0 && inputTokens > 0 && cacheRead <= inputTokens) {
			const cacheHitRate = Math.round((cacheRead / inputTokens) * 100);
			tokenParts.push(`· ${cacheHitRate}% cached`);
		}

		const result: StatItem[] = [];

		result.push({
			key: 'tokens',
			icon: <TokensIcon size={11} />,
			value: tokenParts.join(' '),
			tooltip:
				cacheRead > 0 && inputTokens > 0 && cacheRead <= inputTokens
					? `Latest token snapshot: ${formatNumber(windowUsed)} / ${formatNumber(contextLimit)} · Cache read: ${formatNumber(cacheRead)} of ${formatNumber(inputTokens)} input tokens`
					: 'Latest token snapshot / model limit',
		});

		if (subagentTokensTotal > 0) {
			result.push({
				key: 'subagent-tokens',
				icon: <BotIcon size={11} />,
				value: formatNumber(subagentTokensTotal),
				tooltip: 'Total subagent tokens',
			});
		}

		if (sessionMetrics.totalCost > 0) {
			result.push({
				key: 'cost',
				icon: <TagIcon size={11} />,
				value: formatCost(sessionMetrics.totalCost),
				tooltip: 'Total cost',
			});
		}

		if (derivedStats.requestCount > 0) {
			result.push({
				key: 'requests',
				icon: <HashIcon size={11} />,
				value: `${derivedStats.requestCount} Req`,
				tooltip: 'Total API requests',
			});
		}

		if (derivedStats.subagentCount > 0) {
			result.push({
				key: 'subagents',
				icon: <BotIcon size={11} />,
				value: `${derivedStats.subagentCount} Sub`,
				tooltip: 'Total subagent invocations',
			});
		}

		if (derivedStats.totalDuration > 0) {
			result.push({
				key: 'duration',
				icon: <TimerIcon size={11} />,
				value: formatDuration(derivedStats.totalDuration),
				tooltip: 'Total model duration',
			});
		}

		return result;
	}, [derivedStats, contextLimit, subagentTokensTotal, sessionMetrics]);

	return (
		<StatsDisplay
			mode={mode}
			items={items}
			style={style}
			className={className}
			restoreButton={leftContent}
		/>
	);
};
SessionStatsDisplay.displayName = 'SessionStatsDisplay';
