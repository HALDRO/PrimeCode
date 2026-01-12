/**
 * @file Settings UI Components
 * @description Unified UI primitives for settings pages. Provides consistent styling for
 *              group titles, setting rows, status messages, expandable sections, and CLI status bars.
 *              All components follow the same compact design language with white/opacity colors.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import {
	AlertCircleIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	ExternalLinkIcon,
	RefreshIcon,
	TerminalIcon,
} from '../icons';
import { ScrollContainer, Tooltip } from '../ui';

// =============================================================================
// Group Title - Section header for settings groups
// =============================================================================

interface GroupTitleProps {
	children: React.ReactNode;
	className?: string;
}

export const GroupTitle: React.FC<GroupTitleProps> = ({ children, className }) => (
	<h3
		className={cn(
			'text-xs font-medium text-white/50 mb-(--gap-2) uppercase tracking-wide',
			className,
		)}
	>
		{children}
	</h3>
);

// =============================================================================
// Settings Group - Container for related settings
// =============================================================================

interface SettingsGroupProps {
	children: React.ReactNode;
	className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({ children, className }) => (
	<div
		className={cn(
			'border border-white/10 rounded overflow-hidden mb-(--gap-6) mx-(--gap-1) bg-white/2',
			className,
		)}
	>
		{children}
	</div>
);

// =============================================================================
// Setting Row - Individual setting with label and control
// =============================================================================

interface SettingRowProps {
	title: string;
	tooltip?: string;
	last?: boolean;
	children: React.ReactNode;
	className?: string;
}

export const SettingRow: React.FC<SettingRowProps> = ({
	title,
	tooltip,
	last = false,
	children,
	className,
}) => {
	const content = (
		<div
			className={cn(
				'flex items-center px-2.5 py-1.5 gap-2 min-h-(--settings-row-height)',
				!last && 'border-b border-white/6',
				'hover:bg-white/3 transition-colors',
				className,
			)}
		>
			<span className="flex-1 text-sm text-white/90 whitespace-nowrap">{title}</span>
			<div className="shrink-0 ml-auto">{children}</div>
		</div>
	);

	if (tooltip) {
		return (
			<Tooltip content={tooltip} position="top" delay={200} display="block">
				{content}
			</Tooltip>
		);
	}

	return content;
};

// =============================================================================
// Setting Row Actions - Container for action buttons/controls in a row
// =============================================================================

interface SettingRowActionsProps {
	children: React.ReactNode;
	className?: string;
}

export const SettingRowActions: React.FC<SettingRowActionsProps> = ({ children, className }) => (
	<div className={cn('flex items-center gap-(--gap-3)', className)}>{children}</div>
);

// =============================================================================
// Status Message - Loading/Success/Error indicator
// =============================================================================

interface StatusMessageProps {
	isLoading?: boolean;
	success?: boolean;
	error?: string | null;
	loadingText?: string;
	successText?: string;
	className?: string;
}

export const StatusMessage: React.FC<StatusMessageProps> = ({
	isLoading,
	success,
	error,
	loadingText = 'Processing...',
	successText = 'Done',
	className,
}) => {
	if (!isLoading && !success && !error) {
		return null;
	}

	return (
		<div
			className={cn(
				'text-2xs px-2 py-1 rounded flex items-center gap-1.5',
				isLoading && 'bg-blue-500/10 text-blue-400',
				success && 'bg-green-500/10 text-green-400',
				error && 'bg-red-500/10 text-red-400',
				className,
			)}
		>
			{isLoading && (
				<>
					<RefreshIcon size={9} className="animate-spin" />
					{loadingText}
				</>
			)}
			{success && !isLoading && (
				<>
					<CheckCircleIcon size={9} />
					{successText}
				</>
			)}
			{error && !isLoading && (
				<>
					<AlertCircleIcon size={9} />
					{error}
				</>
			)}
		</div>
	);
};

// =============================================================================
// Operation Status - compact inline feedback for user actions
// =============================================================================

interface OperationStatusProps {
	status: 'idle' | 'working' | 'success' | 'error';
	message?: string;
	className?: string;
}

export const OperationStatus: React.FC<OperationStatusProps> = ({ status, message, className }) => {
	if (status === 'idle') {
		return null;
	}

	const isLoading = status === 'working';
	const success = status === 'success';
	const error = status === 'error' ? (message ?? 'Error') : null;

	return (
		<StatusMessage
			isLoading={isLoading}
			success={success}
			error={error}
			loadingText={message || 'Working...'}
			successText={message || 'Done'}
			className={className}
		/>
	);
};

// =============================================================================
// Expandable Row - Collapsible section with chevron
// =============================================================================

interface ExpandableRowProps {
	title: string;
	subtitle?: string;
	badge?: React.ReactNode;
	statusDot?: 'connected' | 'disconnected' | 'none';
	expanded: boolean;
	onToggle: () => void;
	last?: boolean;
	children?: React.ReactNode;
}

export const ExpandableRow: React.FC<ExpandableRowProps> = ({
	title,
	subtitle,
	badge,
	statusDot = 'none',
	expanded,
	onToggle,
	last = false,
	children,
}) => (
	<div className={cn(!last && 'border-b border-white/6')}>
		<button
			type="button"
			onClick={onToggle}
			className="w-full flex items-center justify-between px-2.5 py-1.5 gap-2 min-h-(--settings-row-height) hover:bg-white/3 transition-colors"
		>
			<div className="flex items-center gap-2">
				{statusDot !== 'none' && (
					<div
						className={cn(
							'w-1.5 h-1.5 rounded-full',
							statusDot === 'connected' ? 'bg-green-500' : 'bg-white/20',
						)}
					/>
				)}
				<span
					className={cn(
						'text-sm',
						statusDot === 'connected' || statusDot === 'none' ? 'text-white/80' : 'text-white/50',
					)}
				>
					{title}
				</span>
				{badge}
			</div>
			<div className="flex items-center gap-2">
				{subtitle && <span className="text-2xs text-white/40">{subtitle}</span>}
				{expanded ? (
					<ChevronDownIcon size={12} className="text-white/40" />
				) : (
					<ChevronRightIcon size={12} className="text-white/40" />
				)}
			</div>
		</button>
		{expanded && <div className="bg-black/20 border-t border-white/5 space-y-0.5">{children}</div>}
	</div>
);

// =============================================================================
// Model List - Scrollable list of models with toggles
// =============================================================================

interface ModelListProps {
	children: React.ReactNode;
	maxHeight?: number;
	className?: string;
}

export const ModelList: React.FC<ModelListProps> = ({ children, maxHeight = 160, className }) => (
	<div className="p-(--gap-2)">
		<ScrollContainer
			className={cn('border border-white/10 rounded', className)}
			style={{ maxHeight }}
			autoHide="scroll"
		>
			<div className="divide-y divide-white/6">{children}</div>
		</ScrollContainer>
	</div>
);

// =============================================================================
// Model Item - Single model row in the list
// =============================================================================

interface ModelItemProps {
	name: string;
	id?: string;
	last?: boolean;
	children?: React.ReactNode;
}

export const ModelItem: React.FC<ModelItemProps> = ({ name, id, children }) => (
	<div className="flex items-center justify-between px-2.5 py-1.5 min-h-(--settings-row-height)">
		<span className="text-sm text-white/90 truncate flex-1" title={id || name}>
			{name}
		</span>
		<div className="flex items-center gap-2 shrink-0">{children}</div>
	</div>
);

// =============================================================================
// Status Indicator - Colored dot with optional text
// =============================================================================

interface StatusIndicatorProps {
	status: 'loading' | 'success' | 'error' | 'idle';
	text?: string;
	className?: string;
}

export const SettingsStatusIndicator: React.FC<StatusIndicatorProps> = ({
	status,
	text,
	className,
}) => {
	const colorMap = {
		loading: 'rgba(255, 255, 255, 0.5)',
		success: 'rgb(34, 197, 94)',
		error: 'rgb(239, 68, 68)',
		idle: 'rgba(255, 255, 255, 0.4)',
	};

	const color = colorMap[status];

	return (
		<span className={cn('font-medium flex items-center gap-1', className)} style={{ color }}>
			{status === 'loading' ? (
				<RefreshIcon size={10} className="animate-spin" />
			) : status === 'success' ? (
				<CheckCircleIcon size={10} />
			) : status === 'error' ? (
				<AlertCircleIcon size={10} />
			) : null}
			{text && <span>{text}</span>}
		</span>
	);
};

// =============================================================================
// Badge - Small label tag
// =============================================================================

interface SettingsBadgeProps {
	children: React.ReactNode;
	variant?: 'default' | 'blue' | 'purple' | 'green';
	className?: string;
}

export const SettingsBadge: React.FC<SettingsBadgeProps> = ({
	children,
	variant = 'default',
	className,
}) => {
	const variantClasses = {
		default: 'bg-white/8 text-white/60',
		blue: 'bg-blue-500/20 text-blue-400',
		purple: 'bg-purple-500/20 text-purple-400',
		green: 'bg-green-500/20 text-green-400',
	};

	return (
		<span className={cn('text-2xs px-1 rounded', variantClasses[variant], className)}>
			{children}
		</span>
	);
};

// =============================================================================
// Error Box - Error message container
// =============================================================================

interface ErrorBoxProps {
	children: React.ReactNode;
	className?: string;
}

export const ErrorBox: React.FC<ErrorBoxProps> = ({ children, className }) => (
	<div
		className={cn(
			'mx-2.5 mb-1.5 p-1.5 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400',
			className,
		)}
	>
		{children}
	</div>
);

// =============================================================================
// Empty State - Placeholder for empty lists
// =============================================================================

interface EmptyStateProps {
	children: React.ReactNode;
	className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ children, className }) => (
	<div className={cn('px-2.5 py-2 text-sm text-white/50', className)}>{children}</div>
);

// =============================================================================
// CLI Status Bar - Unified status component for CLI providers
// =============================================================================

interface CLIStatusBarProps {
	variant: 'claude' | 'opencode';
	isChecking: boolean;
	installed: boolean;
	version?: string;
	updateAvailable?: boolean;
	isLoadingProviders?: boolean;
	error?: string;
	onRefresh: () => void;
	onOpenDocs: () => void;
}

const CLI_CONFIG = {
	claude: {
		name: 'Claude CLI',
		package: '@anthropic-ai/claude-code',
		docsUrl: 'https://docs.anthropic.com/en/docs/claude-code',
	},
	opencode: {
		name: 'OpenCode CLI',
		package: '@opencode-ai/cli',
		docsUrl: 'https://opencode.ai/docs',
	},
} as const;

export const CLIStatusBar: React.FC<CLIStatusBarProps> = ({
	variant,
	isChecking,
	installed,
	version,
	updateAvailable,
	isLoadingProviders,
	error,
	onRefresh,
	onOpenDocs,
}) => {
	const [copied, setCopied] = useState(false);
	const config = CLI_CONFIG[variant];

	const handleCopy = () => {
		navigator.clipboard.writeText(`npm install -g ${config.package}`);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	// Status color logic - error takes priority
	const statusColor = error
		? 'rgb(239, 68, 68)'
		: isChecking
			? 'rgba(255, 255, 255, 0.5)'
			: installed
				? updateAvailable
					? 'rgb(251, 191, 36)'
					: 'rgb(34, 197, 94)'
				: 'rgb(239, 68, 68)';

	// Status text logic - error takes priority
	const statusText = error
		? error
		: isChecking
			? 'Checking...'
			: installed
				? updateAvailable
					? 'Update available'
					: variant === 'claude'
						? 'Up to date'
						: 'Connected'
				: 'Not installed';

	// Show install command when not installed OR (for claude) when update available
	const showInstallCommand =
		!error && (variant === 'claude' ? updateAvailable || !installed : !installed && !isChecking);

	return (
		<div className="mt-2.5 p-2.5 mx-(--gap-1) bg-white/3 border border-white/8 rounded text-xs">
			{/* Header row */}
			<div className={cn('flex items-center justify-between', showInstallCommand && 'mb-2')}>
				<div className="flex items-center gap-1.5">
					<TerminalIcon size={12} className="opacity-60" />
					<span className="text-white/60 font-medium">{config.name}</span>
					{version && (
						<span className="px-(--gap-2) py-px bg-white/8 rounded-sm text-white/70">
							v{version}
						</span>
					)}
					<span className="font-medium" style={{ color: statusColor }}>
						{isChecking ? (
							<RefreshIcon size={10} className="animate-spin" />
						) : error || !installed ? (
							<AlertCircleIcon size={10} />
						) : (
							<CheckCircleIcon size={10} />
						)}
					</span>
					<span style={{ color: statusColor }}>{statusText}</span>
				</div>
				<div className="flex items-center gap-1">
					<Tooltip content="Refresh" position="top" delay={200}>
						<button
							type="button"
							onClick={onRefresh}
							disabled={isChecking}
							className={cn(
								'bg-none border-none p-(--gap-1)_(--gap-2) text-white/50 flex items-center rounded-sm',
								isChecking
									? 'cursor-not-allowed opacity-50'
									: 'cursor-pointer hover:bg-white/10 hover:text-white/80',
							)}
						>
							<RefreshIcon size={11} />
						</button>
					</Tooltip>
					<Tooltip content="Documentation" position="top" delay={200}>
						<button
							type="button"
							onClick={onOpenDocs}
							className="bg-none border-none p-(--gap-1)_(--gap-2) cursor-pointer text-white/50 flex items-center rounded-sm hover:bg-white/10 hover:text-white/80"
						>
							<ExternalLinkIcon size={11} />
						</button>
					</Tooltip>
				</div>
			</div>

			{/* Install/Update command */}
			{showInstallCommand && (
				<div className="flex items-center gap-1.5 p-(--gap-2)_(--gap-3) bg-black/30 hover:bg-black/30 rounded-sm">
					<code className="flex-1 text-xs">
						<span className="text-[#e5c07b]">npm</span>
						<span className="text-white/90"> i -g </span>
						<span className="text-[#98c379]">{config.package}</span>
					</code>
					<Tooltip content={copied ? 'Copied!' : 'Copy command'} position="top" delay={200}>
						<button
							type="button"
							onClick={handleCopy}
							className={cn(
								'bg-none border-none p-0.5 cursor-pointer flex items-center rounded-sm',
								copied ? 'text-green-500' : 'text-white/50',
							)}
						>
							{copied ? <CheckCircleIcon size={11} /> : <CopyIcon size={11} />}
						</button>
					</Tooltip>
				</div>
			)}

			{/* Loading providers state (OpenCode only) */}
			{variant === 'opencode' && installed && isLoadingProviders && !error && (
				<div className="mt-2 pt-2 border-t border-white/6 flex items-center gap-1.5">
					<RefreshIcon size={10} className="animate-spin text-white/50" />
					<span className="text-white/50">Loading providers...</span>
				</div>
			)}
		</div>
	);
};
