/**
 * @file chatStore revert/unrevert state management tests
 * @description Tests for handleRestoreEvent, clearRevertedMessages,
 *              deleteMessagesAfterId, and revert state transitions.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRestorePayload } from '../../../common/protocol';
import { useChatStore } from '../chatStore';
import type { Message } from '../index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
	useChatStore.setState({
		sessionsById: {},
		sessionOrder: [],
		activeSessionId: undefined,
		editingMessageId: null,
		isImprovingPrompt: false,
		improvingPromptRequestId: null,
		promptVersions: null,
	});
}

function createSession(id: string, messages: Message[] = []) {
	const { actions } = useChatStore.getState();
	actions.handleSessionCreated(id);
	if (messages.length > 0) {
		actions.setSessionMessages(id, messages);
	}
}

function getSession(id: string) {
	return useChatStore.getState().sessionsById[id];
}

function dispatchRestore(sessionId: string, payload: Omit<SessionRestorePayload, 'eventType'>) {
	const { actions } = useChatStore.getState();
	const fullPayload: SessionRestorePayload = { eventType: 'restore', ...payload };
	actions.dispatch(sessionId, 'restore', fullPayload);
}

const userMsg = (id: string, content = 'hello'): Message =>
	({ type: 'user', id, timestamp: new Date().toISOString(), content }) as Message;

const assistantMsg = (id: string, content = 'reply'): Message =>
	({ type: 'assistant', id, timestamp: new Date().toISOString(), content }) as Message;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chatStore revert/unrevert state', () => {
	beforeEach(() => {
		resetStore();
	});

	// =========================================================================
	// handleRestoreEvent — 'success' action
	// =========================================================================

	describe('handleRestoreEvent — success', () => {
		it('should set unrevertAvailable and revertedFromMessageId on success', () => {
			createSession('s1', [userMsg('u1'), assistantMsg('a1')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});

			const session = getSession('s1');
			expect(session.unrevertAvailable).toBe(true);
			expect(session.revertedFromMessageId).toBe('u1');
		});

		it('should set unrevertAvailable=false on unrevert success', () => {
			createSession('s1', [userMsg('u1'), assistantMsg('a1')]);

			// Revert
			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});

			// Unrevert
			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: false,
			});

			expect(getSession('s1').unrevertAvailable).toBe(false);
		});

		it('should not clear revertedFromMessageId on success without it', () => {
			createSession('s1', [userMsg('u1')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});

			// Second success without revertedFromMessageId
			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: false,
			});

			// revertedFromMessageId stays — only unrevert_available clears it
			expect(getSession('s1').revertedFromMessageId).toBe('u1');
		});
	});

	// =========================================================================
	// handleRestoreEvent — 'unrevert_available' action
	// =========================================================================

	describe('handleRestoreEvent — unrevert_available', () => {
		it('should set unrevertAvailable to true', () => {
			createSession('s1');
			dispatchRestore('s1', { action: 'unrevert_available', available: true });
			expect(getSession('s1').unrevertAvailable).toBe(true);
		});

		it('should clear revertedFromMessageId when available=false', () => {
			createSession('s1', [userMsg('u1')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});
			expect(getSession('s1').revertedFromMessageId).toBe('u1');

			dispatchRestore('s1', { action: 'unrevert_available', available: false });

			expect(getSession('s1').unrevertAvailable).toBe(false);
			expect(getSession('s1').revertedFromMessageId).toBeNull();
		});

		it('should NOT clear revertedFromMessageId when available=true', () => {
			createSession('s1', [userMsg('u1')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});

			dispatchRestore('s1', { action: 'unrevert_available', available: true });

			expect(getSession('s1').revertedFromMessageId).toBe('u1');
		});
	});

	// =========================================================================
	// handleRestoreEvent — 'add_commit'
	// =========================================================================

	describe('handleRestoreEvent — add_commit', () => {
		it('should add a restore commit', () => {
			createSession('s1');

			dispatchRestore('s1', {
				action: 'add_commit',
				commit: {
					id: 'cp-1',
					sha: 'cp-1',
					message: 'Checkpoint',
					timestamp: new Date().toISOString(),
					associatedMessageId: 'u1',
				},
			});

			expect(getSession('s1').restoreCommits).toHaveLength(1);
			expect(getSession('s1').restoreCommits[0].associatedMessageId).toBe('u1');
		});

		it('should not duplicate commits with same sha', () => {
			createSession('s1');
			const commit = {
				id: 'cp-1',
				sha: 'cp-1',
				message: 'CP',
				timestamp: new Date().toISOString(),
				associatedMessageId: 'u1',
			};

			dispatchRestore('s1', { action: 'add_commit', commit });
			dispatchRestore('s1', { action: 'add_commit', commit });

			expect(getSession('s1').restoreCommits).toHaveLength(1);
		});
	});

	// =========================================================================
	// handleRestoreEvent — 'clear_commits'
	// =========================================================================

	describe('handleRestoreEvent — clear_commits', () => {
		it('should clear all restore commits', () => {
			createSession('s1');
			dispatchRestore('s1', {
				action: 'add_commit',
				commit: {
					id: 'cp-1',
					sha: 'cp-1',
					message: 'CP',
					timestamp: new Date().toISOString(),
					associatedMessageId: 'u1',
				},
			});
			expect(getSession('s1').restoreCommits).toHaveLength(1);

			dispatchRestore('s1', { action: 'clear_commits' });
			expect(getSession('s1').restoreCommits).toHaveLength(0);
		});
	});

	// =========================================================================
	// Full revert → unrevert cycle
	// =========================================================================

	describe('full revert → unrevert cycle', () => {
		it('should complete full cycle: revert → dim → unrevert → undim', () => {
			createSession('s1', [userMsg('u1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')]);

			// Step 1: Revert at u1
			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});
			dispatchRestore('s1', { action: 'unrevert_available', available: true });

			let session = getSession('s1');
			expect(session.revertedFromMessageId).toBe('u1');
			expect(session.unrevertAvailable).toBe(true);

			// Step 2: Unrevert
			dispatchRestore('s1', { action: 'success', canUnrevert: false });
			dispatchRestore('s1', { action: 'unrevert_available', available: false });

			session = getSession('s1');
			expect(session.revertedFromMessageId).toBeNull();
			expect(session.unrevertAvailable).toBe(false);
		});
	});

	// =========================================================================
	// Multi-session isolation
	// =========================================================================

	describe('multi-session isolation', () => {
		it('revert in session A should not affect session B', () => {
			createSession('sA', [userMsg('uA1'), assistantMsg('aA1')]);
			createSession('sB', [userMsg('uB1'), assistantMsg('aB1')]);

			dispatchRestore('sA', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'uA1',
			});

			expect(getSession('sA').revertedFromMessageId).toBe('uA1');
			expect(getSession('sA').unrevertAvailable).toBe(true);
			expect(getSession('sB').revertedFromMessageId).toBeNull();
			expect(getSession('sB').unrevertAvailable).toBe(false);
		});

		it('commits in session A should not appear in session B', () => {
			createSession('sA');
			createSession('sB');

			dispatchRestore('sA', {
				action: 'add_commit',
				commit: {
					id: 'cp-A',
					sha: 'cp-A',
					message: 'CP',
					timestamp: new Date().toISOString(),
					associatedMessageId: 'uA1',
				},
			});

			expect(getSession('sA').restoreCommits).toHaveLength(1);
			expect(getSession('sB').restoreCommits).toHaveLength(0);
		});
	});

	// =========================================================================
	// clearRevertedMessages
	// =========================================================================

	describe('clearRevertedMessages', () => {
		it('should remove messages after revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1'), assistantMsg('a1'), userMsg('u2'), assistantMsg('a2')]);

			// Set revert point
			const { actions } = useChatStore.getState();
			actions.markRevertedFromMessageId('u2', 's1');
			expect(getSession('s1').revertedFromMessageId).toBe('u2');

			// Clear reverted messages
			actions.clearRevertedMessages('s1');

			const session = getSession('s1');
			// Should keep messages before u2 only
			expect(session.messages).toHaveLength(2);
			expect(session.messages[0].id).toBe('u1');
			expect(session.messages[1].id).toBe('a1');
		});

		it('should do nothing when no revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1'), assistantMsg('a1')]);

			const { actions } = useChatStore.getState();
			actions.clearRevertedMessages('s1');

			expect(getSession('s1').messages).toHaveLength(2);
		});

		it('should clear revertedFromMessageId when messageId not found', () => {
			createSession('s1', [userMsg('u1')]);

			const { actions } = useChatStore.getState();
			actions.markRevertedFromMessageId('nonexistent', 's1');
			actions.clearRevertedMessages('s1');

			expect(getSession('s1').revertedFromMessageId).toBeNull();
		});
	});

	// =========================================================================
	// deleteMessagesAfterId
	// =========================================================================

	describe('deleteMessagesAfterId', () => {
		it('should keep the target message and remove everything after', () => {
			createSession('s1', [
				userMsg('u1'),
				assistantMsg('a1'),
				userMsg('u2'),
				assistantMsg('a2'),
				userMsg('u3'),
				assistantMsg('a3'),
			]);

			const { actions } = useChatStore.getState();
			actions.deleteMessagesAfterId('u2', 's1');

			const session = getSession('s1');
			expect(session.messages).toHaveLength(3);
			expect(session.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2']);
		});

		it('should clear revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1'), userMsg('u2')]);

			const { actions } = useChatStore.getState();
			actions.markRevertedFromMessageId('u1', 's1');
			actions.deleteMessagesAfterId('u1', 's1');

			expect(getSession('s1').revertedFromMessageId).toBeNull();
		});
	});
});
