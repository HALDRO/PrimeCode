/**
 * Дамп сессий OpenCode в docs/debug/
 * Запуск: bun run scripts/dump-sessions.ts
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

const WORKSPACE = process.cwd();
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
	const hash = crypto.createHash('md5').update(WORKSPACE).digest('hex');
	const portFile = path.join(os.tmpdir(), `primecode-opencode-port-${hash}.txt`);
	if (!fs.existsSync(portFile)) {
		console.error(`Port file not found: ${portFile}\nIs PrimeCode running?`);
		process.exit(1);
	}
	return `http://127.0.0.1:${fs.readFileSync(portFile, 'utf-8').trim()}`;
}

async function api<T>(base: string, ep: string): Promise<T> {
	const sep = ep.includes('?') ? '&' : '?';
	const res = await fetch(`${base}${ep}${sep}directory=${encodeURIComponent(WORKSPACE)}`);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${ep}`);
	return res.json() as Promise<T>;
}

async function dumpSession(base: string, id: string) {
	console.log(`\nDumping ${id}...`);
	const [session, messages, children] = await Promise.all([
		api<any>(base, `/session/${id}`),
		api<any[]>(base, `/session/${id}/message`),
		api<any[]>(base, `/session/${id}/children`),
	]);
	console.log(
		`  ${messages.length} msgs, ${children.length} children — ${session.title ?? '(no title)'}`,
	);

	const childData: Array<{ session: any; messages: any[] }> = [];
	for (const c of children) {
		const msgs = await api<any[]>(base, `/session/${c.id}/message`);
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

	if (choice === '1') {
		const sessions = await api<any[]>(base, '/session?roots=true&limit=10');
		sessions.sort(
			(a: any, b: any) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created),
		);
		if (!sessions.length) {
			console.log('No sessions.');
			return;
		}

		console.log('');
		for (let i = 0; i < sessions.length; i++) {
			const s = sessions[i];
			const d = new Date(s.time.updated ?? s.time.created).toLocaleString('ru-RU', {
				day: '2-digit',
				month: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			});
			console.log(`  [${i + 1}] ${s.id}  ${d}  ${s.title ?? '(no title)'}`);
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
		if (id.startsWith('ses_')) ids = [id];
	}

	if (!ids.length) {
		console.log('Nothing selected.');
		return;
	}

	for (const id of ids) {
		try {
			await dumpSession(base, id);
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
