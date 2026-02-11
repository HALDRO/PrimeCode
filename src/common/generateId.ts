/**
 * @file ID generation utility
 * @description Generates unique prefixed IDs used across extension and webview.
 */

/** Generate a unique ID with the given prefix: `{prefix}-{timestamp}-{random}` */
export function generateId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
