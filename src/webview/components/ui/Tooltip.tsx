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
	safePolygon,
	shift,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useRole,
	useTransitionStyles,
} from '@floating-ui/react';
import React, { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
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
	/** Allow hovering over the tooltip itself (for reading long content) */
	interactive?: boolean;
	/** Max width for tooltip content in pixels (default: none) */
	maxWidth?: number;
	/** Max height for tooltip content in pixels — enables scroll (default: none) */
	maxHeight?: number;
	/** Restrict flip to left/right only (never top/bottom). Auto-sizes maxWidth to available space. */
	sideOnly?: boolean;
}

const TOOLTIP_OFFSET =
	Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue('--tooltip-offset') || '',
	) || 6;

/** Tooltip content styles - uses VS Code native tooltip colors */
const tooltipContentClassName =
	'p-[var(--tooltip-padding-y)_var(--tooltip-padding-x)] bg-(--tooltip-bg) border border-(--tooltip-border) rounded-(--tooltip-radius) shadow-[var(--tooltip-shadow)] text-xs leading-[1.3] text-(--tooltip-fg) whitespace-nowrap';

/** Interactive tooltip - allows text wrapping and user interaction */
const tooltipContentInteractiveClassName =
	'p-[var(--tooltip-padding-y)_var(--tooltip-padding-x)] bg-(--tooltip-bg) border border-(--tooltip-border) rounded-(--tooltip-radius) shadow-[var(--tooltip-shadow)] text-xs leading-[1.4] text-(--tooltip-fg) whitespace-pre-wrap break-words';

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
	interactive?: boolean;
	maxWidth?: number;
	maxHeight?: number;
	sideOnly?: boolean;
}> = React.memo(
	({
		content,
		position,
		delay,
		referenceElement,
		onClose,
		interactive,
		maxWidth,
		maxHeight,
		sideOnly,
	}) => {
		const [isOpen, setIsOpen] = useState(true);

		// For sideOnly mode: compute available space on each side and pick the larger one
		const computedSideMaxWidth = useMemo(() => {
			if (!sideOnly) return undefined;
			const rect = referenceElement.getBoundingClientRect();
			const spaceLeft = rect.left - 16; // 16px padding from edge
			const spaceRight = window.innerWidth - rect.right - 16;
			return Math.max(spaceLeft, spaceRight, 120);
		}, [sideOnly, referenceElement]);

		const effectiveMaxWidth = maxWidth ?? computedSideMaxWidth;

		const middleware = useMemo(() => {
			if (sideOnly) {
				// Only flip between left and right, never to top/bottom
				return [
					offset(TOOLTIP_OFFSET),
					flip({
						fallbackPlacements: [position === 'right' ? 'left' : 'right'],
						padding: 8,
					}),
					shift({ padding: 8 }),
				];
			}
			return [
				offset(TOOLTIP_OFFSET),
				flip({ fallbackAxisSideDirection: 'start', padding: 8 }),
				shift({ padding: 8 }),
			];
		}, [sideOnly, position]);

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
			middleware,
		});

		const hover = useHover(context, {
			move: false,
			delay: { open: delay, close: interactive ? 150 : 0 },
			handleClose: interactive ? safePolygon() : undefined,
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
					pointerEvents: interactive ? 'auto' : 'none',
					...transitionStyles,
				}}
				{...getFloatingProps()}
			>
				<div
					className={interactive ? tooltipContentInteractiveClassName : tooltipContentClassName}
					style={{
						...(effectiveMaxWidth ? { maxWidth: `${effectiveMaxWidth}px` } : {}),
						...(maxHeight ? { maxHeight: `${maxHeight}px`, overflowY: 'auto' } : {}),
					}}
				>
					{content}
				</div>
			</div>,
			document.body,
		);
	},
);

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
		interactive = false,
		maxWidth,
		maxHeight,
		sideOnly = false,
	}) => {
		const [isActivated, setIsActivated] = useState(false);
		const [referenceElement, setReferenceElement] = useState<HTMLElement | null>(null);
		const isActivatedRef = useRef(false);

		const handleMouseEnter = useCallback(() => {
			if (!isActivatedRef.current) {
				isActivatedRef.current = true;
				setIsActivated(true);
			}
		}, []);

		const handleDeactivate = useCallback(() => {
			isActivatedRef.current = false;
			setIsActivated(false);
		}, []);

		// Stable wrapper style — only recompute when display or wrapperStyle actually change
		const wrapperCssRef = useRef<React.CSSProperties>({ display });
		const prevDisplayRef = useRef(display);
		const prevWrapperStyleRef = useRef(wrapperStyle);
		if (display !== prevDisplayRef.current || wrapperStyle !== prevWrapperStyleRef.current) {
			prevDisplayRef.current = display;
			prevWrapperStyleRef.current = wrapperStyle;
			wrapperCssRef.current = { display, ...wrapperStyle };
		}

		// Don't render tooltip if no content
		if (!content) {
			return <>{children}</>;
		}

		return (
			<>
				<span
					ref={setReferenceElement}
					style={wrapperCssRef.current}
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
						interactive={interactive}
						maxWidth={maxWidth}
						maxHeight={maxHeight}
						sideOnly={sideOnly}
					/>
				)}
			</>
		);
	},
);
Tooltip.displayName = 'Tooltip';
