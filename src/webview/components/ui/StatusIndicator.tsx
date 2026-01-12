/**
 * @file StatusIndicator - unified status component
 * @description Accessible, consistent status indicator following best practices.
 * Supports different variants (success, error, warning, info, pending, processing)
 * and includes appropriate ARIA attributes for screen readers.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { GlowDot } from './GlowDot';

export type StatusVariant = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'processing';

interface StatusIndicatorProps {
	variant: StatusVariant;
	label?: string; // Optional text label
	showLabel?: boolean; // Whether to show label visually
	size?: number;
	className?: string;
}

const ARIA_LABELS: Record<StatusVariant, string> = {
	success: 'Success',
	error: 'Error',
	warning: 'Warning',
	info: 'Information',
	pending: 'Pending',
	processing: 'Processing',
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
	variant,
	label,
	showLabel = false,
	size = 6,
	className,
}) => {
	const ariaLabel = label || ARIA_LABELS[variant];

	return (
		<output
			className={cn('inline-flex items-center gap-1.5 ml-0.5', className)}
			aria-label={ariaLabel}
		>
			<GlowDot variant={variant} size={size} />
			{showLabel && (
				<span className="text-xs text-vscode-foreground opacity-90">
					{label || ARIA_LABELS[variant]}
				</span>
			)}
		</output>
	);
};
