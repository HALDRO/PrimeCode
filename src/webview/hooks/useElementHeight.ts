/**
 * @file useElementHeight - measure DOM element height via ResizeObserver
 * @description Provides a stable ref callback and a reactive pixel height.
 *              Uses ResizeObserver to track dynamic UI changes (attachments, panels, etc.).
 *              Designed for layout reservation (Virtuoso footer padding, sticky offsets).
 */

import { useCallback, useLayoutEffect, useState } from 'react';

export interface UseElementHeightOptions {
	/** Fallback height used until the element is measured. */
	fallbackHeight?: number;
	/** Optional extra pixels to add (e.g. gap). */
	extra?: number;
}

export function useElementHeight<T extends HTMLElement>(options: UseElementHeightOptions = {}) {
	const { fallbackHeight = 0, extra = 0 } = options;
	const [node, setNode] = useState<T | null>(null);
	const [height, setHeight] = useState<number>(fallbackHeight);

	const ref = useCallback((el: T | null) => {
		setNode(el);
	}, []);

	useLayoutEffect(() => {
		if (!node) {
			setHeight(fallbackHeight);
			return;
		}

		const measure = () => {
			const next = Math.max(0, Math.round(node.getBoundingClientRect().height) + extra);
			setHeight(next);
		};

		measure();

		const observer = new ResizeObserver(() => {
			measure();
		});
		observer.observe(node);

		return () => {
			observer.disconnect();
		};
	}, [node, fallbackHeight, extra]);

	return { ref, height } as const;
}

/**
 * Hook to track viewport height reactively.
 * Updates on window resize.
 */
export function useViewportHeight(fallback = 600): number {
	const [height, setHeight] = useState(() =>
		typeof window !== 'undefined' ? window.innerHeight : fallback,
	);

	useLayoutEffect(() => {
		const update = () => setHeight(window.innerHeight);
		update();
		window.addEventListener('resize', update);
		return () => window.removeEventListener('resize', update);
	}, []);

	return height;
}
