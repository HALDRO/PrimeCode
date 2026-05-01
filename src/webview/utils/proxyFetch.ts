/**
 * @file Proxy Fetch Implementation
 * @description Provides a fetch-compatible interface that proxies requests through the VS Code extension host.
 *              Allows the webview to access local resources (like OpenCode server on localhost) bypassing CORS/CSP restrictions.
 */

import { vscode } from './vscode';

// Store pending requests to resolve them when extension responds
const pendingFetches = new Map<
	string,
	{
		resolve: (value: Response) => void;
		reject: (reason?: unknown) => void;
		abortController: AbortController;
		streamController?: ReadableStreamDefaultController<Uint8Array>;
		chunkBuffer?: Uint8Array[];
		streamEnded?: boolean;
		streamError?: string;
	}
>();

// Initialize listener once
let isListening = false;

const initListener = () => {
	if (isListening) return;
	isListening = true;

	window.addEventListener('message', event => {
		const message = event.data;
		// Handle proxy fetch results
		if (message?.type === 'proxyFetchStreamChunk') {
			const entry = pendingFetches.get(message.id);
			if (!entry) return;
			const chunk = message.chunk;
			const uint8Array =
				chunk instanceof Uint8Array
					? chunk
					: chunk instanceof ArrayBuffer
						? new Uint8Array(chunk)
						: ArrayBuffer.isView(chunk)
							? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
							: Array.isArray(chunk)
								? new Uint8Array(chunk)
								: typeof chunk === 'string'
									? new TextEncoder().encode(chunk)
									: new Uint8Array();
			if (!entry.streamController) {
				if (!entry.chunkBuffer) {
					entry.chunkBuffer = [];
				}
				entry.chunkBuffer.push(uint8Array);
				return;
			}
			entry.streamController.enqueue(uint8Array);
			return;
		}

		if (message?.type === 'proxyFetchStreamEnd') {
			const entry = pendingFetches.get(message.id);
			if (!entry) return;
			if (!entry.streamController) {
				entry.streamEnded = true;
				return;
			}
			entry.streamController.close();
			pendingFetches.delete(message.id);
			return;
		}

		if (message?.type === 'proxyFetchStreamError') {
			const entry = pendingFetches.get(message.id);
			if (!entry) return;
			const errorMessage = message.error ?? 'Proxy stream failed';
			if (!entry.streamController) {
				entry.streamError = errorMessage;
				return;
			}
			entry.streamController.error(new Error(errorMessage));
			pendingFetches.delete(message.id);
			return;
		}

		if (message?.type !== 'proxyFetchResult') return;

		const { id, ok, status, statusText, headers, bodyText, error, isStream } = message;

		const entry = pendingFetches.get(id);
		if (!entry) return;

		if (!ok) {
			pendingFetches.delete(id);
			entry.reject(new Error(error ?? 'Proxy fetch failed'));
			return;
		}

		const responseHeaders = new Headers(headers ?? {});
		if (isStream) {
			const response = new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						entry.streamController = controller;
						for (const chunk of entry.chunkBuffer ?? []) {
							controller.enqueue(chunk);
						}
						entry.chunkBuffer = undefined;
						if (entry.streamError) {
							controller.error(new Error(entry.streamError));
							pendingFetches.delete(id);
							return;
						}
						if (entry.streamEnded) {
							controller.close();
							pendingFetches.delete(id);
						}
					},
					cancel() {
						pendingFetches.delete(id);
						vscode.postMessage({ type: 'proxyFetchAbort', id });
					},
				}),
				{
					status,
					statusText,
					headers: responseHeaders,
				},
			);
			entry.resolve(response);
			return;
		}

		pendingFetches.delete(id);

		// Reconstruct Response object
		const response = new Response(bodyText, {
			status,
			statusText,
			headers: responseHeaders,
		});

		entry.resolve(response);
	});

	// Cleanup on unload
	window.addEventListener('beforeunload', () => {
		for (const [_id, entry] of pendingFetches.entries()) {
			entry.abortController.abort();
			entry.reject(new Error('Webview unloaded before proxy fetch completed'));
		}
		pendingFetches.clear();
	});
};

/**
 * Proxy fetch function.
 * Use this as a drop-in replacement for global fetch when you need to access
 * localhost servers that might be blocked by VS Code Webview CSP.
 */
export async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	initListener();

	// Parse arguments
	let url: string;
	let method: string | undefined;
	let reqHeaders: HeadersInit | undefined;
	let reqBody: string | undefined;

	if (input instanceof Request) {
		url = input.url;
		method = input.method;
		reqHeaders = input.headers;
		if (input.body) {
			reqBody = await input.text();
		}
	} else {
		url = String(input);
		method = init?.method;
		reqHeaders = init?.headers;
		if (typeof init?.body === 'string') {
			reqBody = init.body;
		}
	}

	const id = crypto.randomUUID();

	return new Promise<Response>((resolve, reject) => {
		const abortController = new AbortController();

		// Handle AbortSignal
		if (init?.signal) {
			if (init.signal.aborted) {
				reject(new DOMException('Aborted', 'AbortError'));
				return;
			}
			init.signal.addEventListener('abort', () => {
				abortController.abort();
				pendingFetches.delete(id);
				vscode.postMessage({ type: 'proxyFetchAbort', id });
				reject(new DOMException('Aborted', 'AbortError'));
			});
		}

		pendingFetches.set(id, { resolve, reject, abortController });

		// Serialize headers
		const headers: Record<string, string> = {};
		if (reqHeaders instanceof Headers) {
			reqHeaders.forEach((v, k) => {
				headers[k] = v;
			});
		} else if (Array.isArray(reqHeaders)) {
			for (const [k, v] of reqHeaders) headers[k] = v;
		} else if (reqHeaders) {
			Object.assign(headers, reqHeaders as Record<string, string>);
		}

		// Send request to extension host
		vscode.postMessage({
			type: 'proxyFetch',
			id,
			url,
			options: {
				method,
				headers,
				body: reqBody,
			},
		});
	});
}
