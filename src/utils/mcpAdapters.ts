/**
 * @file MCP config adapters
 * @description Pure conversion functions between the extension unified MCP registry
 * and provider-specific config formats (Claude Code CLI, OpenCode).
 */

import type { MCPServerConfig, UnifiedMcpRegistry, UnifiedMcpServer } from '../types';

export const INTERNAL_PERMISSIONS_SERVER_NAME = 'internal-permissions';

export function unifiedServerToClaudeConfig(server: UnifiedMcpServer): MCPServerConfig | null {
	if (server.enabled === false) return null;

	const transport = server.transport;
	if (transport.type === 'stdio') {
		const [command, ...args] = transport.command;
		if (!command) return null;
		return {
			enabled: server.enabled ?? true,
			timeoutMs: server.timeoutMs,
			type: 'stdio',
			command,
			args,
			env: transport.env,
			cwd: transport.cwd,
		};
	}

	if (transport.type === 'http' || transport.type === 'sse') {
		return {
			enabled: server.enabled ?? true,
			timeoutMs: server.timeoutMs,
			type: transport.type,
			url: transport.url,
			headers: transport.headers,
		};
	}

	return null;
}

export function claudeConfigToUnifiedServer(config: MCPServerConfig): UnifiedMcpServer | null {
	const type = config.type;

	if (type === 'stdio' || (!type && config.command)) {
		if (!config.command) return null;
		return {
			enabled: config.enabled ?? true,
			timeoutMs: config.timeoutMs,
			transport: {
				type: 'stdio',
				command: [config.command, ...(config.args ?? [])],
				env: config.env,
				cwd: config.cwd,
			},
		};
	}

	if (type === 'http' || type === 'sse' || (!type && config.url)) {
		if (!config.url) return null;
		return {
			enabled: config.enabled ?? true,
			timeoutMs: config.timeoutMs,
			transport: {
				type: type === 'sse' ? 'sse' : 'http',
				url: config.url,
				headers: config.headers,
			},
		};
	}

	return null;
}

export function buildClaudeMcpServersJson(registry: UnifiedMcpRegistry): {
	mcpServers: Record<string, MCPServerConfig>;
} {
	const mcpServers: Record<string, MCPServerConfig> = {};

	for (const [name, server] of Object.entries(registry)) {
		if (name === INTERNAL_PERMISSIONS_SERVER_NAME) continue;
		const config = unifiedServerToClaudeConfig(server);
		if (!config) continue;
		mcpServers[name] = config;
	}

	return { mcpServers };
}

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
