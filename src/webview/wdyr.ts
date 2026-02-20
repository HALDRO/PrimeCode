/// <reference types="@welldone-software/why-did-you-render" />

import type { HookDifference } from '@welldone-software/why-did-you-render';
import whyDidYouRender from '@welldone-software/why-did-you-render';
import React from 'react';

// Collect WDYR events for JSON export
interface WdyrEvent {
	ts: number;
	component: string;
	reason: string;
	details: Record<string, unknown>;
}

const wdyrLog: WdyrEvent[] = [];

whyDidYouRender(React, {
	trackAllPureComponents: true,
	trackHooks: true,
	logOnDifferentValues: true,
	include: [/.*/],
	notifier(info) {
		const name = info.displayName || 'Unknown';
		const reason = info.reason?.propsDifferences
			? 'props'
			: info.reason?.stateDifferences
				? 'state'
				: info.reason?.hookDifferences
					? 'hooks'
					: 'unknown';

		const details: Record<string, unknown> = {};

		if (info.reason?.propsDifferences && Array.isArray(info.reason.propsDifferences)) {
			details.props = info.reason.propsDifferences.map((d: HookDifference) => ({
				path: d.pathString,
				prev: summarize(d.prevValue),
				next: summarize(d.nextValue),
			}));
		}
		if (info.reason?.stateDifferences && Array.isArray(info.reason.stateDifferences)) {
			details.state = info.reason.stateDifferences.map((d: HookDifference) => ({
				path: d.pathString,
				prev: summarize(d.prevValue),
				next: summarize(d.nextValue),
			}));
		}
		if (info.reason?.hookDifferences) {
			details.hooks = info.reason.hookDifferences.map(d => ({
				path: d.pathString,
				prev: summarize(d.prevValue),
				next: summarize(d.nextValue),
			}));
		}

		wdyrLog.push({ ts: Date.now(), component: name, reason, details });
	},
});

/** Safely serialize a value for JSON — deep traversal with circular ref protection */
function summarize(val: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (val === null || val === undefined) return val;
	if (typeof val === 'function') return `[fn ${val.name || 'anonymous'}]`;
	if (typeof val !== 'object') return val; // primitives pass through

	// Circular reference protection
	if (seen.has(val as object)) return '[circular]';
	seen.add(val as object);

	// Skip React internals (fibers, owners, etc.)
	if (Array.isArray(val)) {
		if (depth > 4) return `[Array(${val.length})]`;
		return val.map(item => summarize(item, depth + 1, seen));
	}

	// Depth limit for deeply nested objects
	if (depth > 4) {
		const keys = Object.keys(val as object);
		return `{Object(${keys.length} keys)}`;
	}

	try {
		const keys = Object.keys(val as object);
		// Skip React fiber/internal objects
		if (
			keys.some(k => k.startsWith('__reactFiber') || k.startsWith('__reactProps') || k === '_owner')
		) {
			return '[ReactInternal]';
		}
		const out: Record<string, unknown> = {};
		for (const k of keys) {
			out[k] = summarize((val as Record<string, unknown>)[k], depth + 1, seen);
		}
		return out;
	} catch {
		return '[unserializable]';
	}
}

// Expose wdyrDump on window for console usage
Object.assign(window, {
	/** Download analyzed WDYR report as JSON */
	wdyrDump() {
		const report = analyzeLog(wdyrLog);
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `wdyr-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
		a.click();
		URL.revokeObjectURL(url);
		console.log(`[wdyr] ${wdyrLog.length} events → ${report.components.length} components`);
		wdyrLog.length = 0;
	},
});

console.log('[wdyr] initialized ✅ — wdyrDump() to download report');

/* ── Analysis engine (runs in browser, no separate script needed) ── */

interface FieldReport {
	field: string;
	count: number;
	wasteful: number;
	samples: { prev: string; next: string }[];
}

interface ComponentReport {
	name: string;
	total: number;
	wasteful: number;
	wastePercent: number;
	reasons: { props: number; state: number; hooks: number; unknown: number };
	fields: FieldReport[];
}

interface AnalysisReport {
	generatedAt: string;
	totalEvents: number;
	timeSpanSec: number;
	components: ComponentReport[];
}

function analyzeLog(log: WdyrEvent[]): AnalysisReport {
	const map = new Map<
		string,
		{
			total: number;
			wasteful: number;
			reasons: { props: number; state: number; hooks: number; unknown: number };
			fields: Map<
				string,
				{ count: number; wasteful: number; samples: { prev: string; next: string }[] }
			>;
		}
	>();

	for (const e of log) {
		let ca = map.get(e.component);
		if (!ca) {
			ca = {
				total: 0,
				wasteful: 0,
				reasons: { props: 0, state: 0, hooks: 0, unknown: 0 },
				fields: new Map(),
			};
			map.set(e.component, ca);
		}
		ca.total++;
		ca.reasons[e.reason as keyof typeof ca.reasons]++;

		const allDiffs: { path: string; prev: unknown; next: unknown }[] = [
			...((e.details.props as { path: string; prev: unknown; next: unknown }[]) || []),
			...((e.details.state as { path: string; prev: unknown; next: unknown }[]) || []),
			...((e.details.hooks as { path: string; prev: unknown; next: unknown }[]) || []),
		];

		let allSameValue = allDiffs.length > 0;
		for (const d of allDiffs) {
			const same = jsonEqual(d.prev, d.next);
			if (!same) allSameValue = false;

			const changedFields = extractChangedFields(d);
			for (const cf of changedFields) {
				let fd = ca.fields.get(cf.field);
				if (!fd) {
					fd = { count: 0, wasteful: 0, samples: [] };
					ca.fields.set(cf.field, fd);
				}
				fd.count++;
				if (same) fd.wasteful++;
				if (fd.samples.length < 2) {
					fd.samples.push({ prev: compactStr(cf.prev), next: compactStr(cf.next) });
				}
			}
		}
		if (allSameValue && allDiffs.length > 0) ca.wasteful++;
	}

	const components: ComponentReport[] = [...map.entries()]
		.sort((a, b) => b[1].total - a[1].total)
		.map(([name, ca]) => ({
			name,
			total: ca.total,
			wasteful: ca.wasteful,
			wastePercent: ca.total > 0 ? Math.round((ca.wasteful / ca.total) * 100) : 0,
			reasons: ca.reasons,
			fields: [...ca.fields.entries()]
				.sort((a, b) => b[1].count - a[1].count)
				.slice(0, 10)
				.map(([field, fd]) => ({ field, ...fd })),
		}));

	return {
		generatedAt: new Date().toISOString(),
		totalEvents: log.length,
		timeSpanSec: log.length > 1 ? +((log[log.length - 1].ts - log[0].ts) / 1000).toFixed(1) : 0,
		components,
	};
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

interface ChangedField {
	field: string;
	prev: unknown;
	next: unknown;
}

function extractChangedFields(d: { path: string; prev: unknown; next: unknown }): ChangedField[] {
	if (d.path && d.path !== '') return [{ field: d.path, prev: d.prev, next: d.next }];
	if (
		d.prev &&
		typeof d.prev === 'object' &&
		!Array.isArray(d.prev) &&
		d.next &&
		typeof d.next === 'object' &&
		!Array.isArray(d.next)
	) {
		const prevObj = d.prev as Record<string, unknown>;
		const nextObj = d.next as Record<string, unknown>;
		const allKeys = new Set([...Object.keys(prevObj), ...Object.keys(nextObj)]);
		const fields: ChangedField[] = [];
		for (const k of allKeys) {
			if (JSON.stringify(prevObj[k]) !== JSON.stringify(nextObj[k])) {
				fields.push({ field: `.${k}`, prev: prevObj[k], next: nextObj[k] });
			}
		}
		return fields.length > 0
			? fields
			: [{ field: '(root) [same values, new ref]', prev: d.prev, next: d.next }];
	}
	return [{ field: '(root)', prev: d.prev, next: d.next }];
}

function compactStr(val: unknown, maxLen = 120): string {
	if (val === null || val === undefined) return String(val);
	if (typeof val === 'string') {
		if (
			val.startsWith('[fn ') ||
			val.startsWith('[Array(') ||
			val.startsWith('{Object(') ||
			val.startsWith('[React') ||
			val.startsWith('[circular')
		)
			return val;
		return val.length > maxLen ? `"${val.slice(0, maxLen)}..."` : `"${val}"`;
	}
	if (typeof val === 'number' || typeof val === 'boolean') return String(val);
	if (Array.isArray(val)) {
		if (val.length === 0) return '[]';
		if (val.length <= 3) return `[${val.map(v => compactStr(v, 40)).join(', ')}]`;
		return `[Array(${val.length})]`;
	}
	if (typeof val === 'object') {
		const keys = Object.keys(val as object);
		if (keys.length === 0) return '{}';
		if (keys.length <= 4) {
			const s = `{${keys.map(k => `${k}:${compactStr((val as Record<string, unknown>)[k], 30)}`).join(', ')}}`;
			return s.length > maxLen ? `{${keys.join(', ')}}` : s;
		}
		return `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', ...' : ''}}`;
	}
	return String(val);
}
