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

interface ChildSessionEntry {
	childSessionId: string;
	parentSessionId: string;
	/** The tool_use ID of the `task` call that spawned this child. */
	taskToolCallId: string;
	/** Timestamp when the link was registered. */
	registeredAt: number;
}

export class SessionGraph {
	/** childSessionId → entry */
	private readonly childToParent = new Map<string, ChildSessionEntry>();
	/** parentSessionId → Set<childSessionId> */
	private readonly parentToChildren = new Map<string, Set<string>>();
	/** taskToolCallId → childSessionId */
	private readonly taskToChild = new Map<string, string>();

	/**
	 * Register a parent↔child link. Idempotent — re-registering the same
	 * childSessionId with the same parent is a no-op.
	 */
	registerChild(childSessionId: string, parentSessionId: string, taskToolCallId: string): void {
		if (this.childToParent.has(childSessionId)) return;

		const entry: ChildSessionEntry = {
			childSessionId,
			parentSessionId,
			taskToolCallId,
			registeredAt: Date.now(),
		};

		this.childToParent.set(childSessionId, entry);
		this.taskToChild.set(taskToolCallId, childSessionId);

		let siblings = this.parentToChildren.get(parentSessionId);
		if (!siblings) {
			siblings = new Set();
			this.parentToChildren.set(parentSessionId, siblings);
		}
		siblings.add(childSessionId);
	}

	getParent(childSessionId: string): string | undefined {
		return this.childToParent.get(childSessionId)?.parentSessionId;
	}

	getChildByTaskId(taskToolCallId: string): string | undefined {
		return this.taskToChild.get(taskToolCallId);
	}

	getChildren(parentSessionId: string): string[] {
		const set = this.parentToChildren.get(parentSessionId);
		return set ? [...set] : [];
	}

	isChild(sessionId: string): boolean {
		return this.childToParent.has(sessionId);
	}

	getEntry(childSessionId: string): ChildSessionEntry | undefined {
		return this.childToParent.get(childSessionId);
	}

	clearParent(parentSessionId: string): void {
		const children = this.parentToChildren.get(parentSessionId);
		if (children) {
			for (const childId of children) {
				const entry = this.childToParent.get(childId);
				if (entry) this.taskToChild.delete(entry.taskToolCallId);
				this.childToParent.delete(childId);
			}
			this.parentToChildren.delete(parentSessionId);
		}
	}

	clear(): void {
		this.childToParent.clear();
		this.parentToChildren.clear();
		this.taskToChild.clear();
	}
}
