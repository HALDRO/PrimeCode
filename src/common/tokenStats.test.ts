import { describe, expect, it } from 'vitest';

import { getDisplayDurationMs } from './tokenStats';

describe('getDisplayDurationMs', () => {
	it('prefers the largest live value while processing so the timer never freezes', () => {
		expect(
			getDisplayDurationMs({
				liveDurationMs: 1200,
				statsDurationMs: 900,
				isProcessing: true,
				liveElapsedMs: 1800,
			}),
		).toBe(1800);
	});

	it('still uses backend duration after processing stops', () => {
		expect(
			getDisplayDurationMs({
				liveDurationMs: 2200,
				statsDurationMs: 2100,
				isProcessing: false,
				liveElapsedMs: 2500,
			}),
		).toBe(2200);
	});

	it('falls back to final stats duration when no live backend duration exists', () => {
		expect(
			getDisplayDurationMs({
				statsDurationMs: 1600,
				isProcessing: false,
				liveElapsedMs: 1900,
			}),
		).toBe(1600);
	});
});
