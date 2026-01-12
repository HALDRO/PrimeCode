/**
 * @file Centralized error handling service for the extension
 * @description Provides unified error handling, classification, and formatting across the entire
 * extension. Implements typed error classes for different error categories (process, network,
 * permission, validation, etc.), error serialization for IPC, user-friendly message generation,
 * and centralized error logging. Inspired by VS Code's error handling patterns.
 */

import * as vscode from 'vscode';

/**
 * Error codes for classification and telemetry
 */
export enum ErrorCode {
	// Process errors (1xx)
	PROCESS_SPAWN_FAILED = 'E101',
	PROCESS_CRASHED = 'E102',
	PROCESS_TIMEOUT = 'E103',
	PROCESS_KILLED = 'E104',

	// CLI errors (2xx)
	CLI_NOT_FOUND = 'E201',
	CLI_INVALID_OUTPUT = 'E202',
	CLI_AUTH_REQUIRED = 'E203',
	CLI_INVALID_API_KEY = 'E204',

	// Network errors (4xx)
	NETWORK_TIMEOUT = 'E401',
	NETWORK_UNREACHABLE = 'E402',
	NETWORK_PROXY_ERROR = 'E403',
	NETWORK_SSL_ERROR = 'E404',

	// Permission errors (5xx)
	PERMISSION_DENIED = 'E501',
	PERMISSION_FILE_ACCESS = 'E502',
	PERMISSION_MCP_CONFIG = 'E503',

	// File system errors (6xx)
	FS_FILE_NOT_FOUND = 'E601',
	FS_READ_ERROR = 'E602',
	FS_WRITE_ERROR = 'E603',
	FS_DIRECTORY_ERROR = 'E604',

	// Validation errors (7xx)
	VALIDATION_INVALID_INPUT = 'E701',
	VALIDATION_SCHEMA_ERROR = 'E702',
	VALIDATION_JSON_PARSE = 'E703',

	// Git errors (8xx)
	GIT_NOT_FOUND = 'E801',
	GIT_OPERATION_FAILED = 'E802',
	GIT_CONFLICT = 'E803',

	// Unknown/generic (9xx)
	UNKNOWN = 'E999',
}

/**
 * Serialized error format for IPC between extension and webview
 */
export interface SerializedError {
	readonly $isError: true;
	readonly code: ErrorCode;
	readonly name: string;
	readonly message: string;
	readonly userMessage: string;
	readonly stack?: string;
	readonly cause?: SerializedError;
	readonly context?: Record<string, unknown>;
}

/**
 * Base error class for all extension errors
 */
export class ExtensionError extends Error {
	readonly code: ErrorCode;
	readonly userMessage: string;
	readonly context?: Record<string, unknown>;

	constructor(
		message: string,
		code: ErrorCode = ErrorCode.UNKNOWN,
		userMessage?: string,
		context?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'ExtensionError';
		this.code = code;
		this.userMessage = userMessage || message;
		this.context = context;
		Object.setPrototypeOf(this, ExtensionError.prototype);
	}

	static is(error: unknown): error is ExtensionError {
		return error instanceof ExtensionError;
	}
}

/**
 * Process-related errors (Claude CLI spawn, execution)
 */
export class ProcessError extends ExtensionError {
	constructor(
		message: string,
		code: ErrorCode = ErrorCode.PROCESS_SPAWN_FAILED,
		context?: Record<string, unknown>,
	) {
		const userMessage = ProcessError.getUserMessage(code, context);
		super(message, code, userMessage, context);
		this.name = 'ProcessError';
		Object.setPrototypeOf(this, ProcessError.prototype);
	}

	private static getUserMessage(code: ErrorCode, _context?: Record<string, unknown>): string {
		switch (code) {
			case ErrorCode.CLI_NOT_FOUND:
				return 'CLI not found. Please ensure the CLI tool is installed and available in PATH.';
			case ErrorCode.CLI_AUTH_REQUIRED:
				return 'Authentication required. Please login in the terminal.';
			case ErrorCode.CLI_INVALID_API_KEY:
				return 'Invalid API key. Please check your configuration.';
			case ErrorCode.PROCESS_TIMEOUT:
				return 'Request timed out. Please try again.';
			case ErrorCode.PROCESS_KILLED:
				return 'Process was stopped.';
			default:
				return 'An error occurred. Please try again.';
		}
	}

	static fromSpawnError(error: Error): ProcessError {
		const message = error.message;

		if (message.includes('ENOENT') || message.includes('command not found')) {
			return new ProcessError(message, ErrorCode.CLI_NOT_FOUND);
		}

		return new ProcessError(message, ErrorCode.PROCESS_SPAWN_FAILED);
	}

	static fromExitCode(code: number, stderr: string): ProcessError {
		if (stderr.includes('Invalid API key')) {
			return new ProcessError(stderr, ErrorCode.CLI_INVALID_API_KEY);
		}

		if (stderr.includes('authentication') || stderr.includes('login')) {
			return new ProcessError(stderr, ErrorCode.CLI_AUTH_REQUIRED);
		}

		return new ProcessError(
			stderr || `Process exited with code ${code}`,
			ErrorCode.PROCESS_CRASHED,
			{ exitCode: code },
		);
	}
}

/**
 * Network-related errors (API calls, proxy)
 */
export class NetworkError extends ExtensionError {
	constructor(
		message: string,
		code: ErrorCode = ErrorCode.NETWORK_UNREACHABLE,
		context?: Record<string, unknown>,
	) {
		const userMessage = NetworkError.getUserMessage(code, context);
		super(message, code, userMessage, context);
		this.name = 'NetworkError';
		Object.setPrototypeOf(this, NetworkError.prototype);
	}

	private static getUserMessage(code: ErrorCode, context?: Record<string, unknown>): string {
		switch (code) {
			case ErrorCode.NETWORK_TIMEOUT:
				return 'Request timed out. Please check your network connection.';
			case ErrorCode.NETWORK_PROXY_ERROR:
				return `Proxy error: ${context?.statusText || 'Connection failed'}. Check proxy settings.`;
			case ErrorCode.NETWORK_SSL_ERROR:
				return 'SSL/TLS error. Please check your security settings.';
			default:
				return 'Network error. Please check your connection.';
		}
	}

	static fromFetchError(error: Error, url?: string): NetworkError {
		const message = error.message;

		if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
			return new NetworkError(message, ErrorCode.NETWORK_TIMEOUT, { url });
		}

		if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
			return new NetworkError(message, ErrorCode.NETWORK_UNREACHABLE, { url });
		}

		if (message.includes('SSL') || message.includes('certificate')) {
			return new NetworkError(message, ErrorCode.NETWORK_SSL_ERROR, { url });
		}

		return new NetworkError(message, ErrorCode.NETWORK_UNREACHABLE, { url });
	}

	static fromHttpStatus(status: number, statusText: string, url?: string): NetworkError {
		if (status === 407 || status === 502 || status === 503) {
			return new NetworkError(`HTTP ${status}: ${statusText}`, ErrorCode.NETWORK_PROXY_ERROR, {
				status,
				statusText,
				url,
			});
		}

		return new NetworkError(`HTTP ${status}: ${statusText}`, ErrorCode.NETWORK_UNREACHABLE, {
			status,
			statusText,
			url,
		});
	}
}

/**
 * File system errors
 */
export class FileSystemError extends ExtensionError {
	constructor(
		message: string,
		code: ErrorCode = ErrorCode.FS_READ_ERROR,
		context?: Record<string, unknown>,
	) {
		const userMessage = FileSystemError.getUserMessage(code, context);
		super(message, code, userMessage, context);
		this.name = 'FileSystemError';
		Object.setPrototypeOf(this, FileSystemError.prototype);
	}

	private static getUserMessage(code: ErrorCode, context?: Record<string, unknown>): string {
		const path = context?.path ? ` '${context.path}'` : '';
		switch (code) {
			case ErrorCode.FS_FILE_NOT_FOUND:
				return `File not found${path}.`;
			case ErrorCode.FS_READ_ERROR:
				return `Failed to read file${path}.`;
			case ErrorCode.FS_WRITE_ERROR:
				return `Failed to write file${path}.`;
			case ErrorCode.FS_DIRECTORY_ERROR:
				return `Directory operation failed${path}.`;
			default:
				return `File system error${path}.`;
		}
	}

	static fromNodeError(error: NodeJS.ErrnoException, path?: string): FileSystemError {
		const context = { path, errno: error.errno, syscall: error.syscall };

		switch (error.code) {
			case 'ENOENT':
				return new FileSystemError(error.message, ErrorCode.FS_FILE_NOT_FOUND, context);
			case 'EACCES':
			case 'EPERM':
				return new FileSystemError(error.message, ErrorCode.PERMISSION_FILE_ACCESS, context);
			case 'EISDIR':
			case 'ENOTDIR':
				return new FileSystemError(error.message, ErrorCode.FS_DIRECTORY_ERROR, context);
			default:
				return new FileSystemError(error.message, ErrorCode.FS_READ_ERROR, context);
		}
	}
}

/**
 * Validation errors (JSON parsing, schema validation)
 */
export class ValidationError extends ExtensionError {
	constructor(
		message: string,
		code: ErrorCode = ErrorCode.VALIDATION_INVALID_INPUT,
		context?: Record<string, unknown>,
	) {
		super(message, code, message, context);
		this.name = 'ValidationError';
		Object.setPrototypeOf(this, ValidationError.prototype);
	}

	static fromJsonParseError(error: SyntaxError, input?: string): ValidationError {
		return new ValidationError(`Invalid JSON: ${error.message}`, ErrorCode.VALIDATION_JSON_PARSE, {
			input: input?.slice(0, 100),
		});
	}
}

/**
 * Git-related errors
 */
export class GitError extends ExtensionError {
	constructor(
		message: string,
		code: ErrorCode = ErrorCode.GIT_OPERATION_FAILED,
		context?: Record<string, unknown>,
	) {
		const userMessage = GitError.getUserMessage(code);
		super(message, code, userMessage, context);
		this.name = 'GitError';
		Object.setPrototypeOf(this, GitError.prototype);
	}

	private static getUserMessage(code: ErrorCode): string {
		switch (code) {
			case ErrorCode.GIT_NOT_FOUND:
				return 'Git is not installed or not in PATH.';
			case ErrorCode.GIT_CONFLICT:
				return 'Git operation failed due to conflicts.';
			default:
				return 'Git operation failed.';
		}
	}
}

/**
 * Centralized error handling service
 */
export class ErrorService {
	private static _instance: ErrorService;
	private readonly _outputChannel: vscode.OutputChannel;
	private _listeners: Array<(error: ExtensionError) => void> = [];

	private constructor() {
		this._outputChannel = vscode.window.createOutputChannel('PrimeCode Errors');
	}

	static getInstance(): ErrorService {
		if (!ErrorService._instance) {
			ErrorService._instance = new ErrorService();
		}
		return ErrorService._instance;
	}

	/**
	 * Add error listener for centralized handling
	 */
	addListener(listener: (error: ExtensionError) => void): () => void {
		this._listeners.push(listener);
		return () => {
			this._listeners = this._listeners.filter(l => l !== listener);
		};
	}

	/**
	 * Handle and log an error, converting unknown errors to ExtensionError
	 */
	handle(error: unknown, context?: string): ExtensionError {
		const extensionError = this.normalize(error);

		this._log(extensionError, context);
		this._emit(extensionError);

		return extensionError;
	}

	/**
	 * Normalize any error to ExtensionError
	 */
	normalize(error: unknown): ExtensionError {
		if (ExtensionError.is(error)) {
			return error;
		}

		if (error instanceof Error) {
			return new ExtensionError(error.message, ErrorCode.UNKNOWN, error.message, {
				originalName: error.name,
				stack: error.stack,
			});
		}

		if (typeof error === 'string') {
			return new ExtensionError(error);
		}

		return new ExtensionError(
			'An unexpected error occurred',
			ErrorCode.UNKNOWN,
			'An unexpected error occurred. Please check the logs for details.',
			{ raw: String(error) },
		);
	}

	/**
	 * Serialize error for IPC (extension <-> webview)
	 */
	serialize(error: ExtensionError): SerializedError {
		return {
			$isError: true,
			code: error.code,
			name: error.name,
			message: error.message,
			userMessage: error.userMessage,
			stack: error.stack,
			context: error.context,
			cause: error.cause instanceof ExtensionError ? this.serialize(error.cause) : undefined,
		};
	}

	/**
	 * Deserialize error from IPC
	 */
	deserialize(data: SerializedError): ExtensionError {
		const error = new ExtensionError(data.message, data.code, data.userMessage, data.context);
		if (data.stack) {
			error.stack = data.stack;
		}
		return error;
	}

	/**
	 * Get user-friendly message from any error
	 */
	getUserMessage(error: unknown): string {
		const normalized = this.normalize(error);
		return normalized.userMessage;
	}

	/**
	 * Check if error is of specific type
	 */
	isErrorCode(error: unknown, code: ErrorCode): boolean {
		return ExtensionError.is(error) && error.code === code;
	}

	/**
	 * Check if error requires user authentication
	 */
	isAuthError(error: unknown): boolean {
		if (!ExtensionError.is(error)) return false;
		return (
			error.code === ErrorCode.CLI_AUTH_REQUIRED || error.code === ErrorCode.CLI_INVALID_API_KEY
		);
	}

	/**
	 * Check if error is recoverable (user can retry)
	 */
	isRecoverable(error: unknown): boolean {
		if (!ExtensionError.is(error)) return true;

		const nonRecoverableCodes = [ErrorCode.CLI_NOT_FOUND, ErrorCode.GIT_NOT_FOUND];

		return !nonRecoverableCodes.includes(error.code);
	}

	/**
	 * Show error notification to user
	 */
	showError(error: unknown, actions?: Array<{ title: string; action: () => void }>): void {
		const message = this.getUserMessage(error);

		if (actions && actions.length > 0) {
			const actionTitles = actions.map(a => a.title);
			vscode.window.showErrorMessage(message, ...actionTitles).then(selected => {
				const action = actions.find(a => a.title === selected);
				action?.action();
			});
		} else {
			vscode.window.showErrorMessage(message);
		}
	}

	/**
	 * Show warning notification
	 */
	showWarning(message: string): void {
		vscode.window.showWarningMessage(message);
	}

	private _log(error: ExtensionError, context?: string): void {
		const timestamp = new Date().toISOString();
		const contextStr = context ? ` [${context}]` : '';

		this._outputChannel.appendLine(`[${timestamp}]${contextStr} ${error.code}: ${error.message}`);

		if (error.context) {
			this._outputChannel.appendLine(`  Context: ${JSON.stringify(error.context)}`);
		}

		if (error.stack) {
			this._outputChannel.appendLine(`  Stack: ${error.stack}`);
		}

		// Also log to console for development
		console.error(`[ErrorService]${contextStr}`, error);
	}

	private _emit(error: ExtensionError): void {
		for (const listener of this._listeners) {
			try {
				listener(error);
			} catch (e) {
				console.error('[ErrorService] Listener error:', e);
			}
		}
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this._outputChannel.dispose();
		this._listeners = [];
	}
}

// Export singleton instance
export const errorService = ErrorService.getInstance();
