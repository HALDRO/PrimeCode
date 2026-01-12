/**
 * @file McpClientService
 * @description Service for connecting to MCP servers and retrieving their capabilities (tools, resources).
 *              Uses @modelcontextprotocol/sdk to establish connections via stdio or HTTP transports.
 *              Supports both StreamableHTTP (modern) and SSE (legacy) protocols based on config type.
 *              Provides methods to ping servers, list tools, and manage connection lifecycle.
 *              Implements resource cleanup pattern to prevent zombie connections.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '../../types';
import { logger } from '../../utils/logger';

// =============================================================================
// Types
// =============================================================================

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface McpServerInfo {
	name: string;
	version?: string;
	tools: McpTool[];
	resources: McpResource[];
	status: 'connected' | 'failed' | 'timeout';
	error?: string;
}

// =============================================================================
// McpClientService
// =============================================================================

export class McpClientService {
	private static readonly DEFAULT_TIMEOUT = 15000; // 15 seconds

	/**
	 * Ping multiple servers in parallel
	 */
	public async pingServers(
		servers: Record<string, MCPServerConfig>,
		timeoutMs = McpClientService.DEFAULT_TIMEOUT,
	): Promise<Record<string, McpServerInfo>> {
		const results: Record<string, McpServerInfo> = {};

		// Run in parallel
		await Promise.all(
			Object.entries(servers).map(async ([name, config]) => {
				if (config.enabled === false) {
					results[name] = {
						name,
						tools: [],
						resources: [],
						status: 'failed',
						error: 'Server is disabled',
					};
				} else {
					results[name] = await this.pingServer(name, config, timeoutMs);
				}
			}),
		);

		return results;
	}

	/**
	 * Ping an MCP server and retrieve its capabilities (tools, resources)
	 */
	public async pingServer(
		name: string,
		config: MCPServerConfig,
		timeoutMs = McpClientService.DEFAULT_TIMEOUT,
	): Promise<McpServerInfo> {
		let client: Client | undefined;
		const result: McpServerInfo = {
			name,
			tools: [],
			resources: [],
			status: 'failed',
		};

		try {
			// 1. Prepare Transport
			const transport = this._createTransport(config);

			// 2. Prepare Client
			client = new Client({ name: 'primecode', version: '1.0.0' }, { capabilities: {} });

			// 3. Connect with Timeout
			await this._connectWithTimeout(client, transport, timeoutMs);

			// 4. Fetch Capabilities
			const [tools, resources] = await Promise.all([
				this._fetchTools(client, timeoutMs),
				this._fetchResources(client, timeoutMs),
			]);

			result.tools = tools;
			result.resources = resources;
			result.status = 'connected';
			result.version = client.getServerVersion()?.version;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			result.status = msg.includes('timeout') ? 'timeout' : 'failed';
			result.error = msg;
			logger.warn(`[McpClientService] Ping failed for ${name}: ${msg}`);
		} finally {
			// CRITICAL: Always close client to kill subprocesses/connections
			try {
				await client?.close();
			} catch (e) {
				logger.debug(`[McpClientService] Error closing client for ${name}:`, e);
			}
		}

		return result;
	}

	private _createTransport(config: MCPServerConfig): Transport {
		if (config.type === 'stdio' || (!config.type && config.command)) {
			if (!config.command) throw new Error('No command specified for stdio transport');

			const env = { ...process.env, ...(config.env || {}) } as Record<string, string>;
			// Clean undefined env values to prevent spawn errors
			for (const key of Object.keys(env)) {
				if (env[key] === undefined) {
					delete env[key];
				}
			}

			return new StdioClientTransport({
				command: config.command,
				args: config.args || [],
				env,
				cwd: config.cwd,
			});
		}

		if (config.url) {
			const url = new URL(config.url);
			if (config.type === 'sse') {
				return new SSEClientTransport(url);
			}
			// Default to StreamableHTTP for 'http' or unspecified type with URL
			return new StreamableHTTPClientTransport(url, {
				requestInit: config.headers ? { headers: config.headers } : undefined,
			});
		}

		throw new Error(`Invalid transport config: ${JSON.stringify(config)}`);
	}

	private async _connectWithTimeout(
		client: Client,
		transport: Transport,
		timeoutMs: number,
	): Promise<void> {
		let timeoutId: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(
				() => reject(new Error(`Connection timeout (${timeoutMs}ms)`)),
				timeoutMs,
			);
		});

		try {
			await Promise.race([client.connect(transport), timeoutPromise]);
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
	}

	private async _fetchTools(client: Client, timeoutMs: number): Promise<McpTool[]> {
		try {
			const res = await this._withTimeout(client.listTools(), timeoutMs);
			return (res.tools || []).map(t => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema as Record<string, unknown>,
			}));
		} catch (e) {
			logger.debug('[McpClientService] Failed to fetch tools:', e);
			return [];
		}
	}

	private async _fetchResources(client: Client, timeoutMs: number): Promise<McpResource[]> {
		try {
			const res = await this._withTimeout(client.listResources(), timeoutMs);
			return (res.resources || []).map(r => ({
				uri: r.uri,
				name: r.name,
				description: r.description,
				mimeType: r.mimeType,
			}));
		} catch {
			return []; // Resources are optional
		}
	}

	private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
		let timeoutId: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error('Operation timeout')), ms);
		});

		return Promise.race([promise, timeoutPromise]).finally(() => {
			if (timeoutId) clearTimeout(timeoutId);
		});
	}
}
