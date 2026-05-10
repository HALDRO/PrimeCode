/**
 * @file Webview-safe prefix-based logger (browser console + extension OutputChannel)
 * @description Mirrors the extension logger API. Logs go to both browser DevTools
 *              (via console) and the VS Code OutputChannel (via postMessage bridge)
 *              so all diagnostics are available in one place.
 *              Prefix format: [ComponentName] [sess:id] message
 */

import { vscode } from './vscode';

// =============================================================================
// Types
// =============================================================================

export interface WebviewLogger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	trace(message: string, ...args: unknown[]): void;
	forComponent(component: string): WebviewLogger;
	forSession(sessionId: string): WebviewLogger;
}

// =============================================================================
// Helpers
// =============================================================================

function formatArgs(args: unknown[]): string {
	if (args.length === 0) return '';
	return args
		.map(arg => {
			if (arg instanceof Error) {
				return `${arg.name}: ${arg.message}`;
			}
			try {
				return JSON.stringify(arg);
			} catch {
				return String(arg);
			}
		})
		.join(' ');
}

// =============================================================================
// Scoped logger
// =============================================================================

function createWebviewLogger(parentPrefix: string): WebviewLogger {
	const prefix = parentPrefix;

	// Extract component name from prefix for forwarding (strip brackets)
	const componentMatch = prefix.match(/\[(\w+)\]/);
	const component = componentMatch ? componentMatch[1] : 'WebView';

	function build(message: string, args: unknown[]): string {
		const extra = formatArgs(args);
		return extra ? `${prefix}${message} ${extra}` : `${prefix}${message}`;
	}

	function forward(
		level: 'info' | 'warn' | 'error' | 'debug',
		message: string,
		args: unknown[],
	): void {
		const extra = formatArgs(args);
		try {
			vscode.postMessage({
				type: 'webviewLog',
				level,
				component,
				message,
				details: extra || undefined,
			});
		} catch {
			// Ignore postMessage failures (webview not ready yet)
		}
	}

	return {
		info: (message: string, ...args: unknown[]) => {
			console.info(build(message, args));
			forward('info', message, args);
		},
		error: (message: string, ...args: unknown[]) => {
			console.error(build(message, args));
			forward('error', message, args);
		},
		warn: (message: string, ...args: unknown[]) => {
			console.warn(build(message, args));
			forward('warn', message, args);
		},
		debug: (message: string, ...args: unknown[]) => {
			console.debug(build(message, args));
			forward('debug', message, args);
		},
		trace: (message: string, ...args: unknown[]) => {
			console.debug(build(message, args));
		},
		forComponent: (comp: string): WebviewLogger => {
			return createWebviewLogger(`${prefix}[${comp}] `);
		},
		forSession: (sessionId: string): WebviewLogger => {
			const short = sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
			return createWebviewLogger(`${prefix}[sess:${short}] `);
		},
	};
}

// =============================================================================
// Root webview logger
// =============================================================================

export const webviewLogger = createWebviewLogger('');
