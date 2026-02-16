/**
 * @file Common exports
 * @description Single entry point for values/types shared between extension and webview.
 */

export * from './constants';
// Normalized event types (shared between extension and webview)
export * from './normalizedTypes';
// Protocol: unified Extension ↔ Webview message contract (named exports to avoid collisions with schemas)
export type {
	CommandOf,
	ExtensionMessage,
	PermissionPolicies,
	QuestionOption,
	SessionAccessPayload,
	SessionDeleteMessagesAfterPayload,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionLifecycleMessage,
	SessionMessageData,
	SessionMessagePayload,
	SessionMessageRemovedPayload,
	SessionMessagesReloadPayload,
	SessionRestorePayload,
	SessionStatsPayload,
	SessionStatus,
	SessionStatusPayload,
	SessionTurnTokensPayload,
	WebviewCommand,
} from './protocol';
// Schemas: runtime-validated types (TypeBox) — exported first as source of truth for Rule, ParsedCommand, etc.
export * from './schemas';

/** Generate a unique ID with the given prefix: `{prefix}-{timestamp}-{random}` */
export function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normalize a user-provided proxy base URL to the canonical form expected by
 * `@ai-sdk/openai-compatible`, which appends `/chat/completions` directly.
 *
 * Handles common user mistakes:
 *   http://host:port            → http://host:port/v1
 *   http://host:port/           → http://host:port/v1
 *   http://host:port///         → http://host:port/v1
 *   http://host:port/v1         → http://host:port/v1
 *   http://host:port/v1/        → http://host:port/v1
 *   http://host:port/v1/models  → http://host:port/v1
 *   http://host:port/v1/chat/completions → http://host:port/v1
 */
export function normalizeProxyBaseUrl(raw: string): string {
	return `${raw
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1(?:\/.*)?$/, '')}/v1`;
}
