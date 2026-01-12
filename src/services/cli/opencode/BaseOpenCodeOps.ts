/**
 * @file Base OpenCode Operations Class
 * @description Abstract base class for all OpenCode Ops classes. Provides common functionality:
 * - Safe client/workspace access via Context Accessor pattern
 * - Unified error handling with safeExecute() wrapper
 * - Automatic logging and error transformation
 * Eliminates boilerplate try/catch/log code across all Ops classes.
 * Uses proper typing from @opencode-ai/sdk for type safety.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { logger } from '../../../utils/logger';
import type { IOpenCodeContext } from './OpenCodeContext.js';

/** Result type for operations that return success/error status */
export interface OperationResult<T = void> {
	success: boolean;
	error?: string;
	data?: T;
}

export abstract class BaseOpenCodeOps {
	constructor(protected _ctx: IOpenCodeContext) {}

	/** Get the active OpenCode SDK client instance */
	protected get _client(): OpencodeClient | undefined {
		return this._ctx.getClient();
	}

	/** Get the current workspace directory */
	protected get _workspaceDir(): string | undefined {
		return this._ctx.getWorkspaceDir();
	}

	/** Get class name for logging */
	protected get _className(): string {
		return this.constructor.name;
	}

	/**
	 * Check if client is ready, throw if not initialized
	 */
	protected _checkReady(): asserts this is { _client: OpencodeClient } {
		if (!this._client) {
			throw new Error('OpenCode not initialized');
		}
	}

	/**
	 * Get client with null check - throws if not initialized
	 */
	protected _getClient(): OpencodeClient {
		const client = this._client;
		if (!client) {
			throw new Error('OpenCode not initialized');
		}
		return client;
	}

	/**
	 * Safe execution wrapper for API operations returning data or null.
	 * Handles client check, error logging, and result transformation.
	 *
	 * @param operationName - Human-readable operation name for logging
	 * @param operation - Async function that receives client and calls the SDK
	 * @param transform - Optional transform function for successful data
	 * @returns Transformed data or null on error
	 */
	protected async safeExecute<TData, TResult = TData>(
		operationName: string,
		operation: (client: OpencodeClient) => Promise<{ error?: unknown; data?: TData }>,
		transform: (data: TData) => TResult = d => d as unknown as TResult,
	): Promise<TResult | null> {
		const logPrefix = `[${this._className}]`;
		const client = this._client;

		if (!client) {
			logger.warn(`${logPrefix} ${operationName} failed: OpenCode not initialized`);
			return null;
		}

		try {
			const res = await operation(client);

			if (res.error) {
				logger.warn(`${logPrefix} ${operationName} failed:`, res.error);
				return null;
			}

			return transform(res.data as TData);
		} catch (error) {
			logger.error(`${logPrefix} Error in ${operationName}:`, error);
			return null;
		}
	}

	/**
	 * Safe execution wrapper that throws on error (for critical operations).
	 */
	protected async safeExecuteOrThrow<TData, TResult = TData>(
		operationName: string,
		operation: (client: OpencodeClient) => Promise<{ error?: unknown; data?: TData }>,
		transform: (data: TData) => TResult = d => d as unknown as TResult,
	): Promise<TResult> {
		const logPrefix = `[${this._className}]`;
		const client = this._client;

		if (!client) {
			throw new Error('OpenCode not initialized');
		}

		try {
			const res = await operation(client);

			if (res.error) {
				const errorStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
				throw new Error(`${operationName} failed: ${errorStr}`);
			}

			return transform(res.data as TData);
		} catch (error) {
			logger.error(`${logPrefix} Error in ${operationName}:`, error);
			throw error;
		}
	}

	/**
	 * Safe execution wrapper returning OperationResult (for mutations).
	 * Always returns { success, error?, data? } instead of throwing.
	 */
	protected async safeExecuteResult<TData, TResult = TData>(
		operationName: string,
		operation: (client: OpencodeClient) => Promise<{ error?: unknown; data?: TData }>,
		transform: (data: TData) => TResult = d => d as unknown as TResult,
	): Promise<OperationResult<TResult>> {
		const logPrefix = `[${this._className}]`;
		const client = this._client;

		if (!client) {
			const errorMsg = 'OpenCode not initialized';
			logger.warn(`${logPrefix} ${operationName} failed: ${errorMsg}`);
			return { success: false, error: errorMsg };
		}

		try {
			const res = await operation(client);

			if (res.error) {
				const errorStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
				logger.warn(`${logPrefix} ${operationName} failed:`, res.error);
				return { success: false, error: errorStr };
			}

			return { success: true, data: transform(res.data as TData) };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			logger.error(`${logPrefix} Error in ${operationName}:`, error);
			return { success: false, error: errorMsg };
		}
	}

	/**
	 * Safe execution with info-level logging (for mutations).
	 * Logs start and completion of operation.
	 */
	protected async safeExecuteWithLog<TData, TResult = TData>(
		operationName: string,
		operation: (client: OpencodeClient) => Promise<{ error?: unknown; data?: TData }>,
		transform: (data: TData) => TResult = d => d as unknown as TResult,
	): Promise<OperationResult<TResult>> {
		logger.info(`[${this._className}] ${operationName}...`);
		const result = await this.safeExecuteResult(operationName, operation, transform);

		if (result.success) {
			logger.info(`[${this._className}] ${operationName} completed successfully`);
		}

		return result;
	}
}
