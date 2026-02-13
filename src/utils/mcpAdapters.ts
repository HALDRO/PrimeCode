/**
 * @file MCP config adapters
 * @description Pure conversion functions between the extension unified MCP registry
 * and provider-specific config formats (OpenCode).
 */

import type { UnifiedMcpRegistry, UnifiedMcpServer } from '../common';

export const INTERNAL_PERMISSIONS_SERVER_NAME = 'internal-permissions';

export type OpenCodeMcpConfig =
	| {
			type: 'local';
			command: string[];
			environment?: Record<string, string>;
			enabled?: boolean;
			timeout?: number;
	  }
	| {
			type: 'remote';
			url: string;
			headers?: Record<string, string>;
			oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false;
			enabled?: boolean;
			timeout?: number;
	  };

export function unifiedServerToOpenCodeConfig(server: UnifiedMcpServer): OpenCodeMcpConfig {
	const enabled = server.enabled !== false;
	const timeout = server.timeoutMs;

	const transport = server.transport;
	if (transport.type === 'stdio') {
		return {
			type: 'local',
			command: transport.command,
			enabled,
			environment: transport.env,
			timeout,
		};
	}

	return {
		type: 'remote',
		url: transport.url,
		enabled,
		headers: transport.headers,
		// OAuth UI not implemented yet; let OpenCode auto-detect unless explicitly disabled later.
		timeout,
	};
}

export function buildOpenCodeMcpConfig(
	registry: UnifiedMcpRegistry,
): Record<string, OpenCodeMcpConfig> {
	const result: Record<string, OpenCodeMcpConfig> = {};

	for (const [name, server] of Object.entries(registry)) {
		if (name === INTERNAL_PERMISSIONS_SERVER_NAME) continue;
		result[name] = unifiedServerToOpenCodeConfig(server);
	}

	return result;
}
