/**
 * @file chatStore revert/unrevert state management tests
 * @description Tests for handleRestoreEvent, clearRevertedMessages,
 *              deleteMessagesAfterId, and revert state transitions.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRestorePayload } from '../../../common/protocol';
import {
	type RuntimeMessagePart,
	type RuntimeMessageRecord,
	type UserMessage,
	useChatStore,
} from '../chatStore';
import { projectRuntimeMessages } from '../selectors';

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

function createSession(id: string, messages: UserMessage[] = []) {
	const { actions } = useChatStore.getState();
	actions.handleSessionCreated(id);
	if (messages.length > 0) {
		const baseTime = Date.UTC(2024, 0, 1, 0, 0, 0);
		const normalizedMessages = messages.map((message, index) => ({
			...message,
			timestamp: new Date(baseTime + index * 1000).toISOString(),
		}));
		actions.setSessionMessages(id, normalizedMessages);
		normalizedMessages.forEach((message, index) => {
			const createdAt = baseTime + index * 1000 + 1;
			const assistantRecord: RuntimeMessageRecord = {
				id: `assistant-${message.id}`,
				sessionId: id,
				role: 'assistant',
				parentId: message.id,
				createdAt,
			};
			const assistantPart: RuntimeMessagePart = {
				id: `assistant-part-${message.id}`,
				messageId: assistantRecord.id,
				sessionId: id,
				type: 'text',
				text: `reply-${message.id}`,
				createdAt,
				completedAt: createdAt,
			};
			actions.dispatch(id, 'message_record', {
				eventType: 'message_record',
				message: assistantRecord,
			});
			actions.dispatch(id, 'message_part', {
				eventType: 'message_part',
				part: assistantPart,
			});
		});
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

const userMsg = (id: string, content = 'hello'): UserMessage => ({
	type: 'user',
	id,
	timestamp: new Date().toISOString(),
	content,
});

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
			createSession('s1', [userMsg('u1')]);

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
			createSession('s1', [userMsg('u1')]);

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

		it('should clear revertedFromMessageId on success with canUnrevert=false', () => {
			createSession('s1', [userMsg('u1')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
				revertedFromMessageId: 'u1',
			});

			// Second success with canUnrevert=false (unrevert completed)
			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: false,
			});

			// revertedFromMessageId is now cleared atomically with canUnrevert
			// to prevent UI desync (dimmed messages with no unrevert button)
			expect(getSession('s1').revertedFromMessageId).toBeNull();
		});

		it('should not invent a revert point without revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1'), userMsg('u2')]);

			dispatchRestore('s1', {
				action: 'success',
				canUnrevert: true,
			});

			const session = getSession('s1');
			expect(session.unrevertAvailable).toBe(true);
			expect(session.revertedFromMessageId).toBeNull();
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
	// handleExtensionMessage — messageQueue cancelled
	// =========================================================================

	describe('handleExtensionMessage — messageQueue cancelled', () => {
		it('should restore cancelled text, attachments, and agent to the draft', () => {
			createSession('s1');
			useChatStore.getState().actions.updateSession({ input: 'existing draft' }, 's1');

			useChatStore.getState().actions.handleExtensionMessage({
				type: 'messageQueue',
				data: {
					action: 'cancelled',
					sessionId: 's1',
					queue: [],
					cancelledText: 'lost prompt',
					cancelledAttachments: {
						files: ['src/foo.ts'],
						codeSnippets: [
							{
								filePath: 'src/foo.ts',
								startLine: 1,
								endLine: 3,
								content: 'const x = 1;',
							},
						],
					},
					cancelledAgent: 'build',
				},
			});

			const session = getSession('s1');
			expect(session.input).toBe('existing draft\n\nlost prompt');
			expect(session.draftAttachments).toEqual({
				files: ['src/foo.ts'],
				codeSnippets: [
					{
						filePath: 'src/foo.ts',
						startLine: 1,
						endLine: 3,
						content: 'const x = 1;',
					},
				],
			});
			expect(session.draftAgent).toBe('build');
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
			createSession('s1', [userMsg('u1'), userMsg('u2')]);

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
			createSession('sA', [userMsg('uA1')]);
			createSession('sB', [userMsg('uB1')]);

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
			createSession('s1', [userMsg('u1'), userMsg('u2')]);

			// Set revert point
			const { actions } = useChatStore.getState();
			actions.markRevertedFromMessageId('u2', 's1');
			expect(getSession('s1').revertedFromMessageId).toBe('u2');

			// Clear reverted messages
			actions.clearRevertedMessages('s1');

			const session = getSession('s1');
			// Should keep messages before u2 only
			const rendered = projectRuntimeMessages(session);
			expect(rendered).toHaveLength(1);
			expect(rendered[0].id).toBe('u1');
		});

		it('should do nothing when no revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1')]);

			const { actions } = useChatStore.getState();
			actions.clearRevertedMessages('s1');

			expect(projectRuntimeMessages(getSession('s1'))).toHaveLength(2);
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
			createSession('s1', [userMsg('u1'), userMsg('u2'), userMsg('u3')]);

			const { actions } = useChatStore.getState();
			actions.deleteMessagesAfterId('u2', 's1');

			const session = getSession('s1');
			const rendered = projectRuntimeMessages(session);
			expect(rendered).toHaveLength(2);
			expect(rendered.map(m => m.id)).toEqual(['u1', 'u2']);
		});

		it('should clear revertedFromMessageId', () => {
			createSession('s1', [userMsg('u1'), userMsg('u2')]);

			const { actions } = useChatStore.getState();
			actions.markRevertedFromMessageId('u1', 's1');
			actions.deleteMessagesAfterId('u1', 's1');

			expect(getSession('s1').revertedFromMessageId).toBeNull();
		});
	});

	// =========================================================================
	// Streaming order regressions
	// =========================================================================

	describe('streaming part order', () => {
		it('should preserve arrival order for mixed text and tool parts in one assistant message', () => {
			const { actions } = useChatStore.getState();
			actions.handleSessionCreated('s1');

			actions.dispatch('s1', 'user_message', {
				eventType: 'user_message',
				message: {
					id: 'u1',
					content: 'debug this',
					timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)).toISOString(),
				},
			});

			actions.dispatch('s1', 'message_record', {
				eventType: 'message_record',
				message: {
					id: 'a1',
					sessionId: 's1',
					role: 'assistant',
					parentId: 'u1',
					createdAt: Date.UTC(2024, 0, 1, 0, 0, 1),
				},
			});

			actions.dispatch('s1', 'message_part', {
				eventType: 'message_part',
				part: {
					id: 'p-text-1',
					messageId: 'a1',
					sessionId: 's1',
					type: 'text',
					text: 'First text',
					createdAt: 200,
				},
			});

			actions.dispatch('s1', 'message_part', {
				eventType: 'message_part',
				part: {
					id: 'p-tool-1',
					messageId: 'a1',
					sessionId: 's1',
					type: 'tool',
					callId: 'tool-1',
					toolName: 'todowrite',
					state: { status: 'completed', input: {}, output: '[]' },
					createdAt: 300,
				},
			});

			actions.dispatch('s1', 'message_part', {
				eventType: 'message_part',
				part: {
					id: 'p-tool-2',
					messageId: 'a1',
					sessionId: 's1',
					type: 'tool',
					callId: 'tool-2',
					toolName: 'bash',
					state: { status: 'completed', input: {}, output: 'ok' },
					createdAt: 400,
				},
			});

			// Late text can carry an earlier start timestamp in session dumps/SSE updates.
			// The UI must still keep it after the tools if it arrived after them.
			actions.dispatch('s1', 'message_part', {
				eventType: 'message_part',
				part: {
					id: 'p-text-2',
					messageId: 'a1',
					sessionId: 's1',
					type: 'text',
					text: 'Late text',
					createdAt: 250,
				},
			});

			const rendered = projectRuntimeMessages(getSession('s1'));
			expect(rendered.map(message => message.id)).toEqual([
				'u1',
				'msg-p-text-1',
				'tool-1',
				'tool-2',
				'msg-p-text-2',
			]);
		});
	});
});
