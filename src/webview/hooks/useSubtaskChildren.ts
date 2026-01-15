import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type Message, useChatStore } from '../store/chatStore';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: Message[] = [];

/**
 * Hook to retrieve all child messages for a given subtask.
 * Handles both:
 * 1. Claude Code style (child messages in same session, linked by ID)
 * 2. OpenCode style (child messages in a separate child session)
 *
 * With unified session architecture, child sessions are stored flat in sessionsById
 * and can be accessed directly by childSessionId.
 */
export function useSubtaskChildren(subtaskId: string): Message[] {
	// 1. Get the subtask message from current active session messages
	const message = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.sessionsById[sid]?.messages.find((m: Message) => m.id === subtaskId);
	});

	// 2. Get sessionsById for direct child session lookup
	const sessionsById = useChatStore(useShallow(state => state.sessionsById));

	// 3. Get current session messages with stable empty array fallback
	const allMessages = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return EMPTY_MESSAGES;
		return state.sessionsById[sid]?.messages ?? EMPTY_MESSAGES;
	});

	const children = useMemo(() => {
		if (!message || message.type !== 'subtask') {
			return EMPTY_MESSAGES;
		}

		let childMsgs: Message[] = [];

		// Case A: Claude Code (child messages are in the same session, linked by ID)
		if (message.childMessages && message.childMessages.length > 0) {
			const linked = message.childMessages
				.map((id: string) => allMessages.find(m => m.id === id))
				.filter((m): m is Message => !!m);
			childMsgs = [...childMsgs, ...linked];
		}

		// Case B: OpenCode (child messages are in a separate child session)
		// If the child session was cleaned up, use the persisted transcript on the subtask.
		if (message.childSessionId) {
			const childSession = sessionsById[message.childSessionId];
			if (childSession?.messages) {
				childMsgs = [...childMsgs, ...childSession.messages];
			} else if (Array.isArray((message as unknown as { transcript?: Message[] }).transcript)) {
				childMsgs = [
					...childMsgs,
					...(((message as unknown as { transcript?: Message[] }).transcript as Message[]) || []),
				];
			}
		}

		// Deduplicate in case of overlap (unlikely but safe)
		const seen = new Set<string>();
		return childMsgs.filter(m => {
			if (m.id && seen.has(m.id)) {
				return false;
			}
			if (m.id) {
				seen.add(m.id);
			}
			return true;
		});
	}, [message, allMessages, sessionsById]);

	return children;
}
