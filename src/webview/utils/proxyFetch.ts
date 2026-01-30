/**
 * @file Proxy Fetch Implementation
 * @description Provides a fetch-compatible interface that proxies requests through the VS Code extension host.
 *              Allows the webview to access local resources (like OpenCode server on localhost) bypassing CORS/CSP restrictions.
 */

import type { WebviewMessage } from '../../common';
import { vscode } from './vscode';

// Store pending requests to resolve them when extension responds
const pendingFetches = new Map<
	string,
	{
		resolve: (value: Response) => void;
		reject: (reason?: unknown) => void;
		abortController: AbortController;
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
		if (message?.type !== 'proxyFetchResult') return;

		const { id, ok, status, statusText, headers, bodyText, error } = message;

		const entry = pendingFetches.get(id);
		if (!entry) return;

		pendingFetches.delete(id);

		if (!ok) {
			entry.reject(new Error(error ?? 'Proxy fetch failed'));
			return;
		}

		// Reconstruct Response object
		const responseHeaders = new Headers(headers ?? {});
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
			init: {
				method,
				headers,
				body: reqBody,
			},
		} as unknown as WebviewMessage);
	});
}
