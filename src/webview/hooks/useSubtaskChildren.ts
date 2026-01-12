import { useMemo } from 'react';
import { type Message, useChatStore } from '../store/chatStore';

/**
 * Hook to retrieve all child messages for a given subtask.
 * Handles both:
 * 1. Claude Code style (child messages in same session, linked by ID)
 * 2. OpenCode style (child messages in a separate child session)
 */
export function useSubtaskChildren(subtaskId: string): Message[] {
	// 1. Get the subtask message from current active messages
	const message = useChatStore(state => state.messages.find(m => m.id === subtaskId));

	// 2. Access all sessions to find child session if needed
	const sessions = useChatStore(state => state.sessions);
	const allMessages = useChatStore(state => state.messages); // Current session messages

	const children = useMemo(() => {
		if (!message || message.type !== 'subtask') {
			return [];
		}

		let childMsgs: Message[] = [];

		// Case A: Claude Code (child messages are in the same session, linked by ID)
		if (message.childMessages && message.childMessages.length > 0) {
			const linked = message.childMessages
				.map(id => allMessages.find(m => m.id === id))
				.filter((m): m is Message => !!m);
			childMsgs = [...childMsgs, ...linked];
		}

		// Case B: OpenCode (child messages are in a separate session)
		if (message.childSessionId) {
			const childSession = sessions.find(s => s.id === message.childSessionId);
			if (childSession?.messages) {
				childMsgs = [...childMsgs, ...childSession.messages];
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
	}, [message, allMessages, sessions]);

	return children;
}
