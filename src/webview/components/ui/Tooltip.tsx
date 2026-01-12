/**
 * @file Tooltip component - smart auto-positioning hover tooltip
 * @description Universal tooltip using @floating-ui/react for robust positioning.
 *              OPTIMIZED: Lazy initialization - floating-ui hooks only activate on first hover.
 *              This prevents 64+ tooltip instances from running expensive calculations on every render.
 *              Automatically flips and shifts to stay within viewport bounds.
 *              Minimalist dark design with smooth fade-in animation.
 */

import {
	autoUpdate,
	flip,
	offset,
	type Placement,
	shift,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useRole,
	useTransitionStyles,
} from '@floating-ui/react';
import React, { type ReactNode, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
	/** Content to display in tooltip - can be string or JSX */
	content: ReactNode;
	/** Preferred position relative to children (auto-flips if needed) */
	position?: TooltipPosition;
	/** Tooltip trigger element(s) */
	children: ReactNode;
	/** Delay before showing tooltip in ms (default: 0) */
	delay?: number;
	/** Additional styles for the wrapper */
	wrapperStyle?: React.CSSProperties;
	/** Additional class for the wrapper */
	className?: string;
	/** Whether the wrapper should be a block element */
	display?: 'block' | 'inline-block' | 'inline-flex' | 'flex' | 'contents';
}

const TOOLTIP_OFFSET =
	Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue('--tooltip-offset') || '',
	) || 6;

/** Tooltip content styles - minimalist dark design */
const tooltipContentClassName =
	'p-[var(--tooltip-padding-y)_var(--tooltip-padding-x)] bg-(--tooltip-bg) border border-(--alpha-10) rounded-(--tooltip-radius) shadow-[var(--tooltip-shadow)] text-xs leading-[1.3] text-(--alpha-90) whitespace-nowrap';

/**
 * Active Tooltip - only rendered when tooltip is activated
 * This component contains all the expensive floating-ui hooks
 */
const ActiveTooltip: React.FC<{
	content: ReactNode;
	position: TooltipPosition;
	delay: number;
	referenceElement: HTMLElement;
	onClose: () => void;
}> = React.memo(({ content, position, delay, referenceElement, onClose }) => {
	const [isOpen, setIsOpen] = useState(true);

	const { refs, floatingStyles, context } = useFloating({
		open: isOpen,
		onOpenChange: open => {
			setIsOpen(open);
			if (!open) {
				// Delay cleanup to allow animation
				setTimeout(onClose, 150);
			}
		},
		placement: position as Placement,
		whileElementsMounted: autoUpdate,
		elements: {
			reference: referenceElement,
		},
		middleware: [
			offset(TOOLTIP_OFFSET),
			flip({
				fallbackAxisSideDirection: 'start',
				padding: 8,
			}),
			shift({ padding: 8 }),
		],
	});

	const hover = useHover(context, {
		move: false,
		delay: { open: delay, close: 0 },
	});
	const focus = useFocus(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: 'tooltip' });

	const { getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

	const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
		duration: 100,
		initial: { opacity: 0 },
	});

	if (!isMounted) {
		return null;
	}

	return createPortal(
		<div
			ref={refs.setFloating}
			style={{
				...floatingStyles,
				zIndex:
					Number.parseInt(
						getComputedStyle(document.documentElement).getPropertyValue('--tooltip-z') || '',
						10,
					) || 10000,
				pointerEvents: 'none',
				...transitionStyles,
			}}
			{...getFloatingProps()}
		>
			<div className={tooltipContentClassName}>{content}</div>
		</div>,
		document.body,
	);
});

/**
 * Lightweight Tooltip wrapper - no floating-ui overhead until hover
 * Only activates expensive positioning logic on first mouseenter
 */
export const Tooltip: React.FC<TooltipProps> = React.memo(
	({
		content,
		position = 'top',
		children,
		delay = 0,
		wrapperStyle,
		className,
		display = 'inline-flex',
	}) => {
		const [isActivated, setIsActivated] = useState(false);
		const [referenceElement, setReferenceElement] = useState<HTMLElement | null>(null);

		const handleMouseEnter = useCallback(() => {
			if (!isActivated) {
				setIsActivated(true);
			}
		}, [isActivated]);

		const handleDeactivate = useCallback(() => {
			setIsActivated(false);
		}, []);

		const wrapperCss = useMemo(() => ({ display, ...wrapperStyle }), [display, wrapperStyle]);

		// Don't render tooltip if no content
		if (!content) {
			return <>{children}</>;
		}

		return (
			<>
				<span
					ref={setReferenceElement}
					style={wrapperCss}
					className={className}
					onMouseEnter={handleMouseEnter}
					onFocus={handleMouseEnter}
				>
					{children}
				</span>
				{isActivated && referenceElement && (
					<ActiveTooltip
						content={content}
						position={position}
						delay={delay}
						referenceElement={referenceElement}
						onClose={handleDeactivate}
					/>
				)}
			</>
		);
	},
);
Tooltip.displayName = 'Tooltip';
