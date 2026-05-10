/**
 * @file Dumps OpenCode sessions to docs/debug.
 * @description Discovers a running OpenCode server, collects sessions, and exports
 * session payloads/messages/children as JSON snapshots for debugging workflows.
 * "Download from last 10 sessions" aggregates sessions across all known workspaces
 * using the `/project` worktree list, then sorts globally by recency.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

function getBaseUrl(): string {
	const port = process.env.OPENCODE_PORT ?? '4096';
	return `http://127.0.0.1:${port}`;
}

/**
 * Check if a real OpenCode server is running at the given URL.
 */
async function isOpenCodeServer(baseUrl: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		const res = await fetch(`${baseUrl}/global/health`, {
			method: 'GET',
			signal: controller.signal,
		});
		clearTimeout(timeout);
		if (!res.ok) return false;
		const data = (await res.json()) as { healthy?: boolean };
		return data.healthy === true;
	} catch {
		return false;
	}
}

/**
 * Discover listen ports of running `opencode` processes.
 * Uses OS-specific commands (tasklist + netstat on Windows, ss/lsof on Unix).
 */
async function discoverOpenCodePorts(): Promise<number[]> {
	const isWindows = process.platform === 'win32';

	if (isWindows) {
		// Step 1: find PIDs of opencode.exe processes
		let tasklistOut: string;
		try {
			const result = await execFileAsync(
				'tasklist',
				['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV', '/NH'],
				{ timeout: 5000 },
			);
			tasklistOut = result.stdout;
		} catch {
			return [];
		}

		const pids = new Set<string>();
		for (const line of tasklistOut.split('\n')) {
			const match = line.match(/"opencode\.exe","(\d+)"/i);
			if (match) pids.add(match[1]);
		}
		if (pids.size === 0) return [];

		// Step 2: find which ports those PIDs are listening on
		let netstatOut: string;
		try {
			const result = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 5000 });
			netstatOut = result.stdout;
		} catch {
			return [];
		}

		const ports: number[] = [];
		for (const line of netstatOut.split('\n')) {
			if (!line.includes('LISTENING')) continue;
			const parts = line.trim().split(/\s+/);
			const pid = parts[parts.length - 1];
			if (!pids.has(pid)) continue;
			const addrPort = parts[1];
			const portStr = addrPort?.split(':').pop();
			if (portStr) {
				const port = Number.parseInt(portStr, 10);
				if (port > 0) ports.push(port);
			}
		}
		return ports;
	}

	// Linux / macOS: use `ss` or `lsof`
	try {
		const { stdout } = await execFileAsync('ss', ['-tlnp'], { timeout: 5000 });
		const ports: number[] = [];
		for (const line of stdout.split('\n')) {
			if (!line.includes('opencode')) continue;
			const match = line.match(/:(\d+)\s/);
			if (match) ports.push(Number.parseInt(match[1], 10));
		}
		if (ports.length > 0) return ports;
	} catch {}

	try {
		const { stdout } = await execFileAsync('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n'], {
			timeout: 5000,
		});
		const ports: number[] = [];
		for (const line of stdout.split('\n')) {
			if (!line.includes('opencode')) continue;
			const match = line.match(/:(\d+)\s/);
			if (match) ports.push(Number.parseInt(match[1], 10));
		}
		return ports;
	} catch {}

	return [];
}

/**
 * Find a working OpenCode server URL.
 * 1. Try canonical port first (4096 or OPENCODE_PORT env).
 * 2. Discover opencode processes and health-check each port.
 * 3. Return first working URL or null.
 */
async function findWorkingServer(): Promise<string | null> {
	// Fast path: canonical port
	const canonicalUrl = getBaseUrl();
	if (await isOpenCodeServer(canonicalUrl)) {
		return canonicalUrl;
	}

	// Slow path: discover processes
	const ports = await discoverOpenCodePorts();
	for (const port of ports) {
		const url = `http://127.0.0.1:${port}`;
		if (await isOpenCodeServer(url)) {
			return url;
		}
	}

	return null;
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

async function safeApi<T>(base: string, ep: string, directory?: string, fallback?: T): Promise<T> {
	try {
		return await api<T>(base, ep, directory);
	} catch {
		if (fallback !== undefined) return fallback;
		throw new Error(`Failed to fetch ${ep}`);
	}
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

async function dumpSession(base: string, id: string, directory?: string) {
	console.log(`\nDumping ${id}...`);
	const [session, statusMap, pathInfo, vcsInfo, permissions, questions] = await Promise.all([
		api<Record<string, unknown>>(base, `/session/${id}`, directory),
		safeApi<SessionStatusMap>(base, '/session/status', directory, {}),
		safeApi<PathInfo>(base, '/path', directory, {}),
		safeApi<VcsInfo>(base, '/vcs', directory, {}),
		safeApi<PermissionRequest[]>(base, '/permission', directory, []),
		safeApi<QuestionRequest[]>(base, '/question', directory, []),
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

	const dump = {
		root: rootNode,
		session,
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
			formatVersion: 2,
		},
	};

	fs.mkdirSync(DEBUG_DIR, { recursive: true });
	const out = path.join(DEBUG_DIR, `${id}.json`);
	fs.writeFileSync(out, JSON.stringify(dump, null, 2), 'utf-8');
	console.log(`  Saved: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

async function main() {
	console.log('Searching for OpenCode server...');
	const base = await findWorkingServer();
	if (!base) {
		console.error('No working OpenCode server found.');
		console.log('\nHint: start OpenCode TUI first: opencode');
		process.exit(1);
	}
	console.log(`Server: ${base}\n`);

	console.log('  [1] Download from last 10 sessions');
	console.log('  [2] Enter session ID manually\n');
	const choice = await ask('> ');

	let ids: string[] = [];
	let directories: (string | undefined)[] = [];

	if (choice === '1') {
		const sessions = (await getSessionsAcrossWorkspaces(base, GLOBAL_WORKSPACE_SAMPLE_LIMIT)).slice(
			0,
			DEFAULT_DUMP_SESSIONS_LIMIT,
		);
		if (!sessions.length) {
			console.log('No sessions.');
			return;
		}

		// Подтягиваем первое сообщение пользователя для превью, если тайтл бесполезный
		const previews = await Promise.all(
			sessions.map(async s => {
				const title = s.title ?? '';
				if (title && !title.startsWith('New session')) return title;
				try {
					const msgs = await api<OpenCodeMessage[]>(
					base,
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
			// Сначала пробуем текущий workspace
			if (await checkSessionExists(base, id, WORKSPACE)) {
				ids = [id];
				directories = [WORKSPACE];
			} else {
				// Спрашиваем путь к проекту
				console.log(`Session not found in current workspace.`);
				console.log(`Enter project directory (or press Enter to skip):`);
				const dir = await ask('> ');
				if (dir) {
					let matchedDir: string | undefined;
					for (const candidate of getDirectoryVariants(dir)) {
						if (await checkSessionExists(base, id, candidate)) {
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
					// Пробуем без directory
					if (await checkSessionExists(base, id)) {
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
		return;
	}

	const targetServer = base;
	for (let i = 0; i < ids.length; i++) {
		try {
			await dumpSession(targetServer, ids[i], directories[i]);
		} catch (e) {
			console.error(`  Failed ${ids[i]}:`, e);
		}
	}
	console.log(`\nDone. ${ids.length} session(s) dumped.`);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
