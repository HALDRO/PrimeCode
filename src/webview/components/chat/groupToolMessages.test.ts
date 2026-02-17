/**
 * @file Tests for groupToolMessages — tool grouping with look-ahead logic
 * @description Verifies that consecutive simple tools are grouped, intermediate
 * assistant/thinking messages are absorbed when followed by more tools, and
 * hard boundaries (heavy tools, end of stream) correctly break groups.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock UI dependencies that access DOM at module level
vi.mock('../ui', () => ({
	CollapseOverlay: () => null,
	Badge: () => null,
	PathChip: () => null,
}));

vi.mock('../../utils/markdown', () => ({
	Markdown: () => null,
}));

vi.mock('../../utils/vscode', () => ({
	useVSCode: () => ({ postMessage: vi.fn() }),
}));

import type { Message } from '../../store/chatStore';
import { groupToolMessages } from './SimpleTool';

// --- Helpers ---

const toolUse = (id: string, toolName = 'read'): Message =>
	({
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
	}) as Message;

const toolResult = (id: string, toolUseId: string, toolName = 'read'): Message =>
	({
		type: 'tool_result',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId,
	}) as Message;

const assistant = (id: string, content = 'Let me continue...'): Message =>
	({
		type: 'assistant',
		id,
		timestamp: new Date().toISOString(),
		content,
	}) as Message;

const thinking = (id: string, content = 'Thinking...'): Message =>
	({
		type: 'thinking',
		id,
		timestamp: new Date().toISOString(),
		content,
	}) as Message;

const heavyTool = (id: string, toolName = 'bash'): Message =>
	({
		type: 'tool_use',
		id,
		timestamp: new Date().toISOString(),
		toolName,
		toolUseId: `tu-${id}`,
	}) as Message;

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

		it('should NOT group trailing tools (no boundary after them)', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP);
			// All individual — trailing, no boundary
			expect(result.every(r => !Array.isArray(r))).toBe(true);
			expect(result).toHaveLength(6);
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

	describe('intermediate messages are NOT absorbed (no content loss)', () => {
		it('should keep assistant message between tool runs as separate item', () => {
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
			// First 2 tools (below threshold) + assistant + 1 tool (below threshold) + assistant
			// No grouping because each run is below threshold
			expect(result).toHaveLength(8);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should keep thinking message between tool runs as separate item', () => {
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
			// Group of 3 tools (6 msgs), then thinking, then tool_use + tool_result (below threshold), then assistant
			expect(result).toHaveLength(5);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).type).toBe('thinking');
			expect((result[2] as Message).type).toBe('tool_use');
			expect((result[3] as Message).type).toBe('tool_result');
			expect((result[4] as Message).type).toBe('assistant');
		});

		it('should create separate groups when split by intermediate text', () => {
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
			// Group1 (3 tools), assistant, Group2 (3 tools), assistant
			expect(result).toHaveLength(4);
			expect(Array.isArray(result[0])).toBe(true);
			expect((result[0] as Message[]).length).toBe(6);
			expect((result[1] as Message).type).toBe('assistant');
			expect(Array.isArray(result[2])).toBe(true);
			expect((result[2] as Message[]).length).toBe(6);
			expect((result[3] as Message).type).toBe('assistant');
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
			// Assistant first (no prior group to absorb into), then trailing tools (not grouped)
			expect((result[0] as Message).type).toBe('assistant');
			// Trailing tools are not grouped (no boundary after)
			expect(result).toHaveLength(7);
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

		it('should handle single tool with intermediate then more tools (no absorption)', () => {
			// Intermediate message breaks the group — two separate runs
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
			// tool_use + tool_result (individual) + assistant + tool_use + tool_result + tool_use + tool_result (individual) + assistant
			expect(result).toHaveLength(8);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
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

		it('should NOT group trailing tools when isStreaming is false (default)', () => {
			const msgs = [
				toolUse('1'),
				toolResult('1r', 'tu-1'),
				toolUse('2'),
				toolResult('2r', 'tu-2'),
				toolUse('3'),
				toolResult('3r', 'tu-3'),
			];
			const result = groupToolMessages(msgs, NO_MCP, false);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
			expect(result).toHaveLength(6);
		});

		it('should NOT group trailing tools below threshold even when streaming', () => {
			const msgs = [toolUse('1'), toolResult('1r', 'tu-1'), toolUse('2'), toolResult('2r', 'tu-2')];
			const result = groupToolMessages(msgs, NO_MCP, true);
			// Only 2 tool_use — below MIN_SIMPLE_TOOL_GROUP_SIZE
			expect(result.every(r => !Array.isArray(r))).toBe(true);
		});

		it('should NOT absorb intermediate messages when streaming (no content loss)', () => {
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
			// Intermediate message breaks the group — no absorption even during streaming
			// First 2 tools (below threshold) + assistant + trailing 1 tool (below threshold)
			expect(result).toHaveLength(7);
			expect(result.every(r => !Array.isArray(r))).toBe(true);
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
});
