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
	SessionAccessPayload,
	SessionDeleteMessagesAfterPayload,
	SessionEventBatchMessage,
	SessionEventMessage,
	SessionEventPayload,
	SessionEventType,
	SessionFilePayload,
	SessionLifecycleMessage,
	SessionMessageData,
	SessionMessagePayload,
	SessionMessageRemovedPayload,
	SessionMessagesReloadPayload,
	SessionMessageUpdate,
	SessionRestorePayload,
	SessionStatsPayload,
	SessionStatus,
	SessionStatusPayload,
	SessionTurnTokensPayload,
	SubtaskTranscriptPayload,
	WebviewCommand,
} from './protocol';
// Schemas: runtime-validated types (TypeBox) — exported first as source of truth for Rule, ParsedCommand, etc.
export * from './schemas';
// Unified tool name registry (shared between extension and webview)
export * from './toolRegistry';

/**
 * Counter for monotonic ID generation within the same millisecond.
 * Mirrors OpenCode's Identifier.ascending() internal state.
 */
let _lastTimestamp = 0;
let _counter = 0;

/**
 * Secure base62 random string using crypto.getRandomValues (works in both
 * Node.js ≥19 and browser/webview). Falls back to Math.random() gracefully.
 */
function secureRandomBase62(length: number): string {
	const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	const bytes = new Uint8Array(length);
	if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let result = '';
	for (let i = 0; i < length; i++) result += chars[bytes[i] % 62];
	return result;
}

/**
 * Generate a unique ID matching OpenCode's `Identifier.ascending()` format.
 *
 * OpenCode's prompt loop uses string comparison (`lastUser.id < lastAssistant.id`)
 * to decide whether to process a new message. Our IDs MUST sort identically to
 * server-generated IDs for the same timestamp, otherwise the loop exits immediately.
 *
 * OpenCode encodes `BigInt(timestamp) * 0x1000n + counter` into a 6-byte Buffer
 * (big-endian, truncating upper bits) then hex-encodes it. We MUST replicate this
 * exact encoding — NOT `.toString(16).slice()` which truncates the wrong end.
 */
export function generateId(prefix: string): string {
	const now = Date.now();
	if (now !== _lastTimestamp) {
		_lastTimestamp = now;
		_counter = 0;
	}
	_counter++;

	// Replicate OpenCode's exact encoding: 6-byte big-endian (truncates upper bits)
	// Uses bitwise extraction instead of Buffer for browser/webview compatibility.
	const encoded = BigInt(now) * BigInt(0x1000) + BigInt(_counter);
	let hex = '';
	for (let i = 0; i < 6; i++) {
		const byte = Number((encoded >> BigInt(40 - 8 * i)) & BigInt(0xff));
		hex += byte.toString(16).padStart(2, '0');
	}

	return `${prefix}_${hex}${secureRandomBase62(14)}`;
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
