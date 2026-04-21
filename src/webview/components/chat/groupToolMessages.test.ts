/**
 * @file Tests for groupToolMessages — tool grouping with look-ahead logic
 * @description Verifies that consecutive simple tools are grouped, intermediate
 * assistant/thinking messages are absorbed when followed by more tools, and
 * hard boundaries (heavy tools, end of stream) correctly break groups.
 */

import { describe, expect, it } from 'vitest';

import type { RenderNode } from '../../store';

type Message = RenderNode;

import {
	getGroupedItemShouldCollapse,
	groupToolMessages,
	precomputeCollapseFlags,
} from './toolGrouping';

// --- Helpers ---

const toolUse = (id: string, toolName = 'read'): RenderNode =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
		toolInput: '{}',
		rawInput: {},
	}) as RenderNode;

const toolResult = (id: string, toolUseId: string, toolName = 'read'): RenderNode =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId,
		toolInput: '{}',
		rawInput: {},
		resultContent: 'done',
		status: 'completed',
	}) as RenderNode;

const assistant = (id: string, content = 'Let me continue...'): RenderNode =>
	({
		kind: 'assistant',
		type: 'assistant',
		id,
		timestamp: new Date().toISOString(),
		content,
		partId: id,
	}) as RenderNode;

const thinking = (id: string, content = 'Thinking...'): RenderNode =>
	({
		kind: 'thinking',
		type: 'thinking',
		id,
		timestamp: new Date().toISOString(),
		content,
		partId: id,
	}) as RenderNode;

const heavyTool = (id: string, toolName = 'bash'): RenderNode =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
		toolInput: '{}',
		rawInput: {},
	}) as RenderNode;

const taskCard = (id: string): RenderNode =>
	({
		kind: 'task_card',
		id,
		timestamp: new Date().toISOString(),
		agent: 'subagent',
		prompt: 'Analyze the codebase',
		description: 'Find and analyze components',
		status: 'running',
		toolCallId: id,
		parentSessionId: 'root',
		childSummary: { childCount: 0, diffStats: { added: 0, removed: 0 } },
	}) as RenderNode;

const NO_MCP: string[] = [];

// --- Tests ---

describe('groupToolMessages', () => {
	describe('basic grouping (unchanged behavior)', () => {
		it('should return empty array for no messages', () => {
			expect(groupToolMessages([], NO_MCP, false)).toEqual([]);
		});

		it('should not group fewer than 3 tool_use messages', () => {
			const msgs = [toolUse('1'), toolResult('1r', 'tu-1'), toolUse('2'), toolResult('2r', 'tu-2')];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// All individual — no arrays
			expect(result.every(r => !Array.isArray(r))).toBe(true);
			expect(result).toHaveLength(4);
		});

		it('should group 3+ consecutive tool_use messages when followed by boundary', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Done.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// First item should be a grouped array, last is the assistant
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6); // 3 tool_use + 3 tool_result
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should group trailing tools even without boundary (e.g. subtask transcripts)', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Trailing tools are now grouped (fixes subtask transcript grouping)
			expect(result).toHaveLength(1);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
		});

		it('should not group non-groupable (heavy) tools', () => {
			const msgs = [
				heavyTool('h1', 'bash'),
				heavyTool('h2', 'edit'),
				heavyTool('h3', 'write'),
				assistant('a1'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});
	});

	describe('bridge absorption: short assistant/thinking messages are absorbed into groups', () => {
		it('should absorb short assistant between tool runs into a single group', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				assistant('a1', 'Let me read more files...'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a2', 'All done.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(7);
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should absorb thinking between tool runs into the group', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				thinking('t1'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
				assistant('a1', 'Done.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(9);
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should absorb short assistant between two tool groups into one merged group', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Reading more...'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
				toolUse('5'),
				toolResult('5r', 'tu-5'),
				toolUse('6'),
				toolResult('6r', 'tu-6'),
				assistant('a2', 'Done.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(13);
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should keep assistant before heavy tool as separate item', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Now editing...'),
				heavyTool('h1', 'edit'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Group of 3 tools, then assistant, then heavy tool
			expect(result).toHaveLength(3);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).kind).toBe('assistant');
			expect((result[2] as Message).id).toBe('h1');
		});

		it('should keep trailing assistant after tools', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'All done, no more tools.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Group of 3 tools, then the trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[1] as Message).kind).toBe('assistant');
		});
	});

	describe('edge cases', () => {
		it('should handle assistant-only messages (no tools at all)', () => {
			const msgs = [assistant('a1'), assistant('a2')];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result).toHaveLength(2);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should handle intermediate message at the very start (no prior tools)', () => {
			const msgs = [
				assistant('a1', 'Starting...'),
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Assistant first (no prior group to absorb into), then trailing tools grouped
			expect((result[0] as Message).kind).toBe('assistant');
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[1])).toBe(true);
			expect((result[1] as Message[]).length).toBe(6);
		});

		it('should not group MCP tools', () => {
			const mcpTool = (id: string): Message =>
				({
					type: 'tool_use',
					id,
					timestamp: new Date().toISOString(),
					toolName: 'mcp__server__tool',
					toolUseId: `tu-${id}`,
				}) as Message;

			const msgs = [mcpTool('m1'), mcpTool('m2'), mcpTool('m3'), assistant('a1')];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should absorb short assistant bridging single tool to more tools into one group', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				assistant('a1', 'Reading more...'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a2', 'Done.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(7);
			expect((result[1] as Message).kind).toBe('assistant');
		});
	});

	describe('streaming: trailing tool grouping', () => {
		it('should group trailing tools when isStreaming is true', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, true);
			// With streaming, trailing tools ARE grouped
			expect(result).toHaveLength(1);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
		});

		it('should group trailing tools even when isStreaming is false', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Trailing tools are grouped regardless of streaming state
			expect(result).toHaveLength(1);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
		});

		it('should NOT group trailing tools below threshold even when streaming', () => {
			const msgs = [toolUse('1'), toolResult('1r', 'tu-1'), toolUse('2'), toolResult('2r', 'tu-2')];
			const result = groupToolMessages(msgs, NO_MCP, true);
			// Only 2 tool_use — below MIN_SIMPLE_TOOL_GROUP_SIZE
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should absorb short assistant bridge when streaming and group trailing tools', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				assistant('a1', 'Reading more...'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, true);
			expect(result).toHaveLength(1);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(7);
		});

		it('should strip trailing assistant from group even when streaming', () => {
			// New algorithm: trailing bridge messages are always stripped from the group
			// on flush. During streaming, the group stays stable (no flickering) because
			// the assistant is simply emitted after the group — not treated as a hard
			// boundary that breaks the group apart.
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Let me continue...'),
			];
			const result = groupToolMessages(msgs, NO_MCP, true);
			// Group of 6 tools + standalone trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should NOT absorb trailing assistant when NOT streaming (final state)', () => {
			// When streaming is done, trailing assistant after tools must be separate
			// so it renders as visible text outside the collapsed group.
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'All done, here is the summary.'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			// Non-streaming: assistant is a hard boundary → group + standalone assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).kind).toBe('assistant');
		});

		it('should strip trailing assistant consistently in both streaming and non-streaming', () => {
			// New algorithm: trailing bridge messages are always stripped from the group.
			// No difference between streaming and non-streaming for this behavior.
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Here is the summary.'),
			];

			// Streaming: group + standalone trailing assistant
			const streaming = groupToolMessages(msgs, NO_MCP, true);
			expect(streaming).toHaveLength(2);
			expect(Array.isArray(streaming[0])).toBe(true);
			expect((streaming[0] as Message[]).length).toBe(6);
			expect((streaming[1] as Message).kind).toBe('assistant');

			// Non-streaming: same result
			const final = groupToolMessages(msgs, NO_MCP, false);
			expect(final).toHaveLength(2);
			expect(Array.isArray(final[0])).toBe(true);
			expect((final[0] as Message[]).length).toBe(6);
			expect((final[1] as Message).kind).toBe('assistant');
		});

		it('should keep mid-group assistant but strip trailing assistant', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				assistant('a1', 'Reading more...'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
				assistant('a2', 'Done.'),
			];

			// Streaming: mid-group assistant stays, trailing stripped
			const streaming = groupToolMessages(msgs, NO_MCP, true);
			expect(streaming).toHaveLength(2);
			expect(Array.isArray(streaming[0])).toBe(true);
			expect((streaming[0] as Message[]).length).toBe(9);
			expect((streaming[1] as Message).kind).toBe('assistant');

			// Non-streaming: same result
			const final = groupToolMessages(msgs, NO_MCP, false);
			expect(final).toHaveLength(2);
			expect((final[0] as Message[]).length).toBe(9);
			expect((final[1] as Message).kind).toBe('assistant');
		});

		it('should keep group stable when more tools arrive after absorbed assistant during streaming', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Let me continue...'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
			];
			const result = groupToolMessages(msgs, NO_MCP, true);
			expect(result).toHaveLength(1);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(9);
		});

		it('should still flush non-trailing groups normally when streaming', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				heavyTool('h1', 'bash'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
				toolUse('5'),
				toolResult('5r', 'tu-5'),
				toolUse('6'),
				toolResult('6r', 'tu-6'),
			];
			const result = groupToolMessages(msgs, NO_MCP, true);
			// First group flushed by boundary, trailing group flushed by streaming
			expect(result).toHaveLength(3);
			expect(Array.isArray(result[0])).toBe(true); // first group
			expect((result[1] as Message).id).toBe('h1'); // heavy tool
			expect(Array.isArray(result[2])).toBe(true); // trailing group (streaming)
		});
	});

	describe('collapse behavior', () => {
		it('should collapse a grouped tools item when followed by subtask', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				taskCard('s1'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP, false);
			const firstItem = grouped[0];
			expect(Array.isArray(grouped[0])).toBe(true);
			expect(grouped[1]).toBe(msgs[6]);
			expect(getGroupedItemShouldCollapse(firstItem)).toBe(true);

			const flags = precomputeCollapseFlags(grouped);
			expect(flags[0]).toBe(true);
		});

		it('should keep non-groupable completed tools outside SimpleToolGroup', () => {
			// Card-style tools such as bash must stay standalone even when their
			// completed update arrives between lightweight tools.
			const msgs = [
				heavyTool('bash1', 'bash'), // tool_use: bash (non-groupable)
				toolUse('r1'), // tool_use: read (groupable)
				toolUse('r2'),
				toolUse('r3'),
				toolUse('r4'),
				toolResult('bash1-res', 'tu-bash1', 'bash'), // tool_result: bash — arrives late
				toolResult('r1-res', 'tu-r1'),
				toolResult('r2-res', 'tu-r2'),
				toolResult('r3-res', 'tu-r3'),
				toolResult('r4-res', 'tu-r4'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP, false);

			// bash start stays standalone
			expect(grouped[0]).toBe(msgs[0]);
			// first lightweight batch is grouped on its own
			expect(Array.isArray(grouped[1])).toBe(true);
			expect(
				(grouped[1] as Message[]).every(
					item => item.kind !== 'tool_use' || item.toolName !== 'bash',
				),
			).toBe(true);

			// late bash completion must stay standalone, not inside the SimpleToolGroup
			expect(grouped[2]).toBe(msgs[5]);
			expect(Array.isArray(grouped[2])).toBe(false);
		});

		it('should collapse a grouped tools item when followed by a card-style tool', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				heavyTool('bash1', 'bash'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP, false);
			const firstItem = grouped[0];
			expect(Array.isArray(grouped[0])).toBe(true);
			expect((grouped[1] as Extract<Message, { kind: 'tool_use' }>).toolName).toBe('bash');
			expect(getGroupedItemShouldCollapse(firstItem)).toBe(true);

			const flags = precomputeCollapseFlags(grouped);
			expect(flags[0]).toBe(true);
		});

		it('should collapse a trailing grouped tools item after streaming completes', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP, false);
			const firstItem = grouped[0];
			expect(Array.isArray(grouped[0])).toBe(true);
			expect(getGroupedItemShouldCollapse(firstItem)).toBe(false);

			const flags = precomputeCollapseFlags(grouped);
			expect(flags[0]).toBe(false);
		});

		it('should keep a live trailing group expanded until a real boundary message appears', () => {
			const streaming = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
				assistant('a1', 'Reading more...'),
				toolUse('4'),
				toolResult('4r', 'tu-4'),
			];

			const groupedWhileStreaming = groupToolMessages(streaming, NO_MCP, true);
			const streamingFirstItem = groupedWhileStreaming[0];
			expect(groupedWhileStreaming).toHaveLength(1);
			expect(Array.isArray(groupedWhileStreaming[0])).toBe(true);
			expect(getGroupedItemShouldCollapse(streamingFirstItem)).toBe(false);

			const withBoundary = [...streaming, heavyTool('bash1', 'bash')];
			const groupedAfterBoundary = groupToolMessages(withBoundary, NO_MCP, true);
			const boundaryFirstItem = groupedAfterBoundary[0];
			expect(Array.isArray(groupedAfterBoundary[0])).toBe(true);
			expect((groupedAfterBoundary[1] as Extract<Message, { kind: 'tool_use' }>).toolName).toBe(
				'bash',
			);
			expect(getGroupedItemShouldCollapse(boundaryFirstItem)).toBe(true);
		});
	});
});
