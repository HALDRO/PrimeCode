/**
 * @file SessionState
 * @description Tracks the active session ID and the set of sessions that have been started
 *              (connected to a CLI backend). activeSessionId is undefined when no session is active.
 */

import type { ISessionState } from './contracts';

export class SessionState implements ISessionState {
	public activeSessionId: string | undefined;
	public startedSessions = new Set<string>();

	constructor() {
		this.activeSessionId = undefined;
	}

	reset(newId?: string) {
		this.activeSessionId = newId;
	}
}
