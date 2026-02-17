/**
 * @file Contracts
 * @description Core DI interfaces for decoupling extension layers. Re-exports ISettings from
 *              Settings.ts as single source of truth. ISessionState tracks active session ID
 *              (now correctly typed as string | undefined) and started sessions set.
 */

export type { ISettings } from './Settings';

export interface IView {
	postMessage(message: unknown): void;
}

export interface ISessionState {
	activeSessionId: string | undefined;
	startedSessions: Set<string>;
	/** @deprecated Use per-session stop guard methods instead. */
	stopGuardUntil: number;
	/** Returns true if the stop guard is active for the given session (or any session if no ID). */
	isStopGuarded(sessionId?: string): boolean;
	/** Activate the stop guard for a specific session. */
	activateStopGuard(durationMs?: number, sessionId?: string): void;
	/** Clear the stop guard for a specific session (or all if no ID). */
	clearStopGuard(sessionId?: string): void;
}
