import { useEffect, useRef, useState } from 'react';

/**
 * Hook: live elapsed timer that ticks every second while active.
 * Preserves accumulated time across brief inactive gaps so the timer
 * doesn't reset when `isActive` flickers (e.g. during sub-agent execution).
 *
 * When `startTime` is provided and the timer activates for the first time,
 * the accumulated base is initialized to `Date.now() - startTime` so that
 * restored sessions show the real elapsed time instead of starting from 0.
 */
export const useElapsedTimer = (isActive: boolean, startTime?: string | number): number => {
	const segmentStartRef = useRef(0);
	const accumulatedRef = useRef(0);
	const wasActiveRef = useRef(false);
	const initializedRef = useRef(false);
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (isActive) {
			if (!wasActiveRef.current) {
				// Transitioning from inactive → active: start a new segment
				segmentStartRef.current = Date.now();

				// On first activation, seed accumulated time from startTime
				// so restored running subtasks show real elapsed time
				if (!initializedRef.current && startTime) {
					const start = typeof startTime === 'number' ? startTime : new Date(startTime).getTime();
					if (start > 0 && start < Date.now()) {
						accumulatedRef.current = Date.now() - start;
					}
					initializedRef.current = true;
				}
			}
			wasActiveRef.current = true;
			const id = setInterval(() => {
				setElapsed(accumulatedRef.current + (Date.now() - segmentStartRef.current));
			}, 1000);
			// Tick immediately so the display updates without waiting 1s
			setElapsed(accumulatedRef.current + (Date.now() - segmentStartRef.current));
			return () => clearInterval(id);
		}
		// Transitioning from active → inactive: accumulate elapsed time from this segment
		if (wasActiveRef.current) {
			accumulatedRef.current += Date.now() - segmentStartRef.current;
			wasActiveRef.current = false;
		}
		return undefined;
	}, [isActive, startTime]);

	return elapsed;
};
