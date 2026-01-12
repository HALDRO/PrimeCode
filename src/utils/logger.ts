import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

/**
 * Serialize a value for logging, handling Error objects specially
 */
function serializeArg(arg: unknown): string {
	if (arg instanceof Error) {
		// Error objects don't serialize well with JSON.stringify
		const errorObj: Record<string, unknown> = {
			name: arg.name,
			message: arg.message,
		};
		if (arg.stack) {
			errorObj.stack = arg.stack;
		}
		// Include any additional properties (like 'code', 'cause', etc.)
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
 * Format arguments for logging
 */
function formatArgs(args: unknown[]): string {
	if (args.length === 0) return '';
	if (args.length === 1) return serializeArg(args[0]);
	return args.map(serializeArg).join(' ');
}

export const logger = {
	initialize: (name: string) => {
		outputChannel = vscode.window.createOutputChannel(name);
	},
	get channel() {
		return outputChannel;
	},
	info: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.appendLine(`[INFO] ${new Date().toISOString()} - ${formatted}`);
		console.log(`${message}`, ...args);
	},
	error: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.appendLine(`[ERROR] ${new Date().toISOString()} - ${formatted}`);
		console.error(`${message}`, ...args);
	},
	warn: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.appendLine(`[WARN] ${new Date().toISOString()} - ${formatted}`);
		console.warn(`${message}`, ...args);
	},
	debug: (message: string, ...args: unknown[]) => {
		const formatted = args.length > 0 ? `${message} ${formatArgs(args)}` : message;
		outputChannel?.appendLine(`[DEBUG] ${new Date().toISOString()} - ${formatted}`);
	},
	show: (preserveFocus?: boolean) => {
		outputChannel?.show(preserveFocus);
	},
	dispose: () => {
		outputChannel?.dispose();
	},
};
