/**
 * @file ScrollContainer - custom scrollbar wrapper component
 * @description Wrapper over OverlayScrollbars providing VS Code-styled custom scrollbars.
 *              Supports auto-hide behavior, click-to-scroll, and exposes viewport ref for
 *              programmatic scroll control. Can notify consumers when the viewport is ready
 *              (e.g., to integrate a virtualization library using the same scroll element).
 */

import {
	OverlayScrollbarsComponent,
	type OverlayScrollbarsComponentRef,
} from 'overlayscrollbars-react';
import type React from 'react';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';

interface ScrollContainerProps {
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
	onScroll?: () => void;
	scrollRef?: React.RefObject<HTMLDivElement | null>;
	/** Called when the internal viewport element is available. */
	onViewportReady?: (viewport: HTMLDivElement) => void;
	osRef?: React.RefObject<OverlayScrollbarsComponentRef | null>;
	autoHide?: 'never' | 'scroll' | 'leave' | 'move';
}

export const ScrollContainer: React.FC<ScrollContainerProps> = ({
	children,
	className,
	style,
	onScroll,
	scrollRef,
	onViewportReady,
	osRef: externalOsRef,
	autoHide = 'scroll',
}) => {
	const internalOsRef = useRef<OverlayScrollbarsComponentRef>(null);
	const activeOsRef = (externalOsRef ||
		internalOsRef) as React.MutableRefObject<OverlayScrollbarsComponentRef | null>;

	const syncViewport = (viewport: HTMLDivElement) => {
		if (scrollRef && 'current' in scrollRef) {
			(scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = viewport;
		}
		onViewportReady?.(viewport);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional ref access to sync viewport
	useEffect(() => {
		if (scrollRef && activeOsRef.current) {
			const instance = activeOsRef.current.osInstance();
			if (instance) {
				const viewport = instance.elements().viewport as HTMLDivElement;
				syncViewport(viewport);
			}
		}
	}, [scrollRef, onViewportReady]);

	return (
		<OverlayScrollbarsComponent
			ref={activeOsRef}
			className={cn('h-full w-full', className)}
			style={style}
			options={{
				scrollbars: {
					theme: 'os-theme-dark',
					autoHide,
					autoHideDelay: 800,
					clickScroll: true,
				},
				overflow: {
					x: 'hidden',
					y: 'scroll',
				},
			}}
			events={{
				scroll: onScroll,
				initialized: () => {
					if (scrollRef && activeOsRef.current) {
						const instance = activeOsRef.current.osInstance();
						if (instance) {
							const viewport = instance.elements().viewport as HTMLDivElement;
							syncViewport(viewport);
						}
					}
				},
			}}
			defer
		>
			{children}
		</OverlayScrollbarsComponent>
	);
};
