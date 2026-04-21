/**
 * @file Tests for groupMessagesIntoSections utility
 * @description Verifies section grouping, revert-point dimming, and hidden message filtering.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock groupToolMessages to be a passthrough — we only test section logic here
vi.mock('../components/chat/SimpleTool', () => ({
	groupToolMessages: (msgs: unknown[]) => msgs,
}));

import type { ChangedFile, RenderNode } from '../store';
import { groupMessagesIntoSections } from './groupSections';

type Message = RenderNode;

// --- Helpers ---

const userMsg = (id: string, content = 'hello'): RenderNode =>
	({
		kind: 'user',
		message: undefined as never,
		type: 'user',
		id,
		timestamp: new Date().toISOString(),
		content,
	}) as RenderNode;

const assistantMsg = (id: string, content = 'reply'): RenderNode =>
	({
		kind: 'assistant',
		type: 'assistant',
		id,
		partId: id,
		timestamp: new Date().toISOString(),
		content,
	}) as RenderNode;

const hiddenMsg = (id: string): RenderNode =>
	({
		kind: 'assistant',
		type: 'assistant',
		id,
		partId: id,
		timestamp: new Date().toISOString(),
		content: 'hidden',
		hidden: true,
	}) as RenderNode;

const toolUseMsg = (id: string): RenderNode =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName: 'test',
		toolUseId: `tu-${id}`,
		toolInput: '{}',
		rawInput: {},
	}) as RenderNode;

const taskCardMsg = (id: string, description = 'nested task'): RenderNode =>
	({
		kind: 'task_card',
		id,
		toolCallId: id,
		parentSessionId: 'root',
		timestamp: new Date().toISOString(),
		agent: 'general',
		prompt: 'do nested work',
		description,
		status: 'completed',
		childSummary: {
			description,
			childCount: 0,
			diffStats: { added: 0, removed: 0 },
		},
	}) as RenderNode;

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

		it('should preserve non-user messages before the first user message', () => {
			const msgs = [assistantMsg('a0'), userMsg('u1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].userMessage.id).toBe('u1');
			// a0 is prepended as an orphan response, a1 is the normal response
			expect(result[0].responses).toHaveLength(2);
		});

		it('keeps nested task-card responses inside the owning user section', () => {
			const msgs = [userMsg('u1'), taskCardMsg('s1'), taskCardMsg('s2')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result).toHaveLength(1);
			expect(result[0].responses).toHaveLength(2);
			expect((result[0].responses[0] as Message).kind).toBe('task_card');
			expect((result[0].responses[1] as Message).kind).toBe('task_card');
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

	describe('SectionStats', () => {
		it('should set isFirst/isLast correctly for single section', () => {
			const msgs = [userMsg('u1'), assistantMsg('a1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.isFirst).toBe(true);
			expect(result[0].stats.isLast).toBe(true);
			expect(result[0].stats.nextUserMessageTs).toBeNull();
		});

		it('should set isFirst/isLast correctly for multiple sections', () => {
			const msgs = [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
			];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.isFirst).toBe(true);
			expect(result[0].stats.isLast).toBe(false);
			expect(result[1].stats.isFirst).toBe(false);
			expect(result[1].stats.isLast).toBe(false);
			expect(result[2].stats.isFirst).toBe(false);
			expect(result[2].stats.isLast).toBe(true);
		});

		it('should compute nextUserMessageTs between sections', () => {
			const t1 = '2024-01-01T00:00:00.000Z';
			const t2 = '2024-01-01T00:01:00.000Z';
			const t3 = '2024-01-01T00:02:00.000Z';
			const msgs = [
				{ kind: 'user', type: 'user', id: 'u1', timestamp: t1, content: 'hi' } as Message,
				{
					kind: 'assistant',
					type: 'assistant',
					id: 'a1',
					partId: 'a1',
					timestamp: t1,
					content: 'reply',
				} as Message,
				{ kind: 'user', type: 'user', id: 'u2', timestamp: t2, content: 'hi2' } as Message,
				{
					kind: 'assistant',
					type: 'assistant',
					id: 'a2',
					partId: 'a2',
					timestamp: t2,
					content: 'reply2',
				} as Message,
				{ kind: 'user', type: 'user', id: 'u3', timestamp: t3, content: 'hi3' } as Message,
			];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.nextUserMessageTs).toBe(new Date(t2).getTime());
			expect(result[1].stats.nextUserMessageTs).toBe(new Date(t3).getTime());
			expect(result[2].stats.nextUserMessageTs).toBeNull();
		});

		it('should compute lastResponseTs from assistant messages', () => {
			const tUser = '2024-01-01T00:00:00.000Z';
			const tAsst1 = '2024-01-01T00:00:05.000Z';
			const tAsst2 = '2024-01-01T00:00:10.000Z';
			const msgs = [
				{ kind: 'user', type: 'user', id: 'u1', timestamp: tUser, content: 'hi' } as Message,
				{
					kind: 'assistant',
					type: 'assistant',
					id: 'a1',
					partId: 'a1',
					timestamp: tAsst1,
					content: 'r1',
				} as Message,
				{
					kind: 'assistant',
					type: 'assistant',
					id: 'a2',
					partId: 'a2',
					timestamp: tAsst2,
					content: 'r2',
				} as Message,
			];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.lastResponseTs).toBe(new Date(tAsst2).getTime());
		});

		it('should return null lastResponseTs when no responses exist', () => {
			const msgs = [userMsg('u1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.lastResponseTs).toBeNull();
		});

		it('should compute fileChanges from changedFiles matching toolUseIds', () => {
			const msgs = [
				userMsg('u1'),
				{
					kind: 'tool_use',
					type: 'tool_use',
					id: 't1',
					timestamp: new Date().toISOString(),
					toolName: 'write',
					toolUseId: 'tu-1',
					toolInput: '{}',
					rawInput: {},
				} as Message,
				{
					kind: 'tool_use',
					type: 'tool_use',
					id: 't2',
					timestamp: new Date().toISOString(),
					toolName: 'write',
					toolUseId: 'tu-2',
					toolInput: '{}',
					rawInput: {},
				} as Message,
				assistantMsg('a1'),
			];
			const changedFiles: ChangedFile[] = [
				{
					toolUseId: 'tu-1',
					filePath: '/a.ts',
					fileName: 'a.ts',
					linesAdded: 10,
					linesRemoved: 2,
					timestamp: 0,
				},
				{
					toolUseId: 'tu-2',
					filePath: '/b.ts',
					fileName: 'b.ts',
					linesAdded: 5,
					linesRemoved: 0,
					timestamp: 0,
				},
				{
					toolUseId: 'tu-other',
					filePath: '/c.ts',
					fileName: 'c.ts',
					linesAdded: 100,
					linesRemoved: 50,
					timestamp: 0,
				},
			];
			const result = groupMessagesIntoSections(msgs, [], null, changedFiles);

			expect(result[0].stats.fileChanges).toEqual({ added: 15, removed: 2, files: 2 });
		});

		it('should return null fileChanges when no tool_use messages match', () => {
			const msgs = [userMsg('u1'), assistantMsg('a1')];
			const changedFiles: ChangedFile[] = [
				{
					toolUseId: 'tu-other',
					filePath: '/c.ts',
					fileName: 'c.ts',
					linesAdded: 100,
					linesRemoved: 50,
					timestamp: 0,
				},
			];
			const result = groupMessagesIntoSections(msgs, [], null, changedFiles);

			expect(result[0].stats.fileChanges).toBeNull();
		});

		it('should use real turnTokens for tokenCount', () => {
			const msgs = [
				userMsg('u1'),
				{
					kind: 'assistant',
					type: 'assistant',
					id: 'a1',
					partId: 'a1',
					timestamp: new Date().toISOString(),
					content: 'reply',
				} as Message,
			];
			const turnTokens = {
				u1: { input: 50, output: 50, total: 100, usage: 25, cacheRead: 0 },
			};
			const result = groupMessagesIntoSections(msgs, [], null, [], turnTokens);

			expect(result[0].stats.tokenCount).toBe(25);
		});

		it('should return null tokenCount when no content to estimate', () => {
			const msgs = [userMsg('u1')];
			const result = groupMessagesIntoSections(msgs, [], null);

			expect(result[0].stats.tokenCount).toBeNull();
		});
	});
});
