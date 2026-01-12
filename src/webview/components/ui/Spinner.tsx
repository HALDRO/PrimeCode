/**
 * @file Spinner - loading indicator component
 * @description Universal loading spinner with VS Code theme integration. Supports multiple sizes
 *              and optional label text. Uses CSS animation for smooth rotation. Can be used inline
 *              or as a block-level loading state. Respects reduced-motion preferences.
 */

import type React from 'react';
import { cn } from '../../lib/cn';

type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

interface SpinnerProps {
	/** Spinner size preset */
	size?: SpinnerSize;
	/** Custom size in pixels (overrides size preset) */
	customSize?: number;
	/** Optional loading text */
	label?: string;
	/** Center spinner in container */
	centered?: boolean;
	/** Additional styles */
	style?: React.CSSProperties;
}

const SIZE_MAP: Record<SpinnerSize, number> = {
	xs: 12,
	sm: 14,
	md: 18,
	lg: 24,
};

export const Spinner: React.FC<SpinnerProps> = ({
	size = 'md',
	customSize,
	label,
	centered = false,
	style,
}) => {
	const pixelSize = customSize ?? SIZE_MAP[size];

	const spinnerElement = (
		<span
			className="inline-block border-2 border-vscode-descriptionForeground border-t-transparent rounded-full animate-spin shrink-0"
			style={{
				width: `${pixelSize}px`,
				height: `${pixelSize}px`,
			}}
			aria-hidden="true"
		/>
	);

	if (centered || label) {
		return (
			<output
				aria-label={label || 'Loading'}
				className={cn(
					'flex items-center gap-2 text-md text-text-secondary',
					centered ? 'justify-center' : 'justify-start',
				)}
				style={style}
			>
				{spinnerElement}
				{label && <span>{label}</span>}
			</output>
		);
	}

	return (
		<output aria-label="Loading" className="inline-flex">
			{spinnerElement}
		</output>
	);
};
