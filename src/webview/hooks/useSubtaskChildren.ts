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

	const isRunning = message?.status === 'running';

	const groupedChildren = useMemo(() => {
		if (!children.length) return EMPTY_GROUPED;
		return groupToolMessages(children, mcpServerNames, isRunning);
	}, [children, mcpServerNames, isRunning]);

	const totalDurationMs = useMemo(() => {
		if (message?.durationMs && message.durationMs > 0) return message.durationMs;
		// Sum child durations from transcript
		let duration = 0;
		for (const msg of children) {
			if (msg.type === 'tool_result' || msg.type === 'thinking') {
				if (msg.durationMs) duration += msg.durationMs;
			}
		}
		if (duration > 0) return duration;
		// Fallback: compute from startTime and last child timestamp
		if (message?.startTime && message.status !== 'running' && children.length > 0) {
			const start = new Date(message.startTime).getTime();
			if (start > 0) {
				// Find the last valid timestamp in transcript (skip children without one)
				for (let i = children.length - 1; i >= 0; i--) {
					const ts = (children[i] as Record<string, unknown>).timestamp as string | undefined;
					if (!ts) continue;
					const end = new Date(ts).getTime();
					if (end > start) return end - start;
				}
			}
		}
		return duration;
	}, [message?.durationMs, message?.startTime, message?.status, children]);

	// Read token stats and model ID directly from the subtask message
	const tokenStats: SubtaskTokenStats | null = useMemo(() => {
		if (!message?.childTokens) return null;
		return {
			input: message.childTokens.input,
			output: message.childTokens.output,
			total: message.childTokens.total,
		};
	}, [message?.childTokens]);

	const childModelId: string | undefined = message?.childModelId;

	return {
		message,
		children,
		groupedChildren,
		totalDurationMs,
		tokenStats,
		childModelId,
	};
}
