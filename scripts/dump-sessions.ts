/**
 * Дамп сессий OpenCode в docs/debug/
 * Запуск: bun run scripts/dump-sessions.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const WORKSPACE =
	process.platform === 'win32' && /^[A-Z]:/.test(process.cwd())
		? process.cwd()[0].toLowerCase() + process.cwd().slice(1)
		: process.cwd();
const DEBUG_DIR = path.join(WORKSPACE, 'docs', 'debug');

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

async function dumpSession(base: string, id: string, directory?: string) {
	console.log(`\nDumping ${id}...`);
	const [session, messages, children] = await Promise.all([
		api<any>(base, `/session/${id}`, directory),
		api<any[]>(base, `/session/${id}/message`, directory),
		api<any[]>(base, `/session/${id}/children`, directory),
	]);
	console.log(
		`  ${messages.length} msgs, ${children.length} children — ${session.title ?? '(no title)'}`,
	);

	const childData: Array<{ session: any; messages: any[] }> = [];
	for (const c of children) {
		const msgs = await api<any[]>(base, `/session/${c.id}/message`, directory);
		console.log(`  child ${c.id}: ${msgs.length} msgs — ${c.title}`);
		childData.push({ session: c, messages: msgs });
	}

	const dump = {
		session,
		messages,
		children: childData,
		_meta: {
			dumpedAt: new Date().toISOString(),
			serverUrl: base,
			sessionId: id,
			directory: WORKSPACE,
			childCount: children.length,
			totalMessages: messages.length,
		},
	};

	fs.mkdirSync(DEBUG_DIR, { recursive: true });
	const out = path.join(DEBUG_DIR, `${id}.json`);
	fs.writeFileSync(out, JSON.stringify(dump, null, 2), 'utf-8');
	console.log(`  Saved: ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}

async function main() {
	const base = getBaseUrl();
	if (
		!(await fetch(`${base}/path`)
			.then(r => r.ok)
			.catch(() => false))
	) {
		console.error('Server not responding.');
		process.exit(1);
	}
	console.log(`Server: ${base}\n`);

	console.log('  [1] Download from last 10 sessions');
	console.log('  [2] Enter session ID manually\n');
	const choice = await ask('> ');

	let ids: string[] = [];
	let directory: string | undefined = WORKSPACE;

	if (choice === '1') {
		const sessions = await api<any[]>(base, '/session?roots=true&limit=10', WORKSPACE);
		sessions.sort(
			(a: any, b: any) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
		);
		if (!sessions.length) {
			console.log('No sessions.');
			return;
		}

		// Подтягиваем первое сообщение пользователя для превью, если тайтл бесполезный
		const previews = await Promise.all(
			sessions.map(async (s: any) => {
				const title = s.title ?? '';
				if (title && !title.startsWith('New session')) return title;
				try {
					const msgs = await api<any[]>(base, `/session/${s.id}/message`, WORKSPACE);
					const first = msgs.find((m: any) => m.role === 'user');
					if (first?.content) {
						const text =
							typeof first.content === 'string'
								? first.content
								: Array.isArray(first.content)
									? first.content
											.filter((p: any) => p.type === 'text')
											.map((p: any) => p.text)
											.join(' ')
									: '';
						if (text)
							return text.replace(/\s+/g, ' ').slice(0, 80) + (text.length > 80 ? '...' : '');
					}
				} catch {}
				return title || '(no title)';
			}),
		);

		console.log('');
		for (let i = 0; i < sessions.length; i++) {
			const s = sessions[i];
			const d = new Date(s.time.updated ?? s.time.created).toLocaleString('ru-RU', {
				day: '2-digit',
				month: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			});
			console.log(`  [${i + 1}] ${d}  ${previews[i]}`);
		}
		console.log(`\nPick numbers (comma-separated) or "all":`);
		const pick = await ask('> ');

		if (pick.toLowerCase() === 'all') {
			ids = sessions.map((s: any) => s.id);
		} else {
			ids = pick
				.split(',')
				.map(n => Number.parseInt(n.trim(), 10) - 1)
				.filter(i => i >= 0 && i < sessions.length)
				.map(i => sessions[i].id);
		}
	} else if (choice === '2') {
		console.log('Enter session ID (ses_...):');
		const id = await ask('> ');
		if (id.startsWith('ses_')) {
			// Сначала пробуем текущий workspace
			if (await checkSessionExists(base, id, WORKSPACE)) {
				directory = WORKSPACE;
				ids = [id];
			} else {
				// Спрашиваем путь к проекту
				console.log(`Session not found in current workspace.`);
				console.log(`Enter project directory (or press Enter to skip):`);
				const dir = await ask('> ');
				if (dir) {
					const normalizedDir =
						process.platform === 'win32' && /^[A-Z]:/.test(dir)
							? dir[0].toLowerCase() + dir.slice(1)
							: dir;
					if (await checkSessionExists(base, id, normalizedDir)) {
						directory = normalizedDir;
						ids = [id];
					} else {
						console.log(`  Session ${id} not found for directory ${dir}.`);
					}
				} else {
					// Пробуем без directory
					directory = undefined;
					if (await checkSessionExists(base, id)) {
						ids = [id];
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
	for (const id of ids) {
		try {
			await dumpSession(targetServer, id, directory);
		} catch (e) {
			console.error(`  Failed ${id}:`, e);
		}
	}
	console.log(`\nDone. ${ids.length} session(s) dumped.`);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
