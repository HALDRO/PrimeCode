import type { WebviewMessage } from '../../common';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

export class SseHandler implements WebviewMessageHandler {
	private connections = new Map<string, { close: () => void }>();

	constructor(private context: HandlerContext) {}

	async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'sseSubscribe':
				await this.handleSubscribe(msg as unknown as { id: string; url: string });
				break;
			case 'sseClose':
				this.handleClose((msg as unknown as { id: string }).id);
				break;
		}
	}

	private async handleSubscribe(message: { id: string; url: string }) {
		const { id, url } = message;

		if (typeof id !== 'string' || typeof url !== 'string') {
			logger.warn('[SseHandler] Invalid sseSubscribe message', message);
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

		// Start the fetch connection
		fetch(url, {
			headers: { Accept: 'text/event-stream' },
			signal: controller.signal,
		})
			.then(async res => {
				if (!res.ok || !res.body) {
					this.sendError(id, `SSE connection failed: ${res.status}`);
					return;
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							this.context.view.postMessage({ type: 'sseClosed', data: { id } });
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
									const data = line.slice(6);
									this.context.view.postMessage({
										type: 'sseEvent',
										data: { id, data },
									});
								}
							}
						}
					}
				} catch (err) {
					if ((err as Error).name !== 'AbortError') {
						this.sendError(id, String((err as Error)?.message ?? err));
					}
					this.connections.delete(id);
				}
			})
			.catch(err => {
				if ((err as Error).name !== 'AbortError') {
					logger.error('[SseHandler] SSE connection failed', { url, err });
					this.sendError(id, String((err as Error)?.message ?? err));
				}
				this.connections.delete(id);
			});

		this.connections.set(id, { close: () => controller.abort() });
		logger.info('[SseHandler] SSE subscription started:', id);
	}

	private handleClose(id: string) {
		const conn = this.connections.get(id);
		if (conn) {
			conn.close();
			this.connections.delete(id);
		}
	}

	private sendError(id: string, error: string) {
		this.context.view.postMessage({
			type: 'sseError',
			data: { id, error },
		});
	}

	dispose() {
		for (const conn of this.connections.values()) {
			conn.close();
		}
		this.connections.clear();
	}
}
