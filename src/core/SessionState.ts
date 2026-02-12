/**
 * @file SessionState
 * @description Tracks the active session ID and the set of sessions that have been started
 *              (connected to a CLI backend). activeSessionId is undefined when no session is active.
 */

import type { ISessionState } from './contracts';

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

	/** Returns true if the stop guard is currently active. */
	isStopGuarded(): boolean {
		return this.stopGuardUntil > 0 && Date.now() < this.stopGuardUntil;
	}

	/** Activate the stop guard for the given duration (default 10s). */
	activateStopGuard(durationMs = 10_000): void {
		this.stopGuardUntil = Date.now() + durationMs;
	}

	/** Clear the stop guard (e.g. when user sends a new message). */
	clearStopGuard(): void {
		this.stopGuardUntil = 0;
	}
}
