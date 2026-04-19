import { describe, expect, it } from 'vitest';
import { getMessageHighlights, parseMessageSegments } from './messageParser';

const validCommands = new Set(['compact', 'summarize']);
const validSubagents = new Set(['reviewer']);

describe('messageParser', () => {
	it('highlights standalone slash commands', () => {
		const highlights = getMessageHighlights(
			'Please run /compact now',
			validCommands,
			validSubagents,
		);
		expect(highlights).toEqual([{ start: 11, end: 19, content: '/compact', type: 'command' }]);
	});

	it('does not highlight slash commands inside punctuation wrappers', () => {
		const texts = ['`/compact`', '(/compact)', '[/compact]', '{/compact}', 'text:/compact'];
		for (const text of texts) {
			const highlights = getMessageHighlights(text, validCommands, validSubagents);
			expect(highlights).toEqual([]);
		}
	});

	it('does not highlight commands when they are embedded in larger tokens', () => {
		const texts = ['abc/compact', '/compact,', '/compact.', '/compact)', 'foo@reviewer'];
		for (const text of texts) {
			const highlights = getMessageHighlights(text, validCommands, validSubagents);
			expect(highlights).toEqual([]);
		}
	});

	it('highlights standalone subagents with the same boundary rules', () => {
		const highlights = getMessageHighlights('Ask @reviewer please', validCommands, validSubagents);
		expect(highlights).toEqual([{ start: 4, end: 13, content: '@reviewer', type: 'subagent' }]);
	});

	it('parseMessageSegments preserves plain text around invalid command-like tokens', () => {
		const segments = parseMessageSegments(
			'Use (`/compact`) but run /compact',
			validCommands,
			validSubagents,
		);
		expect(segments).toEqual([
			{ start: 0, end: 25, content: 'Use (`/compact`) but run ', type: 'text' },
			{ start: 25, end: 33, content: '/compact', type: 'command' },
		]);
	});
});
