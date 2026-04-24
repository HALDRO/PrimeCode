import type { Part } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import { extractPromptFromParts } from './promptParts';

describe('extractPromptFromParts', () => {
	it('extracts the richest text part', () => {
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

		expect(result.text).toBe('fix this');
		expect(result.files).toEqual(['C:\\repo\\src\\app.ts']);
		expect(result.codeSnippets).toEqual([
			{ filePath: 'C:\\repo\\src\\app.ts', startLine: 10, endLine: 20, content: '' },
		]);
		expect(result.images).toEqual([
			{ id: 'img1', name: 'shot.png', dataUrl: 'data:image/png;base64,abc' },
		]);
	});

	it('uses file source metadata when available', () => {
		const result = extractPromptFromParts([
			{ id: 't1', type: 'text', text: 'inspect @src/app.ts' } as Part,
			{
				id: 'f1',
				type: 'file',
				url: 'file:///C:/repo/src/app.ts?start=2&end=4',
				filename: 'app.ts',
				source: {
					path: 'src/app.ts',
					text: { value: '@src/app.ts', start: 8, end: 19 },
				},
			} as Part,
		]);

		expect(result.codeSnippets).toEqual([
			{ filePath: 'src/app.ts', startLine: 2, endLine: 4, content: '@src/app.ts' },
		]);
	});
});
