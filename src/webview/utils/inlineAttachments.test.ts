import { describe, expect, it } from 'vitest';
import {
	extractInlineAttachmentMatches,
	extractInlineAttachmentPayload,
	formatInlineFileReference,
	formatInlineSnippetReference,
	prependInlineAttachmentReferences,
} from '../../common/inlineAttachments';

describe('inlineAttachments', () => {
	it('extracts file and snippet inline matches', () => {
		const text = 'Check @[src/app.ts] and @[src/api.ts]#L10-L20 now';
		const matches = extractInlineAttachmentMatches(text);

		expect(matches).toEqual([
			{
				raw: '@[src/app.ts]',
				start: 6,
				end: 19,
				path: 'src/app.ts',
				displayPath: 'src/app.ts',
				isDirectory: false,
				startLine: undefined,
				endLine: undefined,
				kind: 'file',
			},
			{
				raw: '@[src/api.ts]#L10-L20',
				start: 24,
				end: 45,
				path: 'src/api.ts',
				displayPath: 'src/api.ts',
				isDirectory: false,
				startLine: 10,
				endLine: 20,
				kind: 'snippet',
			},
		]);
	});

	it('builds attachment payload from inline references', () => {
		const text = '@[src/app.ts] @[src/api.ts]#L2-L4\n\nPlease inspect both';
		const payload = extractInlineAttachmentPayload(text);

		expect(payload.files).toEqual(['src/app.ts']);
		expect(payload.codeSnippets).toEqual([
			{ filePath: 'src/api.ts', startLine: 2, endLine: 4, content: '' },
		]);
	});

	it('deduplicates repeated inline file and snippet references', () => {
		const text = '@[src/app.ts] @[src/app.ts] @[src/api.ts]#L2-L4 @[src/api.ts]#L2-L4';
		const payload = extractInlineAttachmentPayload(text);

		expect(payload.files).toEqual(['src/app.ts']);
		expect(payload.codeSnippets).toEqual([
			{ filePath: 'src/api.ts', startLine: 2, endLine: 4, content: '' },
		]);
	});

	it('treats non-positive line references as file references consistently', () => {
		const text = '@[src/app.ts]#L0 @[src/valid.ts]#L1';
		const matches = extractInlineAttachmentMatches(text);
		const payload = extractInlineAttachmentPayload(text);

		expect(matches[0]).toMatchObject({ kind: 'file', startLine: undefined, endLine: undefined });
		expect(matches[1]).toMatchObject({ kind: 'snippet', startLine: 1, endLine: 1 });
		expect(payload.files).toEqual(['src/app.ts']);
		expect(payload.codeSnippets).toEqual([
			{ filePath: 'src/valid.ts', startLine: 1, endLine: 1, content: '' },
		]);
	});

	it('prepends inline references for restore roundtrip', () => {
		const restored = prependInlineAttachmentReferences(
			'Please inspect both',
			['src/app.ts'],
			[{ filePath: 'src/api.ts', startLine: 2, endLine: 4 }],
		);

		expect(restored).toBe('@[src/app.ts] @[src/api.ts]#L2-L4\n\nPlease inspect both');
		expect(formatInlineFileReference('src/app.ts')).toBe('@[src/app.ts]');
		expect(formatInlineSnippetReference({ filePath: 'src/api.ts', startLine: 2, endLine: 4 })).toBe(
			'@[src/api.ts]#L2-L4',
		);
	});

	it('does not duplicate existing inline references when restoring', () => {
		const restored = prependInlineAttachmentReferences(
			'@[src/app.ts] @[src/api.ts]#L2-L4\n\nPlease inspect both',
			['src/app.ts'],
			[{ filePath: 'src/api.ts', startLine: 2, endLine: 4 }],
		);

		expect(restored).toBe('@[src/app.ts] @[src/api.ts]#L2-L4\n\nPlease inspect both');
	});
});
