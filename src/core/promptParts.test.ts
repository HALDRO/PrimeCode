import { describe, expect, it } from 'vitest';
import { buildOptimisticPromptParts, buildPromptParts } from './promptParts';

describe('buildPromptParts', () => {
	it('builds text and file parts with source metadata', () => {
		const parts = buildPromptParts({
			text: '@[src/app.ts] please inspect',
			attachments: { files: ['src/app.ts'] },
		});

		expect(parts[0]).toEqual({
			type: 'text',
			text: '@[src/app.ts] please inspect',
		});
		expect(parts[1]).toMatchObject({
			type: 'file',
			mime: 'text/plain',
			url: 'file://src/app.ts',
			filename: 'app.ts',
			source: {
				type: 'file',
				text: { value: '@[src/app.ts]', start: 0, end: 13 },
				path: 'src/app.ts',
			},
		});
	});

	it('builds snippet file parts with line query and source metadata', () => {
		const parts = buildPromptParts({
			text: '@[src/api.ts]#L10-L20 fix this',
			attachments: {
				codeSnippets: [{ filePath: 'src/api.ts', startLine: 10, endLine: 20, content: '' }],
			},
		});

		expect(parts[0]).toEqual({
			type: 'text',
			text: '@[src/api.ts]#L10-L20 fix this',
		});
		expect(parts[1]).toMatchObject({
			type: 'file',
			mime: 'text/plain',
			url: 'file://src/api.ts?start=10&end=20',
			filename: 'api.ts',
			source: {
				type: 'file',
				text: { value: '@[src/api.ts]#L10-L20', start: 0, end: 21 },
				path: 'src/api.ts',
			},
		});
	});

	it('builds optimistic parts with session and message ids', () => {
		const parts = buildOptimisticPromptParts({
			text: '@[src/app.ts] review',
			attachments: { files: ['src/app.ts'] },
			sessionId: 'ses1',
			messageId: 'msg1',
		});

		expect(parts[0]).toMatchObject({
			id: 'msg1-text',
			messageID: 'msg1',
			sessionID: 'ses1',
			type: 'text',
			text: '@[src/app.ts] review',
		});
		expect(parts[1]).toMatchObject({
			id: 'msg1-file-0',
			messageID: 'msg1',
			sessionID: 'ses1',
			type: 'file',
			source: {
				text: { value: '@[src/app.ts]', start: 0, end: 13 },
			},
		});
	});

	it('still adds semantic file parts when text has no inline reference', () => {
		const parts = buildPromptParts({
			text: 'please inspect',
			attachments: { files: ['src/app.ts'] },
		});

		expect(parts[0]).toEqual({ type: 'text', text: 'please inspect' });
		expect(parts[1]).toMatchObject({
			type: 'file',
			url: 'file://src/app.ts',
			filename: 'app.ts',
		});
		expect(parts[1]).not.toHaveProperty('source');
	});

	it('deduplicates files, snippets, and images before creating parts', () => {
		const parts = buildPromptParts({
			text: '@[src/app.ts] @[src/api.ts]#L10-L20 check screenshot',
			attachments: {
				files: ['src/app.ts', 'src/app.ts'],
				codeSnippets: [
					{ filePath: 'src/api.ts', startLine: 10, endLine: 20, content: '' },
					{ filePath: 'src/api.ts', startLine: 10, endLine: 20, content: '' },
				],
				images: [
					{ id: 'img-1', name: 'shot.png', dataUrl: 'data:image/png;base64,AAA' },
					{ id: 'img-2', name: 'shot-copy.png', dataUrl: 'data:image/png;base64,AAA' },
				],
			},
		});

		expect(parts.filter(part => part.type === 'file')).toHaveLength(3);
		expect(
			parts.filter(part => part.type === 'file' && part.url === 'file://src/app.ts'),
		).toHaveLength(1);
		expect(
			parts.filter(
				part => part.type === 'file' && part.url === 'file://src/api.ts?start=10&end=20',
			),
		).toHaveLength(1);
		expect(
			parts.filter(part => part.type === 'file' && part.url === 'data:image/png;base64,AAA'),
		).toHaveLength(1);
	});

	it('preserves real image mime types from data urls', () => {
		const parts = buildPromptParts({
			text: 'inspect image',
			attachments: {
				images: [{ id: 'img-1', name: 'shot.webp', dataUrl: 'data:image/webp;base64,AAA' }],
			},
		});

		expect(parts[1]).toMatchObject({
			type: 'file',
			mime: 'image/webp',
			url: 'data:image/webp;base64,AAA',
		});
	});

	it('skips malformed attachment paths instead of producing invalid file urls', () => {
		const parts = buildPromptParts({
			text: 'keep the message body',
			attachments: {
				files: ['^)'],
				codeSnippets: [{ filePath: '^)', startLine: 1, endLine: 1, content: '' }],
			},
		});

		expect(parts).toEqual([{ type: 'text', text: 'keep the message body' }]);
	});

	it('preserves large plain text without truncation', () => {
		const text = 'large prompt '.repeat(20_000);
		const parts = buildPromptParts({ text });

		expect(parts).toEqual([{ type: 'text', text }]);
	});
});
