import { useEffect, useRef, useState } from 'react';

/** Hook: live elapsed timer that ticks every second while active. */
export const useElapsedTimer = (isActive: boolean): number => {
	const startRef = useRef(Date.now());
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (!isActive) return;
		startRef.current = Date.now();
		setElapsed(0);
		const id = setInterval(() => setElapsed(Date.now() - startRef.current), 1000);
		return () => clearInterval(id);
	}, [isActive]);

	return elapsed;
};
