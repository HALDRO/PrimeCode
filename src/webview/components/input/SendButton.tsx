/**
 * @file Elegant Send/Stop button component for chat input
 * @description Minimalist animated button integrated into input area.
 * Features subtle hover effects, smooth state transitions between send/stop modes,
 * and refined visual feedback. Designed to complement the input field without
 * overwhelming the UI, following modern chat design best practices.
 * Uses custom Tooltip for hover hints.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { ContextWaterGlass } from '../chat/ContextWaterGlass';
import { StopIcon } from '../icons';
import { SessionStatsDisplay, Tooltip } from '../ui';

/** Custom filled send icon from Iconoir */
const SendFilledIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
	>
		<path
			fillRule="evenodd"
			d="M3.291 3.309a.75.75 0 0 0-.976.996l3.093 6.945H13a.75.75 0 0 1 0 1.5H5.408l-3.093 6.945a.75.75 0 0 0 .976.996l19-8a.75.75 0 0 0 0-1.382z"
			clipRule="evenodd"
		/>
	</svg>
);

interface SendButtonProps {
	/** Whether the AI is currently processing */
	isProcessing: boolean;
	/** Whether there's content to send */
	hasContent: boolean;
	/** Send handler */
	onSend: () => void;
	/** Stop handler */
	onStop: () => void;
}

export const SendButton: React.FC<SendButtonProps> = ({
	isProcessing,
	hasContent,
	onSend,
	onStop,
}) => {
	const [isHovered, setIsHovered] = useState(false);
	const [isPressed, setIsPressed] = useState(false);
	const [showPulse, setShowPulse] = useState(false);

	// Subtle pulse when content becomes available
	useEffect(() => {
		if (hasContent && !isProcessing) {
			setShowPulse(true);
			const timer = setTimeout(() => setShowPulse(false), 400);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [hasContent, isProcessing]);

	const handleClick = () => {
		if (isProcessing) {
			onStop();
		} else if (hasContent) {
			onSend();
		}
	};

	const isDisabled = !isProcessing && !hasContent;
	const isActive = hasContent || isProcessing;

	// Refined color palette
	const getIconColor = (): string => {
		if (isProcessing) {
			return isHovered ? 'var(--color-stop-hover)' : 'var(--color-stop)';
		}
		if (isDisabled) {
			return 'var(--vscode-foreground, rgba(255,255,255,0.8))';
		}
		if (isHovered || showPulse) {
			return 'var(--color-thinking)';
		}
		return 'var(--vscode-foreground)';
	};

	const getBackgroundColor = (): string => {
		if (isProcessing && isHovered) {
			return 'color-mix(in srgb, var(--color-stop) 12%, transparent)';
		}
		if (isActive && isHovered) {
			return 'color-mix(in srgb, var(--color-thinking) 15%, transparent)';
		}
		return 'transparent';
	};

	const tooltipContent = (
		<div className="flex flex-col gap-(--gap-2) py-(--gap-2)">
			{isProcessing && (
				<span className="text-xs text-vscode-foreground opacity-70">Click to stop generation</span>
			)}
			<SessionStatsDisplay mode="tooltip" />
		</div>
	);

	return (
		<Tooltip content={tooltipContent} position="top" delay={200}>
			<button
				type="button"
				onClick={handleClick}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => {
					setIsHovered(false);
					setIsPressed(false);
				}}
				onMouseDown={() => setIsPressed(true)}
				onMouseUp={() => setIsPressed(false)}
				disabled={isDisabled}
				className={cn(
					'relative w-(--send-btn-size) self-stretch m-(--send-btn-margin) border-none rounded-md flex items-center justify-center transition-all duration-200 overflow-hidden shrink-0',
					isDisabled ? 'cursor-default' : 'cursor-pointer',
					isPressed && 'scale-95',
				)}
				style={{
					background: getBackgroundColor(),
				}}
			>
				{/* Water glass context indicator */}
				<ContextWaterGlass isVisible={!isHovered} />

				{/* Icon with smooth transitions */}
				<div
					className={cn(
						'flex items-center justify-center transition-all duration-200',
						isHovered && !isDisabled && 'scale-110',
					)}
					style={{ color: getIconColor() }}
				>
					{isProcessing ? (
						<div className="flex items-center justify-center animate-[stopPulse_1.5s_ease-in-out_infinite]">
							<StopIcon size={18} />
						</div>
					) : (
						<SendFilledIcon size={18} />
					)}
				</div>

				{/* Subtle pulse ring */}
				{showPulse && !isProcessing && (
					<div className="absolute inset-(--send-btn-inset) rounded-[inherit] border-(length:--send-btn-border-width) border-solid border-(--color-thinking) opacity-60 animate-[subtlePulse_0.4s_ease-out_forwards] pointer-events-none" />
				)}

				{/* Processing indicator */}
				{isProcessing && (
					<div className="absolute bottom-(--gap-3) flex gap-(--gap-1)">
						{[0, 1, 2].map(i => (
							<div
								key={i}
								className="w-(--send-btn-dot-size) h-(--send-btn-dot-size) rounded-full bg-(--color-stop) opacity-80"
								style={{
									animation: `dotBounce 1s ease-in-out ${i * 0.15}s infinite`,
								}}
							/>
						))}
					</div>
				)}

				{/* Keyframes */}
				<style>
					{`
					@keyframes subtlePulse {
						0% {
							transform: scale(1);
							opacity: 0.6;
						}
						100% {
							transform: scale(1.15);
							opacity: 0;
						}
					}
					
					@keyframes stopPulse {
						0%, 100% { opacity: 1; }
						50% { opacity: 0.5; }
					}
					
					@keyframes dotBounce {
						0%, 80%, 100% {
							transform: translateY(0);
							opacity: 0.4;
						}
						40% {
							transform: translateY(-2px);
							opacity: 1;
						}
					}
				`}
				</style>
			</button>
		</Tooltip>
	);
};

export default SendButton;
