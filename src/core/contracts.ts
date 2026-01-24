/**
 * @file Contracts
 * @description Core interfaces for dependency injection and decoupling.
 */

import type { PrimeCodeSettings } from './Settings';

export interface ISettings {
	get<T>(key: keyof PrimeCodeSettings): T | undefined;
	set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void>;
	getAll(): PrimeCodeSettings;
	refresh(): void;
}

export interface ICLIConfig {
	provider: 'claude' | 'opencode';
	model?: string;
	workspaceRoot: string;
	yoloMode?: boolean;
	agent?: string;
	env?: Record<string, string>;
	serverTimeoutMs?: number;
}

export interface ICLIRunner {
	spawn(prompt: string, config: ICLIConfig): Promise<void>;
	spawnFollowUp(prompt: string, config: ICLIConfig): Promise<void>;
	createNewSession(prompt: string, config: ICLIConfig): Promise<void>;
	respondToPermission(decision: {
		requestId: string;
		approved: boolean;
		alwaysAllow?: boolean;
		response?: 'once' | 'always' | 'reject';
	}): Promise<void>;
	kill(): Promise<void>;
	getSessionId(): string | null;
	getOpenCodeServerInfo(): { baseUrl: string; directory: string } | null;
	on(event: string, listener: (...args: unknown[]) => void): this;
	off(event: string, listener: (...args: unknown[]) => void): this;
}

export interface IView {
	postMessage(message: unknown): void;
}

export interface ISessionState {
	activeSessionId: string;
	startedSessions: Set<string>;
	// Stats storage can be added here
}
