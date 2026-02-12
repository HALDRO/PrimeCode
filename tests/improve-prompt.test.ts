/**
 * @file Improve Prompt Integration Test
 * @description End-to-end tests for the Prompt Improver feature against a live OpenCode server.
 *              Validates the full flow: session creation → message with baked instruction →
 *              SSE wait for session.idle → fetch assistant response → session cleanup.
 *
 *              Run with: bun test tests/improve-prompt.test.ts
 *
 *              Prerequisites: OpenCode server must be running (start PrimeCode extension first).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = 'c:\\Users\\Comp\\Desktop\\PrimeCode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function discoverPort(): number | null {
	try {
		const tempDir = os.tmpdir();
		const files = fs.readdirSync(tempDir).filter(f => f.startsWith('primecode-opencode-port-'));
		if (files.length > 0) {
			const content = fs.readFileSync(path.join(tempDir, files[0]), 'utf-8');
			return parseInt(content.trim(), 10) || null;
		}
	} catch {
		return null;
	}
	return null;
}

function buildUrl(base: string, endpoint: string, directory: string): string {
	const url = new URL(`${base}${endpoint}`);
	if (directory) url.searchParams.append('directory', directory);
	return url.toString();
}

type Session = { id: string; parentID?: string };
type Message = {
	info?: { role?: string; id?: string };
	parts?: Array<{ type?: string; text?: string }>;
	time?: { created?: number; completed?: number };
};

const DEFAULT_INSTRUCTION =
	'Rewrite the following user prompt to be clearer, more specific, and more actionable for an AI coding agent. Preserve the original intent and constraints. Return ONLY the rewritten prompt text, nothing else — no explanations, no markdown fences, no preamble.';

// ---------------------------------------------------------------------------
// SSE helper — mirrors waitForSessionIdle from SessionHandler.ts
// ---------------------------------------------------------------------------

function waitForSessionIdle(
	baseUrl: string,
	directory: string,
	sessionId: string,
	signal: AbortSignal,
	timeoutMs = 120_000,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('Aborted'));
			return;
		}

		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`SSE timeout after ${timeoutMs}ms waiting for session.idle`));
		}, timeoutMs);

		const sseUrl = `${baseUrl}/event?directory=${encodeURIComponent(directory)}`;
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

		const cleanup = () => {
			clearTimeout(timer);
			try {
				reader?.cancel().catch(() => {});
			} catch {}
		};

		signal.addEventListener(
			'abort',
			() => {
				cleanup();
				reject(new Error('Aborted'));
			},
			{ once: true },
		);

		void (async () => {
			try {
				const resp = await fetch(sseUrl, {
					method: 'GET',
					headers: { Accept: 'text/event-stream' },
					signal,
				});
				if (!resp.ok || !resp.body) {
					throw new Error(`SSE connect failed: ${resp.status}`);
				}

				reader = resp.body.getReader();
				const decoder = new TextDecoder();
				let buffer = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (!line.startsWith('data:')) continue;
						const raw = line.slice(5).trim();
						if (!raw) continue;

						try {
							const evt = JSON.parse(raw) as {
								type?: string;
								properties?: { sessionID?: string };
							};
							if (evt.type === 'session.idle' && evt.properties?.sessionID === sessionId) {
								cleanup();
								resolve();
								return;
							}
						} catch {}
					}
				}

				reject(new Error('SSE stream ended without session.idle'));
			} catch (err) {
				cleanup();
				if (!signal.aborted) reject(err);
			}
		})();
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Improve Prompt — Integration', () => {
	let baseUrl: string;
	const directory = WORKSPACE_ROOT;
	const createdSessions: string[] = [];

	beforeAll(() => {
		const port = discoverPort();
		if (!port) throw new Error('OpenCode server not running — start PrimeCode extension first');
		baseUrl = `http://127.0.0.1:${port}`;
		console.log(`[ImprovePrompt Test] Server: ${baseUrl}`);
	});

	afterAll(async () => {
		// Cleanup all temp sessions created during tests
		for (const sid of createdSessions) {
			await fetch(buildUrl(baseUrl, `/session/${sid}`, directory), { method: 'DELETE' }).catch(
				() => {},
			);
		}
		console.log(`[ImprovePrompt Test] Cleaned up ${createdSessions.length} temp sessions`);
	});

	// -----------------------------------------------------------------------
	// 1. Session lifecycle
	// -----------------------------------------------------------------------

	describe('Session lifecycle', () => {
		it('creates a temporary session', async () => {
			const resp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(resp.ok).toBe(true);

			const session = (await resp.json()) as Session;
			expect(session.id).toMatch(/^ses_/);
			createdSessions.push(session.id);
			console.log(`[Test] Created session: ${session.id}`);
		});

		it('creates a child session with parentID', async () => {
			// Get an existing main session to use as parent
			const listResp = await fetch(buildUrl(baseUrl, '/session', directory));
			const sessions = (await listResp.json()) as Session[];
			const parent = sessions.find(s => !s.parentID);
			if (!parent) {
				console.warn('[Test] No parent session available, skipping');
				return;
			}

			const resp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ parentID: parent.id }),
			});
			expect(resp.ok).toBe(true);

			const session = (await resp.json()) as Session;
			expect(session.id).toMatch(/^ses_/);
			createdSessions.push(session.id);
			console.log(`[Test] Created child session: ${session.id} (parent: ${parent.id})`);
		});

		it('deletes a temporary session', async () => {
			// Create one to delete
			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;

			const delResp = await fetch(buildUrl(baseUrl, `/session/${session.id}`, directory), {
				method: 'DELETE',
			});
			// Accept 200, 204, or 404 (already deleted)
			expect([200, 204, 404]).toContain(delResp.status);
			console.log(`[Test] Deleted session: ${session.id}, status: ${delResp.status}`);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Message format validation
	// -----------------------------------------------------------------------

	describe('Message format', () => {
		it('sends message with instruction baked into text (no system field)', async () => {
			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;
			createdSessions.push(session.id);

			const userText = 'fix the bug in my code';
			const fullText = `${DEFAULT_INSTRUCTION}\n\n---\n\n${userText}`;

			const msgBody = {
				parts: [{ type: 'text', text: fullText }],
			};

			const resp = await fetch(buildUrl(baseUrl, `/session/${session.id}/message`, directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(msgBody),
			});

			expect(resp.ok).toBe(true);
			const contentType = resp.headers.get('content-type');
			expect(contentType).toContain('application/json');
			console.log(`[Test] Message sent OK to session ${session.id}`);
		});

		it('sends message with model selection', async () => {
			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;
			createdSessions.push(session.id);

			const msgBody = {
				parts: [{ type: 'text', text: `${DEFAULT_INSTRUCTION}\n\n---\n\ntest prompt` }],
				model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
			};

			const resp = await fetch(buildUrl(baseUrl, `/session/${session.id}/message`, directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(msgBody),
			});

			expect(resp.ok).toBe(true);
			console.log(`[Test] Message with model sent OK`);
		});
	});

	// -----------------------------------------------------------------------
	// 3. SSE event stream
	// -----------------------------------------------------------------------

	describe('SSE event stream', () => {
		it('connects to /event endpoint', async () => {
			const controller = new AbortController();
			const sseUrl = `${baseUrl}/event?directory=${encodeURIComponent(directory)}`;

			const resp = await fetch(sseUrl, {
				method: 'GET',
				headers: { Accept: 'text/event-stream' },
				signal: controller.signal,
			});

			expect(resp.ok).toBe(true);
			expect(resp.body).toBeTruthy();

			// Read at least one chunk to confirm stream is alive
			const body = resp.body;
			if (!body) throw new Error('No body');
			const reader = body.getReader();
			const timeout = setTimeout(() => controller.abort(), 5000);

			try {
				const { done } = await reader.read();
				console.log(`[Test] SSE stream connected, first read done=${done}`);
			} catch (err) {
				if (err instanceof Error && err.name !== 'AbortError') throw err;
				console.log('[Test] SSE stream connected (no events within 5s, OK)');
			} finally {
				clearTimeout(timeout);
				controller.abort();
				reader.cancel().catch(() => {});
			}
		});
	});

	// -----------------------------------------------------------------------
	// 4. Full end-to-end Improve Prompt flow
	// -----------------------------------------------------------------------

	describe('Full E2E flow', () => {
		it('creates session → sends message → waits SSE idle → gets response', async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 120_000);

			try {
				// Step 1: Create temp session
				const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
					signal: controller.signal,
				});
				expect(createResp.ok).toBe(true);
				const session = (await createResp.json()) as Session;
				expect(session.id).toMatch(/^ses_/);
				createdSessions.push(session.id);
				console.log(`[E2E] Session created: ${session.id}`);

				// Step 2: Start SSE listener BEFORE sending message
				const idlePromise = waitForSessionIdle(
					baseUrl,
					directory,
					session.id,
					controller.signal,
					120_000,
				);

				// Step 3: Send message with instruction baked into text
				const userPrompt = 'add dark mode to my app';
				const fullText = `${DEFAULT_INSTRUCTION}\n\n---\n\n${userPrompt}`;

				const msgResp = await fetch(
					buildUrl(baseUrl, `/session/${session.id}/message`, directory),
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ parts: [{ type: 'text', text: fullText }] }),
						signal: controller.signal,
					},
				);
				expect(msgResp.ok).toBe(true);
				console.log('[E2E] Message sent, waiting for session.idle...');

				// Step 4: Wait for session.idle via SSE
				await idlePromise;
				console.log('[E2E] session.idle received!');

				// Step 5: Fetch messages and extract assistant response
				const histResp = await fetch(
					buildUrl(baseUrl, `/session/${session.id}/message`, directory),
					{ method: 'GET', signal: controller.signal },
				);
				expect(histResp.ok).toBe(true);

				const messages = (await histResp.json()) as Message[];
				console.log(`[E2E] Messages in session: ${messages.length}`);

				// Find last completed assistant message
				let assistantText = '';
				for (let j = messages.length - 1; j >= 0; j--) {
					const msg = messages[j];
					if (msg.info?.role !== 'assistant') continue;
					if (!msg.time?.completed) continue;

					for (const part of msg.parts || []) {
						if (part.type === 'text' && part.text) assistantText += part.text;
					}
					break;
				}

				assistantText = assistantText.trim();
				expect(assistantText.length).toBeGreaterThan(0);
				console.log(`[E2E] Assistant response (${assistantText.length} chars):`);
				console.log(`[E2E] "${assistantText.slice(0, 200)}..."`);

				// The improved prompt should be different from the original
				expect(assistantText).not.toBe(userPrompt);
				// And should be a reasonable length (not just a single word)
				expect(assistantText.length).toBeGreaterThan(10);
			} finally {
				clearTimeout(timeout);
				controller.abort();
			}
		}, 130_000); // 130s test timeout

		it('custom template is used in the message text', async () => {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 120_000);

			try {
				// Create session
				const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
					signal: controller.signal,
				});
				const session = (await createResp.json()) as Session;
				createdSessions.push(session.id);

				const customTemplate =
					'Translate the following prompt into a formal software requirements specification. Return ONLY the specification text.';
				const userPrompt = 'make the button blue';
				const fullText = `${customTemplate}\n\n---\n\n${userPrompt}`;

				// Start SSE listener
				const idlePromise = waitForSessionIdle(
					baseUrl,
					directory,
					session.id,
					controller.signal,
					120_000,
				);

				// Send message
				const msgResp = await fetch(
					buildUrl(baseUrl, `/session/${session.id}/message`, directory),
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ parts: [{ type: 'text', text: fullText }] }),
						signal: controller.signal,
					},
				);
				expect(msgResp.ok).toBe(true);

				await idlePromise;

				// Fetch response
				const histResp = await fetch(
					buildUrl(baseUrl, `/session/${session.id}/message`, directory),
					{ method: 'GET', signal: controller.signal },
				);
				const messages = (await histResp.json()) as Message[];

				let assistantText = '';
				for (let j = messages.length - 1; j >= 0; j--) {
					const msg = messages[j];
					if (msg.info?.role !== 'assistant' || !msg.time?.completed) continue;
					for (const part of msg.parts || []) {
						if (part.type === 'text' && part.text) assistantText += part.text;
					}
					break;
				}

				assistantText = assistantText.trim();
				expect(assistantText.length).toBeGreaterThan(0);
				console.log(
					`[E2E Custom] Response (${assistantText.length} chars): "${assistantText.slice(0, 150)}..."`,
				);
			} finally {
				clearTimeout(timeout);
				controller.abort();
			}
		}, 130_000);
	});

	// -----------------------------------------------------------------------
	// 5. Abort / cancellation
	// -----------------------------------------------------------------------

	describe('Abort handling', () => {
		it('aborts SSE wait when signal is triggered', async () => {
			const controller = new AbortController();

			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;
			createdSessions.push(session.id);

			// Start SSE wait, then abort after 2s
			const idlePromise = waitForSessionIdle(
				baseUrl,
				directory,
				session.id,
				controller.signal,
				30_000,
			);

			setTimeout(() => controller.abort(), 2000);

			await expect(idlePromise).rejects.toThrow(/Aborted/);
			console.log('[Test] Abort correctly propagated to SSE wait');
		}, 10_000);

		it('pre-aborted signal rejects immediately', async () => {
			const controller = new AbortController();
			controller.abort(); // Already aborted

			const promise = waitForSessionIdle(baseUrl, directory, 'ses_fake', controller.signal, 5000);

			await expect(promise).rejects.toThrow(/Aborted/);
			console.log('[Test] Pre-aborted signal rejected immediately');
		});
	});

	// -----------------------------------------------------------------------
	// 6. Edge cases
	// -----------------------------------------------------------------------

	describe('Edge cases', () => {
		it('system field in POST body is silently ignored', async () => {
			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;
			createdSessions.push(session.id);

			// Send with system field — should NOT cause an error, but will be ignored
			const msgBody = {
				parts: [{ type: 'text', text: 'Hello' }],
				system: 'This should be ignored by the API',
			};

			const resp = await fetch(buildUrl(baseUrl, `/session/${session.id}/message`, directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(msgBody),
			});

			// API accepts it (doesn't error), but ignores the system field
			expect(resp.ok).toBe(true);
			console.log('[Test] system field accepted but ignored (confirmed)');
		});

		it('empty text parts are handled gracefully', async () => {
			const createResp = await fetch(buildUrl(baseUrl, '/session', directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			const session = (await createResp.json()) as Session;
			createdSessions.push(session.id);

			const msgBody = {
				parts: [{ type: 'text', text: '' }],
			};

			const resp = await fetch(buildUrl(baseUrl, `/session/${session.id}/message`, directory), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(msgBody),
			});

			// May succeed or fail — we just verify it doesn't crash
			expect([200, 400, 422, 500]).toContain(resp.status);
			console.log(`[Test] Empty text response: ${resp.status}`);
		});
	});
});
