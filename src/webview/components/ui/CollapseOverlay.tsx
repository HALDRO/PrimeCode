/**
 * @file CollapseOverlay - compact bottom-attached collapse control
 * @description Renders a small bottom-centered chevron tab for collapsing expanded blocks.
 *              Intended to be mounted only inside expanded content areas, within a `relative` container.
 *              Uses an SVG-backed shape so the angled sides reach the bottom edge with a smooth outline.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { ChevronDownIcon } from '../icons';

interface CollapseOverlayProps {
	visible: boolean;
	onCollapse: () => void;
	className?: string;
	/** Tooltip/aria label only (no visible text). */
	label?: string;
}

export const CollapseOverlay: React.FC<CollapseOverlayProps> = ({
	visible,
	onCollapse,
	className,
	label = 'Collapse',
}) => {
	if (!visible) {
		return null;
	}

	return (
		<div
			className={cn(
				'pointer-events-none absolute inset-x-0 bottom-0 flex justify-center',
				className,
			)}
		>
			<button
				type="button"
				onClick={onCollapse}
				aria-label={label}
				title={label}
				className={cn(
					'pointer-events-auto relative',
					'flex items-center justify-center',
					'h-6 w-20',
					'bg-transparent border-none p-0',
					'opacity-85 hover:opacity-100',
					'transition-[opacity,transform] duration-150 ease-out',
					'active:translate-y-px',
				)}
				style={undefined}
			>
				<svg
					aria-hidden="true"
					viewBox="0 0 100 24"
					preserveAspectRatio="none"
					className="absolute inset-0 translate-y-px"
				>
					{/*
						Top is slightly narrower, bottom is full width.
						Side slopes are gentle and extend to the bottom edge.
						Bottom stroke is intentionally omitted to blend with the container border.
					*/}
					<path d="M20 1 H80 Q87 1 91 5 L99 24 H1 L9 5 Q13 1 20 1 Z" fill="var(--tool-bg-header)" />
					<path
						d="M1 24 L9 5 Q13 1 20 1 H80 Q87 1 91 5 L99 24"
						fill="none"
						stroke="var(--tool-border-color)"
						strokeWidth="1"
						vectorEffect="non-scaling-stroke"
						strokeLinejoin="round"
						strokeLinecap="round"
					/>
				</svg>
				<span className="relative flex items-center justify-center w-full h-full">
					<ChevronDownIcon size={16} className="rotate-180 opacity-90" />
				</span>
			</button>
		</div>
	);
};
