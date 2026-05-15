import { describe, expect, it } from 'vitest';
import { extractPatchFilePaths, getToolDisplayName } from './toolRegistry';

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

describe('getToolDisplayName fallback normalization', () => {
	it('normalizes snake_case unknown tool names', () => {
		expect(getToolDisplayName('custom_tool_name')).toBe('Custom Tool Name');
	});

	it('normalizes kebab-case unknown tool names', () => {
		expect(getToolDisplayName('custom-tool-name')).toBe('Custom Tool Name');
	});

	it('normalizes camelCase unknown tool names', () => {
		expect(getToolDisplayName('customToolName')).toBe('Custom Tool Name');
	});

	it('normalizes PascalCase unknown tool names', () => {
		expect(getToolDisplayName('CustomToolName')).toBe('Custom Tool Name');
	});

	it('normalizes mixed underscore and casing for unknown tool names', () => {
		expect(getToolDisplayName('Lsp_diagnostics')).toBe('Lsp Diagnostics');
	});

	it('preserves canonical registry names for known tools', () => {
		expect(getToolDisplayName('bash')).toBe('Bash');
		expect(getToolDisplayName('apply_patch')).toBe('Apply Patch');
		expect(getToolDisplayName('lsp')).toBe('LSP');
	});
});
