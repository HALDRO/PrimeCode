/**
 * @file SubtaskManager
 * @description Encapsulates all subtask lifecycle logic previously scattered across ChatProvider:
 * - Deferred child session linking (pending tool IDs → child session resolution)
 * - Token accumulation per subtask
 * - Parent/child routing resolution for subtask UI updates
 *
 * ChatProvider delegates to this class instead of managing 7+ Maps/Sets directly.
 *
 * NOTE: No inactivity timeout — matches official OpenCode behavior where child sessions
 * run until the LLM finishes, errors out, or the parent is explicitly aborted.
 */

import type { SessionGraph } from './SessionManager';

export interface TokenDelta {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
	durationMs?: number;
}

interface AccumulatedTokens {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	durationMs?: number;
}

const ZERO_TOKENS: AccumulatedTokens = {
	input: 0,
	output: 0,
	total: 0,
	cacheRead: 0,
	durationMs: 0,
};

export class SubtaskManager {
	/** Tool IDs awaiting child session linking. */
	private readonly pendingToolIds = new Set<string>();
	/** childSessionId → toolUseId */
	private readonly childToToolUseId = new Map<string, string>();
	/** toolUseId → parentSessionId */
	private readonly toolToParentSession = new Map<string, string>();
	/** toolUseId → childSessionId */
	private readonly toolToChildSession = new Map<string, string>();
	/** toolUseId → parent assistant messageID */
	private readonly toolToParentMessageId = new Map<string, string>();
	/** Accumulated child token stats per toolUseId. */
	private readonly tokenAccumulators = new Map<string, AccumulatedTokens>();

	constructor(private readonly graph: SessionGraph) {}

	// ─── Registration ────────────────────────────────────────────────────────

	/**
	 * Register a new subtask from a `task` tool_use event.
	 * Child session ID may already be known from OpenCode task metadata.
	 */
	registerSubtask(
		toolUseId: string,
		parentSessionId: string,
		childSessionId?: string,
		parentMessageId?: string,
	): void {
		this.toolToParentSession.set(toolUseId, parentSessionId);
		if (parentMessageId) this.toolToParentMessageId.set(toolUseId, parentMessageId);

		if (childSessionId) {
			this.linkChildSession(childSessionId, toolUseId, parentSessionId);
			return;
		}

		this.pendingToolIds.add(toolUseId);
	}

	/**
	 * Deterministically link a child session to a registered task tool call.
	 * OpenCode CLI provides metadata.sessionId in the tool part's running update
	 * (after ctx.metadata() in task.ts) and in the completed tool_result.
	 */
	linkChildSession(childSessionId: string, toolUseId: string, parentSessionId?: string): boolean {
		const resolvedParentSessionId = parentSessionId ?? this.toolToParentSession.get(toolUseId);
		if (!resolvedParentSessionId) return false;

		const existingToolUseId = this.childToToolUseId.get(childSessionId);
		if (existingToolUseId && existingToolUseId !== toolUseId) {
			return false;
		}

		this.toolToParentSession.set(toolUseId, resolvedParentSessionId);
		this.pendingToolIds.delete(toolUseId);
		this.childToToolUseId.set(childSessionId, toolUseId);
		this.toolToChildSession.set(toolUseId, childSessionId);
		this.graph.registerChild(childSessionId, resolvedParentSessionId, toolUseId);
		return true;
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	isPending(toolUseId: string): boolean {
		return this.pendingToolIds.has(toolUseId);
	}

	/** Check if a toolUseId is registered (pending or already linked). */
	isRegistered(toolUseId: string): boolean {
		return this.pendingToolIds.has(toolUseId) || this.toolToParentSession.has(toolUseId);
	}

	getParentSession(toolUseId: string): string | undefined {
		return this.toolToParentSession.get(toolUseId);
	}

	getToolUseId(childSessionId: string): string | undefined {
		return this.childToToolUseId.get(childSessionId);
	}

	getChildSessionId(toolUseId: string): string | undefined {
		return this.toolToChildSession.get(toolUseId);
	}

	getParentMessageId(toolUseId: string): string | undefined {
		return this.toolToParentMessageId.get(toolUseId);
	}

	getOldestPendingToolUseId(parentSessionId: string): string | undefined {
		for (const toolUseId of this.pendingToolIds) {
			if (this.toolToParentSession.get(toolUseId) === parentSessionId) {
				return toolUseId;
			}
		}
		return undefined;
	}

	hasActiveSubtasks(): boolean {
		return this.pendingToolIds.size > 0;
	}

	/**
	 * Resolve routing info for a child session event.
	 * Returns parentSessionId + toolUseId, or undefined if not routable.
	 */
	resolveRouting(
		childSessionId: string,
	): { parentSessionId: string; toolUseId: string; parentMessageId?: string } | undefined {
		const parentSessionId = this.graph.getParent(childSessionId);
		if (!parentSessionId) return undefined;
		const toolUseId = this.childToToolUseId.get(childSessionId);
		if (!toolUseId) return undefined;
		return {
			parentSessionId,
			toolUseId,
			parentMessageId: this.toolToParentMessageId.get(toolUseId),
		};
	}

	// ─── Token Accumulation ──────────────────────────────────────────────────

	accumulateTokens(toolUseId: string, delta: TokenDelta): AccumulatedTokens {
		const prev = this.tokenAccumulators.get(toolUseId) ?? { ...ZERO_TOKENS };
		const accumulated: AccumulatedTokens = {
			input: prev.input + (delta.inputTokens ?? 0),
			output: prev.output + (delta.outputTokens ?? 0),
			total: prev.total + (delta.totalTokens ?? 0),
			cacheRead: prev.cacheRead + (delta.cacheReadTokens ?? 0),
			durationMs: (prev.durationMs ?? 0) + (delta.durationMs ?? 0),
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
		this.toolToParentSession.delete(toolUseId);
		this.toolToParentMessageId.delete(toolUseId);
		this.tokenAccumulators.delete(toolUseId);
		this.toolToChildSession.delete(toolUseId);

		// Remove child→toolUseId mapping
		for (const [childId, tid] of this.childToToolUseId.entries()) {
			if (tid === toolUseId) {
				this.childToToolUseId.delete(childId);
			}
		}
	}

	/** Clear all subtask state (used on dispose). */
	clearAll(): void {
		this.pendingToolIds.clear();
		this.toolToParentSession.clear();
		this.toolToParentMessageId.clear();
		this.childToToolUseId.clear();
		this.toolToChildSession.clear();
		this.tokenAccumulators.clear();
	}
}
