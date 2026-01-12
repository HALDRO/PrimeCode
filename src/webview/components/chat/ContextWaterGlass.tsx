/**
 * @file Context usage "water glass" visualization
 * @description A vertical progress indicator that looks like a filling glass of water.
 *              Uses SVG animation for a realistic water surface effect.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { useModelContextWindow, useTotalStats } from '../../store';

interface ContextWaterGlassProps {
	isVisible?: boolean;
}

export const ContextWaterGlass: React.FC<ContextWaterGlassProps> = ({ isVisible = true }) => {
	const totalStats = useTotalStats();
	const contextLimit = useModelContextWindow();

	const totalTokens = totalStats.totalTokensInput + totalStats.totalTokensOutput;
	const percentage = Math.min((totalTokens / contextLimit) * 100, 100);

	// Water color based on fill level
	const getWaterColor = (opacityScale = 1) => {
		if (percentage > 90) {
			return `rgba(239, 68, 68, ${0.25 * opacityScale})`;
		} // Muted Red
		if (percentage > 70) {
			return `rgba(245, 158, 11, ${0.2 * opacityScale})`;
		} // Muted Amber
		return `rgba(168, 85, 247, ${0.15 * opacityScale})`; // Muted Purple
	};

	return (
		<div
			className={cn(
				'absolute inset-0 pointer-events-none overflow-hidden rounded-[inherit] transition-opacity duration-200',
				isVisible ? 'opacity-100' : 'opacity-0',
			)}
		>
			<svg
				width="100%"
				height="100%"
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				className="absolute bottom-0 left-0"
				aria-hidden="true"
			>
				<title>Context Usage</title>
				<defs>
					<linearGradient id="waterGradient" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="rgba(255,255,255,0.1)" />
						<stop offset="100%" stopColor="transparent" />
					</linearGradient>
					{/* Blur for depth of field on back wave */}
					<filter id="waveBlur">
						<feGaussianBlur in="SourceGraphic" stdDeviation="0.4" />
					</filter>
				</defs>

				<g
					style={{
						transform: `translateY(${100 - percentage}%)`,
						transition: 'transform 1.2s cubic-bezier(0.4, 0, 0.2, 1)',
					}}
				>
					{/* Back Rolling Wave */}
					<g filter="url(#waveBlur)">
						<path
							d="M 0 0 Q 15 3 30 0 T 60 0 T 90 0 T 120 0 T 150 0 T 180 0 T 210 0 V 100 H 0 Z"
							fill={getWaterColor(0.5)}
							className="transition-colors duration-700"
						>
							<animateTransform
								attributeName="transform"
								type="translate"
								from="0,1"
								to="-60,1"
								dur="7s"
								repeatCount="indefinite"
							/>
						</path>
					</g>

					{/* Front Rolling Wave */}
					<path
						d="M 0 0 Q 25 5 50 0 T 100 0 T 150 0 T 200 0 V 100 H 0 Z"
						fill={getWaterColor(1)}
						stroke="rgba(255,255,255,0.08)"
						strokeWidth="0.3"
						className="transition-colors duration-700"
					>
						<animateTransform
							attributeName="transform"
							type="translate"
							from="0,0"
							to="-100,0"
							dur="4s"
							repeatCount="indefinite"
						/>
					</path>

					{/* Surface Highlight (Moving with front wave) */}
					<path
						d="M 0 0 Q 25 5 50 0 T 100 0 T 150 0 T 200 0"
						fill="none"
						stroke="rgba(255,255,255,0.2)"
						strokeWidth="0.4"
						strokeLinecap="round"
					>
						<animateTransform
							attributeName="transform"
							type="translate"
							from="0,0"
							to="-100,0"
							dur="4s"
							repeatCount="indefinite"
						/>
					</path>

					{/* Bubbles for "alive" effect */}
					{[0, 1, 2, 3, 4].map(i => (
						<circle key={`bubble-${i}`} r={0.5 + (i % 3) * 0.5} fill="rgba(255,255,255,0.25)">
							<animate
								attributeName="cx"
								values={`${15 + i * 20};${25 + i * 20};${15 + i * 20}`}
								dur={`${2 + (i % 3)}s`}
								repeatCount="indefinite"
							/>
							<animate
								attributeName="cy"
								values="110;-10"
								dur={`${4 + (i % 4) * 1.5}s`}
								begin={`${i * 0.8}s`}
								repeatCount="indefinite"
							/>
							<animate
								attributeName="opacity"
								values="0;0.6;0"
								dur={`${4 + (i % 4) * 1.5}s`}
								begin={`${i * 0.8}s`}
								repeatCount="indefinite"
							/>
						</circle>
					))}
				</g>
			</svg>
		</div>
	);
};
