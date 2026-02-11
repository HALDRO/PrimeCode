/**
 * @file Tests for groupMessagesIntoSections utility
 * @description Verifies section grouping, revert-point dimming, and hidden message filtering.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock groupToolMessages to be a passthrough — we only test section logic here
vi.mock('../components/chat/SimpleTool', () => ({
	groupToolMessages: (msgs: unknown[]) => msgs,
}));

import type { Message } from '../store';
import { groupMessagesIntoSections } from './groupSections';

// --- Helpers ---

const userMsg = (id: string, content = 'hello'): Message =>
	({ type: 'user', id, timestamp: new Date().toISOString(), content }) as Message;

const assistantMsg = (id: string, content = 'reply'): Message =>
	({ type: 'assistant', id, timestamp: new Date().toISOString(), content }) as Message;

const hiddenMsg = (id: string): Message =>
	({
		type: 'assistant',
		id,
		timestamp: new Date().toISOString(),
		content: 'hidden',
		hidden: true,
	}) as Message;

const toolUseMsg = (id: string): Message =>
	({
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName: 'test',
		toolUseId: `tu-${id}`,
		hidden: false,
	}) as Message;

// --- Tests ---

describe('groupMessagesIntoSections', () => {
	describe('basic grouping', () => {
		it('should return empty array for no messages', () => {
			const result = groupMessagesIntoSections([], [], null);
			expect(result).toEqual([]);
		});

		it('should create one section for a single user message', () => {
			const msgs = [userMsg('u1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].userMessage.id).toBe('u1');
			expect(result[0].responses).toEqual([]);
			expect(result[0].sectionIndex).toBe(0);
			expect(result[0].isReverted).toBe(false);
		});

		it('should group assistant messages under the preceding user message', () => {
			const msgs = [userMsg('u1'), assistantMsg('a1'), assistantMsg('a2')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].responses).toHaveLength(2);
		});

		it('should create multiple sections for multiple user messages', () => {
			const msgs = [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
			];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(3);
			expect(result[0].userMessage.id).toBe('u1');
			expect(result[0].responses).toHaveLength(1);
			expect(result[1].userMessage.id).toBe('u2');
			expect(result[1].responses).toHaveLength(1);
			expect(result[2].userMessage.id).toBe('u3');
			expect(result[2].responses).toHaveLength(0);
		});

		it('should assign sequential sectionIndex values', () => {
			const msgs = [userMsg('u1'), userMsg('u2'), userMsg('u3')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result.map(s => s.sectionIndex)).toEqual([0, 1, 2]);
		});

		it('should ignore non-user messages before the first user message', () => {
			const msgs = [assistantMsg('a0'), userMsg('u1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].userMessage.id).toBe('u1');
			expect(result[0].responses).toHaveLength(1);
		});
	});

	describe('hidden message filtering', () => {
		it('should exclude hidden messages from sections', () => {
			const msgs = [userMsg('u1'), hiddenMsg('h1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].responses).toHaveLength(1);
			expect((result[0].responses[0] as Message).id).toBe('a1');
		});

		it('should handle all responses being hidden', () => {
			const msgs = [userMsg('u1'), hiddenMsg('h1'), hiddenMsg('h2')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].responses).toHaveLength(0);
		});
	});

	describe('revert point logic', () => {
		it('should not mark any sections as reverted when revertedFromMessageId is null', () => {
			const msgs = [userMsg('u1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result.every(s => s.isReverted === false)).toBe(true);
			expect(result.every(s => s.isRevertPoint === false)).toBe(true);
		});

		it('should handle non-existent revert point ID gracefully', () => {
			const msgs = [userMsg('u1'), userMsg('u2')];
			const result = groupMessagesIntoSections(msgs, [], 'non-existent');

			expect(result.every(s => s.isReverted === false)).toBe(true);
			expect(result.every(s => s.isRevertPoint === false)).toBe(true);
		});

		// =====================================================================
		// BUG REPRODUCTION TESTS — these reflect EXPECTED user behavior
		// The revert point section AND all sections after it should be dimmed.
		// "Restore" means "go back to the state BEFORE this message" — so the
		// message itself and everything after it should be visually reverted.
		// =====================================================================

		it('BUG: restore on last (3rd) message should dim that section', () => {
			// User has 3 messages, clicks Restore on the 3rd.
			// Expected: section u3 is dimmed (reverted).
			// Current bug: nothing is dimmed because revert point is the last section.
			const msgs = [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
				assistantMsg('a3'),
			];
			const result = groupMessagesIntoSections(msgs, [], 'u3');

			expect(result).toHaveLength(3);
			expect(result[0].isReverted).toBe(false);
			expect(result[1].isReverted).toBe(false);
			expect(result[2].isReverted).toBe(true);
			expect(result[2].isRevertPoint).toBe(true);
			expect(result[0].isRevertPoint).toBe(false);
			expect(result[1].isRevertPoint).toBe(false);
		});

		it('BUG: restore on 2nd of 3 messages should dim 2nd and 3rd sections', () => {
			// User has 3 messages, clicks Restore on the 2nd.
			// Expected: sections u2 and u3 are both dimmed.
			// Current bug: only u3 is dimmed, u2 (the revert point) is NOT dimmed.
			const msgs = [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
				assistantMsg('a3'),
			];
			const result = groupMessagesIntoSections(msgs, [], 'u2');

			expect(result).toHaveLength(3);
			expect(result[0].isReverted).toBe(false); // before revert point
			expect(result[1].isReverted).toBe(true); // revert point — SHOULD be dimmed
			expect(result[2].isReverted).toBe(true); // after revert point
		});

		it('BUG: restore on 1st of 3 messages should dim all sections', () => {
			// User clicks Restore on the very first message.
			// Expected: ALL sections are dimmed (entire conversation reverted).
			// Current bug: u1 is NOT dimmed, only u2 and u3 are.
			const msgs = [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
				assistantMsg('a3'),
			];
			const result = groupMessagesIntoSections(msgs, [], 'u1');

			expect(result).toHaveLength(3);
			expect(result[0].isReverted).toBe(true);
			expect(result[1].isReverted).toBe(true);
			expect(result[2].isReverted).toBe(true);
			expect(result[0].isRevertPoint).toBe(true);
			expect(result[1].isRevertPoint).toBe(false);
			expect(result[2].isRevertPoint).toBe(false);
		});

		it('BUG: restore on only section should dim it', () => {
			// Single message conversation, user clicks Restore.
			// Expected: the only section is dimmed.
			// Current bug: nothing is dimmed.
			const msgs = [userMsg('u1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], 'u1');

			expect(result).toHaveLength(1);
			expect(result[0].isReverted).toBe(true);
			expect(result[0].isRevertPoint).toBe(true);
		});

		it('BUG: restore on 2nd of 2 messages should dim only 2nd', () => {
			// Two messages, restore on the 2nd.
			// Expected: u2 is dimmed, u1 is not.
			// Current bug: nothing is dimmed (u2 is last section).
			const msgs = [userMsg('u1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')];
			const result = groupMessagesIntoSections(msgs, [], 'u2');

			expect(result).toHaveLength(2);
			expect(result[0].isReverted).toBe(false);
			expect(result[1].isReverted).toBe(true);
			expect(result[1].isRevertPoint).toBe(true);
			expect(result[0].isRevertPoint).toBe(false);
		});

		it('restore on 1st of 4 messages should dim all 4 sections', () => {
			const msgs = [userMsg('u1'), userMsg('u2'), userMsg('u3'), userMsg('u4')];
			const result = groupMessagesIntoSections(msgs, [], 'u1');

			expect(result[0].isReverted).toBe(true);
			expect(result[1].isReverted).toBe(true);
			expect(result[2].isReverted).toBe(true);
			expect(result[3].isReverted).toBe(true);
		});

		it('restore on 3rd of 4 messages should dim 3rd and 4th only', () => {
			const msgs = [userMsg('u1'), userMsg('u2'), userMsg('u3'), userMsg('u4')];
			const result = groupMessagesIntoSections(msgs, [], 'u3');

			expect(result[0].isReverted).toBe(false);
			expect(result[1].isReverted).toBe(false);
			expect(result[2].isReverted).toBe(true);
			expect(result[3].isReverted).toBe(true);
		});
	});

	describe('mixed message types', () => {
		it('should handle tool_use messages as responses', () => {
			const msgs = [userMsg('u1'), toolUseMsg('t1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].responses).toHaveLength(2);
		});
	});
});
