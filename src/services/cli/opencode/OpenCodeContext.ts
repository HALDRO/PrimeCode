/**
 * @file OpenCode Context Interface
 * @description Defines the interface for accessing OpenCode service state securely.
 * Implements the Context Accessor pattern to solve the stale client reference problem.
 * Uses proper typing from @opencode-ai/sdk for type safety.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { logger } from '../../../utils/logger';

export interface IOpenCodeContext {
	/**
	 * Get the active OpenCode SDK client instance.
	 * Returns undefined if the service is not initialized or the client is disconnected.
	 */
	getClient(): OpencodeClient | undefined;

	/**
	 * Get the current workspace directory.
	 * This can change if the user opens a different folder.
	 */
	getWorkspaceDir(): string | undefined;

	/**
	 * Get the unified logger instance.
	 */
	getLogger(): typeof logger;
}
