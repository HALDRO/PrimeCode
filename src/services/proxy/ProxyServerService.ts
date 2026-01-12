/**
 * @file ProxyServerService
 * @description Local HTTP proxy server that converts Claude API requests to OpenAI format.
 * Claude Code CLI sends requests in Anthropic format to ANTHROPIC_BASE_URL.
 * This proxy intercepts those requests, converts them to OpenAI format using our converters,
 * forwards to the actual OpenAI-compatible backend, and converts responses back to Claude format.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { stripProviderPrefix } from '../../shared/constants';
import { logger } from '../../utils/logger';
import {
	claudeRequestToOpenAI,
	OpenAIToClaudeStreamConverter,
	openAIResponseToClaude,
} from '../converters';

// =============================================================================
// Types
// =============================================================================

export interface ProxyConfig {
	/** Target OpenAI-compatible API base URL */
	targetBaseUrl: string;
	/** API key for the target backend */
	apiKey: string;
	/** Local port to listen on (0 = auto-assign) */
	localPort?: number;
	/** Model mapping: Claude model name -> OpenAI model name */
	modelMapping?: Record<string, string>;
}

export interface ProxyServerInfo {
	port: number;
	baseUrl: string;
}

// =============================================================================
// ProxyServerService
// =============================================================================

export class ProxyServerService {
	private _server: http.Server | null = null;
	private _config: ProxyConfig | null = null;
	private _port: number = 0;

	/**
	 * Start the proxy server
	 */
	public async start(config: ProxyConfig): Promise<ProxyServerInfo> {
		if (this._server) {
			await this.stop();
		}

		this._config = config;

		return new Promise((resolve, reject) => {
			this._server = http.createServer((req, res) => {
				this._handleRequest(req, res).catch(err => {
					logger.error('[ProxyServer] Request handler error:', err);
					if (!res.headersSent) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { message: 'Internal proxy error' } }));
					}
				});
			});

			this._server.on('error', err => {
				logger.error('[ProxyServer] Server error:', err);
				reject(err);
			});

			const port = config.localPort || 0;
			this._server.listen(port, '127.0.0.1', () => {
				const address = this._server?.address();
				if (address && typeof address === 'object') {
					this._port = address.port;
					const baseUrl = `http://127.0.0.1:${this._port}`;
					logger.info(`[ProxyServer] Started on ${baseUrl}`);
					resolve({ port: this._port, baseUrl });
				} else {
					reject(new Error('Failed to get server address'));
				}
			});
		});
	}

	/**
	 * Stop the proxy server
	 */
	public async stop(): Promise<void> {
		if (!this._server) return;

		return new Promise(resolve => {
			this._server?.close(() => {
				logger.info('[ProxyServer] Stopped');
				this._server = null;
				this._port = 0;
				resolve();
			});
		});
	}

	/**
	 * Check if server is running
	 */
	public isRunning(): boolean {
		return this._server !== null;
	}

	/**
	 * Get current server info
	 */
	public getInfo(): ProxyServerInfo | null {
		if (!this._server || this._port === 0) return null;
		return {
			port: this._port,
			baseUrl: `http://127.0.0.1:${this._port}`,
		};
	}

	// =========================================================================
	// Request Handling
	// =========================================================================

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const fullUrl = req.url || '/';
		const method = req.method || 'GET';

		// Parse URL to get pathname without query string
		const urlPath = fullUrl.split('?')[0];

		logger.debug(
			`[ProxyServer] ${method} ${fullUrl} -> routing to: ${this._getRouteDescription(urlPath, method)}`,
		);

		// Handle CORS preflight
		if (method === 'OPTIONS') {
			this._setCorsHeaders(res);
			res.writeHead(204);
			res.end();
			return;
		}

		// Route requests
		if (urlPath === '/v1/messages' && method === 'POST') {
			await this._handleMessagesEndpoint(req, res);
		} else if (urlPath === '/v1/messages/count_tokens' && method === 'POST') {
			await this._handleCountTokensEndpoint(req, res);
		} else if (urlPath === '/v1/models' && method === 'GET') {
			await this._handleModelsEndpoint(req, res);
		} else if (urlPath.startsWith('/api/')) {
			// Silently accept API logging/telemetry requests
			await this._handleApiEndpoint(req, res);
		} else {
			// Pass through other requests
			await this._proxyPassthrough(req, res);
		}
	}

	private _getRouteDescription(urlPath: string, method: string): string {
		if (urlPath === '/v1/messages' && method === 'POST') return 'messages (convert to OpenAI)';
		if (urlPath === '/v1/messages/count_tokens' && method === 'POST') return 'count_tokens (mock)';
		if (urlPath === '/v1/models' && method === 'GET') return 'models (mock)';
		if (urlPath.startsWith('/api/')) return 'api (mock success)';
		return 'passthrough (mock success)';
	}

	/**
	 * Handle /v1/messages - main Claude API endpoint
	 * Converts to OpenAI /v1/chat/completions
	 */
	private async _handleMessagesEndpoint(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		if (!this._config) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Proxy not configured' } }));
			return;
		}

		try {
			// Read request body
			const body = await this._readBody(req);
			const claudeRequest = JSON.parse(body);

			logger.debug(
				'[ProxyServer] Claude request:',
				JSON.stringify(claudeRequest).substring(0, 500),
			);

			// Check if streaming
			const isStreaming = claudeRequest.stream === true;

			// Map model if needed
			let targetModel = claudeRequest.model;
			if (this._config.modelMapping?.[targetModel]) {
				targetModel = this._config.modelMapping[targetModel];
				logger.debug(`[ProxyServer] Model mapped: ${claudeRequest.model} -> ${targetModel}`);
			}

			// Strip oai/ prefix - it's only for UI/OpenCode, backend doesn't understand it
			targetModel = stripProviderPrefix(targetModel);
			logger.debug(`[ProxyServer] Target model: ${targetModel}`);

			// Convert Claude request to OpenAI format
			const openAIRequest = claudeRequestToOpenAI(claudeRequest);
			openAIRequest.model = targetModel;
			openAIRequest.stream = isStreaming;

			logger.debug(
				'[ProxyServer] OpenAI request:',
				JSON.stringify(openAIRequest).substring(0, 500),
			);

			// Forward to OpenAI backend
			const targetUrl = new URL('/v1/chat/completions', this._config.targetBaseUrl);

			if (isStreaming) {
				await this._handleStreamingResponse(targetUrl, openAIRequest, claudeRequest.model, res);
			} else {
				await this._handleNonStreamingResponse(targetUrl, openAIRequest, claudeRequest.model, res);
			}
		} catch (error) {
			logger.error('[ProxyServer] Messages endpoint error:', error);
			this._sendErrorResponse(res, error);
		}
	}

	/**
	 * Handle streaming response - convert OpenAI SSE to Claude SSE
	 */
	private async _handleStreamingResponse(
		targetUrl: URL,
		openAIRequest: Record<string, unknown>,
		originalModel: string,
		res: http.ServerResponse,
	): Promise<void> {
		const converter = new OpenAIToClaudeStreamConverter(originalModel, `msg_${Date.now()}`);

		const requestOptions = this._buildRequestOptions(targetUrl, 'POST');
		const requestBody = JSON.stringify(openAIRequest);

		logger.debug(`[ProxyServer] Sending streaming request to ${targetUrl.href}`);

		const proxyReq = this._createRequest(targetUrl, requestOptions, proxyRes => {
			logger.debug(
				`[ProxyServer] Received response: status=${proxyRes.statusCode}, headers=${JSON.stringify(proxyRes.headers).substring(0, 200)}`,
			);

			// Check for error status
			if (proxyRes.statusCode !== 200) {
				logger.error(`[ProxyServer] Backend returned error status: ${proxyRes.statusCode}`);
				// Read error body for logging and forward to client
				let errorBody = '';
				proxyRes.on('data', chunk => {
					errorBody += chunk.toString();
				});
				proxyRes.on('end', () => {
					logger.error(`[ProxyServer] Backend error body: ${errorBody.substring(0, 500)}`);
					this._setCorsHeaders(res);
					res.writeHead(proxyRes.statusCode || 500, {
						'Content-Type': 'application/json',
					});
					res.end(
						errorBody ||
							JSON.stringify({ error: { message: `Backend error: ${proxyRes.statusCode}` } }),
					);
				});
				return;
			}

			// Set response headers for SSE
			this._setCorsHeaders(res);
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});

			let buffer = '';

			proxyRes.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();

				// Process complete SSE events (split by double newline)
				const parts = buffer.split('\n\n');
				buffer = parts.pop() || ''; // Keep incomplete part in buffer

				for (const part of parts) {
					if (!part.trim()) continue;

					// Handle [DONE] marker
					if (part.includes('data: [DONE]')) {
						const claudeSSE = converter.convertChunk('data: [DONE]\n\n');
						if (claudeSSE) {
							res.write(claudeSSE);
						}
						continue;
					}

					try {
						// Log first 200 chars of OpenAI chunk (every 10th to reduce spam)
						if (Math.random() < 0.1) {
							const dataMatch = part.match(/^data: (.+)$/m);
							if (dataMatch) {
								try {
									const json = JSON.parse(dataMatch[1]);
									const delta = json.choices?.[0]?.delta;
									if (delta) {
										const hasContent = delta.content !== undefined;
										const hasToolCalls = delta.tool_calls !== undefined;
										logger.info(
											`[ProxyServer] OpenAI delta: content=${hasContent ? `"${(delta.content || '').substring(0, 30)}"` : 'none'}, tool_calls=${hasToolCalls}`,
										);
									}
								} catch {
									// ignore parse errors
								}
							}
						}

						// Convert OpenAI chunk to Claude format
						const claudeSSE = converter.convertChunk(`${part}\n\n`);
						if (claudeSSE) {
							res.write(claudeSSE);
						}
					} catch (e) {
						logger.error('[ProxyServer] Stream conversion error:', e);
					}
				}
			});

			proxyRes.on('end', () => {
				res.end();
			});

			proxyRes.on('error', err => {
				logger.error('[ProxyServer] Proxy response error:', err);
				res.end();
			});
		});

		proxyReq.on('error', err => {
			logger.error('[ProxyServer] Proxy request error:', err);
			this._sendErrorResponse(res, err);
		});

		proxyReq.write(requestBody);
		proxyReq.end();
	}

	/**
	 * Handle non-streaming response - convert OpenAI response to Claude response
	 */
	private async _handleNonStreamingResponse(
		targetUrl: URL,
		openAIRequest: Record<string, unknown>,
		originalModel: string,
		res: http.ServerResponse,
	): Promise<void> {
		const requestOptions = this._buildRequestOptions(targetUrl, 'POST');
		const requestBody = JSON.stringify(openAIRequest);

		const proxyReq = this._createRequest(targetUrl, requestOptions, async proxyRes => {
			const responseBody = await this._readStream(proxyRes);

			try {
				if (proxyRes.statusCode !== 200) {
					logger.error(`[ProxyServer] Backend error: ${proxyRes.statusCode}`);

					// Forward error response to client
					this._setCorsHeaders(res);
					res.writeHead(proxyRes.statusCode || 500, {
						'Content-Type': 'application/json',
					});
					res.end(
						responseBody ||
							JSON.stringify({ error: { message: `Backend error: ${proxyRes.statusCode}` } }),
					);
					return;
				}

				// Convert OpenAI response to Claude format
				const messageId = `msg_${Date.now()}`;
				const claudeResponse = openAIResponseToClaude(responseBody, originalModel, messageId);

				logger.debug(
					'[ProxyServer] Claude response:',
					JSON.stringify(claudeResponse).substring(0, 500),
				);

				this._setCorsHeaders(res);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(claudeResponse));
			} catch (error) {
				logger.error('[ProxyServer] Response conversion error:', error);
				this._sendErrorResponse(res, error);
			}
		});

		proxyReq.on('error', err => {
			logger.error('[ProxyServer] Proxy request error:', err);
			this._sendErrorResponse(res, err);
		});

		proxyReq.write(requestBody);
		proxyReq.end();
	}

	/**
	 * Handle /v1/models endpoint
	 */
	private async _handleModelsEndpoint(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		// Return a list of "Claude" models that map to OpenAI models
		const models = {
			data: [
				{
					id: 'claude-sonnet-4-5',
					object: 'model',
					created: Date.now(),
					owned_by: 'anthropic',
				},
				{
					id: 'claude-haiku-4-5',
					object: 'model',
					created: Date.now(),
					owned_by: 'anthropic',
				},
				{
					id: 'claude-opus-4-5',
					object: 'model',
					created: Date.now(),
					owned_by: 'anthropic',
				},
			],
			object: 'list',
		};

		this._setCorsHeaders(res);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(models));
	}

	/**
	 * Handle /v1/messages/count_tokens endpoint
	 * Returns an estimated token count (Claude CLI uses this for context management)
	 */
	private async _handleCountTokensEndpoint(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		try {
			const body = await this._readBody(req);
			const request = JSON.parse(body);

			// Estimate tokens based on message content
			// This is a rough approximation: ~4 chars per token for English, ~2 for other languages
			let totalChars = 0;

			if (request.system) {
				totalChars +=
					typeof request.system === 'string'
						? request.system.length
						: JSON.stringify(request.system).length;
			}

			if (request.messages && Array.isArray(request.messages)) {
				for (const msg of request.messages) {
					if (typeof msg.content === 'string') {
						totalChars += msg.content.length;
					} else if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.text) totalChars += block.text.length;
							if (block.thinking) totalChars += block.thinking.length;
						}
					}
				}
			}

			// Rough token estimate (conservative: ~3 chars per token)
			const estimatedTokens = Math.ceil(totalChars / 3);

			this._setCorsHeaders(res);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ input_tokens: estimatedTokens }));
		} catch (error) {
			logger.error('[ProxyServer] Count tokens error:', error);
			// Return a default value on error
			this._setCorsHeaders(res);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ input_tokens: 1000 }));
		}
	}

	/**
	 * Handle /api/* endpoints (telemetry, logging, etc.)
	 * These are non-essential, so we just acknowledge them
	 */
	private async _handleApiEndpoint(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		// Consume the request body if present
		if (req.method === 'POST' || req.method === 'PUT') {
			await this._readBody(req);
		}

		// Return success for telemetry/logging endpoints
		this._setCorsHeaders(res);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	}

	/**
	 * Pass through requests to target backend
	 * For unknown Anthropic-specific endpoints, return mock responses
	 */
	private async _proxyPassthrough(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const fullUrl = req.url || '/';
		const urlPath = fullUrl.split('?')[0];

		// For unknown /v1/* endpoints (Anthropic-specific), return mock success
		// These are endpoints that OpenAI backends don't support
		if (urlPath.startsWith('/v1/')) {
			logger.debug(`[ProxyServer] Mock response for unsupported endpoint: ${urlPath}`);

			// Consume request body if present
			if (req.method === 'POST' || req.method === 'PUT') {
				await this._readBody(req);
			}

			this._setCorsHeaders(res);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
			return;
		}

		// For non-v1 endpoints, try to pass through (or mock)
		if (!this._config) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Proxy not configured' } }));
			return;
		}

		// Consume request body if present
		if (req.method === 'POST' || req.method === 'PUT') {
			await this._readBody(req);
		}

		// Return generic success for unknown endpoints
		this._setCorsHeaders(res);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private _buildRequestOptions(
		url: URL,
		method: string,
	): http.RequestOptions | https.RequestOptions {
		return {
			hostname: url.hostname,
			port: url.port || (url.protocol === 'https:' ? 443 : 80),
			path: url.pathname + url.search,
			method,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this._config?.apiKey || ''}`,
				Accept: 'application/json',
			},
		};
	}

	private _createRequest(
		url: URL,
		options: http.RequestOptions | https.RequestOptions,
		callback: (res: http.IncomingMessage) => void,
	): http.ClientRequest {
		if (url.protocol === 'https:') {
			return https.request(options, callback);
		}
		return http.request(options, callback);
	}

	private async _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = '';
			req.on('data', chunk => {
				body += chunk.toString();
			});
			req.on('end', () => resolve(body));
			req.on('error', reject);
		});
	}

	private async _readStream(stream: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let data = '';
			stream.on('data', chunk => {
				data += chunk.toString();
			});
			stream.on('end', () => resolve(data));
			stream.on('error', reject);
		});
	}

	private _setCorsHeaders(res: http.ServerResponse): void {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader(
			'Access-Control-Allow-Headers',
			'Content-Type, Authorization, X-API-Key, Anthropic-Version',
		);
	}

	private _sendErrorResponse(res: http.ServerResponse, error: unknown): void {
		if (res.headersSent) return;

		const message = error instanceof Error ? error.message : 'Unknown error';
		this._setCorsHeaders(res);
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				type: 'error',
				error: {
					type: 'api_error',
					message,
				},
			}),
		);
	}
}

// Singleton instance
let proxyServerInstance: ProxyServerService | null = null;

export function getProxyServer(): ProxyServerService {
	if (!proxyServerInstance) {
		proxyServerInstance = new ProxyServerService();
	}
	return proxyServerInstance;
}
