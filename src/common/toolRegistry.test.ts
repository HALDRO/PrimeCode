import { describe, expect, it } from 'vitest';
import { extractPatchFilePaths } from './toolRegistry';

describe('extractPatchFilePaths', () => {
	it('extracts file paths from legacy apply_patch headers', () => {
		const paths = extractPatchFilePaths({
			patchText: ['*** Begin Patch', '*** src/foo.ts', '@@', '-old', '+new', '*** End Patch'].join(
				'\n',
			),
		});

		expect(paths).toEqual(['src/foo.ts']);
	});

	it('extracts file paths from structured apply_patch headers', () => {
		const paths = extractPatchFilePaths({
			patchText: [
				'*** Begin Patch',
				'*** Update File: src/foo.ts',
				'@@',
				'-old',
				'+new',
				'*** End Patch',
			].join('\n'),
		});

		expect(paths).toEqual(['src/foo.ts']);
	});
});
