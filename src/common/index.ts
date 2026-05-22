/**
 * @file Common exports
 * @description Single entry point for values/types shared between extension and webview.
 */

export * from './constants';
// Normalized event types (shared between extension and webview)
export * from './normalizedTypes';
// Protocol: unified Extension ↔ Webview message contract (named exports to avoid collisions with schemas)
export type {
	AgentResource,
	CommandListItem,
	CommandOf,
	CommandResource,
	ExtensionMessage,
	LspStatusData,
	ManagedResource,
	PermissionPolicies,
	PluginListItem,
	PluginResource,
	QuestionAnswer,
	QueuedMessageData,
	ResourceKind,
	SendMessageAttachments,
	SessionPermissionRequest,
	SessionQuestionRequest,
	SessionTodoItem,
	ShowNotificationMessage,
	SkillListItem,
	SkillResource,
	TabStateMessage,
	WebviewCommand,
} from './protocol';
export * from './proxyEndpoints';
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

	// Replicate OpenCode's exact encoding: 6-byte big-endian (truncates upper bits).
	// Extract lower 48 bits and format as zero-padded hex.
	const encoded = BigInt(now) * 0x1000n + BigInt(_counter);
	const hex = (encoded & 0xffffffffffffn).toString(16).padStart(12, '0');

	return `${prefix}_${hex}${secureRandomBase62(14)}`;
}
function findTaskResultContentOutsideCodeFence(raw: string): string | undefined {
	let inFence = false;
	let lineStart = 0;
	while (lineStart <= raw.length) {
		const lineEnd = raw.indexOf('\n', lineStart);
		const end = lineEnd === -1 ? raw.length : lineEnd;
		const line = raw.slice(lineStart, end);
		if (line.trimStart().startsWith('```')) {
			inFence = !inFence;
			if (lineEnd === -1) break;
			lineStart = lineEnd + 1;
			continue;
		}
		const openMatch = line.match(/^\s*<task_result>\s*/i);
		if (!inFence && openMatch?.[0]) {
			const contentStart = lineStart + openMatch[0].length;
			const closeMatch = raw.slice(contentStart).match(/<\/task_result>/i);
			if (closeMatch?.index !== undefined) {
				return raw.slice(contentStart, contentStart + closeMatch.index).trim();
			}
			return undefined;
		}
		if (lineEnd === -1) break;
		lineStart = lineEnd + 1;
	}
	return undefined;
}

export function extractCanonicalTaskResult(raw: string): string {
	const trimmed = raw.trim();
	return findTaskResultContentOutsideCodeFence(trimmed) ?? trimmed;
}

export function stripTaskResultDisplayMetadata(raw: string): string {
	return raw
		.replace(/<task_metadata>[\s\S]*?<\/task_metadata>/g, '')
		.replace(/^to continue:\s*task\([\s\S]*$/gm, '')
		.replace(/^task_id:\s*\S+.*$/gm, '')
		.trim();
}
