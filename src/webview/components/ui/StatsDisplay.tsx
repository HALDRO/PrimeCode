/**
 * @file StatsDisplay - unified statistics display component
 * @description Single component for displaying session/message statistics.
 *              Accepts array of stat items and renders them with consistent styling.
 *              Supports modes: 'message', 'panel', 'footer', 'tooltip'.
 */

import type React from 'react';
import { type CSSProperties, type ReactNode, useMemo } from 'react';
import { cn } from '../../lib/cn';
import { useModelContextWindow, useTokenStats, useTotalStats } from '../../store';
import { formatCost, formatDuration, formatNumber } from '../../utils/format';
import { HashIcon, TagIcon, TimerIcon, TokensIcon, ZapIcon } from '../icons';
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

export interface StatsDisplayProps {
	items: StatItem[];
	mode?: 'message' | 'panel' | 'footer' | 'tooltip';
	style?: CSSProperties;
	className?: string;
	restoreButton?: ReactNode;
}

const CONTAINER_CLASSES: Record<NonNullable<StatsDisplayProps['mode']>, string> = {
	message:
		'flex items-end justify-end gap-(--gap-3) text-sm px-(--gap-3) pt-(--gap-1) pb-(--gap-0-5) mt-auto',
	panel: 'flex items-center gap-(--gap-3) text-(--changed-files-font-size)',
	footer:
		'flex items-center justify-center gap-(--gap-3) h-(--tool-header-height) px-(--gap-3) text-(--changed-files-font-size) font-(family-name:--vscode-font-family) border-t border-(--panel-header-border) bg-black/15 rounded-t-lg',
	tooltip: 'flex items-center h-full gap-(--gap-6) text-xs whitespace-nowrap',
};

const VARIANT_CLASSES: Record<string, string> = {
	default:
		'flex items-end gap-(--gap-1) text-sm leading-none text-vscode-foreground opacity-90 min-w-0',
	success: 'flex items-end gap-(--gap-1) text-sm leading-none text-success opacity-100 min-w-0',
	added: 'flex items-end gap-(--gap-1) text-sm leading-none text-success opacity-100 min-w-0',
	removed: 'flex items-end gap-(--gap-1) text-sm leading-none text-error opacity-100 min-w-0',
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
	if (items.length === 0 && !restoreButton) {
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
}> = ({ mode, style, className }) => {
	const totalStats = useTotalStats();
	const tokenStats = useTokenStats();
	const contextLimit = useModelContextWindow();

	const items = useMemo<StatItem[]>(() => {
		const totalTokens = totalStats.totalTokensInput + totalStats.totalTokensOutput;
		const percentage = Math.min((totalTokens / contextLimit) * 100, 100);

		const result: StatItem[] = [
			{
				key: 'percentage',
				icon: <TokensIcon size={11} />,
				value: `${percentage.toFixed(1)}%`,
				tooltip: 'Context window usage',
			},
			{
				key: 'tokens',
				icon: <TokensIcon size={11} />,
				value: `${formatNumber(totalTokens)} / ${formatNumber(contextLimit)}`,
				tooltip: 'Tokens used / Context limit',
			},
		];

		if (tokenStats.cacheReadTokens > 0) {
			result.push({
				key: 'cache',
				icon: <ZapIcon size={11} />,
				value: formatNumber(tokenStats.cacheReadTokens),
				tooltip: 'Cache read tokens',
			});
		}

		if (totalStats.totalCost > 0) {
			result.push({
				key: 'cost',
				icon: <TagIcon size={11} />,
				value: formatCost(totalStats.totalCost),
				tooltip: 'Total cost',
			});
		}

		if (totalStats.requestCount > 0) {
			result.push({
				key: 'requests',
				icon: <HashIcon size={11} />,
				value: `${totalStats.requestCount} Req`,
				tooltip: 'Total API requests',
			});
		}

		if (totalStats.totalDuration && totalStats.totalDuration > 0) {
			result.push({
				key: 'duration',
				icon: <TimerIcon size={11} />,
				value: formatDuration(totalStats.totalDuration),
				tooltip: 'Total model duration',
			});
		}

		return result;
	}, [totalStats, tokenStats, contextLimit]);

	return <StatsDisplay mode={mode} items={items} style={style} className={className} />;
};
SessionStatsDisplay.displayName = 'SessionStatsDisplay';
