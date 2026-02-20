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
	},
) {
	const { autoHide, autoHideDelay, minThumbHeight } = config;
	const trackRef = useRef<HTMLDivElement>(null);
	const rafRef = useRef(0);
	const hideTimerRef = useRef(0);
	const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);

	const [visible, setVisible] = useState(autoHide === 'never');
	const [hovered, setHovered] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [thumbState, setThumbState] = useState({ top: 0, height: 0, show: false });

	const updateThumb = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const { scrollTop, scrollHeight, clientHeight } = el;
		if (scrollHeight <= clientHeight) {
			setThumbState({ top: 0, height: 0, show: false });
			return;
		}
		const ratio = clientHeight / scrollHeight;
		const thumbH = Math.max(ratio * clientHeight, minThumbHeight);
		const maxTop = clientHeight - thumbH;
		const scrollRatio = scrollTop / (scrollHeight - clientHeight);
		setThumbState({ top: scrollRatio * maxTop, height: thumbH, show: true });
	}, [scrollerRef, minThumbHeight]);

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
			dragRef.current = { startY: e.clientY, startScrollTop: el.scrollTop };
			setDragging(true);
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
		},
		[scrollerRef],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!dragRef.current) return;
			const el = scrollerRef.current;
			if (!el) return;
			const { scrollHeight, clientHeight } = el;
			const thumbH = thumbState.height || minThumbHeight;
			const trackH = clientHeight - thumbH;
			if (trackH <= 0) return;
			const deltaY = e.clientY - dragRef.current.startY;
			const scrollDelta = (deltaY / trackH) * (scrollHeight - clientHeight);
			el.scrollTop = dragRef.current.startScrollTop + scrollDelta;
		},
		[scrollerRef, thumbState.height, minThumbHeight],
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
			const clickY = e.clientY - rect.top;
			const { scrollHeight, clientHeight } = el;
			el.scrollTop = (clickY / clientHeight) * (scrollHeight - clientHeight);
		},
		[scrollerRef],
	);

	const opacity = dragging || hovered ? 0.7 : visible || autoHide === 'never' ? 0.4 : 0;

	return {
		trackRef,
		thumbState,
		opacity,
		dragging,
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
}: {
	thumb: ReturnType<typeof useScrollThumb>;
	thumbWidth: number;
}) {
	if (!thumb.thumbState.show) return null;
	return (
		<div
			ref={thumb.trackRef}
			onClick={thumb.onTrackClick}
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
				top: 0,
				right: 0,
				width: `${thumbWidth + 4}px`,
				height: '100%',
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
					right: 1,
					top: thumb.thumbState.top,
					width: `${thumbWidth}px`,
					height: `${thumb.thumbState.height}px`,
					borderRadius: `${thumbWidth / 2}px`,
					backgroundColor: 'color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent)',
					opacity: thumb.opacity,
					transition: thumb.dragging ? 'none' : 'opacity 0.2s ease',
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
}

export const ScrollThumb: React.FC<ScrollThumbProps> = ({
	scrollerRef,
	autoHide = 'scroll',
	thumbWidth = 4,
	minThumbHeight = 24,
	autoHideDelay = 1200,
}) => {
	const thumb = useScrollThumb(scrollerRef, { autoHide, autoHideDelay, minThumbHeight });
	return <ThumbUI thumb={thumb} thumbWidth={thumbWidth} />;
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
		},
		forwardedRef,
	) => {
		const scrollerRef = useRef<HTMLDivElement | null>(null);

		const handleScrollerRef = useCallback(
			(node: HTMLDivElement | null) => {
				scrollerRef.current = node;
				if (typeof forwardedRef === 'function') forwardedRef(node);
				else if (forwardedRef) forwardedRef.current = node;
			},
			[forwardedRef],
		);

		const thumb = useScrollThumb(scrollerRef, { autoHide, autoHideDelay, minThumbHeight });

		return (
			<div
				className={cn('relative h-full w-full min-h-0 flex flex-col overflow-hidden', className)}
				style={style}
			>
				<div
					ref={handleScrollerRef}
					className="flex-1 min-h-0"
					style={{
						overflowX: 'hidden',
						overflowY: 'auto',
						scrollbarWidth: 'none' as const,
					}}
				>
					{children}
				</div>
				<ThumbUI thumb={thumb} thumbWidth={thumbWidth} />
			</div>
		);
	},
);

ScrollContainer.displayName = 'ScrollContainer';
