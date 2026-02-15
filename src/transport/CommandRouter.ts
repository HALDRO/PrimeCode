/**
 * @file CommandRouter
 * @description Declarative routing table for Webview → Extension commands.
 *              Replaces the exhaustive switch in ChatProvider.resolveHandler()
 *              with a data-driven registry. Each handler registers the command
 *              types it owns, and the router dispatches accordingly.
 *
 *              Benefits:
 *              - Adding a new command = one line in the registration table
 *              - Runtime validation of unknown commands
 *              - Testable in isolation (no ChatProvider dependency)
 */

import type { WebviewCommand } from '../common/protocol';
import type { WebviewMessageHandler } from '../providers/handlers/types';
import { logger } from '../utils/logger';

// =============================================================================
// Types
// =============================================================================

type CommandType = WebviewCommand['type'];

interface RouteEntry {
	handler: WebviewMessageHandler;
	/** Optional label for logging/debugging */
	label?: string;
}

// =============================================================================
// CommandRouter
// =============================================================================

export class CommandRouter {
	private readonly routes = new Map<CommandType, RouteEntry>();

	/**
	 * Register a handler for one or more command types.
	 * Throws if a command type is already registered (catches wiring bugs early).
	 */
	public register(handler: WebviewMessageHandler, types: CommandType[], label?: string): void {
		for (const type of types) {
			const existing = this.routes.get(type);
			if (existing) {
				throw new Error(
					`[CommandRouter] Duplicate route: "${type}" already registered by "${existing.label ?? 'unknown'}"`,
				);
			}
			this.routes.set(type, { handler, label });
		}
	}

	/**
	 * Dispatch a webview command to its registered handler.
	 * Returns false if no handler is registered (caller decides what to do).
	 */
	public async dispatch(msg: WebviewCommand): Promise<boolean> {
		const entry = this.routes.get(msg.type);
		if (!entry) {
			logger.warn(`[CommandRouter] No handler for command: ${msg.type}`);
			return false;
		}
		await entry.handler.handleMessage(msg);
		return true;
	}

	/** Check if a command type has a registered handler. */
	public has(type: CommandType): boolean {
		return this.routes.has(type);
	}

	/** Get all registered command types (useful for debugging). */
	public registeredTypes(): CommandType[] {
		return [...this.routes.keys()];
	}
}
