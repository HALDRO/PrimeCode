import type { ToolPart } from '@opencode-ai/sdk/v2/client';
import { describe, expect, it } from 'vitest';
import { extractOwnedFilePaths, extractOwnedFilePathsFromToolState } from '../fileOwnership';

function makeToolPart(
	tool: string,
	input: Record<string, unknown>,
	metadata?: Record<string, unknown>,
): ToolPart {
	return {
		id: `${tool}-part`,
		messageID: 'message-1',
		sessionID: 'session-1',
		type: 'tool',
		tool,
		callID: `${tool}-call`,
		state: { status: 'completed', input, output: 'done' },
		metadata,
	} as ToolPart;
}

describe('extractOwnedFilePaths', () => {
	it('extracts write paths from explicit file inputs', () => {
		expect(extractOwnedFilePaths(makeToolPart('write', { path: 'src/a.ts' }))).toEqual([
			'src/a.ts',
		]);
	});

	it('extracts edit paths from canonical aliases', () => {
		expect(extractOwnedFilePaths(makeToolPart('edit_file', { filePath: 'src/b.ts' }))).toEqual([
			'src/b.ts',
		]);
	});

	it('extracts apply_patch paths from patch text headers', () => {
		expect(
			extractOwnedFilePaths(
				makeToolPart('apply_patch', {
					patchText: ['*** Begin Patch', '*** Update File: src/c.ts', '*** End Patch'].join('\n'),
				}),
			),
		).toEqual(['src/c.ts']);
	});

	it('extracts apply_patch paths from metadata fallbacks', () => {
		expect(
			extractOwnedFilePaths(makeToolPart('apply_patch', {}, { files: [{ filePath: 'src/d.ts' }] })),
		).toEqual(['src/d.ts']);
	});

	it('returns no owned files for non-mutating tools', () => {
		expect(extractOwnedFilePaths(makeToolPart('bash', { command: 'echo hi' }))).toEqual([]);
	});

	it('normalizes leading dot and path separators', () => {
		expect(extractOwnedFilePaths(makeToolPart('write', { path: '.\\src\\norm.ts' }))).toEqual([
			'src/norm.ts',
		]);
	});

	it('extracts ownership from raw tool state without a ToolPart wrapper', () => {
		expect(
			extractOwnedFilePathsFromToolState('edit', {
				path: '.\\src\\turn-owned.ts',
				old_string: 'a',
				new_string: 'b',
			}),
		).toEqual(['src/turn-owned.ts']);
	});
});
