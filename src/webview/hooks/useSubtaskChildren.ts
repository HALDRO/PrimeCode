import { useMemo } from 'react';
import { type GroupedResponseItem, groupToolMessages } from '../components/chat/toolGrouping';
import type { RenderMessage, RenderSubtaskMessage, TokenUsage } from '../store';
import { useChatStore } from '../store/chatStore';
import { projectRuntimeMessages } from '../store/selectors';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: RenderMessage[] = [];
const EMPTY_GROUPED: GroupedResponseItem[] = [];

type SubtaskTokenStats = Pick<TokenUsage, 'input' | 'output' | 'total'>;

function useSubtaskChildrenInSession(childSessionId: string | undefined): RenderMessage[] {
	const childSession = useChatStore(state =>
		childSessionId ? state.sessionsById[childSessionId] : undefined,
	);

	return useMemo(() => {
		if (!childSession) return EMPTY_MESSAGES;
		const projected = projectRuntimeMessages(childSession);
		return projected.length ? projected : EMPTY_MESSAGES;
	}, [childSession]);
}

/**
 * Higher-level hook for UI rendering: returns subtask message, grouped children, and total duration.
 * This keeps UI components from duplicating the parent-card vs child-session lookup logic.
 */
export function useSubtaskThread(
	subtaskId: string,
	sessionId: string,
	_mcpServerNames: string[],
): {
	message?: RenderSubtaskMessage;
	children: RenderMessage[];
	groupedChildren: GroupedResponseItem[];
	totalDurationMs: number;
	tokenStats: SubtaskTokenStats | null;
	childModelId: string | undefined;
} {
	const session = useChatStore(state => state.sessionsById[sessionId]);

	const message = useMemo(() => {
		const found = projectRuntimeMessages(session).find(m => m.id === subtaskId);
		return found && found.kind === 'subtask' ? (found as RenderSubtaskMessage) : undefined;
	}, [session, subtaskId]);

	const childSessionId = (message as { childSessionId?: string } | undefined)?.childSessionId;
	const children = useSubtaskChildrenInSession(childSessionId);

	const groupedChildren = useMemo(() => {
		if (!children.length) return EMPTY_GROUPED;
		const isStreaming = message?.status === 'running';
		const grouped = groupToolMessages(children, _mcpServerNames, isStreaming);
		return grouped.length ? grouped : EMPTY_GROUPED;
	}, [children, _mcpServerNames, message?.status]);

	const totalDurationMs = useMemo(() => {
		return message?.durationMs ?? 0;
	}, [message?.durationMs]);

	// Read token stats and model ID directly from the subtask message
	const tokenStats: SubtaskTokenStats | null = useMemo(() => {
		if (!message?.childTokens) return null;
		const total = message.childTokens.total;
		if (typeof total !== 'number') return null;
		return {
			input: message.childTokens.input,
			output: message.childTokens.output,
			total,
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
