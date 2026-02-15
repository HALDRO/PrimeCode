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
	/** Timestamp (ms) until which incoming 'busy' SSE events are suppressed after Stop. */
	stopGuardUntil: number;
	/** Returns true if the stop guard is currently active. */
	isStopGuarded(): boolean;
	/** Activate the stop guard for the given duration. */
	activateStopGuard(durationMs?: number): void;
	/** Clear the stop guard (e.g. when user sends a new message). */
	clearStopGuard(): void;
}
