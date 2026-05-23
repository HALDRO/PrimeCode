/**
 * @file Dumps OpenCode sessions to docs/debug.
 * @description Spawns a temporary `opencode serve` instance, collects sessions, and exports
 * session payloads/messages/children as JSON snapshots for debugging workflows.
 * Server shuts down when the script exits (Ctrl-C or normal completion).
 * "Download from last 10 sessions" aggregates sessions across all known workspaces
 * using the `/project` worktree list, then sorts globally by recency.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

// ─── State ────────────────────────────────────────────────────────────────────

let serverProc: ChildProcess | null = null;
let baseUrl = '';

const WORKSPACE = process.cwd();
const DEBUG_DIR = path.join(WORKSPACE, 'docs', 'debug');
const GLOBAL_WORKSPACE_SAMPLE_LIMIT = 50;
const DEFAULT_DUMP_SESSIONS_LIMIT = 30;

type OpenCodeSession = {
	id: string;
	title?: string;
	directory?: string;
	time?: { created?: number; updated?: number };
};

type OpenCodeProject = {
	worktree?: string;
};

type OpenCodeMessage = Record<string, unknown>;

type ChildSession = Record<string, unknown> & {
	id: string;
	title?: string;
	parentID?: string;
};

type SnapshotFileDiff = {
	file?: string;
	patch?: string;
	additions?: number;
	deletions?: number;
	status?: string;
};

type SessionTodo = Record<string, unknown>;

type SessionStatusMap = Record<string, unknown>;

type PathInfo = Record<string, unknown>;

type VcsInfo = Record<string, unknown>;

type PermissionRequest = Record<string, unknown>;

type QuestionRequest = Record<string, unknown>;

type DumpedSessionNode = {
	session: Record<string, unknown>;
	messages: OpenCodeMessage[];
	todo: SessionTodo[];
	diff: SnapshotFileDiff[];
	messageDiffs: Array<{
		messageID: string;
		role?: string;
		parentID?: string;
		diffs: SnapshotFileDiff[];
	}>;
	children: DumpedSessionNode[];
	_meta: {
		messageCount: number;
		childCount: number;
		todoCount: number;
		diffCount: number;
		messageDiffCount: number;
	};
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toComparableTime(session: OpenCodeSession): number {
	return Number(session.time?.updated ?? session.time?.created ?? 0);
}

function normalizeDirectoryPath(dir: string): string {
	return dir.trim().replace(/[\\/]+$/, '');
}

function getDirectoryVariants(dir: string): string[] {
	const normalized = normalizeDirectoryPath(dir);
	if (!normalized) return [];
	const variants = new Set<string>([normalized]);

	if (process.platform === 'win32' && /^[A-Za-z]:/.test(normalized)) {
		variants.add(normalized[0].toLowerCase() + normalized.slice(1));
		variants.add(normalized[0].toUpperCase() + normalized.slice(1));
	}

	return [...variants];
}

function getWorkspaceLabel(dir?: string): string {
	if (!dir) return '(unknown workspace)';
	const cleaned = dir.replace(/[\\/]+$/, '');
	const parts = cleaned.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? dir;
}

function ask(q: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(r =>
		rl.question(q, a => {
			rl.close();
			r(a.trim());
		}),
	);
}

// ─── Server Lifecycle ─────────────────────────────────────────────────────────

/** Spawn a temporary opencode server. Auto-kills on process exit. */
async function startServer(): Promise<string> {
	console.log('Starting opencode serve...');
	const proc = spawn('opencode', ['serve', '--port=0', '--hostname=127.0.0.1'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, NO_COLOR: '1' },
		shell: process.platform === 'win32',
	});
	serverProc = proc;

	let output = '';
	const url = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error('Timeout waiting for opencode serve to start (15s)'));
		}, 15_000);

		let resolved = false;
		const onData = (chunk: Buffer) => {
			if (resolved) return;
			output += chunk.toString();
			const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s\r\n]+)/);
			if (match?.[1]) {
				resolved = true;
				clearTimeout(timer);
				resolve(match[1]);
			}
		};

		proc.stdout?.on('data', onData);
		proc.stderr?.on('data', onData);
		proc.on('error', err => {
			clearTimeout(timer);
			reject(err);
		});
		proc.on('exit', code => {
			if (resolved) return;
			clearTimeout(timer);
			reject(new Error(`opencode serve exited with code ${code}\n${output}`));
		});
	});

	console.log(`Server: ${url}\n`);
	return url;
}

function killServer(): void {
	if (serverProc && !serverProc.killed) {
		serverProc.kill();
	}
}

// Register cleanup on exit
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(0); });
process.on('SIGTERM', () => { killServer(); process.exit(0); });

// ─── API ──────────────────────────────────────────────────────────────────────

async function api<T>(base: string, ep: string, directory?: string): Promise<T> {
	let url = `${base}${ep}`;
	if (directory !== undefined) {
		const sep = ep.includes('?') ? '&' : '?';
		url += `${sep}directory=${encodeURIComponent(directory)}`;
	}
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${ep}`);
	return res.json() as Promise<T>;
}

async function safeApi<T>(base: string, ep: string, directory?: string, fallback?: T): Promise<T> {
	try {
		return await api<T>(base, ep, directory);
	} catch {
		if (fallback !== undefined) return fallback;
		throw new Error(`Failed to fetch ${ep}`);
	}
}

/** Проверяет, доступна ли сессия на сервере (с указанием directory) */
async function checkSessionExists(
	base: string,
	sessionId: string,
	directory?: string,
): Promise<boolean> {
	try {
		let url = `${base}/session/${sessionId}`;
		if (directory) url += `?directory=${encodeURIComponent(directory)}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

// ─── Session Dumping ──────────────────────────────────────────────────────────

function extractMessageDiffs(messages: OpenCodeMessage[]) {
	const result: DumpedSessionNode['messageDiffs'] = [];
	for (const rawMessage of messages) {
		const info =
			rawMessage && typeof rawMessage === 'object' && 'info' in rawMessage
				? ((rawMessage as { info?: Record<string, unknown> }).info ?? {})
				: {};
		const summary =
			info && typeof info === 'object' && 'summary' in info
				? ((info as { summary?: Record<string, unknown> }).summary ?? {})
				: {};
		const diffs = Array.isArray(summary.diffs) ? (summary.diffs as SnapshotFileDiff[]) : [];
		if (diffs.length === 0) continue;
		result.push({
			messageID: typeof info.id === 'string' ? info.id : '(unknown)',
			role: typeof info.role === 'string' ? info.role : undefined,
			parentID: typeof info.parentID === 'string' ? info.parentID : undefined,
			diffs,
		});
	}
	return result;
}

function extractUserPreviewText(message: OpenCodeMessage): string {
	const info =
		message && typeof message === 'object' && 'info' in message
			? ((message as { info?: Record<string, unknown> }).info ?? {})
			: {};
	if (info.role !== 'user') return '';
	const parts =
		message && typeof message === 'object' && 'parts' in message
			? ((message as { parts?: unknown[] }).parts ?? [])
			: [];
	if (!Array.isArray(parts)) return '';
	return parts
		.filter(
			(part): part is { type?: string; text?: string } =>
				Boolean(part) && typeof part === 'object' && 'type' in part,
		)
		.filter(part => part.type === 'text' && typeof part.text === 'string')
		.map(part => part.text?.trim() ?? '')
		.filter(Boolean)
		.join(' ');
}

async function dumpSessionNode(
	base: string,
	session: Record<string, unknown>,
	directory?: string,
): Promise<DumpedSessionNode> {
	const sessionId = typeof session.id === 'string' ? session.id : undefined;
	if (!sessionId) {
		throw new Error('Session node is missing id');
	}

	const [messages, todo, diff, children] = await Promise.all([
		safeApi<OpenCodeMessage[]>(base, `/session/${sessionId}/message`, directory, []),
		safeApi<SessionTodo[]>(base, `/session/${sessionId}/todo`, directory, []),
		safeApi<SnapshotFileDiff[]>(base, `/session/${sessionId}/diff`, directory, []),
		safeApi<ChildSession[]>(base, `/session/${sessionId}/children`, directory, []),
	]);

	const messageDiffs = extractMessageDiffs(messages);
	const childNodes: DumpedSessionNode[] = [];
	for (const child of children) {
		const childSession = await safeApi<Record<string, unknown>>(
			base,
			`/session/${child.id}`,
			directory,
			child,
		);
		const childNode = await dumpSessionNode(base, childSession, directory);
		childNodes.push(childNode);
	}

	return {
		session,
		messages,
		todo,
		diff,
		messageDiffs,
		children: childNodes,
		_meta: {
			messageCount: messages.length,
			childCount: childNodes.length,
			todoCount: todo.length,
			diffCount: diff.length,
			messageDiffCount: messageDiffs.length,
		},
	};
}

async function getSessionsAcrossWorkspaces(base: string, perWorkspaceLimit: number): Promise<OpenCodeSession[]> {
	const projects = await api<OpenCodeProject[]>(base, '/project');
	const directories = new Set<string>(getDirectoryVariants(WORKSPACE));
	for (const project of projects) {
		const worktree = project.worktree?.trim();
		if (!worktree) continue;
		for (const candidate of getDirectoryVariants(worktree)) {
			directories.add(candidate);
		}
	}

	const sessionsByWorkspace = await Promise.all(
		[...directories].map(async directory => {
			try {
				const rows = await api<OpenCodeSession[]>(
					base,
					`/session?limit=${perWorkspaceLimit}`,
					directory,
				);
				return rows.map(row => ({ ...row, directory: row.directory ?? directory }));
			} catch {
				return [] as OpenCodeSession[];
			}
		}),
	);

	const deduped = new Map<string, OpenCodeSession>();
	for (const rows of sessionsByWorkspace) {
		for (const session of rows) {
			const previous = deduped.get(session.id);
			if (!previous || toComparableTime(session) > toComparableTime(previous)) {
				deduped.set(session.id, session);
			}
		}
	}

	const merged = [...deduped.values()].sort((a, b) => toComparableTime(b) - toComparableTime(a));
	if (merged.length === 0) {
		const fallback = await api<OpenCodeSession[]>(base, `/session?limit=${perWorkspaceLimit}`);
		return fallback.sort((a, b) => toComparableTime(b) - toComparableTime(a));
	}
	return merged;
}

/** Fetch the full server config (includes agent definitions with prompts). */
async function fetchConfig(base: string, directory?: string): Promise<Record<string, unknown> | null> {
	try {
		return await api<Record<string, unknown>>(base, '/config', directory);
	} catch {
		return null;
	}
}

async function dumpSession(base: string, id: string, directory?: string) {
	console.log(`\nDumping ${id}...`);
	const [session, statusMap, pathInfo, vcsInfo, permissions, questions, config] = await Promise.all([
		api<Record<string, unknown>>(base, `/session/${id}`, directory),
		safeApi<SessionStatusMap>(base, '/session/status', directory, {}),
		safeApi<PathInfo>(base, '/path', directory, {}),
		safeApi<VcsInfo>(base, '/vcs', directory, {}),
		safeApi<PermissionRequest[]>(base, '/permission', directory, []),
		safeApi<QuestionRequest[]>(base, '/question', directory, []),
		fetchConfig(base, directory),
	]);
	const rootNode = await dumpSessionNode(base, session, directory);
	console.log(
		`  ${rootNode._meta.messageCount} msgs, ${rootNode._meta.childCount} children — ${session.title ?? '(no title)'}`,
	);
	for (const child of rootNode.children) {
		const childSessionId = typeof child.session.id === 'string' ? child.session.id : '(unknown)';
		const childTitle = typeof child.session.title === 'string' ? child.session.title : '(no title)';
		console.log(`  child ${childSessionId}: ${child._meta.messageCount} msgs — ${childTitle}`);
	}

	// Extract the used agent from the full server config
	const sessionAgentName = typeof session.agent === 'string' ? session.agent : '';
	const configAgent: Record<string, unknown> | null =
		config && typeof config.agent === 'object' && config.agent !== null
			? (config.agent as Record<string, unknown>)
			: null;
	const usedAgent: Record<string, unknown> | null =
		sessionAgentName && configAgent
			? (Object.values(configAgent).find(
					(a: unknown) =>
						typeof a === 'object' && a !== null && (a as Record<string, unknown>).name === sessionAgentName,
				) as Record<string, unknown> ?? null)
			: null;

	const dump = {
		root: rootNode,
		session,
		config,
		agent: usedAgent
			? {
					name: usedAgent.name,
					prompt: typeof usedAgent.prompt === 'string' ? usedAgent.prompt : null,
					promptLength: typeof usedAgent.prompt === 'string' ? usedAgent.prompt.length : 0,
				}
			: null,
		status: {
			current: typeof session.id === 'string' ? statusMap[session.id] : undefined,
			all: statusMap,
		},
		instance: {
			path: pathInfo,
			vcs: vcsInfo,
		},
		pending: {
			permissions,
			questions,
		},
		children: rootNode.children,
		_meta: {
			dumpedAt: new Date().toISOString(),
			serverUrl: base,
			sessionId: id,
			directory: directory ?? '(none)',
			childCount: rootNode._meta.childCount,
			totalMessages: rootNode._meta.messageCount,
			formatVersion: 3,
		},
	};

	fs.mkdirSync(DEBUG_DIR, { recursive: true });
	const out = path.join(DEBUG_DIR, `${id}.json`);
	fs.writeFileSync(out, JSON.stringify(dump, null, 2), 'utf-8');
	console.log(`  Saved: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	baseUrl = await startServer();

	console.log('  [1] Download from last 10 sessions');
	console.log('  [2] Enter session ID manually\n');
	const choice = await ask('> ');

	let ids: string[] = [];
	let directories: (string | undefined)[] = [];

	if (choice === '1') {
		const sessions = (await getSessionsAcrossWorkspaces(baseUrl, GLOBAL_WORKSPACE_SAMPLE_LIMIT)).slice(
			0,
			DEFAULT_DUMP_SESSIONS_LIMIT,
		);
		if (!sessions.length) {
			console.log('No sessions.');
			killServer();
			return;
		}

		const previews = await Promise.all(
			sessions.map(async s => {
				const title = s.title ?? '';
				if (title && !title.startsWith('New session')) return title;
				try {
					const msgs = await api<OpenCodeMessage[]>(
						baseUrl,
						`/session/${s.id}/message`,
						s.directory ?? WORKSPACE,
					);
					const first = msgs.find(message => extractUserPreviewText(message));
					const text = first ? extractUserPreviewText(first) : '';
					if (text)
						return text.replace(/\s+/g, ' ').slice(0, 80) + (text.length > 80 ? '...' : '');
				} catch {}
				return title || '(no title)';
			}),
		);

		console.log('');
		for (let i = 0; i < sessions.length; i++) {
			const s = sessions[i];
			const d = new Date(toComparableTime(s)).toLocaleString('ru-RU', {
				day: '2-digit',
				month: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			});
			const ws = ` [${getWorkspaceLabel(s.directory)}]`;
			console.log(`  [${i + 1}] ${d}${ws}  ${previews[i]}`);
		}
		console.log(`\nPick numbers (comma-separated) or "all":`);
		const pick = await ask('> ');

		if (pick.toLowerCase() === 'all') {
			ids = sessions.map(s => s.id);
			directories = sessions.map(s => s.directory);
		} else {
			const indices = pick
				.split(',')
				.map(n => Number.parseInt(n.trim(), 10) - 1)
				.filter(i => i >= 0 && i < sessions.length);
			ids = indices.map(i => sessions[i].id);
			directories = indices.map(i => sessions[i].directory);
		}
	} else if (choice === '2') {
		console.log('Enter session ID (ses_...):');
		const id = await ask('> ');
		if (id.startsWith('ses_')) {
			if (await checkSessionExists(baseUrl, id, WORKSPACE)) {
				ids = [id];
				directories = [WORKSPACE];
			} else {
				console.log(`Session not found in current workspace.`);
				console.log(`Enter project directory (or press Enter to skip):`);
				const dir = await ask('> ');
				if (dir) {
					let matchedDir: string | undefined;
					for (const candidate of getDirectoryVariants(dir)) {
						if (await checkSessionExists(baseUrl, id, candidate)) {
							matchedDir = candidate;
							break;
						}
					}
					if (matchedDir) {
						ids = [id];
						directories = [matchedDir];
					} else {
						console.log(`  Session ${id} not found for directory ${dir}.`);
					}
				} else {
					if (await checkSessionExists(baseUrl, id)) {
						ids = [id];
						directories = [undefined];
					} else {
						console.log(`  Session ${id} not found.`);
					}
				}
			}
		}
	}

	if (!ids.length) {
		console.log('Nothing selected.');
		killServer();
		return;
	}

	for (let i = 0; i < ids.length; i++) {
		try {
			await dumpSession(baseUrl, ids[i], directories[i]);
		} catch (e) {
			console.error(`  Failed ${ids[i]}:`, e);
		}
	}
	console.log(`\nDone. ${ids.length} session(s) dumped.`);
	killServer();
}

main().catch(e => {
	console.error(e);
	killServer();
	process.exit(1);
});
