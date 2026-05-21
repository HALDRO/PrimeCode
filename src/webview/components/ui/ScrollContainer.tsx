import React, {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { cn } from '../../lib/cn';

// ── Shared thumb hook ──────────────────────────────────────────────

function useScrollThumb(
	scrollerRef: React.RefObject<HTMLDivElement | null>,
	config: {
		autoHide: string;
		autoHideDelay: number;
		minThumbHeight: number;
		orientation: 'vertical' | 'horizontal';
		alwaysVisible?: boolean;
	},
) {
	const { autoHide, autoHideDelay, minThumbHeight, orientation, alwaysVisible } = config;
	const trackRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);
	const hideTimerRef = useRef(0);
	const dragRef = useRef<{ startPointerOffset: number; startScrollOffset: number } | null>(null);

	const [visible, setVisible] = useState(autoHide === 'never');
	const [hovered, setHovered] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [thumbState, setThumbState] = useState({ top: 0, height: 0, show: false });

	const updateThumb = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const viewportSize = orientation === 'horizontal' ? el.clientWidth : el.clientHeight;
		const scrollSize = orientation === 'horizontal' ? el.scrollWidth : el.scrollHeight;
		const scrollOffset = orientation === 'horizontal' ? el.scrollLeft : el.scrollTop;
		if (scrollSize <= viewportSize) {
			setThumbState({ top: 0, height: 0, show: false });
			return;
		}
		const ratio = viewportSize / scrollSize;
		const thumbH = Math.max(ratio * viewportSize, minThumbHeight);
		const maxTop = viewportSize - thumbH;
		const scrollRatio = scrollOffset / (scrollSize - viewportSize);
		setThumbState({ top: scrollRatio * maxTop, height: thumbH, show: true });
	}, [scrollerRef, minThumbHeight, orientation]);

	const showAndScheduleHide = useCallback(() => {
		if (autoHide === 'never') return;
		setVisible(true);
		window.clearTimeout(hideTimerRef.current);
		hideTimerRef.current = window.setTimeout(() => {
			if (!dragRef.current) setVisible(false);
		}, autoHideDelay);
	}, [autoHide, autoHideDelay]);

	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const onScroll = () => {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = requestAnimationFrame(() => {
				updateThumb();
				showAndScheduleHide();
			});
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		updateThumb();
		const ro = new ResizeObserver(() => updateThumb());
		ro.observe(el);
		return () => {
			el.removeEventListener('scroll', onScroll);
			ro.disconnect();
			cancelAnimationFrame(rafRef.current);
			window.clearTimeout(hideTimerRef.current);
		};
	}, [scrollerRef, updateThumb, showAndScheduleHide]);

	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const mo = new MutationObserver(() => {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = requestAnimationFrame(updateThumb);
		});
		mo.observe(el, { childList: true, subtree: true });
		return () => mo.disconnect();
	}, [scrollerRef, updateThumb]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const el = scrollerRef.current;
			if (!el) return;
			dragRef.current = {
				startPointerOffset: orientation === 'horizontal' ? e.clientX : e.clientY,
				startScrollOffset: orientation === 'horizontal' ? el.scrollLeft : el.scrollTop,
			};
			setDragging(true);
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
		},
		[scrollerRef, orientation],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!dragRef.current) return;
			const el = scrollerRef.current;
			if (!el) return;
			const viewportSize = orientation === 'horizontal' ? el.clientWidth : el.clientHeight;
			const scrollSize = orientation === 'horizontal' ? el.scrollWidth : el.scrollHeight;
			const thumbH = thumbState.height || minThumbHeight;
			const trackH = viewportSize - thumbH;
			if (trackH <= 0) return;
			const delta =
				orientation === 'horizontal'
					? e.clientX - dragRef.current.startPointerOffset
					: e.clientY - dragRef.current.startPointerOffset;
			const scrollDelta = (delta / trackH) * (scrollSize - viewportSize);
			if (orientation === 'horizontal') {
				el.scrollLeft = dragRef.current.startScrollOffset + scrollDelta;
			} else {
				el.scrollTop = dragRef.current.startScrollOffset + scrollDelta;
			}
		},
		[scrollerRef, thumbState.height, minThumbHeight, orientation],
	);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		dragRef.current = null;
		setDragging(false);
		(e.target as HTMLElement).releasePointerCapture(e.pointerId);
	}, []);

	const onTrackClick = useCallback(
		(e: React.MouseEvent) => {
			if (e.target !== trackRef.current) return;
			const el = scrollerRef.current;
			if (!el || !trackRef.current) return;
			const rect = trackRef.current.getBoundingClientRect();
			const clickY = orientation === 'horizontal' ? e.clientX - rect.left : e.clientY - rect.top;
			const viewportSize = orientation === 'horizontal' ? el.clientWidth : el.clientHeight;
			const scrollSize = orientation === 'horizontal' ? el.scrollWidth : el.scrollHeight;
			const nextOffset = (clickY / viewportSize) * (scrollSize - viewportSize);
			if (orientation === 'horizontal') {
				el.scrollLeft = nextOffset;
			} else {
				el.scrollTop = nextOffset;
			}
		},
		[scrollerRef, orientation],
	);

	const opacity = alwaysVisible
		? 0.7
		: dragging || hovered
			? 0.7
			: visible || autoHide === 'never'
				? 0.4
				: 0;

	return {
		trackRef,
		thumbState,
		opacity,
		dragging,
		hovered,
		setHovered,
		setVisible,
		showAndScheduleHide,
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onTrackClick,
	};
}

// ── Thumb renderer (shared) ────────────────────────────────────────

function ThumbUI({
	thumb,
	thumbWidth,
	scrollerRef,
	orientation,
	alwaysVisible,
	thumbColor,
	noHoverExpand,
}: {
	thumb: ReturnType<typeof useScrollThumb>;
	thumbWidth: number;
	scrollerRef: React.RefObject<HTMLDivElement | null>;
	orientation: 'vertical' | 'horizontal';
	alwaysVisible?: boolean;
	thumbColor?: string;
	noHoverExpand?: boolean;
}) {
	if (!thumb.thumbState.show) return null;
	const activeWidth = noHoverExpand
		? thumbWidth
		: alwaysVisible
			? thumbWidth + 2
			: thumb.hovered || thumb.dragging
				? thumbWidth + 2
				: thumbWidth;
	return (
		<div
			ref={thumb.trackRef}
			onClick={thumb.onTrackClick}
			onWheel={e => {
				const el = scrollerRef.current;
				if (!el) return;
				if (orientation === 'horizontal') {
					el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
					return;
				}
				el.scrollTop += e.deltaY;
			}}
			onMouseEnter={() => {
				thumb.setHovered(true);
				thumb.setVisible(true);
			}}
			onMouseLeave={() => {
				thumb.setHovered(false);
				if (!thumb.dragging) thumb.showAndScheduleHide();
			}}
			style={{
				position: 'absolute',
				top: orientation === 'horizontal' ? 'auto' : 0,
				right: orientation === 'horizontal' ? 0 : 0,
				bottom: orientation === 'horizontal' ? 0 : 'auto',
				left: orientation === 'horizontal' ? 0 : 'auto',
				width: orientation === 'horizontal' ? '100%' : `${thumbWidth + 4}px`,
				height: orientation === 'horizontal' ? `${thumbWidth + 4}px` : '100%',
				zIndex: 50,
				cursor: 'default',
				pointerEvents: 'auto',
			}}
		>
			<div
				onPointerDown={thumb.onPointerDown}
				onPointerMove={thumb.onPointerMove}
				onPointerUp={thumb.onPointerUp}
				onPointerCancel={thumb.onPointerUp}
				style={{
					position: 'absolute',
					right: orientation === 'horizontal' ? 'auto' : 1,
					top: orientation === 'horizontal' ? 'auto' : thumb.thumbState.top,
					bottom: orientation === 'horizontal' ? 1 : 'auto',
					left: orientation === 'horizontal' ? thumb.thumbState.top : 'auto',
					width: orientation === 'horizontal' ? `${thumb.thumbState.height}px` : `${activeWidth}px`,
					height:
						orientation === 'horizontal' ? `${activeWidth}px` : `${thumb.thumbState.height}px`,
					borderRadius: `${activeWidth / 2}px`,
					backgroundColor:
						thumbColor || 'color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent)',
					opacity: thumb.opacity,
					transition: thumb.dragging ? 'none' : 'opacity 0.2s ease, width 0.15s ease',
					cursor: thumb.dragging ? 'grabbing' : 'grab',
				}}
			/>
		</div>
	);
}

// ── ScrollThumb (thumb-only, for external scrollers like Virtuoso) ─

interface ScrollThumbProps {
	scrollerRef: React.RefObject<HTMLDivElement | null>;
	autoHide?: 'never' | 'scroll' | 'leave' | 'move';
	thumbWidth?: number;
	minThumbHeight?: number;
	autoHideDelay?: number;
	orientation?: 'vertical' | 'horizontal';
	alwaysVisible?: boolean;
	thumbColor?: string;
}

export const ScrollThumb: React.FC<ScrollThumbProps> = ({
	scrollerRef,
	autoHide = 'scroll',
	thumbWidth = 4,
	minThumbHeight = 24,
	autoHideDelay = 1200,
	orientation = 'vertical',
	alwaysVisible,
	thumbColor,
}) => {
	const thumb = useScrollThumb(scrollerRef, {
		autoHide,
		autoHideDelay,
		minThumbHeight,
		orientation,
		alwaysVisible,
	});
	return (
		<ThumbUI
			thumb={thumb}
			thumbWidth={thumbWidth}
			scrollerRef={scrollerRef}
			orientation={orientation}
			alwaysVisible={alwaysVisible}
			thumbColor={thumbColor}
		/>
	);
};

// ── ScrollContainer (full wrapper with scroller + thumb) ───────────

interface ScrollContainerProps {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
	autoHide?: 'never' | 'scroll' | 'leave' | 'move';
	thumbWidth?: number;
	minThumbHeight?: number;
	autoHideDelay?: number;
	orientation?: 'vertical' | 'horizontal';
	trackGutter?: number;
	/** Disable thumb width expansion on hover. */
	noHoverExpand?: boolean;
}

export const ScrollContainer = React.forwardRef<HTMLDivElement, ScrollContainerProps>(
	(
		{
			children,
			className,
			style,
			autoHide = 'scroll',
			thumbWidth = 4,
			minThumbHeight = 24,
			autoHideDelay = 1200,
			orientation = 'vertical',
			trackGutter = 0,
			noHoverExpand = false,
		},
		forwardedRef,
	) => {
		const scrollerRef = useRef<HTMLDivElement | null>(null);

		const handleHorizontalWheel = useCallback(
			(e: React.WheelEvent<HTMLDivElement>) => {
				if (orientation !== 'horizontal') return;

				const scroller = scrollerRef.current;
				if (!scroller) return;

				const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				if (delta === 0) return;

				const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
				if (maxScrollLeft <= 0) return;

				e.preventDefault();
				scroller.scrollLeft = Math.max(0, Math.min(maxScrollLeft, scroller.scrollLeft + delta));
			},
			[orientation],
		);

		const handleMiddleMouseDown = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (orientation === 'horizontal' && e.button === 1) {
					e.preventDefault();
				}
			},
			[orientation],
		);

		const handleScrollerRef = useCallback(
			(node: HTMLDivElement | null) => {
				scrollerRef.current = node;
				if (typeof forwardedRef === 'function') forwardedRef(node);
				else if (forwardedRef) forwardedRef.current = node;
			},
			[forwardedRef],
		);

		const thumb = useScrollThumb(scrollerRef, {
			autoHide,
			autoHideDelay,
			minThumbHeight,
			orientation,
		});

		return (
			<div
				className={cn(
					'relative h-full flex-1 w-full min-h-0 flex flex-col overflow-hidden',
					className,
				)}
				style={{
					boxSizing: 'border-box',
					paddingBottom:
						orientation === 'horizontal' && trackGutter > 0 ? `${trackGutter}px` : undefined,
					paddingRight:
						orientation === 'vertical' && trackGutter > 0 ? `${trackGutter}px` : undefined,
					...style,
				}}
			>
				<div
					ref={handleScrollerRef}
					className="flex-1 min-h-0"
					onWheel={handleHorizontalWheel}
					onMouseDown={handleMiddleMouseDown}
					style={{
						overflowX: orientation === 'horizontal' ? 'auto' : 'hidden',
						overflowY: orientation === 'horizontal' ? 'hidden' : 'auto',
						scrollbarWidth: 'none' as const,
					}}
				>
					{children}
				</div>
				<ThumbUI
					thumb={thumb}
					thumbWidth={thumbWidth}
					scrollerRef={scrollerRef}
					orientation={orientation}
					noHoverExpand={noHoverExpand}
				/>
			</div>
		);
	},
);

ScrollContainer.displayName = 'ScrollContainer';
