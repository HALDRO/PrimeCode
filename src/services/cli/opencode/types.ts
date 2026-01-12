/**
 * @file OpenCode SDK Types
 * @description Internal type definitions for OpenCode SDK integration.
 * Extracted from OpenCodeService.ts during refactoring.
 * Uses proper typing from @opencode-ai/sdk for type safety.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';

export interface OpenCodeAgent {
	name: string;
	description?: string;
	mode: 'subagent' | 'primary' | 'all';
	builtIn: boolean;
	options?: Record<string, unknown>;
}

export interface OpenCodeSession {
	id: string;
	title: string;
	projectID?: string;
	directory?: string;
	time?: { created: number; updated: number };
}

export interface OpenCodeEvent {
	type: string;
	properties?: Record<string, unknown>;
}

export interface OpencodeInstance {
	client: OpencodeClient;
	server: {
		url: string;
		close(): void;
	};
}

// Result types for various operations
export interface Result {
	success: boolean;
	error?: string;
}

export interface ForkResult extends Result {
	newSessionId?: string;
}

export interface ShareResult extends Result {
	shareUrl?: string;
}

export interface OAuthStartResult extends Result {
	url?: string;
	method?: string;
	instructions?: string;
}

export interface McpAuthResult extends Result {
	authorizationUrl?: string;
}

export interface CustomProviderConfig {
	id: string;
	name: string;
	baseURL: string;
	apiKey: string;
	models?: Array<{ id: string; name: string }>;
}
