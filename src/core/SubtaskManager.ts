/**
 * @file SubtaskManager
 * @description Encapsulates all subtask lifecycle logic previously scattered across ChatProvider:
 * - Deferred child session linking (pending tool IDs → child session resolution)
 * - Inactivity timer management (start, reset, clear, timeout callback)
 * - Token accumulation per subtask
 * - Parent transcript routing resolution
 *
 * ChatProvider delegates to this class instead of managing 7+ Maps/Sets directly.
 */

import type { ISessionState } from './contracts';
import type { SessionGraph } from './SessionManager';

export interface SubtaskManagerCallbacks {
	/** Called when a subtask has been inactive for SUBTASK_INACTIVITY_TIMEOUT_MS. */
	onTimeout: (toolUseId: string) => void;
}

export interface TokenDelta {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
}

interface AccumulatedTokens {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
}

const ZERO_TOKENS: AccumulatedTokens = { input: 0, output: 0, total: 0, cacheRead: 0 };

export class SubtaskManager {
	private static readonly INACTIVITY_TIMEOUT_MS = 30_000;

	/** Tool IDs awaiting child session linking. */
	private readonly pendingToolIds = new Set<string>();
	/** Inactivity timers keyed by toolUseId. */
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** childSessionId → toolUseId */
	private readonly childToToolUseId = new Map<string, string>();
	/** toolUseId → parentSessionId */
	private readonly toolToParentSession = new Map<string, string>();
	/** Accumulated child token stats per toolUseId. */
	private readonly tokenAccumulators = new Map<string, AccumulatedTokens>();

	constructor(
		private readonly graph: SessionGraph,
		private readonly sessionState: ISessionState,
		private readonly callbacks: SubtaskManagerCallbacks,
	) {}

	// ─── Registration ────────────────────────────────────────────────────────

	/**
	 * Register a new subtask from a `task` tool_use event.
	 * Starts an inactivity timer. Child session ID is unknown at this point.
	 */
	registerSubtask(toolUseId: string, parentSessionId: string): void {
		this.pendingToolIds.add(toolUseId);
		this.toolToParentSession.set(toolUseId, parentSessionId);
		this.startTimer(toolUseId);
	}

	// ─── Deferred Linking ────────────────────────────────────────────────────

	/**
	 * Attempt to link an unknown session as a child of a pending subtask.
	 * Called when the first event arrives from a session not in the graph.
	 * Returns true if linking succeeded.
	 */
	tryLinkChildSession(sessionId: string): boolean {
		if (
			this.graph.isChild(sessionId) ||
			this.sessionState.startedSessions.has(sessionId) ||
			this.pendingToolIds.size === 0
		) {
			return false;
		}

		const pendingToolId = this.pendingToolIds.values().next().value;
		if (!pendingToolId) return false;

		const parentSessionId = this.toolToParentSession.get(pendingToolId);
		if (!parentSessionId) return false;

		this.pendingToolIds.delete(pendingToolId);
		this.graph.registerChild(sessionId, parentSessionId, pendingToolId);
		this.childToToolUseId.set(sessionId, pendingToolId);
		this.resetTimer(pendingToolId);

		return true;
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	isPending(toolUseId: string): boolean {
		return this.pendingToolIds.has(toolUseId);
	}

	getParentSession(toolUseId: string): string | undefined {
		return this.toolToParentSession.get(toolUseId);
	}

	getToolUseId(childSessionId: string): string | undefined {
		return this.childToToolUseId.get(childSessionId);
	}

	hasActiveSubtasks(): boolean {
		return this.pendingToolIds.size > 0 || this.timers.size > 0;
	}

	/**
	 * Resolve routing info for a child session event.
	 * Returns parentSessionId + toolUseId, or undefined if not routable.
	 */
	resolveRouting(
		childSessionId: string,
	): { parentSessionId: string; toolUseId: string } | undefined {
		const parentSessionId = this.graph.getParent(childSessionId);
		if (!parentSessionId) return undefined;
		const toolUseId = this.childToToolUseId.get(childSessionId);
		if (!toolUseId) return undefined;
		return { parentSessionId, toolUseId };
	}

	// ─── Timer Management ────────────────────────────────────────────────────

	/** Reset inactivity timer for a child session (called on every child event). */
	resetTimerByChild(childSessionId: string): void {
		const toolUseId = this.childToToolUseId.get(childSessionId);
		if (toolUseId) this.resetTimer(toolUseId);
	}

	private startTimer(toolUseId: string): void {
		this.clearTimer(toolUseId);
		const timer = setTimeout(() => {
			this.callbacks.onTimeout(toolUseId);
		}, SubtaskManager.INACTIVITY_TIMEOUT_MS);
		this.timers.set(toolUseId, timer);
	}

	private resetTimer(toolUseId: string): void {
		if (!this.timers.has(toolUseId)) return;
		this.startTimer(toolUseId);
	}

	private clearTimer(toolUseId: string): void {
		const timer = this.timers.get(toolUseId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(toolUseId);
		}
	}

	// ─── Token Accumulation ──────────────────────────────────────────────────

	accumulateTokens(toolUseId: string, delta: TokenDelta): AccumulatedTokens {
		const prev = this.tokenAccumulators.get(toolUseId) ?? { ...ZERO_TOKENS };
		const accumulated: AccumulatedTokens = {
			input: prev.input + (delta.inputTokens ?? 0),
			output: prev.output + (delta.outputTokens ?? 0),
			total: prev.total + (delta.totalTokens ?? 0),
			cacheRead: prev.cacheRead + (delta.cacheReadTokens ?? 0),
		};
		this.tokenAccumulators.set(toolUseId, accumulated);
		return accumulated;
	}

	getAccumulatedTokens(toolUseId: string): AccumulatedTokens {
		return this.tokenAccumulators.get(toolUseId) ?? { ...ZERO_TOKENS };
	}

	// ─── Cleanup ─────────────────────────────────────────────────────────────

	/** Clean up all state for a completed/errored subtask. */
	completeSubtask(toolUseId: string): void {
		this.pendingToolIds.delete(toolUseId);
		this.clearTimer(toolUseId);
		this.toolToParentSession.delete(toolUseId);
		this.tokenAccumulators.delete(toolUseId);

		// Remove child→toolUseId mapping
		for (const [childId, tid] of this.childToToolUseId.entries()) {
			if (tid === toolUseId) {
				this.childToToolUseId.delete(childId);
			}
		}
	}

	/** Clear all subtask state (used on dispose). */
	clearAll(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.pendingToolIds.clear();
		this.toolToParentSession.clear();
		this.childToToolUseId.clear();
		this.tokenAccumulators.clear();
	}
}
