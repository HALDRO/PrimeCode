import { useMemo } from 'react';
import { type GroupedResponseItem, groupToolMessages } from '../components/chat/toolGrouping';
import type { RenderMessage, RenderSubtaskMessage, TokenUsage } from '../store';
import { type ChatState, useChatStore } from '../store/chatStore';
import { projectRuntimeMessages } from '../store/selectors';

// Stable empty array reference to prevent infinite re-renders
const EMPTY_MESSAGES: RenderMessage[] = [];
const EMPTY_GROUPED: GroupedResponseItem[] = [];

type SubtaskTokenStats = Pick<TokenUsage, 'input' | 'output' | 'total'>;

function hasCanonicalTaskResult(message: RenderSubtaskMessage | undefined): boolean {
	return typeof message?.result === 'string' && message.result.trim().length > 0;
}

function findSubtaskCard(
	sessionsById: ChatState['sessionsById'],
	parentSessionId: string,
	subtaskId: string,
): RenderSubtaskMessage | undefined {
	const parentSession = sessionsById[parentSessionId];
	if (!parentSession) return undefined;
	const found = projectRuntimeMessages(parentSession).find(m => m.id === subtaskId);
	return found && found.kind === 'subtask' ? (found as RenderSubtaskMessage) : undefined;
}

function buildInlineSessionPreviewMessages(
	sessionsById: ChatState['sessionsById'],
	sessionId: string | undefined,
	excludeTerminalAssistantText: boolean,
): RenderMessage[] {
	if (!sessionId) return EMPTY_MESSAGES;
	const childSession = sessionsById[sessionId];
	if (!childSession) return EMPTY_MESSAGES;

	const projected = projectRuntimeMessages(childSession, {
		materializeTaskCards: false,
		compactToolOutputs: true,
		excludeTerminalAssistantText,
	});
	return projected.length > 0 ? projected : EMPTY_MESSAGES;
}

function useInlineChildSessionPreview(
	childSessionId: string | undefined,
	excludeTerminalAssistantText: boolean,
): RenderMessage[] {
	const sessionsById = useChatStore(state => state.sessionsById);

	return useMemo(() => {
		const projected = buildInlineSessionPreviewMessages(
			sessionsById,
			childSessionId,
			excludeTerminalAssistantText,
		);
		return projected.length ? projected : EMPTY_MESSAGES;
	}, [sessionsById, childSessionId, excludeTerminalAssistantText]);
}

/**
 * Derived view model for a task-linked child session preview rendered inside a subtask card.
 * This stays UI-only: canonical data lives in session/message/part state.
 */
export function useSubtaskPreview(
	subtaskId: string,
	parentSessionId: string,
	_mcpServerNames: string[],
): {
	message?: RenderSubtaskMessage;
	children: RenderMessage[];
	groupedChildren: GroupedResponseItem[];
	childSessionTitle: string | undefined;
	totalDurationMs: number;
	tokenStats: SubtaskTokenStats | null;
	childModelId: string | undefined;
	diffStats: { added: number; removed: number };
	taskResultEntry: RenderSubtaskMessage['normalizedEntry'];
	taskResultContent: string;
} {
	const sessionsById = useChatStore(state => state.sessionsById);

	const message = useMemo(
		() => findSubtaskCard(sessionsById, parentSessionId, subtaskId),
		[sessionsById, parentSessionId, subtaskId],
	);

	const childSessionId = (message as { childSessionId?: string } | undefined)?.childSessionId;
	const childSessionTitle = childSessionId ? sessionsById[childSessionId]?.title : undefined;
	const shouldProjectTaskResult = hasCanonicalTaskResult(message);
	const visiblePreview = useInlineChildSessionPreview(childSessionId, shouldProjectTaskResult);

	const groupedChildren = useMemo(() => {
		if (!visiblePreview.length) return EMPTY_GROUPED;
		const isStreaming = message?.status === 'running';
		const grouped = groupToolMessages(visiblePreview, _mcpServerNames, isStreaming);
		return grouped.length ? grouped : EMPTY_GROUPED;
	}, [visiblePreview, _mcpServerNames, message?.status]);

	const totalDurationMs = useMemo(() => {
		return message?.durationMs ?? message?.childTokens?.durationMs ?? 0;
	}, [message?.durationMs, message?.childTokens?.durationMs]);

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
	const diffStats = useMemo(() => {
		if (!childSessionId) return { added: 0, removed: 0 };
		const childSession = sessionsById[childSessionId];
		if (!childSession) return { added: 0, removed: 0 };

		const cumulative = childSession.cumulativeDiffs ?? [];
		if (cumulative.length > 0) {
			return cumulative.reduce(
				(acc, diff) => ({
					added: acc.added + (diff.additions ?? 0),
					removed: acc.removed + (diff.deletions ?? 0),
				}),
				{ added: 0, removed: 0 },
			);
		}

		const changedFiles = childSession.changedFiles ?? [];
		return changedFiles.reduce(
			(acc, file) => ({
				added: acc.added + (file.linesAdded ?? 0),
				removed: acc.removed + (file.linesRemoved ?? 0),
			}),
			{ added: 0, removed: 0 },
		);
	}, [sessionsById, childSessionId]);
	const taskResultContent = shouldProjectTaskResult ? (message?.result ?? '').trim() : '';
	const taskResultEntry = shouldProjectTaskResult ? message?.normalizedEntry : undefined;

	return {
		message,
		children: visiblePreview,
		groupedChildren,
		childSessionTitle,
		totalDurationMs,
		tokenStats,
		childModelId,
		diffStats,
		taskResultEntry,
		taskResultContent,
	};
}
