import { useMemo } from 'react';
import { groupToolMessages } from '../components/chat/SimpleTool';
import { type Message, useChatStore } from '../store/chatStore';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_GROUPED: (Message | Message[])[] = [];

interface SubtaskTokenStats {
	input: number;
	output: number;
	total: number;
}

/**
 * Hook to retrieve all child messages for a given subtask.
 * Reads directly from the subtask message's `transcript` array —
 * child events are aggregated into the parent session by the backend,
 * so no separate child session bucket lookup is needed.
 */
function useSubtaskChildren(subtaskId: string): Message[] {
	const transcript = useChatStore(state => {
		const sid = state.activeSessionId;
		if (!sid) return EMPTY_MESSAGES;
		const msg = state.sessionsById[sid]?.messages.find((m: Message) => m.id === subtaskId);
		if (!msg || msg.type !== 'subtask') return EMPTY_MESSAGES;
		return msg.transcript?.length ? (msg.transcript as Message[]) : EMPTY_MESSAGES;
	});

	return transcript;
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
	childModelId: string | undefined;
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
	const tokenStats: SubtaskTokenStats | null = null;

	// Child model ID is no longer available from separate session bucket
	const childModelId: string | undefined = undefined;

	return {
		message,
		children,
		groupedChildren,
		totalDurationMs,
		tokenStats,
		childModelId,
	};
}
