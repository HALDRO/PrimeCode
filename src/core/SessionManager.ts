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
	 * Timestamp (ms) until which incoming "busy" status events from SSE
	 * should be suppressed for the active session. Set by onStopRequest()
	 * to prevent race conditions where delayed SSE events overwrite the
	 * forced "idle" status after the user clicks Stop.
	 *
	 * Reset to 0 when the user sends a new message (onSendMessage).
	 */
	public stopGuardUntil = 0;

	constructor() {
		this.activeSessionId = undefined;
	}

	reset(newId?: string) {
		this.activeSessionId = newId;
		this.stopGuardUntil = 0;
	}

	isStopGuarded(): boolean {
		return this.stopGuardUntil > 0 && Date.now() < this.stopGuardUntil;
	}

	activateStopGuard(durationMs = 10_000): void {
		this.stopGuardUntil = Date.now() + durationMs;
	}

	clearStopGuard(): void {
		this.stopGuardUntil = 0;
	}
}

// ─── Session Graph ───────────────────────────────────────────────────────────

export interface ChildSessionEntry {
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

	/**
	 * Build the task→child map from CLI history data.
	 * Used during replay to establish links from backend session list.
	 */
	registerChildrenFromHistory(
		parentSessionId: string,
		taskToolCallIds: string[],
		childSessionIds: string[],
	): void {
		const len = Math.min(taskToolCallIds.length, childSessionIds.length);
		for (let i = 0; i < len; i++) {
			this.registerChild(childSessionIds[i], parentSessionId, taskToolCallIds[i]);
		}
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
