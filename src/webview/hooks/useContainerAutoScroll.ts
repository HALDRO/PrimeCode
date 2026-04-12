/**
 * @file useContainerAutoScroll — shared auto-scroll + detach logic for scrollable containers.
 *
 * Mirrors the main session's scroll behavior:
 * - MutationObserver with rAF dedup for auto-scroll during streaming
 * - Manual scroll-up detection ("detach") so the user can browse history
 * - Re-attach when user scrolls back to bottom
 * - showScrollToBottom flag for a floating button
 *
 * Used by SubtaskItem and SimpleToolGroup to unify behavior with the main chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseContainerAutoScrollOptions {
	/** Whether the container is actively streaming / running. */
	active: boolean;
	/** Distance from bottom (px) before the scroll-to-bottom button appears. */
	buttonThreshold?: number;
	/** Upward scroll distance (px) to trigger detach. */
	detachThreshold?: number;
	/** Also observe characterData mutations (useful for per-token text updates). */
	observeCharacterData?: boolean;
}

interface UseContainerAutoScrollReturn {
	/** Attach to the scrollable container element. */
	scrollerRef: React.RefObject<HTMLDivElement | null>;
	/** Whether the scroll-to-bottom button should be visible. */
	showScrollToBottom: boolean;
	/** Call this to programmatically scroll to bottom and re-attach. */
	scrollToBottom: () => void;
	/** Whether the user has manually scrolled away from the bottom. */
	isDetached: boolean;
}

const DEFAULT_BUTTON_THRESHOLD = 60;
const DEFAULT_DETACH_THRESHOLD = 8;

export function useContainerAutoScroll({
	active,
	buttonThreshold = DEFAULT_BUTTON_THRESHOLD,
	detachThreshold = DEFAULT_DETACH_THRESHOLD,
	observeCharacterData = false,
}: UseContainerAutoScrollOptions): UseContainerAutoScrollReturn {
	const scrollerRef = useRef<HTMLDivElement | null>(null);
	const userDetachedRef = useRef(false);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);

	// Reset detach flag when streaming starts
	useEffect(() => {
		if (active) {
			userDetachedRef.current = false;
			setShowScrollToBottom(false);
		}
	}, [active]);

	// ── Scroll listener: detach detection + button visibility ──────
	useEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;

		let rafId: number | null = null;
		let lastScrollTop = el.scrollTop;

		const onScroll = () => {
			const currentScrollTop = el.scrollTop;
			const distance = el.scrollHeight - currentScrollTop - el.clientHeight;

			if (active) {
				if (currentScrollTop < lastScrollTop && distance > detachThreshold) {
					userDetachedRef.current = true;
				} else if (distance <= detachThreshold) {
					userDetachedRef.current = false;
				}
			}

			lastScrollTop = currentScrollTop;

			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				const d = el.scrollHeight - el.scrollTop - el.clientHeight;
				setShowScrollToBottom(d > buttonThreshold);
			});
		};

		el.addEventListener('scroll', onScroll, { passive: true });
		// Initial check
		onScroll();

		return () => {
			el.removeEventListener('scroll', onScroll);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [active, buttonThreshold, detachThreshold]);

	// ── MutationObserver: auto-scroll when content changes ─────────
	useEffect(() => {
		const el = scrollerRef.current;
		if (!active || !el) return;

		let rafId: number | null = null;
		const nudge = () => {
			if (userDetachedRef.current) return;
			if (rafId !== null) return;
			rafId = requestAnimationFrame(() => {
				rafId = null;
				const scroller = scrollerRef.current;
				if (!scroller || userDetachedRef.current) return;
				scroller.scrollTop = scroller.scrollHeight;
			});
		};

		// Initial scroll
		nudge();

		const observer = new MutationObserver(nudge);
		observer.observe(el, {
			childList: true,
			subtree: true,
			...(observeCharacterData && { characterData: true }),
		});

		return () => {
			observer.disconnect();
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [active, observeCharacterData]);

	const scrollToBottom = useCallback(() => {
		userDetachedRef.current = false;
		const el = scrollerRef.current;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
	}, []);

	return {
		scrollerRef,
		showScrollToBottom,
		scrollToBottom,
		isDetached: userDetachedRef.current,
	};
}
