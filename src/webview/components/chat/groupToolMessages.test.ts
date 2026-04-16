/**
 * @file Tests for groupToolMessages — tool grouping with look-ahead logic
 * @description Verifies that consecutive simple tools are grouped, intermediate
 * assistant/thinking messages are absorbed when followed by more tools, and
 * hard boundaries (heavy tools, end of stream) correctly break groups.
 */

import { describe, expect, it } from 'vitest';

import type { RenderMessage } from '../../store';

type Message = RenderMessage;

import { groupToolMessages, precomputeCollapseFlags } from './toolGrouping';

// --- Helpers ---

const toolUse = (id: string, toolName = 'read'): RenderMessage =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
		toolInput: '{}',
		rawInput: {},
	}) as RenderMessage;

const toolResult = (id: string, toolUseId: string, toolName = 'read'): RenderMessage =>
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
	}) as RenderMessage;

const assistant = (id: string, content = 'Let me continue...'): RenderMessage =>
	({
		kind: 'assistant',
		type: 'assistant',
		id,
		timestamp: new Date().toISOString(),
		content,
		partId: id,
	}) as RenderMessage;

const thinking = (id: string, content = 'Thinking...'): RenderMessage =>
	({
		kind: 'thinking',
		type: 'thinking',
		id,
		timestamp: new Date().toISOString(),
		content,
		partId: id,
	}) as RenderMessage;

const heavyTool = (id: string, toolName = 'bash'): RenderMessage =>
	({
		kind: 'tool_use',
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
		toolInput: '{}',
		rawInput: {},
	}) as RenderMessage;

const subtask = (id: string): RenderMessage =>
	({
		kind: 'subtask',
		type: 'subtask',
		id,
		timestamp: new Date().toISOString(),
		agent: 'subagent',
		prompt: 'Analyze the codebase',
		description: 'Find and analyze components',
		status: 'running',
		message: undefined as never,
	}) as unknown as RenderMessage;

const NO_MCP: string[] = [];

// --- Tests ---

describe('groupToolMessages', () => {
	describe('basic grouping (unchanged behavior)', () => {
		it('should return empty array for no messages', () => {
			expect(groupToolMessages([], NO_MCP)).toEqual([]);
		});

		it('should not group fewer than 3 tool_use messages', () => {
			const msgs = [toolUse('1'), toolResult('1r', 'tu-1'), toolUse('2'), toolResult('2r', 'tu-2')];
			const result = groupToolMessages(msgs, NO_MCP);
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
			const result = groupToolMessages(msgs, NO_MCP);
			// First item should be a grouped array, last is the assistant
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6); // 3 tool_use + 3 tool_result
			expect((result[1] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
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
			const result = groupToolMessages(msgs, NO_MCP);
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Bridge absorption: short assistant is absorbed, creating one group of 7 (4 tools + 2 results + 1 assistant bridge) + trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			// Group contains all 3 tool_use + 3 tool_result + 1 absorbed assistant
			expect((result[0] as Message[]).length).toBe(7);
			expect((result[1] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Bridge absorption: thinking is absorbed, single group of 9 (4 tools + 4 results + 1 thinking) + trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(9);
			expect((result[1] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Bridge absorption: short assistant absorbed, one merged group of 13 + trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(13);
			expect((result[1] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Group of 3 tools, then assistant, then heavy tool
			expect(result).toHaveLength(3);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Group of 3 tools, then the trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[1] as Message).type).toBe('assistant');
		});
	});

	describe('edge cases', () => {
		it('should handle assistant-only messages (no tools at all)', () => {
			const msgs = [assistant('a1'), assistant('a2')];
			const result = groupToolMessages(msgs, NO_MCP);
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Assistant first (no prior group to absorb into), then trailing tools grouped
			expect((result[0] as Message).type).toBe('assistant');
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
			const result = groupToolMessages(msgs, NO_MCP);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should absorb short assistant bridging single tool to more tools into one group', () => {
			// Bridge absorption: short assistant between 1 tool and 2 more tools
			// Total 3 tool_use → meets threshold, absorbed into single group
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
			const result = groupToolMessages(msgs, NO_MCP);
			// Bridge absorption merges all into one group of 7 + trailing assistant
			expect(result).toHaveLength(2);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(7);
			expect((result[1] as Message).type).toBe('assistant');
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
			// Bridge absorption: short assistant absorbed, 3 tool_use meets threshold,
			// streaming allows trailing group → single group of 7
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
			expect((result[1] as Message).type).toBe('assistant');
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
			expect((result[1] as Message).type).toBe('assistant');
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
			expect((streaming[1] as Message).type).toBe('assistant');

			// Non-streaming: same result
			const final = groupToolMessages(msgs, NO_MCP, false);
			expect(final).toHaveLength(2);
			expect(Array.isArray(final[0])).toBe(true);
			expect((final[0] as Message[]).length).toBe(6);
			expect((final[1] as Message).type).toBe('assistant');
		});

		it('should keep mid-group assistant but strip trailing assistant', () => {
			// Assistant between two tool sequences stays in the group.
			// Trailing assistant at the end is stripped out.
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
			expect((streaming[0] as Message[]).length).toBe(9); // tools + mid-group assistant
			expect((streaming[1] as Message).type).toBe('assistant'); // "Done." standalone

			// Non-streaming: same result
			const final = groupToolMessages(msgs, NO_MCP, false);
			expect(final).toHaveLength(2);
			expect((final[0] as Message[]).length).toBe(9);
			expect((final[1] as Message).type).toBe('assistant');
		});

		it('should keep group stable when more tools arrive after absorbed assistant during streaming', () => {
			// Simulates render cycle 2: tools arrive after the previously-absorbed assistant.
			// The group should stay as one unit (no break-then-reassemble).
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
			// All absorbed into one group of 9
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
				subtask('s1'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP);
			expect(Array.isArray(grouped[0])).toBe(true);

			const flags = precomputeCollapseFlags(grouped);
			expect(flags[0]).toBe(true);
		});

		it('should not split group when non-groupable tool_result lands between groupable tool_use messages (streaming order)', () => {
			// During live streaming, parallel tools from one CLI step arrive as:
			// all tool_use first (pending/running), then tool_result (completed).
			// A tool_result from a non-groupable tool (e.g. bash) can land between
			// groupable tool_use messages — it must NOT split the group.
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
				// Next step: more groupable tools
				toolUse('g1', 'grep'),
				toolResult('g1-res', 'tu-g1', 'grep'),
				toolUse('g2', 'grep'),
				toolResult('g2-res', 'tu-g2', 'grep'),
				toolUse('r5'),
				toolResult('r5-res', 'tu-r5'),
			];

			const grouped = groupToolMessages(msgs, NO_MCP);

			// bash tool_use is non-groupable → standalone
			expect(grouped[0]).toBe(msgs[0]);

			// All remaining tools (read x4 + bash tool_result + read results + grep x2 + read)
			// should be in ONE group, not split into two
			const groups = grouped.filter(item => Array.isArray(item));
			expect(groups).toHaveLength(1);

			// The single group should contain 8 unique tool executions: the late bash
			// completion is still present in the group, but crucially it no longer
			// splits the lightweight tool batch into two groups.
			const toolUseCount = new Set(
				(groups[0] as Message[])
					.filter(m => m.type === 'tool_use')
					.map(m => (m as Extract<Message, { type: 'tool_use' }>).toolUseId),
			).size;
			expect(toolUseCount).toBe(8);
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
			expect(Array.isArray(grouped[0])).toBe(true);

			const flags = precomputeCollapseFlags(grouped);
			expect(flags[0]).toBe(false);
		});
	});
});
