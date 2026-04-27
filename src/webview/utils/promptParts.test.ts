import type { Part } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import { extractPromptFromParts } from './promptParts';

describe('extractPromptFromParts', () => {
	it('extracts the richest non-synthetic text part', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: 'hi' } as Part,
			{ id: 't0', type: 'text', text: 'synthetic long text', synthetic: true } as Part,
			{ id: 't2', type: 'text', text: 'hello world' } as Part,
		]);

		expect(result.text).toBe('hello world');
	});

	it('extracts file, snippet, and image attachments', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: 'fix this' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts',
				filename: 'app.ts',
			} as Part,
			{
				id: 'f2',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts?start=10&end=20',
				filename: 'app.ts',
			} as Part,
			{
				id: 'img1',
				type: 'file',
				url: 'data:image/png;base64,abc',
				filename: 'shot.png',
			} as Part,
		]);

		expect(result.text).toBe(
			'@[C:\\repo\\src\\app.ts] @[C:\\repo\\src\\app.ts]#L10-L20\n\nfix this',
		);
		expect(result.files).toEqual(['C:\\repo\\src\\app.ts']);
		expect(result.codeSnippets).toEqual([
			{ filePath: 'C:\\repo\\src\\app.ts', startLine: 10, endLine: 20, content: '' },
		]);
		expect(result.images).toEqual([
			{ id: 'img1', name: 'shot.png', dataUrl: 'data:image/png;base64,abc' },
		]);
	});

	it('uses canonical inline text from file source metadata when available', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: '@[src/app.ts]#L2-L4\n\ninspect this' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts?start=2&end=4',
				filename: 'app.ts',
				source: {
					path: 'src/app.ts',
					text: { value: '@[src/app.ts]#L2-L4', start: 0, end: 20 },
				},
			} as Part,
		]);

		expect(result.text).toBe('@[src/app.ts]#L2-L4\n\ninspect this');
		expect(result.codeSnippets).toEqual([
			{ filePath: 'src/app.ts', startLine: 2, endLine: 4, content: '@[src/app.ts]#L2-L4' },
		]);
	});

	it('does not duplicate inline refs when optimistic text already contains source-backed refs', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: '@[src/app.ts]\n\nplease review this' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts',
				filename: 'app.ts',
				source: {
					path: 'src/app.ts',
					text: { value: '@[src/app.ts]', start: 0, end: 12 },
				},
			} as Part,
		]);

		expect(result.text).toBe('@[src/app.ts]\n\nplease review this');
		expect(result.files).toEqual(['src/app.ts']);
	});

	it('prepends only missing inline refs when text already has partial source-backed refs', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: '@[src/app.ts]\n\nplease review this' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts',
				filename: 'app.ts',
				source: {
					path: 'src/app.ts',
					text: { value: '@[src/app.ts]', start: 0, end: 12 },
				},
			} as Part,
			{
				id: 'f2',
				type: 'file',
				url: 'file:///C:/repo/src/extra.ts',
				filename: 'extra.ts',
			} as Part,
		]);

		expect(result.text).toBe('@[C:\\repo\\src\\extra.ts]\n\n@[src/app.ts]\n\nplease review this');
		expect(result.files).toEqual(['src/app.ts', 'C:\\repo\\src\\extra.ts']);
	});

	it('restores inline references for send/restore roundtrip', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: 'please review this' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts',
				filename: 'app.ts',
			} as Part,
			{
				id: 'f2',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts?start=5&end=8',
				filename: 'app.ts',
			} as Part,
		]);

		expect(result.text).toBe(
			'@[C:\\repo\\src\\app.ts] @[C:\\repo\\src\\app.ts]#L5-L8\n\nplease review this',
		);
		expect(result.files).toEqual(['C:\\repo\\src\\app.ts']);
		expect(result.codeSnippets).toEqual([
			{ filePath: 'C:\\repo\\src\\app.ts', startLine: 5, endLine: 8, content: '' },
		]);
	});
});
