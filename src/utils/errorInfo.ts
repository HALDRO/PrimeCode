/**
 * @file Structured error information extraction
 * @description Preserves error structure (code, cause chain, metadata) when converting
 *              unknown errors into a canonical ErrorInfo object. Used for both logging
 *              enrichment and notification overlay propagation.
 *
 *              Unlike the old stringifyUnknownError (which only extracted .message),
 *              this preserves the full error shape so consumers can programmatically
 *              handle different error types, show error codes, and trace cause chains.
 */

// =============================================================================
// Types
// =============================================================================

export type ErrorSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface ErrorInfo {
	/** Human-readable error message (always present). */
	message: string;
	/** Machine-readable error code for programmatic handling (e.g. 'PROVIDER_AUTH', 'RATE_LIMIT'). */
	code?: string;
	/** Severity level inferred from error shape. */
	severity: ErrorSeverity;
	/** Error class name (e.g. 'ProviderAuthError', 'APIError'). */
	name?: string;
	/** Stack trace, if available and safe to expose. */
	stack?: string;
	/** Chained cause (e.g. `error.cause`) if present. */
	cause?: ErrorInfo;
	/** Arbitrary metadata attached to the original error object. */
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Severity inference
// =============================================================================

/**
 * Infer severity from error structure and message content.
 * Based on OpenCode's error categorization:
 * - critical: auth failures, context overflow, quota exhausted (unrecoverable, user must act)
 * - error: API failures, spawn errors, unknown (may be retryable)
 * - warning: output length, rate limits, transient issues
 * - info: system notices, non-error information
 */
function inferSeverity(name: string | undefined, message: string): ErrorSeverity {
	const lower = message.toLowerCase();
	const lowerName = name?.toLowerCase() ?? '';

	// Critical: auth failures, context overflow, quota exhausted
	if (
		lowerName.includes('autherror') ||
		lowerName.includes('providerautherror') ||
		lowerName.includes('contextoverflowerror') ||
		(/\b(auth|unauthorized|forbidden)\b/.test(lower) &&
			/\b(api[_\s]?key|token|credential)\b/.test(lower)) ||
		/\bcontext[_\s]?(length[_\s]?exceeded|overflow)\b/.test(lower) ||
		/\b(quota|insufficient[_\s]?quota)\b/.test(lower)
	) {
		return 'critical';
	}

	// Warning: output length, rate limits, transient
	if (
		/\boutput[_\s]?length\b/.test(lower) ||
		/\brate[_\s]?limit\b/.test(lower) ||
		lower.includes('too many requests') ||
		lower.includes('throttle')
	) {
		return 'warning';
	}

	return 'error';
}

// =============================================================================
// Stack extraction
// =============================================================================

function extractStack(error: unknown): string | undefined {
	if (error instanceof Error && error.stack) {
		return error.stack;
	}
	return undefined;
}

// =============================================================================
// Metadata extraction (custom properties on error objects)
// =============================================================================

function extractMetadata(error: unknown): Record<string, unknown> | undefined {
	if (!error || typeof error !== 'object') return undefined;
	if (error instanceof Error) {
		const record = error as unknown as Record<string, unknown>;
		const meta: Record<string, unknown> = {};
		for (const key of Object.getOwnPropertyNames(error)) {
			if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
			const val = record[key];
			if (val !== undefined && typeof val !== 'function') {
				meta[key] = val;
			}
		}
		return Object.keys(meta).length > 0 ? meta : undefined;
	}
	// Plain object — include all own keys except message
	const record = error as Record<string, unknown>;
	const meta: Record<string, unknown> = {};
	for (const key of Object.getOwnPropertyNames(error)) {
		if (key === 'message') continue;
		const val = record[key];
		if (val !== undefined && typeof val !== 'function') {
			meta[key] = val;
		}
	}
	return Object.keys(meta).length > 0 ? meta : undefined;
}

// =============================================================================
// Cause chain extraction
// =============================================================================

function extractCause(error: unknown): ErrorInfo | undefined {
	if (error instanceof Error && error.cause) {
		return extractErrorInfo(error.cause);
	}
	return undefined;
}

// =============================================================================
// Code extraction
// =============================================================================

function extractCode(error: unknown): string | undefined {
	if (!error || typeof error !== 'object') return undefined;
	const record = error as Record<string, unknown>;

	// Common error code fields across different libraries
	if (typeof record.code === 'string') return record.code;
	if (typeof record.errorCode === 'string') return record.errorCode;
	if (typeof record.statusCode === 'number') return String(record.statusCode);

	// Nested data.code (common in API error responses)
	const data = record.data;
	if (data && typeof data === 'object') {
		const dataRecord = data as Record<string, unknown>;
		if (typeof dataRecord.code === 'string') return dataRecord.code;
		if (typeof dataRecord.statusCode === 'number') return String(dataRecord.statusCode);
		if (typeof dataRecord.error === 'object' && dataRecord.error !== null) {
			const innerError = dataRecord.error as Record<string, unknown>;
			if (typeof innerError.code === 'string') return innerError.code;
			if (typeof innerError.statusCode === 'number') return String(innerError.statusCode);
		}
	}

	return undefined;
}

// =============================================================================
// Message extraction (always returns a non-empty string)
// =============================================================================

function extractMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name || 'Unknown error';
	if (typeof error === 'string' && error.trim()) return error.trim();
	if (!error || typeof error !== 'object') return 'Unknown error';

	const record = error as Record<string, unknown>;

	// Direct .message
	const message = record.message;
	if (typeof message === 'string' && message.trim()) return message.trim();

	// Nested data.message
	const data = record.data;
	if (data && typeof data === 'object') {
		const dataMessage = (data as Record<string, unknown>).message;
		if (typeof dataMessage === 'string' && dataMessage.trim()) return dataMessage.trim();
	}

	// Fallback: JSON.stringify
	try {
		return JSON.stringify(error);
	} catch {
		return 'Unknown error';
	}
}

function extractName(error: unknown): string | undefined {
	if (error instanceof Error) return error.name;
	if (!error || typeof error !== 'object') return undefined;
	const name = (error as Record<string, unknown>).name;
	return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

// =============================================================================
// Main extraction function
// =============================================================================

export function extractErrorInfo(error: unknown): ErrorInfo {
	const message = extractMessage(error);
	const name = extractName(error);
	const severity = inferSeverity(name, message);
	const code = extractCode(error);
	const stack = extractStack(error);
	const cause = extractCause(error);
	const metadata = extractMetadata(error);

	return {
		message,
		code,
		severity,
		name,
		stack,
		cause,
		metadata,
	};
}
