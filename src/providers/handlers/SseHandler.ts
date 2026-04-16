import type { CommandOf, WebviewCommand } from '../../common';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

/** Maximum time (ms) to wait for the initial SSE connection before giving up. */
const SSE_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Minimum interval (ms) between forwarding SSE data events to the webview.
 * The webview only uses these events as a heartbeat (connected / disconnected),
 * so there is no need to relay every single server-sent frame.
 */
const SSE_THROTTLE_MS = 5_000;

export class SseHandler implements WebviewMessageHandler {
	private connections = new Map<string, { close: () => void }>();

	/** Per-subscription timestamp of the last forwarded sseEvent. */
	private lastForwardedAt = new Map<string, number>();

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'sseSubscribe':
				await this.handleSubscribe(msg);
				break;
			case 'sseClose':
				this.handleClose(msg.id);
				break;
		}
	}

	private async handleSubscribe(msg: CommandOf<'sseSubscribe'>) {
		const { id, url } = msg;

		if (typeof id !== 'string' || typeof url !== 'string') {
			logger.warn('[SseHandler] Invalid sseSubscribe message', { id, url });
			return;
		}

		// Security check: only allow connections to the configured OpenCode server
		const serverUrl = this.context.settings.get('opencode.serverUrl') as string | undefined;
		const runnerServerInfo = this.context.cli.getOpenCodeServerInfo();
		const activeServerUrl = runnerServerInfo?.baseUrl || serverUrl;

		if (!activeServerUrl) {
			this.sendError(id, 'OpenCode server URL not configured');
			return;
		}

		let target: URL;
		let allowed: URL;
		try {
			target = new URL(url);
			allowed = new URL(activeServerUrl);
		} catch {
			this.sendError(id, 'Invalid URL for SSE subscription');
			return;
		}

		// Ensure we are connecting to the same origin as the OpenCode server
		if (target.origin !== allowed.origin) {
			this.sendError(id, 'SSE only allowed to OpenCode server origin');
			return;
		}

		this.handleClose(id);

		const controller = new AbortController();

		// Connection timeout: abort if no response within the limit
		const connectTimer = setTimeout(() => {
			controller.abort();
			this.sendError(id, `SSE connection timed out after ${SSE_CONNECT_TIMEOUT_MS}ms`);
			this.connections.delete(id);
		}, SSE_CONNECT_TIMEOUT_MS);

		// Start the fetch connection
		fetch(url, {
			headers: { Accept: 'text/event-stream' },
			signal: controller.signal,
		})
			.then(async res => {
				clearTimeout(connectTimer);
				if (!res.ok || !res.body) {
					this.sendError(id, `SSE connection failed: ${res.status}`);
					return;
				}

				this.context.bridge.data('sseOpen', { id });

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							this.context.bridge.data('sseClosed', { id });
							this.connections.delete(id);
							break;
						}

						buffer += decoder.decode(value, { stream: true });

						const messages = buffer.split('\n\n');
						buffer = messages.pop() || '';

						for (const msg of messages) {
							const lines = msg.split('\n');
							for (const line of lines) {
								if (line.startsWith('data: ')) {
									// Throttle: the webview only uses sseEvent as a
									// heartbeat (connected/disconnected), so forwarding
									// every frame is unnecessary and spams the bridge.
									const now = Date.now();
									const last = this.lastForwardedAt.get(id) ?? 0;
									if (now - last < SSE_THROTTLE_MS) continue;
									this.lastForwardedAt.set(id, now);

									const data = line.slice(6);
									this.context.bridge.data('sseEvent', { id, data });
								}
							}
						}
					}
				} catch (err) {
					if ((err as Error).name !== 'AbortError') {
						this.sendError(id, String((err as Error)?.message ?? err));
					}
					this.connections.delete(id);
					this.lastForwardedAt.delete(id);
				}
			})
			.catch(err => {
				clearTimeout(connectTimer);
				if ((err as Error).name !== 'AbortError') {
					logger.error('[SseHandler] SSE connection failed', { url, err });
					this.sendError(id, String((err as Error)?.message ?? err));
				}
				this.connections.delete(id);
				this.lastForwardedAt.delete(id);
			});

		this.connections.set(id, {
			close: () => {
				clearTimeout(connectTimer);
				controller.abort();
			},
		});
		logger.info('[SseHandler] SSE subscription started:', id);
	}

	private handleClose(id: string) {
		const conn = this.connections.get(id);
		if (conn) {
			conn.close();
			this.connections.delete(id);
		}
		this.lastForwardedAt.delete(id);
	}

	private sendError(id: string, error: string) {
		this.context.bridge.data('sseError', { id, error });
	}

	dispose() {
		for (const conn of this.connections.values()) {
			conn.close();
		}
		this.connections.clear();
	}
}
