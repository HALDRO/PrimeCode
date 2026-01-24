import type { ISessionState } from './contracts';

export class SessionState implements ISessionState {
	public activeSessionId: string;
	public startedSessions = new Set<string>();

	constructor() {
		this.activeSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}

	reset(newId?: string) {
		this.activeSessionId =
			newId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}
}
