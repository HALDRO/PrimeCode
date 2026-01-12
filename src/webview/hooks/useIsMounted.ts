import { useCallback, useEffect, useRef } from 'react';

/**
 * Hook to check if component is mounted.
 * Useful for async operations that might complete after component unmount.
 */
export function useIsMounted() {
	const isMounted = useRef(false);

	useEffect(() => {
		isMounted.current = true;
		return () => {
			isMounted.current = false;
		};
	}, []);

	return useCallback(() => isMounted.current, []);
}
