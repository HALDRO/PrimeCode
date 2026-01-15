/**
 * @file GenerationStatus - animated status indicator during model generation
 * @description Premium visual indicator showing current model activity status.
 *              Normalizes incoming status text (removes trailing dots/ellipsis) and
 *              renders animated typing dots to avoid duplicate static punctuation.
 *              Displays pulsing glow effects and status text.
 *              Only visible during active processing. Uses CSS animations for
 *              smooth, performant visual feedback without layout shifts.
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { useChatStatus, useIsProcessing, useMessages, useStreamingToolId } from '../../store';

/**
 * Animated typing dots indicator
 */
const TypingDots: React.FC = () => (
	<span className="inline-flex items-center gap-1 ml-2">
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '0ms', animationDuration: '600ms' }}
		/>
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '150ms', animationDuration: '600ms' }}
		/>
		<span
			className="w-1 h-1 rounded-full bg-current animate-bounce"
			style={{ animationDelay: '300ms', animationDuration: '600ms' }}
		/>
	</span>
);

/**
 * Pulsing glow ring animation
 */
const PulseRing: React.FC<{ color: string }> = ({ color }) => (
	<span
		className="absolute inset-0 rounded-full animate-ping opacity-30"
		style={{ backgroundColor: color }}
	/>
);

/**
 * Status icon with glow effect
 */
const StatusIcon: React.FC<{ isThinking: boolean }> = ({ isThinking }) => {
	const color = isThinking ? 'var(--color-thinking)' : 'var(--color-accent)';
	const glowColor = isThinking ? 'var(--glow-thinking)' : 'var(--glow-accent)';

	return (
		<span className="relative inline-flex items-center justify-center w-2.5 h-2.5">
			<PulseRing color={glowColor} />
			<span
				className="relative w-1.5 h-1.5 rounded-full z-10"
				style={{
					backgroundColor: color,
					boxShadow: `0 0 6px ${glowColor}, 0 0 12px ${glowColor}`,
				}}
			/>
		</span>
	);
};

/**
 * Format status text for display
 */
const formatStatus = (status: string): string => {
	if (!status || status === 'Ready') return '';

	const cleaned = status.trim();
	if (!cleaned) return '';

	// Remove trailing dot punctuation. We render animated dots separately.
	const withoutTrailingDots = cleaned.replace(/[.\u2026]+\s*$/, '').trim();
	if (!withoutTrailingDots) return '';

	return withoutTrailingDots.charAt(0).toUpperCase() + withoutTrailingDots.slice(1);
};

/**
 * Determine if status indicates thinking/reasoning
 */
const isThinkingStatus = (status: string): boolean => {
	const lower = status.toLowerCase();
	return (
		lower.includes('think') ||
		lower.includes('reason') ||
		lower.includes('analyz') ||
		lower.includes('process')
	);
};

export const GenerationStatus: React.FC = () => {
	const isProcessing = useIsProcessing();
	const status = useChatStatus();
	const streamingToolId = useStreamingToolId();
	const messages = useMessages();
	const [visible, setVisible] = useState(false);
	const [displayStatus, setDisplayStatus] = useState('');

	// Check if there's active text streaming (last assistant message is being updated)
	const lastMessage = messages[messages.length - 1];
	const isTextStreaming =
		lastMessage?.type === 'assistant' && lastMessage.content && lastMessage.content.length > 0;

	// Don't show status if there's active streaming (tool or text)
	const hasActiveStream = !!streamingToolId || isTextStreaming;

	// Smooth show/hide with slight delay to prevent flicker
	useEffect(() => {
		if (isProcessing && !hasActiveStream) {
			const timer = setTimeout(() => setVisible(true), 100);
			return () => clearTimeout(timer);
		}
		// Fade out with delay
		const timer = setTimeout(() => setVisible(false), 300);
		return () => clearTimeout(timer);
	}, [isProcessing, hasActiveStream]);

	// Update display status with debounce to prevent rapid changes
	useEffect(() => {
		if (status && status !== 'Ready') {
			const timer = setTimeout(() => setDisplayStatus(formatStatus(status)), 50);
			return () => clearTimeout(timer);
		}
		setDisplayStatus('');
		return undefined;
	}, [status]);

	// Don't render if not visible or has active stream
	if (!visible || hasActiveStream || !isProcessing) {
		return null;
	}

	const isThinking = isThinkingStatus(displayStatus || status);
	const showStatus = displayStatus || (isProcessing ? 'Generating' : '');

	return (
		<div
			className={cn(
				'flex items-center justify-start gap-2 py-2',
				'transition-all duration-300 ease-out',
				visible && isProcessing ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
			)}
		>
			<div
				className={cn(
					'inline-flex items-center gap-2 px-2.5 py-1 rounded-md',
					'bg-(--alpha-subtle)',
				)}
			>
				<StatusIcon isThinking={isThinking} />
				<span
					className={cn(
						'text-xs font-medium',
						isThinking ? 'text-(--color-thinking)' : 'text-vscode-foreground opacity-60',
					)}
				>
					{showStatus}
					<TypingDots />
				</span>
			</div>
		</div>
	);
};

GenerationStatus.displayName = 'GenerationStatus';
