import { useMemo } from 'react';
import { groupToolMessages } from '../components/chat/SimpleTool';
import { type Message, useChatStore } from '../store/chatStore';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_GROUPED: (Message | Message[])[] = [];

export interface SubtaskTokenStats {
	input: number;
	output: number;
	total: number;
}

/**
 * Hook to retrieve all child messages for a given subtask using unified Context ID.
 * Resolves contextId from the subtask message and retrieves the corresponding session bucket.
 *
 * Subscribes only to the specific child session's messages (not the entire sessionsById map)
 * to avoid unnecessary re-renders and potential recursive rendering when contextId
 * accidentally points to the parent session.
 */
export function useSubtaskChildren(subtaskId: string): Message[] {
	// 1. Get the subtask message from current active session messages
	const message = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.sessionsById[sid]?.messages.find((m: Message) => m.id === subtaskId);
	});

	// 2. Extract contextId from the subtask message
	const contextId = message?.type === 'subtask' ? message.contextId : undefined;

	// 3. Subscribe to the specific child session's messages only (not all sessions).
	//    Guard: if contextId equals the active session, ignore it to prevent recursive rendering.
	const childMessages = useChatStore(state => {
		if (!contextId) return EMPTY_MESSAGES;
		// Safety: never read from the parent session as child context
		if (contextId === state.activeSessionId) return EMPTY_MESSAGES;
		const session = state.sessionsById[contextId];
		return session?.messages?.length ? session.messages : EMPTY_MESSAGES;
	});

	// 4. Fall back to archived transcript if no live child session
	const children = useMemo(() => {
		if (!message || message.type !== 'subtask') {
			return EMPTY_MESSAGES;
		}
		if (childMessages.length > 0) {
			return childMessages;
		}
		return message.transcript ?? EMPTY_MESSAGES;
	}, [message, childMessages]);

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
	tokenStats: SubtaskTokenStats | null;
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

	// Aggregate token stats from child session — read primitives to avoid new-object re-renders
	const contextId = message?.contextId;
	const tokenInput = useChatStore(state => {
		if (!contextId || contextId === state.activeSessionId) return 0;
		return state.sessionsById[contextId]?.totalStats?.totalInputTokens ?? 0;
	});
	const tokenOutput = useChatStore(state => {
		if (!contextId || contextId === state.activeSessionId) return 0;
		return state.sessionsById[contextId]?.totalStats?.totalOutputTokens ?? 0;
	});
	const tokenStats: SubtaskTokenStats | null = useMemo(() => {
		if (tokenInput === 0 && tokenOutput === 0) return null;
		return { input: tokenInput, output: tokenOutput, total: tokenInput + tokenOutput };
	}, [tokenInput, tokenOutput]);

	return {
		message,
		children,
		groupedChildren,
		totalDurationMs,
		tokenStats,
	};
}
