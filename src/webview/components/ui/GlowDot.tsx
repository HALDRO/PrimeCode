/**
 * @file GlowDot - animated status indicator dot with glow effect
 * @description Compact visual indicator for status representation. Renders a small circular dot
 *              with customizable color and glow effect. Used across tool messages, thinking indicators,
 *              and status displays. Supports preset status variants (success, error, warning, info)
 *              or custom colors. Glow effect creates visual emphasis without being distracting.
 */

import type React from 'react';
import { cn } from '../../lib/cn';

type StatusVariant = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'processing';

interface GlowDotProps {
	/** Direct color value (overrides variant) */
	color?: string;
	/** Direct glow color value (overrides variant) */
	glow?: string;
	/** Dot size in pixels */
	size?: number;
	/** Preset status variant */
	variant?: StatusVariant;
}

const STATUS_COLORS: Record<StatusVariant, { color: string; glow: string }> = {
	success: { color: 'var(--color-success)', glow: 'var(--glow-success)' },
	error: { color: 'var(--color-error)', glow: 'var(--glow-error)' },
	warning: { color: 'var(--color-warning)', glow: 'var(--glow-warning)' },
	info: { color: 'var(--color-info)', glow: 'var(--glow-info)' },
	pending: { color: 'var(--color-pending)', glow: 'var(--glow-pending)' },
	processing: { color: 'var(--color-thinking)', glow: 'var(--glow-thinking)' },
};

export const GlowDot: React.FC<GlowDotProps> = ({ color, glow, size = 6, variant = 'pending' }) => {
	const statusColors = STATUS_COLORS[variant];
	const finalColor = color ?? statusColors.color;
	const finalGlow = glow ?? statusColors.glow;

	return (
		<span
			className={cn('inline-flex items-center justify-center shrink-0 align-middle rounded-full')}
			style={{
				width: `${size}px`,
				height: `${size}px`,
				minWidth: `${size}px`,
				minHeight: `${size}px`,
				backgroundColor: finalColor,
				boxShadow: `0 0 4px ${finalGlow}, 0 0 8px ${finalGlow}`,
			}}
			aria-hidden="true"
		/>
	);
};
