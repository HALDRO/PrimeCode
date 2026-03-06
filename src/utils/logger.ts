import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;

/**
 * Serialize a value for logging, handling Error objects specially.
 */
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

/**
 * Format arguments for logging.
 */
function formatArgs(args: unknown[]): string {
	if (args.length === 0) return '';
	if (args.length === 1) return serializeArg(args[0]);
	return args.map(serializeArg).join(' ');
}

/**
 * Structured logger backed by VS Code LogOutputChannel.
 *
 * Log level is controlled natively by VS Code:
 *   "Developer: Set Log Level…" → choose level for "PrimeCode"
 *
 * Levels (from most to least verbose): Trace → Debug → Info → Warning → Error
 */
export const logger = {
	initialize: (name: string) => {
		outputChannel = vscode.window.createOutputChannel(name, { log: true });
	},
	get channel() {
		return outputChannel;
	},
	info: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.info(formatted);
	},
	error: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.error(formatted);
	},
	warn: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.warn(formatted);
	},
	debug: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.debug(formatted);
	},
	/** Very verbose tracing — only visible when log level is set to Trace. */
	trace: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.trace(formatted);
	},
	show: (preserveFocus?: boolean) => {
		outputChannel?.show(preserveFocus);
	},
	dispose: () => {
		outputChannel?.dispose();
	},
};
