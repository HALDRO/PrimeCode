/**
 * @file SubtaskManager tests
 * @description Tests deterministic subtask lifecycle behavior.
 */

import { describe, expect, it } from 'vitest';
import { SessionGraph } from '../SessionManager';
import { SubtaskManager } from '../SubtaskManager';

const createManager = () => {
	const graph = new SessionGraph();
	const manager = new SubtaskManager(graph);
	return { manager, graph };
};

describe('SubtaskManager', () => {
	describe('registerSubtask', () => {
		it('tracks a pending subtask when child session is not known yet', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			expect(manager.isPending('tool-1')).toBe(true);
			expect(manager.getParentSession('tool-1')).toBe('parent-session-1');
		});

		it('links immediately when child session is known', () => {
			const { manager, graph } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1', 'child-session-1');

			expect(manager.isPending('tool-1')).toBe(false);
			expect(manager.getChildSessionId('tool-1')).toBe('child-session-1');
			expect(graph.getParent('child-session-1')).toBe('parent-session-1');
		});
	});

	describe('linkChildSession', () => {
		it('links a known child to a registered tool call', () => {
			const { manager, graph } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			const linked = manager.linkChildSession('child-session-1', 'tool-1');

			expect(linked).toBe(true);
			expect(manager.getChildSessionId('tool-1')).toBe('child-session-1');
			expect(manager.getToolUseId('child-session-1')).toBe('tool-1');
			expect(graph.getParent('child-session-1')).toBe('parent-session-1');
		});

		it('rejects relinking the same child to a different tool', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.registerSubtask('tool-2', 'parent-session-1');
			manager.linkChildSession('child-session-1', 'tool-1');

			const linked = manager.linkChildSession('child-session-1', 'tool-2');

			expect(linked).toBe(false);
			expect(manager.getToolUseId('child-session-1')).toBe('tool-1');
		});

		it('rejects linking when parent session is unknown', () => {
			const { manager } = createManager();

			const linked = manager.linkChildSession('child-session-1', 'tool-1');

			expect(linked).toBe(false);
		});
	});

	describe('resolveRouting', () => {
		it('returns parent session and tool ID for known child', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1', 'child-session-1');

			expect(manager.resolveRouting('child-session-1')).toEqual({
				parentSessionId: 'parent-session-1',
				toolUseId: 'tool-1',
			});
		});

		it('returns undefined for unknown child', () => {
			const { manager } = createManager();
			expect(manager.resolveRouting('unknown')).toBeUndefined();
		});
	});

	describe('token accumulation', () => {
		it('accumulates token deltas for a subtask', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			manager.accumulateTokens('tool-1', {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cacheReadTokens: 10,
			});

			expect(manager.getAccumulatedTokens('tool-1')).toEqual({
				input: 100,
				output: 50,
				total: 150,
				cacheRead: 10,
			});
		});
	});

	describe('completeSubtask', () => {
		it('clears all tracked state for a finished subtask', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1', 'child-session-1');
			manager.accumulateTokens('tool-1', {
				inputTokens: 1,
				outputTokens: 2,
				totalTokens: 3,
				cacheReadTokens: 4,
			});

			manager.completeSubtask('tool-1');

			expect(manager.isRegistered('tool-1')).toBe(false);
			expect(manager.getChildSessionId('tool-1')).toBeUndefined();
			expect(manager.getToolUseId('child-session-1')).toBeUndefined();
			expect(manager.getAccumulatedTokens('tool-1')).toEqual({
				input: 0,
				output: 0,
				total: 0,
				cacheRead: 0,
			});
		});
	});

	describe('clearAll', () => {
		it('clears all tracked subtasks', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1', 'child-1');
			manager.registerSubtask('tool-2', 'parent-session-1');

			manager.clearAll();

			expect(manager.isRegistered('tool-1')).toBe(false);
			expect(manager.isRegistered('tool-2')).toBe(false);
			expect(manager.getToolUseId('child-1')).toBeUndefined();
		});
	});
});
