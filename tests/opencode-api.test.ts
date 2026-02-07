/**
 * @file OpenCode API Integration Test
 * @description Direct tests against OpenCode REST API to validate minimal implementation.
 *              Run with: bun test tests/opencode-api.test.ts
 */

import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const WORKSPACE_ROOT = 'c:\\Users\\Comp\\Desktop\\PrimeCode';

// Find any available OpenCode port file
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

// Shared types matching OpenCode API
type Session = {
	id: string;
	title?: string;
	parentID?: string;
	time?: { created?: number; updated?: number };
};

type Message = {
	info?: { role?: string; id?: string };
	parts?: Array<{ type: string; text?: string; tool?: string; callID?: string }>;
	time?: { created?: number };
};

describe('OpenCode API', () => {
	let baseUrl: string;

	beforeAll(() => {
		const port = discoverPort();
		if (!port) throw new Error('OpenCode server not running');
		baseUrl = `http://127.0.0.1:${port}`;
		console.log(`[Test] Server: ${baseUrl}`);
	});

	// Helper: fetch sessions
	const getSessions = async (): Promise<Session[]> => {
		const resp = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
		return resp.ok ? resp.json() : [];
	};

	// Helper: fetch messages
	const getMessages = async (sessionId: string): Promise<Message[]> => {
		const resp = await fetch(`${baseUrl}/session/${sessionId}/message?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
		return resp.ok ? resp.json() : [];
	};

	describe('Sessions API', () => {
		it('GET /session returns array', async () => {
			const sessions = await getSessions();
			expect(Array.isArray(sessions)).toBe(true);
			console.log(`[Test] Sessions: ${sessions.length}`);
		});

		it('session has correct structure', async () => {
			const sessions = await getSessions();
			const s = sessions[0];
			if (!s) return;

			expect(s.id).toMatch(/^ses_/);
			expect(typeof s.time?.created).toBe('number');
		});

		it('parentID identifies subagents', async () => {
			const sessions = await getSessions();
			const main = sessions.filter(s => !s.parentID);
			const subs = sessions.filter(s => s.parentID);

			console.log(`[Test] Main: ${main.length}, Subagents: ${subs.length}`);
			expect(main.length).toBeGreaterThan(0);

			if (subs[0]) {
				expect(subs[0].parentID).toMatch(/^ses_/);
			}
		});

		it('POST /session creates new session', async () => {
			const resp = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(WORKSPACE_ROOT)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});

			expect(resp.ok).toBe(true);
			const data = await resp.json() as { id: string };
			expect(data.id).toMatch(/^ses_/);
			console.log(`[Test] Created session: ${data.id}`);
		});

		it('POST /session/{id}/message works', async () => {
			const sessions = await getSessions();
			const session = sessions.find(s => !s.parentID);
			if (!session) return;

			const body = {
				parts: [{ type: 'text', text: 'Hello' }],
				model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet-latest' }
			};

			const resp = await fetch(`${baseUrl}/session/${session.id}/message?directory=${encodeURIComponent(WORKSPACE_ROOT)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});

			if (!resp.ok) {
				console.log('Message Error:', resp.status, await resp.text());
			}
			expect(resp.ok).toBe(true);
			
			// Check if response is JSON (even if null)
			const contentType = resp.headers.get('content-type');
			expect(contentType).toContain('application/json');
		});
	});

	describe('Messages API', () => {
		it('GET /session/{id}/message returns array', async () => {
			const sessions = await getSessions();
			const main = sessions.find(s => !s.parentID);
			if (!main) return;

			const messages = await getMessages(main.id);
			expect(Array.isArray(messages)).toBe(true);
			console.log(`[Test] Session ${main.id}: ${messages.length} messages`);
		});

		it('message has info.role and parts', async () => {
			const sessions = await getSessions();
			for (const s of sessions.filter(s => !s.parentID).slice(0, 5)) {
				const messages = await getMessages(s.id);
				const msg = messages[0];
				if (!msg) continue;

				expect(msg.info?.role).toMatch(/^(user|assistant)$/);
				expect(Array.isArray(msg.parts)).toBe(true);
				console.log(`[Test] Message role: ${msg.info?.role}, parts: ${msg.parts?.length}`);
				break;
			}
		});

		it('text parts have text field', async () => {
			const sessions = await getSessions();
			for (const s of sessions.filter(s => !s.parentID).slice(0, 5)) {
				const messages = await getMessages(s.id);
				for (const msg of messages) {
					const textPart = msg.parts?.find(p => p.type === 'text');
					if (textPart) {
						expect(typeof textPart.text).toBe('string');
						console.log(`[Test] Text: "${textPart.text?.slice(0, 50)}..."`);
						return;
					}
				}
			}
		});

		it('tool parts have tool and callID', async () => {
			const sessions = await getSessions();
			for (const s of sessions.filter(s => !s.parentID).slice(0, 10)) {
				const messages = await getMessages(s.id);
				for (const msg of messages) {
					const toolPart = msg.parts?.find(p => p.type === 'tool');
					if (toolPart) {
						expect(typeof toolPart.tool).toBe('string');
						expect(typeof toolPart.callID).toBe('string');
						console.log(`[Test] Tool: ${toolPart.tool}, callID: ${toolPart.callID?.slice(0, 20)}`);
						return;
					}
				}
			}
		});
	});

	describe('System API (Commands, Agents, MCP)', () => {
		it('GET /command returns commands list', async () => {
			const resp = await fetch(`${baseUrl}/command?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			if (resp.status === 404) {
				console.warn('[Test] GET /command not supported (404)');
				return;
			}
			expect(resp.ok).toBe(true);
			const commands = await resp.json();
			expect(Array.isArray(commands)).toBe(true);
			console.log(`[Test] Commands: ${commands.length}`);
			if (commands.length > 0) {
				console.log(`[Test] First command: ${commands[0].name}`);
			}
		});

		it('GET /agent returns agents list', async () => {
			const resp = await fetch(`${baseUrl}/agent?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			if (resp.status === 404) {
				console.warn('[Test] GET /agent not supported (404)');
				return;
			}
			expect(resp.ok).toBe(true);
			const agents = await resp.json();
			expect(Array.isArray(agents)).toBe(true);
			console.log(`[Test] Agents: ${agents.length}`);
		});

		it('GET /config/providers returns providers', async () => {
			const resp = await fetch(`${baseUrl}/config/providers?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			if (resp.status === 404) {
				console.warn('[Test] GET /config/providers not supported (404)');
				return;
			}
			expect(resp.ok).toBe(true);
			const providers = await resp.json();
			expect(typeof providers).toBe('object');
			console.log(`[Test] Providers: ${Object.keys(providers).length}`);
		});

		it('GET /mcp returns mcp status', async () => {
			const resp = await fetch(`${baseUrl}/mcp?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			if (resp.status === 404) {
				console.warn('[Test] GET /mcp not supported (404)');
				return;
			}
			expect(resp.ok).toBe(true);
			const mcp = await resp.json();
			expect(typeof mcp).toBe('object');
			console.log(`[Test] MCP Status: available`);
		});
	});

	describe('Minimal Implementation', () => {
		it('listSessions - minimal code', async () => {
			const resp = await fetch(`${baseUrl}/session?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			const sessions = (await resp.json()) as Session[];

			const result = sessions
				.filter(s => !s.parentID)
				.map(s => ({
					id: s.id,
					title: s.title || 'Untitled',
					lastModified: s.time?.updated || s.time?.created || Date.now(),
				}));

			expect(result.length).toBeGreaterThan(0);
			console.log(`[Test] listSessions: ${result.length}`);
		});

		it('getHistory - minimal code', async () => {
			const sessions = await getSessions();
			const main = sessions.find(s => !s.parentID);
			if (!main) return;

			const messages = await getMessages(main.id);

			const events = messages.flatMap(msg => {
				const role = msg.info?.role;
				const timestamp = msg.time?.created ? new Date(msg.time.created).toISOString() : new Date().toISOString();

				return (msg.parts || [])
					.filter(p => p.type === 'text' && p.text)
					.map(p => ({
						type: role === 'assistant' ? 'message' : 'user_message',
						content: p.text,
						timestamp,
					}));
			});

			console.log(`[Test] getHistory: ${events.length} events`);
		});
	});

	describe('Edge Cases', () => {
		it('handles non-existent session', async () => {
			const resp = await fetch(`${baseUrl}/session/ses_nonexistent/message?directory=${encodeURIComponent(WORKSPACE_ROOT)}`);
			// Should return error or empty
			expect([200, 404, 400, 500]).toContain(resp.status);
		});

		it('handles empty directory param', async () => {
			const resp = await fetch(`${baseUrl}/session?directory=`);
			expect([200, 400, 404]).toContain(resp.status);
		});

		it('timestamps are in milliseconds', async () => {
			const sessions = await getSessions();
			const s = sessions[0];
			if (!s?.time?.created) return;

			// Milliseconds should be > year 2020 in ms
			expect(s.time.created).toBeGreaterThan(1577836800000);
			// And reasonable (not seconds)
			expect(s.time.created).toBeGreaterThan(Date.now() - 365 * 24 * 60 * 60 * 1000);
		});
	});
});
