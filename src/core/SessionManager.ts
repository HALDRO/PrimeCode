/**
 * @file SessionManager.ts
 * @description Consolidated session management: active session tracking (SessionState)
 *              and parent↔child session graph (SessionGraph).
 */

import type { ISessionState } from './contracts';

// ─── Session State ───────────────────────────────────────────────────────────

export class SessionState implements ISessionState {
	public activeSessionId: string | undefined;
	public startedSessions = new Set<string>();

	/**
	 * @deprecated Use per-session stop guard via stopGuards map.
	 * Kept for interface compatibility — returns max of all per-session guards.
	 */
	public get stopGuardUntil(): number {
		let max = 0;
		for (const ts of this.stopGuards.values()) {
			if (ts > max) max = ts;
		}
		return max;
	}
	public set stopGuardUntil(_v: number) {
		throw new Error(
			'stopGuardUntil setter is deprecated. Use activateStopGuard(duration, sessionId) instead.',
		);
	}

	/**
	 * Per-session stop guards. Maps sessionId → timestamp (ms) until which
	 * incoming "busy" status events should be suppressed for that session.
	 * Prevents race conditions where delayed SSE events overwrite the
	 * forced "idle" status after the user clicks Stop.
	 */
	private readonly stopGuards = new Map<string, number>();

	constructor() {
		this.activeSessionId = undefined;
	}

	reset(newId?: string) {
		this.activeSessionId = newId;
		this.stopGuards.clear();
	}

	isStopGuarded(sessionId?: string): boolean {
		if (sessionId) {
			const until = this.stopGuards.get(sessionId);
			return until !== undefined && until > 0 && Date.now() < until;
		}
		// Fallback: check if any session is guarded
		for (const until of this.stopGuards.values()) {
			if (until > 0 && Date.now() < until) return true;
		}
		return false;
	}

	activateStopGuard(durationMs = 10_000, sessionId?: string): void {
		if (!sessionId) return;
		this.stopGuards.set(sessionId, Date.now() + durationMs);
	}

	clearStopGuard(sessionId?: string): void {
		if (sessionId) {
			this.stopGuards.delete(sessionId);
		} else {
			this.stopGuards.clear();
		}
	}
}

export class SessionManager {
	private readonly sessions = new Map<
		string,
		{ id: string; title?: string; parentID?: string; lastModified?: number; created?: number }
	>();

	setSession(session: {
		id: string;
		title?: string;
		parentID?: string;
		lastModified?: number;
		created?: number;
	}): void {
		this.sessions.set(session.id, session);
	}

	getSession(sessionId: string) {
		return this.sessions.get(sessionId);
	}

	removeSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	clear(): void {
		this.sessions.clear();
	}
}

// ─── Session Graph ───────────────────────────────────────────────────────────

/** How the parent↔child link was established. */
export type LinkSource = 'metadata' | 'session_parentID' | 'deferred' | 'restored';

export interface ChildSessionEntry {
	childSessionId: string;
	parentSessionId: string;
	/** The tool_use ID of the `task` call that spawned this child. */
	taskToolCallId: string;
	/** Timestamp when the link was registered. */
	registeredAt: number;
	/** How this link was established — useful for debugging. */
	linkSource: LinkSource;
}

/** Pending link: task metadata arrived but session info hasn't yet. */
interface PendingTaskLink {
	toolCallId: string;
	childSessionId: string;
	parentSessionId: string;
	createdAt: number;
}

/** Minimal session info needed for graph rebuild from history/restore. */
export interface SessionInfoForRebuild {
	id: string;
	parentID?: string;
	/** If known, the tool call that spawned this session. */
	taskToolCallId?: string;
}

export class SessionGraph {
	/** childSessionId → entry */
	private readonly childToParent = new Map<string, ChildSessionEntry>();
	/** parentSessionId → Set<childSessionId> */
	private readonly parentToChildren = new Map<string, Set<string>>();
	/** taskToolCallId → childSessionId */
	private readonly taskToChild = new Map<string, string>();
	/** childSessionId → taskToolCallId (reverse of taskToChild, permanent) */
	private readonly childToTaskToolCall = new Map<string, string>();
	/** Pending links: childSessionId → PendingTaskLink (metadata arrived before session). */
	private readonly pendingLinks = new Map<string, PendingTaskLink>();

	// ─── Registration ────────────────────────────────────────────────────

	/**
	 * Register a parent↔child link. Idempotent — re-registering the same
	 * childSessionId with the same parent is a no-op.
	 * Also resolves any pending link for this childSessionId.
	 */
	registerChild(
		childSessionId: string,
		parentSessionId: string,
		taskToolCallId: string,
		linkSource: LinkSource = 'metadata',
	): void {
		if (this.childToParent.has(childSessionId)) return;

		const entry: ChildSessionEntry = {
			childSessionId,
			parentSessionId,
			taskToolCallId,
			registeredAt: Date.now(),
			linkSource,
		};

		this.childToParent.set(childSessionId, entry);
		this.taskToChild.set(taskToolCallId, childSessionId);
		this.childToTaskToolCall.set(childSessionId, taskToolCallId);

		let siblings = this.parentToChildren.get(parentSessionId);
		if (!siblings) {
			siblings = new Set();
			this.parentToChildren.set(parentSessionId, siblings);
		}
		siblings.add(childSessionId);

		// Resolve pending link if one existed for this child.
		this.pendingLinks.delete(childSessionId);
	}

	// ─── Pending / Deferred Linking ──────────────────────────────────────

	/**
	 * Record a pending link when task metadata arrives before the child session.
	 * When the session later appears, call `resolvePendingLink()`.
	 */
	addPendingLink(toolCallId: string, childSessionId: string, parentSessionId: string): void {
		if (this.childToParent.has(childSessionId)) return; // already linked
		this.pendingLinks.set(childSessionId, {
			toolCallId,
			childSessionId,
			parentSessionId,
			createdAt: Date.now(),
		});
	}

	/**
	 * Try to resolve a pending link for a session that just appeared.
	 * Returns true if a pending link was found and resolved.
	 */
	resolvePendingLink(childSessionId: string): boolean {
		const pending = this.pendingLinks.get(childSessionId);
		if (!pending) return false;
		this.registerChild(
			pending.childSessionId,
			pending.parentSessionId,
			pending.toolCallId,
			'deferred',
		);
		return true;
	}

	/** Check if there's a pending (unresolved) link for a child session. */
	hasPendingLink(childSessionId: string): boolean {
		return this.pendingLinks.has(childSessionId);
	}

	/** Get all unresolved pending links (for debug). */
	getPendingLinks(): PendingTaskLink[] {
		return [...this.pendingLinks.values()];
	}

	// ─── Reconciliation ──────────────────────────────────────────────────

	/**
	 * Reconcile a task metadata link: if the child session is already known
	 * in the graph, ensure the toolCallId mapping exists. If not, create a
	 * pending link. Used during history replay and reconnect.
	 */
	reconcileTaskMetadataLink(
		toolCallId: string,
		childSessionId: string,
		parentSessionId: string,
	): void {
		if (this.childToParent.has(childSessionId)) {
			// Session already registered — just ensure task mapping exists.
			if (!this.taskToChild.has(toolCallId)) {
				this.taskToChild.set(toolCallId, childSessionId);
			}
			if (!this.childToTaskToolCall.has(childSessionId)) {
				this.childToTaskToolCall.set(childSessionId, toolCallId);
			}
			return;
		}
		// Session not yet known — defer.
		this.addPendingLink(toolCallId, childSessionId, parentSessionId);
	}

	// ─── Queries ─────────────────────────────────────────────────────────

	getParent(childSessionId: string): string | undefined {
		return this.childToParent.get(childSessionId)?.parentSessionId;
	}

	getChildByTaskId(taskToolCallId: string): string | undefined {
		return this.taskToChild.get(taskToolCallId);
	}

	/** Get the originating tool call ID for a child session. */
	getOriginatingToolCall(childSessionId: string): string | undefined {
		return this.childToTaskToolCall.get(childSessionId);
	}

	getChildren(parentSessionId: string): string[] {
		const set = this.parentToChildren.get(parentSessionId);
		return set ? [...set] : [];
	}

	/**
	 * Get all descendants of a session (children, grandchildren, etc.)
	 * using breadth-first traversal. Includes a depth guard to prevent
	 * infinite loops on corrupted graph state.
	 */
	getDescendants(sessionId: string, maxDepth = 50): string[] {
		const result: string[] = [];
		const queue: Array<{ id: string; depth: number }> = [{ id: sessionId, depth: 0 }];
		const visited = new Set<string>();
		visited.add(sessionId);

		let head = 0;
		while (head < queue.length) {
			const current = queue[head++];
			if (!current) break;
			if (current.depth >= maxDepth) continue;

			const children = this.parentToChildren.get(current.id);
			if (!children) continue;

			for (const childId of children) {
				if (visited.has(childId)) continue;
				visited.add(childId);
				result.push(childId);
				queue.push({ id: childId, depth: current.depth + 1 });
			}
		}
		return result;
	}

	/**
	 * Get the lineage (ancestry chain) from a session up to the root.
	 * Returns [immediateParent, grandparent, ..., root].
	 * Includes a depth guard.
	 */
	getLineage(sessionId: string, maxDepth = 50): string[] {
		const lineage: string[] = [];
		let current = sessionId;
		let depth = 0;

		while (depth < maxDepth) {
			const parentId = this.childToParent.get(current)?.parentSessionId;
			if (!parentId) break;
			lineage.push(parentId);
			current = parentId;
			depth++;
		}
		return lineage;
	}

	isChild(sessionId: string): boolean {
		return this.childToParent.has(sessionId);
	}

	getEntry(childSessionId: string): ChildSessionEntry | undefined {
		return this.childToParent.get(childSessionId);
	}

	/** Get the number of direct children for a session. */
	getChildCount(sessionId: string): number {
		return this.parentToChildren.get(sessionId)?.size ?? 0;
	}

	/** Get the total number of descendants for a session. */
	getDescendantCount(sessionId: string, maxDepth = 50): number {
		return this.getDescendants(sessionId, maxDepth).length;
	}

	// ─── Rebuild / Restore ───────────────────────────────────────────────

	/**
	 * Rebuild the graph from a list of session infos (e.g. after history
	 * reload or reconnect). Clears existing state first.
	 */
	rebuildFromSessions(sessions: SessionInfoForRebuild[]): void {
		this.clear();
		for (const session of sessions) {
			if (session.parentID) {
				this.registerChild(
					session.id,
					session.parentID,
					session.taskToolCallId ?? `restored-${session.id}`,
					'restored',
				);
			}
		}
	}

	// ─── Cleanup ─────────────────────────────────────────────────────────

	clearParent(parentSessionId: string): void {
		const children = this.parentToChildren.get(parentSessionId);
		if (children) {
			for (const childId of children) {
				const entry = this.childToParent.get(childId);
				if (entry) this.taskToChild.delete(entry.taskToolCallId);
				this.childToParent.delete(childId);
				this.childToTaskToolCall.delete(childId);
			}
			this.parentToChildren.delete(parentSessionId);
		}
	}

	clear(): void {
		this.childToParent.clear();
		this.parentToChildren.clear();
		this.taskToChild.clear();
		this.childToTaskToolCall.clear();
		this.pendingLinks.clear();
	}

	// ─── Debug ───────────────────────────────────────────────────────────

	/** Serialize the full graph state for debug dump. */
	toDebugSnapshot(): {
		entries: ChildSessionEntry[];
		pendingLinks: PendingTaskLink[];
		childCount: number;
	} {
		return {
			entries: [...this.childToParent.values()],
			pendingLinks: [...this.pendingLinks.values()],
			childCount: this.childToParent.size,
		};
	}
}
