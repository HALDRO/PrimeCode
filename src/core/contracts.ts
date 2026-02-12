/**
 * @file Contracts
 * @description Core DI interfaces for decoupling extension layers. Re-exports ISettings from
 *              Settings.ts as single source of truth. ISessionState tracks active session ID
 *              (now correctly typed as string | undefined) and started sessions set.
 */

import type { CLIEvent } from './executor/types';

export type { ISettings } from './Settings';

export interface ICLIConfig {
	provider: 'claude' | 'opencode';
	model?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	env?: Record<string, string>;
	serverTimeoutMs?: number;
	autoCompact?: boolean;
	commitReminder?: boolean;
}

export interface ICLIRunner {
	spawn(prompt: string, config: ICLIConfig): Promise<unknown>;
	spawnFollowUp(prompt: string, sessionId: string, config: ICLIConfig): Promise<unknown>;
	/** Truncate session history at a specific message ID (OpenCode only; no-op for other providers). */
	truncateSession(sessionId: string, messageId: string, config: ICLIConfig): Promise<void>;
	spawnReview(prompt: string, config: ICLIConfig): Promise<unknown>;
	createNewSession(prompt: string, config: ICLIConfig): Promise<unknown>;
	/** Creates an empty session without sending a message. Returns the session ID. */
	createEmptySession(config: ICLIConfig): Promise<string>;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;
	kill(): Promise<void>;
	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null;
	getProvider(): 'claude' | 'opencode';
	listSessions(config: ICLIConfig): Promise<
		Array<{
			id: string;
			title?: string;
			lastModified?: number;
			created?: number;
			parentID?: string;
		}>
	>;
	getHistory(sessionId: string, config: ICLIConfig): Promise<CLIEvent[]>;
	deleteSession(sessionId: string, config: ICLIConfig): Promise<boolean>;
	renameSession(sessionId: string, title: string, config: ICLIConfig): Promise<boolean>;
	abort(): Promise<void>;
	on(event: string, listener: (...args: unknown[]) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
}

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
