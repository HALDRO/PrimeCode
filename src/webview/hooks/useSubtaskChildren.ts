import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { type Message, useChatStore } from '../store/chatStore';
import { groupToolMessages } from '../utils/messageGrouping';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_GROUPED: (Message | Message[])[] = [];

/**
 * Hook to retrieve all child messages for a given subtask using unified Context ID.
 * Resolves contextId from the subtask message and retrieves the corresponding session bucket.
 */
export function useSubtaskChildren(subtaskId: string): Message[] {
	// 1. Get the subtask message from current active session messages
	const message = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.sessionsById[sid]?.messages.find((m: Message) => m.id === subtaskId);
	});

	// 2. Get sessionsById for direct context lookup
	const sessionsById = useChatStore(useShallow(state => state.sessionsById));

	const children = useMemo(() => {
		if (!message || message.type !== 'subtask') {
			return EMPTY_MESSAGES;
		}

		// Get contextId from subtask message
		const contextId = message.contextId;

		if (!contextId) return EMPTY_MESSAGES;

		// Lookup session bucket by contextId
		const contextSession = sessionsById[contextId];

		// If session exists (live), return its messages.
		// If session is closed/completed, messages are moved to transcript.
		return contextSession?.messages ?? message.transcript ?? EMPTY_MESSAGES;
	}, [message, sessionsById]);

	return children;
}

/**
 * Higher-level hook for UI rendering: returns subtask message, grouped children, and total duration.
 * This keeps UI components from duplicating the “context session vs transcript” logic.
 */
export function useSubtaskThread(
	subtaskId: string,
	mcpServerNames: string[],
): {
	message?: Extract<Message, { type: 'subtask' }>;
	children: Message[];
	groupedChildren: (Message | Message[])[];
	totalDurationMs: number;
} {
	const message = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		const found = state.sessionsById[sid]?.messages.find((m: Message) => m.id === subtaskId);
		return found && found.type === 'subtask'
			? (found as Extract<Message, { type: 'subtask' }>)
			: undefined;
	});

	const children = useSubtaskChildren(subtaskId);

	const groupedChildren = useMemo(() => {
		if (!children.length) return EMPTY_GROUPED;
		return groupToolMessages(children, mcpServerNames);
	}, [children, mcpServerNames]);

	const totalDurationMs = useMemo(() => {
		if (message?.durationMs && message.durationMs > 0) return message.durationMs;
		let duration = 0;
		for (const msg of children) {
			if (msg.type === 'tool_result' || msg.type === 'thinking') {
				if (msg.durationMs) duration += msg.durationMs;
			}
		}
		return duration;
	}, [message?.durationMs, children]);

	return {
		message,
		children,
		groupedChildren,
		totalDurationMs,
	};
}
