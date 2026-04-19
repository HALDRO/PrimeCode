export interface TokenSnapshotInput {
	input?: number;
	output?: number;
	reasoning?: number;
	total?: number;
	cache?: {
		read?: number;
		write?: number;
	};
}

export interface TurnUsageState {
	previousTurnSnapshotTotal?: number;
	previousSessionSnapshotTotal?: number;
}

export interface TurnUsageResult {
	totalTokens: number;
	usageTokens: number;
	nextSessionSnapshotTotal: number;
}

export interface TurnUsageLike {
	usage?: number;
	durationMs?: number;
}

export interface DisplayDurationState {
	liveDurationMs?: number;
	statsDurationMs?: number;
	isProcessing: boolean;
	liveElapsedMs: number;
}

export interface TimeBounds {
	earliestTs?: number;
	latestTs?: number;
}

export function getSnapshotTotal(tokens: TokenSnapshotInput): number {
	const input = Math.max(0, tokens.input ?? 0);
	const output = Math.max(0, tokens.output ?? 0);
	const reasoning = Math.max(0, tokens.reasoning ?? 0);
	const cacheRead = Math.max(0, tokens.cache?.read ?? 0);
	const cacheWrite = Math.max(0, tokens.cache?.write ?? 0);

	if (typeof tokens.total === 'number' && tokens.total > 0) {
		return tokens.total;
	}

	return input + output + reasoning + cacheRead + cacheWrite;
}

export function computeTurnUsage(
	tokens: TokenSnapshotInput,
	state: TurnUsageState,
): TurnUsageResult {
	const totalTokens = getSnapshotTotal(tokens);
	if (totalTokens <= 0) {
		return {
			totalTokens: 0,
			usageTokens: 0,
			nextSessionSnapshotTotal: state.previousSessionSnapshotTotal ?? 0,
		};
	}

	const baseline =
		typeof state.previousTurnSnapshotTotal === 'number' && state.previousTurnSnapshotTotal > 0
			? state.previousTurnSnapshotTotal
			: Math.max(0, state.previousSessionSnapshotTotal ?? 0);

	return {
		totalTokens,
		usageTokens: Math.max(0, totalTokens - baseline),
		nextSessionSnapshotTotal: totalTokens,
	};
}

export function getCompletedDurationMs(created?: number, completed?: number): number {
	if (typeof created !== 'number' || typeof completed !== 'number') return 0;
	if (created <= 0 || completed < created) return 0;
	return completed - created;
}

export function getTurnUsageTokenCount(turn?: TurnUsageLike | null): number | null {
	return typeof turn?.usage === 'number' && turn.usage > 0 ? turn.usage : null;
}

export function getTurnUsageDuration(turn?: TurnUsageLike | null): number | null {
	return typeof turn?.durationMs === 'number' && turn.durationMs > 0 ? turn.durationMs : null;
}

export function getDisplayDurationMs(state: DisplayDurationState): number | null {
	if (state.isProcessing) {
		const liveElapsed = state.liveElapsedMs > 0 ? state.liveElapsedMs : 0;
		const backendLive =
			typeof state.liveDurationMs === 'number' && state.liveDurationMs > 0
				? state.liveDurationMs
				: 0;
		const backendStats =
			typeof state.statsDurationMs === 'number' && state.statsDurationMs > 0
				? state.statsDurationMs
				: 0;
		const liveDisplay = Math.max(liveElapsed, backendLive, backendStats);
		return liveDisplay > 0 ? liveDisplay : null;
	}
	if (typeof state.liveDurationMs === 'number' && state.liveDurationMs > 0) {
		return state.liveDurationMs;
	}
	if (typeof state.statsDurationMs === 'number' && state.statsDurationMs > 0) {
		return state.statsDurationMs;
	}
	return null;
}

export function sumUsageValues(values: Iterable<number | null | undefined>): number {
	let total = 0;
	for (const value of values) {
		if (typeof value === 'number' && value > 0) total += value;
	}
	return total;
}

export function addTimestamp(bounds: TimeBounds, timestamp?: number): TimeBounds {
	if (typeof timestamp !== 'number' || timestamp <= 0) {
		return bounds;
	}
	return {
		earliestTs:
			typeof bounds.earliestTs === 'number' ? Math.min(bounds.earliestTs, timestamp) : timestamp,
		latestTs:
			typeof bounds.latestTs === 'number' ? Math.max(bounds.latestTs, timestamp) : timestamp,
	};
}

export function getBoundsDurationMs(bounds: TimeBounds): number | undefined {
	if (
		typeof bounds.earliestTs !== 'number' ||
		typeof bounds.latestTs !== 'number' ||
		bounds.latestTs <= bounds.earliestTs
	) {
		return undefined;
	}
	return bounds.latestTs - bounds.earliestTs;
}
