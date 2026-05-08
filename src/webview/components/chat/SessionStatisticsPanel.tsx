/**
 * @file SessionStatisticsPanel
 * @description Compact bottom context-fill indicator with a portal-rendered statistics popover.
 *              Four neutral threshold dots stay in the chat overlay, while Floating UI renders
 *              one-line usage rows in document.body above sticky chat stacking contexts.
 */

import {
	autoUpdate,
	flip,
	offset,
	shift,
	useClick,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useRole,
	useTransitionStyles,
} from '@floating-ui/react';
import type React from 'react';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useActiveSessionTreeUsageStats } from '../../store';
import type { SessionTreeUsageStats } from '../../store/sessionUsage';
import { formatCost, formatDuration, formatNumber } from '../../utils/format';

interface DetailRow {
	key: string;
	label: string;
	value: string;
	tone?: 'muted' | 'warning';
	emphasis?: boolean;
}

const CONTEXT_THRESHOLDS = [25, 50, 75, 100] as const;
const FLOATING_MIDDLEWARE = [offset(10), flip({ padding: 8 }), shift({ padding: 8 })];

function formatTokens(value: number): string {
	return value > 0 ? formatNumber(value) : '0';
}

function formatContext(stats: SessionTreeUsageStats): string {
	const context = stats.latestRootContext;
	if (!context) return 'Unavailable';
	const percentage = context.usage === null ? '' : ` (${context.usage.toFixed(1)}%)`;
	return `${formatNumber(context.total)} / ${formatNumber(context.limit)}${percentage}`;
}

function getContextUsage(stats: SessionTreeUsageStats): number | null {
	return stats.latestRootContext?.usage ?? null;
}

function buildDetailRows(stats: SessionTreeUsageStats): DetailRow[] {
	const rows: DetailRow[] = [
		{
			key: 'context-usage',
			label: 'Context usage',
			value: formatContext(stats),
			emphasis: true,
		},
		{
			key: 'total-tokens',
			label: 'Total tokens',
			value: formatTokens(stats.totalTokens),
			emphasis: true,
		},
		{
			key: 'session-tokens',
			label: 'Session tokens',
			value: formatTokens(stats.rootTokens),
		},
		{
			key: 'child-sessions',
			label: 'Subagents',
			value: formatNumber(stats.childSessionCount),
		},
		{
			key: 'subagent-tokens',
			label: 'Subagent tokens',
			value: formatTokens(stats.childTokens),
		},
		{
			key: 'cache-read',
			label: 'Cache read',
			value: formatTokens(stats.cacheRead),
		},
		{
			key: 'cache-write',
			label: 'Cache write',
			value: formatTokens(stats.cacheWrite),
		},
		{
			key: 'requests',
			label: 'Requests',
			value: formatNumber(stats.requestCount),
		},
		{
			key: 'cost',
			label: 'Cost',
			value: formatCost(stats.cost),
		},
		{
			key: 'duration',
			label: 'Duration',
			value: formatDuration(stats.durationMs),
		},
	];

	if (stats.incompleteUsageCount > 0) {
		rows.push({
			key: 'incomplete-usage',
			label: 'Incomplete usage',
			value: formatNumber(stats.incompleteUsageCount),
			tone: 'warning',
			emphasis: true,
		});
	}

	return rows;
}

function getDotClassName(usage: number | null, threshold: number): string {
	const filled = usage !== null && usage > threshold - 25;
	const hot = usage !== null && usage >= 75;

	return cn(
		'h-(--gap-2) w-(--gap-2) rounded-full transition-[background-color,opacity] duration-150',
		filled
			? 'bg-vscode-descriptionForeground opacity-85'
			: 'bg-vscode-descriptionForeground opacity-25',
		hot && filled && 'bg-warning opacity-95',
		usage === null && 'opacity-45 shadow-none',
	);
}

function getContextProgressWidth(usage: number | null): string {
	if (usage === null) return '0%';
	return `${Math.min(Math.max(usage, 0), 100)}%`;
}

export const SessionStatisticsPanel: React.FC = () => {
	const stats = useActiveSessionTreeUsageStats();
	const usage = getContextUsage(stats);
	const rows = useMemo(() => buildDetailRows(stats), [stats]);
	const [expanded, setExpanded] = useState(false);

	const { refs, floatingStyles, context } = useFloating({
		open: expanded,
		onOpenChange: setExpanded,
		placement: 'top',
		whileElementsMounted: autoUpdate,
		middleware: FLOATING_MIDDLEWARE,
	});
	const hover = useHover(context, { move: false, delay: { open: 0, close: 120 } });
	const focus = useFocus(context);
	const click = useClick(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: 'dialog' });
	const { getReferenceProps, getFloatingProps } = useInteractions([
		hover,
		focus,
		click,
		dismiss,
		role,
	]);
	const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
		duration: 100,
		initial: { opacity: 0 },
	});

	const ariaLabel =
		usage === null ? 'Context usage unavailable' : `Context usage ${usage.toFixed(1)}%`;

	return (
		<div className="pointer-events-none absolute left-1/2 bottom-(--gap-1) z-30 -translate-x-1/2 animate-fade-in">
			<div className="relative flex justify-center font-(family-name:--vscode-font-family)">
				<button
					ref={refs.setReference}
					type="button"
					aria-label={ariaLabel}
					aria-haspopup="dialog"
					aria-expanded={expanded}
					className={cn(
						'pointer-events-auto group/stat inline-flex h-(--h-xs) items-center justify-center gap-(--gap-2) rounded-sm border-none bg-transparent px-(--gap-1) cursor-pointer transition-opacity duration-150',
						'opacity-70 hover:opacity-100 focus:outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder',
						expanded && 'opacity-100',
					)}
					{...getReferenceProps()}
				>
					{CONTEXT_THRESHOLDS.map(threshold => (
						<span
							key={threshold}
							aria-hidden="true"
							className={getDotClassName(usage, threshold)}
						/>
					))}
				</button>

				{isMounted &&
					createPortal(
						<div
							ref={refs.setFloating}
							role="dialog"
							aria-label="Detailed session statistics"
							className="pointer-events-auto w-[min(220px,calc(100vw-var(--gap-7)*2))] overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-overlay) font-(family-name:--vscode-font-family) text-vscode-foreground shadow-[0_8px_28px_color-mix(in_srgb,var(--vscode-editor-background)_68%,transparent)] backdrop-blur-sm"
							style={{
								...floatingStyles,
								...transitionStyles,
								zIndex:
									Number.parseInt(
										getComputedStyle(document.documentElement).getPropertyValue('--tooltip-z') ||
											'',
										10,
									) || 10000,
							}}
							{...getFloatingProps()}
						>
							<div className="px-(--gap-5) py-(--gap-4)">
								<div className="mb-(--gap-4) h-(--gap-1) overflow-hidden rounded-full bg-(--alpha-muted)">
									<div
										className={cn(
											'h-full rounded-full bg-vscode-descriptionForeground transition-[width,background-color] duration-200',
											usage !== null && usage >= 75 && 'bg-warning',
										)}
										style={{ width: getContextProgressWidth(usage) }}
									/>
								</div>
								<div className="flex flex-col text-sm leading-none">
									{rows.map(row => (
										<div
											key={row.key}
											className={cn(
												'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-(--gap-5) border-b border-(--border-subtle) py-(--gap-2-5) last:border-b-0',
												row.emphasis && 'font-medium',
											)}
										>
											<span className="min-w-0 truncate text-vscode-foreground opacity-90">
												{row.label}
											</span>
											<span
												className={cn(
													'text-right tabular-nums whitespace-nowrap text-vscode-foreground',
													row.tone === 'warning' && 'text-warning',
													row.tone === 'muted' && 'text-vscode-descriptionForeground',
													row.emphasis ? 'opacity-100' : 'opacity-85',
												)}
											>
												{row.value}
											</span>
										</div>
									))}
								</div>
							</div>
						</div>,
						document.body,
					)}
			</div>
		</div>
	);
};

SessionStatisticsPanel.displayName = 'SessionStatisticsPanel';
