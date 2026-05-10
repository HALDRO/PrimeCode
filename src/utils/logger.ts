/**
 * @file Structured scoped logger backed by VS Code LogOutputChannel
 * @description Prefix-based human-readable logging with automatic session/component
 *              context injection. VS Code's LogOutputChannel already provides
 *              timestamps — the logger only adds [Component] and [sess:id] prefixes
 *              for quick scanning and filtering.
 *
 *              Log level is controlled natively by VS Code:
 *                "Developer: Set Log Level…" → choose level for "PrimeCode"
 *              Levels (most → least verbose): Trace → Debug → Info → Warning → Error
 *
 *              Usage:
 *                import { logger } from '../utils/logger';
 *                const log = logger.forComponent('ChatProvider');
 *                log.info('User message sent', { sessionId });
 *                // → [ChatProvider] User message sent {"sessionId":"abc"}
 *
 *              Session-scoped variant (chained):
 *                const log = logger.forComponent('Executor').forSession('abc123');
 *                log.error('Server start failed', error);
 *                // → [sess:abc123…] [Executor] Server start failed {"message":"..."}
 */

import * as vscode from 'vscode';

// =============================================================================
// Types
// =============================================================================

export interface Logger {
	info(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	trace(message: string, ...args: unknown[]): void;
	/** Create a child logger that prepends the component tag to every line. */
	forComponent(component: string): Logger;
	/** Create a child logger that prepends the session ID to every line. */
	forSession(sessionId: string): Logger;
	show(preserveFocus?: boolean): void;
	dispose(): void;
}

// =============================================================================
// Internal state
// =============================================================================

let outputChannel: vscode.LogOutputChannel | undefined;

// =============================================================================
// Helpers
// =============================================================================

function serializeArg(arg: unknown): string {
	if (arg instanceof Error) {
		const errorObj: Record<string, unknown> = {
			name: arg.name,
			message: arg.message,
		};
		if (arg.stack) {
			errorObj.stack = arg.stack;
		}
		for (const key of Object.getOwnPropertyNames(arg)) {
			if (!(key in errorObj)) {
				errorObj[key] = (arg as unknown as Record<string, unknown>)[key];
			}
		}
		return JSON.stringify(errorObj);
	}
	try {
		return JSON.stringify(arg);
	} catch {
		return String(arg);
	}
}

function formatArgs(args: unknown[]): string {
	if (args.length === 0) return '';
	if (args.length === 1) return serializeArg(args[0]);
	return args.map(serializeArg).join(' ');
}

// =============================================================================
// Scoped logger implementation
// =============================================================================

function createScopedLogger(parentPrefix: string): Logger {
	const prefix = parentPrefix;

	function buildMessage(message: string, args: unknown[]): string {
		const extra = formatArgs(args);
		return extra ? `${prefix}${message} ${extra}` : `${prefix}${message}`;
	}

	return {
		info: (message: string, ...args: unknown[]) => {
			outputChannel?.info(buildMessage(message, args));
		},
		error: (message: string, ...args: unknown[]) => {
			outputChannel?.error(buildMessage(message, args));
		},
		warn: (message: string, ...args: unknown[]) => {
			outputChannel?.warn(buildMessage(message, args));
		},
		debug: (message: string, ...args: unknown[]) => {
			outputChannel?.debug(buildMessage(message, args));
		},
		trace: (message: string, ...args: unknown[]) => {
			outputChannel?.trace(buildMessage(message, args));
		},
		forComponent: (component: string): Logger => {
			return createScopedLogger(`${prefix}[${component}] `);
		},
		forSession: (sessionId: string): Logger => {
			const short = sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId;
			return createScopedLogger(`${prefix}[sess:${short}] `);
		},
		show: (preserveFocus?: boolean) => {
			outputChannel?.show(preserveFocus);
		},
		dispose: () => {
			outputChannel?.dispose();
			outputChannel = undefined;
		},
	};
}

// =============================================================================
// Root logger (no prefix)
// =============================================================================

const rootLogger: Logger & {
	initialize(name: string): void;
	readonly channel: vscode.LogOutputChannel | undefined;
} = {
	...createScopedLogger(''),

	initialize: (name: string) => {
		outputChannel = vscode.window.createOutputChannel(name, { log: true });
	},

	get channel() {
		return outputChannel;
	},
};

export const logger = rootLogger;
