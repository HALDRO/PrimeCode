/*
 * @file RetryService
 * @description Provides exponential-backoff retries for async operations.
 * Used to harden OpenCode SSE subscription/reconnect paths against transient network failures.
 */

import { logger } from '../utils/logger';
import { ErrorCode, ExtensionError, errorService, NetworkError } from './ErrorService';

// =============================================================================
// Types
// =============================================================================

export interface RetryOptions {
	/** Maximum number of retry attempts (default: 3) */
	maxRetries?: number;
	/** Initial delay in ms before first retry (default: 1000) */
	initialDelayMs?: number;
	/** Maximum delay in ms between retries (default: 30000) */
	maxDelayMs?: number;
	/** Multiplier for exponential backoff (default: 2) */
	backoffMultiplier?: number;
	/** Jitter factor to randomize delays (0-1, default: 0.1) */
	jitterFactor?: number;
	/** Timeout for each attempt in ms (default: 60000) */
	attemptTimeoutMs?: number;
	/** Custom function to determine if error is retryable */
	isRetryable?: (error: unknown) => boolean;
	/** Callback on each retry attempt */
	onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
	/** Callback when all retries exhausted */
	onExhausted?: (error: unknown, attempts: number) => void;
	/** AbortSignal to cancel retries */
	signal?: AbortSignal;
}

export interface RetryResult<T> {
	success: boolean;
	data?: T;
	error?: ExtensionError;
	attempts: number;
	totalTimeMs: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_OPTIONS: Required<
	Omit<RetryOptions, 'onRetry' | 'onExhausted' | 'signal' | 'isRetryable'>
> = {
	maxRetries: 3,
	initialDelayMs: 1000,
	maxDelayMs: 30000,
	backoffMultiplier: 2,
	jitterFactor: 0.1,
	attemptTimeoutMs: 60000,
};

// =============================================================================
// Retry Service
// =============================================================================

export class RetryService {
	private static _instance: RetryService;

	private constructor() {}

	static getInstance(): RetryService {
		if (!RetryService._instance) {
			RetryService._instance = new RetryService();
		}
		return RetryService._instance;
	}

	/**
	 * Execute an async operation with retry logic
	 */
	async execute<T>(
		operation: (attempt: number) => Promise<T>,
		options: RetryOptions = {},
	): Promise<RetryResult<T>> {
		const opts = { ...DEFAULT_OPTIONS, ...options };
		const startTime = Date.now();
		let lastError: unknown;
		let attempt = 0;

		while (attempt <= opts.maxRetries) {
			attempt++;

			// Check if aborted
			if (opts.signal?.aborted) {
				return {
					success: false,
					error: new ExtensionError('Operation cancelled', ErrorCode.PROCESS_KILLED),
					attempts: attempt,
					totalTimeMs: Date.now() - startTime,
				};
			}

			try {
				// Execute with timeout
				const data = await this._executeWithTimeout(
					() => operation(attempt),
					opts.attemptTimeoutMs,
					opts.signal,
				);

				return {
					success: true,
					data,
					attempts: attempt,
					totalTimeMs: Date.now() - startTime,
				};
			} catch (error) {
				lastError = error;

				// Check if we should retry
				const shouldRetry =
					attempt <= opts.maxRetries && this._isRetryable(error, opts.isRetryable);

				if (!shouldRetry) {
					break;
				}

				// Calculate delay with exponential backoff and jitter
				const delayMs = this._calculateDelay(attempt, opts);

				logger.info(
					`[RetryService] Attempt ${attempt}/${opts.maxRetries + 1} failed, retrying in ${delayMs}ms: ${this._getErrorMessage(error)}`,
				);

				// Notify callback
				opts.onRetry?.(attempt, error, delayMs);

				// Wait before retry
				await this._delay(delayMs, opts.signal);
			}
		}

		// All retries exhausted
		const normalizedError = errorService.normalize(lastError);
		opts.onExhausted?.(lastError, attempt);

		logger.error(`[RetryService] All ${attempt} attempts failed: ${normalizedError.message}`);

		return {
			success: false,
			error: normalizedError,
			attempts: attempt,
			totalTimeMs: Date.now() - startTime,
		};
	}

	/**
	 * Execute operation with automatic reconnection for streams
	 * Useful for SSE connections that may drop
	 */
	async executeWithReconnect<T>(
		connect: () => Promise<T>,
		options: RetryOptions & {
			/** Called when reconnection starts */
			onReconnecting?: (attempt: number) => void;
			/** Called when successfully reconnected */
			onReconnected?: () => void;
		} = {},
	): Promise<RetryResult<T>> {
		const result = await this.execute(
			async attempt => {
				if (attempt > 1) {
					options.onReconnecting?.(attempt);
				}
				const data = await connect();
				if (attempt > 1) {
					options.onReconnected?.();
				}
				return data;
			},
			{
				...options,
				onRetry: (attempt, error, delayMs) => {
					logger.info(`[RetryService] Reconnecting (attempt ${attempt})...`);
					options.onRetry?.(attempt, error, delayMs);
				},
			},
		);

		return result;
	}

	/**
	 * Check if an error is retryable (network issues, temporary failures)
	 * Uses error.code (Node.js system errors), HTTP status, and message patterns
	 */
	isNetworkError(error: unknown): boolean {
		if (error instanceof NetworkError) {
			return true;
		}

		// Check error.code first (most reliable for Node.js errors)
		if (error && typeof error === 'object' && 'code' in error) {
			const code = (error as { code?: string }).code;
			const networkCodes = [
				'ETIMEDOUT',
				'ECONNRESET',
				'ECONNREFUSED',
				'ENOTFOUND',
				'ENETUNREACH',
				'EHOSTUNREACH',
				'EPIPE',
				'EAI_AGAIN',
				'ECONNABORTED',
				'ESOCKETTIMEDOUT',
			];
			if (code && networkCodes.includes(code.toUpperCase())) {
				return true;
			}
		}

		// Check HTTP status codes from error context
		if (error && typeof error === 'object' && 'status' in error) {
			const status = (error as { status?: number }).status;
			if (status && [408, 429, 500, 502, 503, 504].includes(status)) {
				return true;
			}
		}

		// Fallback to message pattern matching (for errors without code/status)
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			// Only check patterns that aren't covered by error.code above
			const messageOnlyPatterns = [
				'socket hang up',
				'network',
				'fetch failed',
				'failed to fetch',
				'sse',
				'stream',
				'bad gateway',
				'service unavailable',
				'gateway timeout',
			];

			return messageOnlyPatterns.some(pattern => message.includes(pattern));
		}

		return false;
	}

	/**
	 * Check if error is a temporary server error (5xx)
	 */
	isTemporaryServerError(error: unknown): boolean {
		if (error instanceof ExtensionError && error.context) {
			const status = error.context.status as number | undefined;
			return status !== undefined && status >= 500 && status < 600;
		}

		if (error instanceof Error) {
			const message = error.message;
			return /\b(500|502|503|504)\b/.test(message);
		}

		return false;
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private async _executeWithTimeout<T>(
		operation: () => Promise<T>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new NetworkError('Operation timed out', ErrorCode.NETWORK_TIMEOUT));
			}, timeoutMs);

			// Handle abort signal
			const abortHandler = () => {
				clearTimeout(timeoutId);
				reject(new ExtensionError('Operation cancelled', ErrorCode.PROCESS_KILLED));
			};

			signal?.addEventListener('abort', abortHandler, { once: true });

			operation()
				.then(result => {
					clearTimeout(timeoutId);
					signal?.removeEventListener('abort', abortHandler);
					resolve(result);
				})
				.catch(error => {
					clearTimeout(timeoutId);
					signal?.removeEventListener('abort', abortHandler);
					reject(error);
				});
		});
	}

	private _isRetryable(error: unknown, customCheck?: (error: unknown) => boolean): boolean {
		// Custom check takes precedence
		if (customCheck) {
			return customCheck(error);
		}

		// Network errors are always retryable
		if (this.isNetworkError(error)) {
			return true;
		}

		// Temporary server errors are retryable
		if (this.isTemporaryServerError(error)) {
			return true;
		}

		// Check if error service considers it recoverable
		return errorService.isRecoverable(error);
	}

	private _calculateDelay(
		attempt: number,
		opts: Required<Omit<RetryOptions, 'onRetry' | 'onExhausted' | 'signal' | 'isRetryable'>>,
	): number {
		// Exponential backoff: initialDelay * (multiplier ^ (attempt - 1))
		const exponentialDelay = opts.initialDelayMs * opts.backoffMultiplier ** (attempt - 1);

		// Cap at max delay
		const cappedDelay = Math.min(exponentialDelay, opts.maxDelayMs);

		// Add jitter to prevent thundering herd
		const jitter = cappedDelay * opts.jitterFactor * (Math.random() * 2 - 1);

		return Math.max(0, Math.round(cappedDelay + jitter));
	}

	private async _delay(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				// Clean up abort listener when timeout completes normally
				if (signal && abortHandler) {
					signal.removeEventListener('abort', abortHandler);
				}
				resolve();
			}, ms);

			let abortHandler: (() => void) | undefined;

			if (signal) {
				abortHandler = () => {
					clearTimeout(timeoutId);
					reject(new ExtensionError('Delay cancelled', ErrorCode.PROCESS_KILLED));
				};
				signal.addEventListener('abort', abortHandler, { once: true });
			}
		});
	}

	private _getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error);
	}
}

// Export singleton instance
export const retryService = RetryService.getInstance();

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Wrap an async function with retry logic
 */
export function withRetry<T extends (...args: unknown[]) => Promise<unknown>>(
	fn: T,
	options?: RetryOptions,
): (...args: Parameters<T>) => Promise<RetryResult<Awaited<ReturnType<T>>>> {
	return async (...args: Parameters<T>) => {
		return retryService.execute(() => fn(...args) as Promise<Awaited<ReturnType<T>>>, options);
	};
}

/**
 * Create a retryable fetch wrapper
 */
export async function fetchWithRetry(
	url: string,
	init?: RequestInit,
	options?: RetryOptions,
): Promise<RetryResult<Response>> {
	return retryService.execute(
		async () => {
			const response = await fetch(url, init);

			// Throw on server errors to trigger retry
			if (response.status >= 500) {
				throw NetworkError.fromHttpStatus(response.status, response.statusText, url);
			}

			return response;
		},
		{
			...options,
			isRetryable: error => {
				// Retry on network errors and 5xx responses
				return retryService.isNetworkError(error) || retryService.isTemporaryServerError(error);
			},
		},
	);
}
