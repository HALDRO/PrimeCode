import { describe, expect, it } from 'vitest';
import { sanitizeToolPartForUi } from './toolPayloadGuard';

describe('sanitizeToolPartForUi', () => {
	it('clears heavy read output for history ui', () => {
		const part = {
			id: 'tool-read',
			type: 'tool',
			tool: 'read',
			callID: 'call-read',
			state: {
				status: 'completed',
				output: '<path>/tmp/a.ts</path>\n<content>very large file body</content>',
			},
		};

		const result = sanitizeToolPartForUi(part);
		expect(result.state.output).toBe('');
	});

	it('compacts grep output for history ui', () => {
		const part = {
			id: 'tool-grep',
			type: 'tool',
			tool: 'grep',
			callID: 'call-grep',
			state: {
				status: 'completed',
				output:
					'Found 2 matches\n/tmp/a.ts:\n  Line 10: foo\n  Line 11: bar\n/tmp/b.ts:\n  Line 22: baz',
			},
		};

		const result = sanitizeToolPartForUi(part);
		expect(result.state.output).toContain('Found 2 matches');
		expect(result.state.output).toContain('/tmp/a.ts');
		expect(result.state.output).toContain('/tmp/a.ts:10');
		expect(result.state.output).toContain('/tmp/a.ts:11');
		expect(result.state.output).toContain('/tmp/b.ts:22');
	});

	it('trims oversized apply_patch diff payloads while preserving structure', () => {
		const huge = 'x'.repeat(40_000);
		const part = {
			id: 'tool-1',
			type: 'tool',
			tool: 'apply_patch',
			callID: 'call-1',
			state: {
				status: 'completed',
				metadata: {
					diff: huge,
					files: [
						{
							filePath: 'C:\\repo\\src\\app.ts',
							relativePath: 'src/app.ts',
							type: 'update',
							patch: huge,
							additions: 1,
							deletions: 1,
						},
					],
					diagnostics: {},
				},
			},
		};

		const result = sanitizeToolPartForUi(part);
		const metadata = result.state.metadata as {
			truncated?: boolean;
			diff?: string;
			files?: Array<{
				patch?: string;
				relativePath?: string;
				additions?: number;
				deletions?: number;
			}>;
		};

		expect(metadata.truncated).toBe(true);
		expect(metadata.diff).toBeUndefined();
		expect(metadata.files?.[0]?.patch?.length).toBeLessThan(10_500);
		expect(metadata.files?.[0]?.patch).toContain('[primecode truncated patch:');
		expect(metadata.files?.[0]?.patch).toContain('chars]');
		expect(metadata.files?.[0]?.relativePath).toBe('src/app.ts');
		expect(metadata.files?.[0]?.additions).toBe(1);
		expect(metadata.files?.[0]?.deletions).toBe(1);
	});

	it('drops binary apply_patch patch bodies', () => {
		const part = {
			id: 'tool-bin',
			type: 'tool',
			tool: 'apply_patch',
			callID: 'call-bin',
			state: {
				status: 'completed',
				metadata: {
					diff: 'Index: C:\\repo\\bin\\app.exe\n@@ -1,2 +0,0 @@\n-\u0000MZ\u0001\u0002',
					files: [
						{
							filePath: 'C:\\repo\\bin\\app.exe',
							relativePath: 'bin/app.exe',
							type: 'delete',
							patch: 'Index: C:\\repo\\bin\\app.exe\n@@ -1,2 +0,0 @@\n-\u0000MZ\u0001\u0002',
						},
					],
				},
			},
		};

		const result = sanitizeToolPartForUi(part);
		const metadata = result.state.metadata as {
			diff?: string;
			truncated?: boolean;
			files?: Array<{ patch?: string; binary?: boolean }>;
		};

		expect(metadata.diff).toBeUndefined();
		expect(metadata.truncated).toBe(true);
		expect(metadata.files?.[0]?.patch).toBeUndefined();
		expect(metadata.files?.[0]?.binary).toBe(true);
	});
});
