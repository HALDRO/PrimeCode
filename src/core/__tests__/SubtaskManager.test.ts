/**
 * @file SubtaskManager tests
 * @description Tests for the subtask lifecycle logic extracted from ChatProvider:
 * - Deferred child session linking
 * - Inactivity timer management
 * - Token accumulation
 * - Parent transcript routing resolution
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionGraph, SessionState } from '../SessionManager';
import { SubtaskManager } from '../SubtaskManager';

// Use fake timers for timeout tests
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const createManager = () => {
	const graph = new SessionGraph();
	const sessionState = new SessionState();
	const onTimeout = vi.fn();
	const manager = new SubtaskManager(graph, sessionState, { onTimeout });
	return { manager, graph, sessionState, onTimeout };
};

describe('SubtaskManager', () => {
	describe('registerSubtask', () => {
		it('should track a pending subtask tool ID', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			expect(manager.isPending('tool-1')).toBe(true);
		});

		it('should store parent session mapping', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			expect(manager.getParentSession('tool-1')).toBe('parent-session-1');
		});

		it('should start an inactivity timer', () => {
			const { manager, onTimeout } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			// Timer should not fire immediately
			expect(onTimeout).not.toHaveBeenCalled();

			// Advance past timeout
			vi.advanceTimersByTime(30_001);
			expect(onTimeout).toHaveBeenCalledWith('tool-1');
		});
	});

	describe('tryLinkChildSession (deferred linking)', () => {
		it('should link unknown session to pending subtask', () => {
			const { manager, graph } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			const linked = manager.tryLinkChildSession('child-session-1');

			expect(linked).toBe(true);
			expect(graph.isChild('child-session-1')).toBe(true);
			expect(graph.getParent('child-session-1')).toBe('parent-session-1');
			expect(manager.getToolUseId('child-session-1')).toBe('tool-1');
		});

		it('should not link if no pending subtasks', () => {
			const { manager } = createManager();

			const linked = manager.tryLinkChildSession('child-session-1');
			expect(linked).toBe(false);
		});

		it('should not link already-known child sessions', () => {
			const { manager, graph } = createManager();
			graph.registerChild('child-session-1', 'parent-session-1', 'tool-1');

			manager.registerSubtask('tool-2', 'parent-session-1');
			const linked = manager.tryLinkChildSession('child-session-1');
			expect(linked).toBe(false);
		});

		it('should not link sessions that are started top-level sessions', () => {
			const { manager, sessionState } = createManager();
			sessionState.startedSessions.add('top-level-session');

			manager.registerSubtask('tool-1', 'parent-session-1');
			const linked = manager.tryLinkChildSession('top-level-session');
			expect(linked).toBe(false);
		});

		it('should remove tool ID from pending set after linking', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			manager.tryLinkChildSession('child-session-1');
			expect(manager.isPending('tool-1')).toBe(false);
		});

		it('should reset the inactivity timer after linking', () => {
			const { manager, onTimeout } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			// Advance 20s, then link
			vi.advanceTimersByTime(20_000);
			manager.tryLinkChildSession('child-session-1');

			// Advance another 20s — should NOT timeout (timer was reset)
			vi.advanceTimersByTime(20_000);
			expect(onTimeout).not.toHaveBeenCalled();

			// Advance to full 30s after reset — should timeout
			vi.advanceTimersByTime(10_001);
			expect(onTimeout).toHaveBeenCalledWith('tool-1');
		});
	});

	describe('resetTimerByChild', () => {
		it('should reset timer on child activity', () => {
			const { manager, onTimeout } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.tryLinkChildSession('child-session-1');

			// Advance 25s, then reset
			vi.advanceTimersByTime(25_000);
			manager.resetTimerByChild('child-session-1');

			// Advance another 25s — should NOT timeout
			vi.advanceTimersByTime(25_000);
			expect(onTimeout).not.toHaveBeenCalled();

			// Advance to full 30s after reset
			vi.advanceTimersByTime(5_001);
			expect(onTimeout).toHaveBeenCalledWith('tool-1');
		});

		it('should be a no-op for unknown child sessions', () => {
			const { manager } = createManager();
			// Should not throw
			manager.resetTimerByChild('unknown-child');
		});
	});

	describe('resolveRouting', () => {
		it('should return parent session and tool ID for known child', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.tryLinkChildSession('child-session-1');

			const routing = manager.resolveRouting('child-session-1');
			expect(routing).toEqual({
				parentSessionId: 'parent-session-1',
				toolUseId: 'tool-1',
			});
		});

		it('should return undefined for unknown child', () => {
			const { manager } = createManager();
			expect(manager.resolveRouting('unknown')).toBeUndefined();
		});

		it('should return undefined if graph has parent but no toolUseId mapping', () => {
			const { manager, graph } = createManager();
			// Register in graph directly without going through SubtaskManager
			graph.registerChild('child-1', 'parent-1', 'tool-1');

			// SubtaskManager doesn't know about this child
			expect(manager.resolveRouting('child-1')).toBeUndefined();
		});
	});

	describe('token accumulation', () => {
		it('should accumulate token deltas for a subtask', () => {
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

		it('should sum multiple token deltas', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			manager.accumulateTokens('tool-1', {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cacheReadTokens: 10,
			});
			manager.accumulateTokens('tool-1', {
				inputTokens: 200,
				outputTokens: 100,
				totalTokens: 300,
				cacheReadTokens: 20,
			});

			expect(manager.getAccumulatedTokens('tool-1')).toEqual({
				input: 300,
				output: 150,
				total: 450,
				cacheRead: 30,
			});
		});

		it('should return zero tokens for unknown tool', () => {
			const { manager } = createManager();
			expect(manager.getAccumulatedTokens('unknown')).toEqual({
				input: 0,
				output: 0,
				total: 0,
				cacheRead: 0,
			});
		});
	});

	describe('completeSubtask', () => {
		it('should clear timer and pending state', () => {
			const { manager, onTimeout } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');

			manager.completeSubtask('tool-1');

			// Timer should be cleared
			vi.advanceTimersByTime(60_000);
			expect(onTimeout).not.toHaveBeenCalled();

			// Pending state should be cleared
			expect(manager.isPending('tool-1')).toBe(false);
		});

		it('should clean up child session mapping', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.tryLinkChildSession('child-session-1');

			manager.completeSubtask('tool-1');

			expect(manager.getToolUseId('child-session-1')).toBeUndefined();
		});

		it('should clean up token accumulators', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.accumulateTokens('tool-1', {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cacheReadTokens: 0,
			});

			manager.completeSubtask('tool-1');

			expect(manager.getAccumulatedTokens('tool-1')).toEqual({
				input: 0,
				output: 0,
				total: 0,
				cacheRead: 0,
			});
		});
	});

	describe('clearAll', () => {
		it('should clear all timers and state', () => {
			const { manager, onTimeout } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.registerSubtask('tool-2', 'parent-session-1');
			manager.tryLinkChildSession('child-1');

			manager.clearAll();

			vi.advanceTimersByTime(60_000);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(manager.isPending('tool-1')).toBe(false);
			expect(manager.isPending('tool-2')).toBe(false);
			expect(manager.getToolUseId('child-1')).toBeUndefined();
		});
	});

	describe('hasActiveSubtasks', () => {
		it('should return true when there are pending or timed subtasks', () => {
			const { manager } = createManager();
			expect(manager.hasActiveSubtasks()).toBe(false);

			manager.registerSubtask('tool-1', 'parent-session-1');
			expect(manager.hasActiveSubtasks()).toBe(true);
		});

		it('should return false after all subtasks complete', () => {
			const { manager } = createManager();
			manager.registerSubtask('tool-1', 'parent-session-1');
			manager.completeSubtask('tool-1');

			expect(manager.hasActiveSubtasks()).toBe(false);
		});
	});
});
