/**
 * @file Zustand store selectors — chat, UI, and settings
 * @description Optimized selectors for deriving per-session chat state, UI dropdowns, and settings.
 * Only selectors actually consumed by components are exported here (dead code removed).
 * Uses stable empty-array refs (EMPTY_MESSAGES, etc.) to prevent infinite re-renders with useShallow.
 */

import { useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { parseModelId } from '../../common';
import { sumUsageValues } from '../../common/tokenStats';
import {
	getAvailableModelVariants,
	getConfiguredAgentVariant,
	resolveEffectiveVariant,
} from '../lib/modelVariants';
import {
	type ChangedFile,
	type ChatSession,
	type ChatState,
	type CommitInfo,
	type RenderAssistantMessage,
	type RenderCompactionMessage,
	type RenderNode,
	type RenderTaskCardNode,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type TokenUsage,
	type ToolResultView,
	useChatStore,
} from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import type { TransientNotification } from './uiStore';
import { type UIState, useUIStore } from './uiStore';

// Stable empty array references to prevent infinite re-renders with useShallow
const EMPTY_MESSAGES: RenderNode[] = [];
const EMPTY_COMMITS: CommitInfo[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];
const EMPTY_CUMULATIVE_DIFFS: ChatSession['cumulativeDiffs'] = [];
const EMPTY_NOTIFICATIONS: TransientNotification[] = [];
const EMPTY_PERMISSIONS: import('../../common').SessionPermissionRequest[] = [];
const EMPTY_QUESTIONS: import('../../common').SessionQuestionRequest[] = [];

function getCompactionView(
	messageId: string,
	session: ChatSession,
): RenderCompactionMessage | undefined {
	const userParts = session.runtimeMessagePartsById[messageId] || [];
	const compactionPart = userParts.find(part => part.type === 'compaction');
	if (!compactionPart) return undefined;

	const assistantRecord = session.runtimeMessageRecords.find(
		record => record.role === 'assistant' && record.parentId === messageId,
	);
	const assistantParts = assistantRecord
		? session.runtimeMessagePartsById[assistantRecord.id] || []
		: [];
	const summary = assistantParts
		.filter(part => part.type === 'text' && typeof part.text === 'string' && !part.synthetic)
		.map(part => part.text?.trim() || '')
		.filter(Boolean)
		.join('\n\n');
	const hasIncompleteAssistantParts = assistantParts.some(
		part => typeof part.completedAt !== 'number' && part.state?.status !== 'completed',
	);

	return {
		type: 'compaction',
		messageId,
		auto: compactionPart.auto,
		summary: summary || undefined,
		partId: compactionPart.id,
		...(assistantRecord ? { assistantMessageId: assistantRecord.id } : {}),
		isStreaming: hasIncompleteAssistantParts,
		completedAt: assistantRecord?.completedAt,
	};
}

function getUserMessageText(messageId: string, session: ChatSession): string {
	const parts = session.runtimeMessagePartsById[messageId] || [];
	return parts
		.filter(part => part.type === 'text' && typeof part.text === 'string' && !part.synthetic)
		.map(part => part.text?.trim() || '')
		.filter(Boolean)
		.join('\n\n');
}

export function projectRuntimeMessages(session: ChatSession | undefined): RenderNode[] {
	if (!session) return EMPTY_MESSAGES;

	const runtimeUserMessageIds = new Set(
		session.runtimeMessageRecords
			.filter(message => message.role === 'user')
			.map(message => message.id),
	);

	const passthrough: RenderNode[] = [];
	for (const message of Object.values(session.userMessagesById)) {
		if (typeof message.id === 'string' && !runtimeUserMessageIds.has(message.id)) {
			const compaction = getCompactionView(message.id, session);
			const renderUser: RenderUserMessage = {
				...message,
				id: message.id,
				kind: 'user' as const,
				...(compaction ? { compaction } : {}),
			};
			passthrough.push(renderUser);
		}
	}
	const userMessagesById = session.userMessagesById;

	const runtimeProjected: RenderNode[] = [];
	const seenMessageIds = new Set<string>();
	const projectParts = (
		messageId: string,
		record?: ChatSession['runtimeMessageRecords'][number],
	): void => {
		seenMessageIds.add(messageId);
		// Keep the original arrival order from the store. During streaming, later tool
		// updates can share timestamps with earlier text parts, and re-sorting here
		// makes assistant text jump below tool cards and breaks tool grouping.
		const parts = session.runtimeMessagePartsById[messageId] || [];
		for (const part of parts) {
			const partCompleted = typeof part.completedAt === 'number';
			const recordCompleted = typeof record?.completedAt === 'number';
			const timestamp =
				typeof part.createdAt === 'number'
					? new Date(part.createdAt).toISOString()
					: typeof record?.createdAt === 'number'
						? new Date(record.createdAt).toISOString()
						: '1970-01-01T00:00:00.000Z';

			if (part.type === 'text' && part.text && !part.synthetic) {
				runtimeProjected.push({
					kind: 'assistant',
					id: `msg-${part.id}`,
					type: 'assistant',
					content: part.text,
					partId: part.id,
					isStreaming: record
						? !recordCompleted
						: !partCompleted && part.state?.status !== 'completed',
					timestamp,
					...(record?.agent ? { agent: record.agent } : {}),
				});
				continue;
			}

			if (part.type === 'reasoning' && part.text) {
				runtimeProjected.push({
					kind: 'thinking',
					id: `thinking-${part.id}`,
					type: 'thinking',
					content: part.text,
					partId: part.id,
					isStreaming: !partCompleted && part.state?.status !== 'completed',
					startTime: part.createdAt,
					durationMs:
						typeof part.createdAt === 'number' && typeof part.completedAt === 'number'
							? part.completedAt - part.createdAt
							: undefined,
					timestamp,
				});
				continue;
			}

			if (part.type === 'tool' && part.callId) {
				const isRunning =
					!partCompleted &&
					(part.state?.status === 'pending' ||
						part.state?.status === 'running' ||
						part.state?.status === undefined);
				runtimeProjected.push({
					kind: 'tool_use',
					id: part.callId,
					type: 'tool_use',
					toolName: part.toolName || 'unknown',
					toolUseId: part.callId,
					toolInput: JSON.stringify(part.state?.input || {}),
					rawInput: (part.state?.input as Record<string, unknown>) ?? {},
					streamingOutput: part.state?.output,
					isRunning,
					timestamp,
					...(part.state?.status ? { status: part.state.status } : {}),
					...(part.state?.title ? { title: part.state.title } : {}),
					...(part.state?.output ? { resultContent: part.state.output } : {}),
					...(part.state?.metadata
						? { metadata: part.state.metadata as Record<string, unknown> }
						: {}),
					...(part.normalizedEntry ? { normalizedEntry: part.normalizedEntry } : {}),
				});
			}
		}
	};

	for (const record of session.runtimeMessageRecords) {
		if (record.role === 'user') {
			const user = userMessagesById[record.id];
			const compaction = getCompactionView(record.id, session);
			const fallbackContent = getUserMessageText(record.id, session);
			if (user?.id || compaction || fallbackContent) {
				const renderUser = {
					id: record.id,
					type: 'user',
					content: user?.content || fallbackContent,
					model: user?.model || record.modelId || session.model || 'default',
					timestamp:
						user?.timestamp ||
						(typeof record.createdAt === 'number'
							? new Date(record.createdAt).toISOString()
							: '1970-01-01T00:00:00.000Z'),
					kind: 'user',
					...(user?.agent ? { agent: user.agent } : {}),
					...(user?.attachments ? { attachments: user.attachments } : {}),
					...(user?.normalizedEntry ? { normalizedEntry: user.normalizedEntry } : {}),
					...(compaction ? { compaction } : {}),
				} satisfies RenderUserMessage;
				runtimeProjected.push(renderUser);
			}
			seenMessageIds.add(record.id);
			continue;
		}

		projectParts(record.id, record);
	}

	for (const messageId of Object.keys(session.runtimeMessagePartsById)) {
		if (seenMessageIds.has(messageId)) continue;
		projectParts(messageId);
	}

	// Preserve store arrival order. Live streaming can emit multiple parts with the
	// same timestamps, and sorting here reorders tool/text blocks versus the order
	// established by runtimeMessageRecords and runtimeMessagePartsById.
	return [...passthrough, ...runtimeProjected];
}

/** Compute diff stats from a child session's changedFiles — pure, no hooks. */
function getChildDiffStats(
	state: ChatState,
	childSessionId: string | undefined,
): { added: number; removed: number } {
	if (!childSessionId) return { added: 0, removed: 0 };
	const childSession = state.sessionsById[childSessionId];
	if (!childSession) return { added: 0, removed: 0 };
	return childSession.changedFiles.reduce(
		(acc, file) => ({
			added: acc.added + (file.linesAdded ?? 0),
			removed: acc.removed + (file.linesRemoved ?? 0),
		}),
		{ added: 0, removed: 0 },
	);
}

/**
 * Flat projection of a single session's messages into RenderNode[].
 * Task tool_use nodes are materialized as task_card with childSessionId
 * and lightweight childSummary — NO recursive child transcript embedding.
 * Child session content is rendered by React components (TaskCardItem)
 * that subscribe to child sessions independently via useChildSessionMessages().
 */
export function projectSessionMessages(
	state: ChatState,
	sessionId: string | undefined,
): RenderNode[] {
	if (!sessionId) return EMPTY_MESSAGES;
	const session = state.sessionsById[sessionId];
	if (!session) return EMPTY_MESSAGES;

	const baseItems = projectRuntimeMessages(session);

	// Echo suppression: after a completed task_card, the LLM typically emits
	// an assistant text that paraphrases the task result. Since the task card
	// already shows the result, this echo is redundant. We skip the first
	// assistant text after a completed task_card. Thinking blocks pass through.
	const items: RenderNode[] = [];
	let afterCompletedTask = false;
	for (const item of baseItems) {
		if (item.kind === 'tool_use' && (item.toolName || '').toLowerCase() === 'task') {
			const toolCallId = item.toolUseId;
			const taskInput = item.rawInput ?? {};
			const childSessionId =
				typeof item.metadata?.sessionId === 'string' ? item.metadata.sessionId : undefined;
			const childSessionState = childSessionId ? state.sessionsById[childSessionId] : undefined;
			const derivedTaskStatus: RenderTaskCardNode['status'] = (() => {
				const taskStatus = item.status as RenderToolUseMessage['status'] | undefined;
				if (taskStatus === 'error') return 'error';
				if (taskStatus === 'completed') return 'completed';
				if (taskStatus === 'cancelled') return 'cancelled';
				if (childSessionState?.status === 'Stopped' && !childSessionState.isProcessing) {
					return 'cancelled';
				}
				if (taskStatus === 'pending') return 'pending';
				return 'running';
			})();
			const nestedChildCount = childSessionId
				? (state.childSessionIdsByParentId[childSessionId]?.length ?? 0)
				: 0;
			const diffStats = getChildDiffStats(state, childSessionId);
			const metadataModel =
				item.metadata && typeof item.metadata.model === 'object'
					? (item.metadata.model as { providerID?: string; modelID?: string })
					: undefined;
			const childModelId =
				metadataModel?.providerID && metadataModel?.modelID
					? `${metadataModel.providerID}/${metadataModel.modelID}`
					: childSessionState?.model;
			const result =
				item.status === 'completed' && typeof item.resultContent === 'string'
					? item.resultContent.trim()
					: undefined;
			const childTokens = childSessionId ? aggregateSessionTokens(childSessionState) : undefined;
			const node: RenderTaskCardNode = {
				kind: 'task_card',
				id: toolCallId,
				toolCallId,
				parentSessionId: sessionId,
				parentMessageId: undefined,
				timestamp: item.timestamp,
				status: derivedTaskStatus,
				agent: typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : undefined,
				description: typeof taskInput.description === 'string' ? taskInput.description : undefined,
				prompt: typeof taskInput.prompt === 'string' ? taskInput.prompt : undefined,
				result,
				startTime: item.timestamp,
				childSessionId,
				childSummary: {
					title:
						childSessionState?.title ??
						(typeof taskInput.description === 'string' ? taskInput.description : undefined),
					modelId: childModelId,
					durationMs: childTokens?.durationMs,
					tokens: childTokens,
					diffStats,
					childCount: nestedChildCount,
				},
			};
			items.push(node);
			if (derivedTaskStatus === 'completed') afterCompletedTask = true;
			continue;
		}

		// Suppress the first assistant text after a completed task card (LLM echo).
		// Thinking blocks between the task card and the echo pass through.
		if (afterCompletedTask) {
			if (item.kind === 'thinking') {
				items.push(item);
				continue;
			}
			if (item.kind === 'assistant') {
				afterCompletedTask = false;
				continue;
			}
			afterCompletedTask = false;
		}

		items.push(item);
	}

	return items.length > 0 ? items : EMPTY_MESSAGES;
}

function getActiveSession(state: ChatState): ChatSession | undefined {
	const sid = state.activeSessionId;
	if (!sid) return undefined;
	return state.sessionsById[sid];
}

export const useSessionContextMetrics = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);
	const contextLimit = useModelContextWindow();

	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const session = state.sessionsById[activeSessionId ?? ''];
		if (!session) {
			return {
				context: undefined,
				totalCost: 0,
			};
		}

		let lastAssistantWithTokens: ChatSession['runtimeMessageRecords'][number] | undefined;
		let totalCost = 0;
		for (const message of session.runtimeMessageRecords) {
			if (message.role !== 'assistant') continue;
			if (typeof message.cost === 'number') totalCost += message.cost;
			const total =
				typeof message.tokens?.total === 'number'
					? message.tokens.total
					: (message.tokens?.input ?? 0) +
						(message.tokens?.output ?? 0) +
						(message.tokens?.reasoning ?? 0) +
						(message.tokens?.cacheRead ?? 0) +
						(message.tokens?.cacheWrite ?? 0);
			if (total > 0) lastAssistantWithTokens = message;
		}

		if (!lastAssistantWithTokens?.tokens) {
			return { context: undefined, totalCost };
		}

		const tokens = lastAssistantWithTokens.tokens;
		const total =
			typeof tokens.total === 'number'
				? tokens.total
				: (tokens.input ?? 0) +
					(tokens.output ?? 0) +
					(tokens.reasoning ?? 0) +
					(tokens.cacheRead ?? 0) +
					(tokens.cacheWrite ?? 0);

		return {
			totalCost,
			context: {
				limit: contextLimit,
				input: tokens.input ?? 0,
				output: tokens.output ?? 0,
				reasoning: tokens.reasoning ?? 0,
				cacheRead: tokens.cacheRead ?? 0,
				cacheWrite: tokens.cacheWrite ?? 0,
				total,
				usage: contextLimit > 0 ? Math.min((total / contextLimit) * 100, 100) : null,
			},
		};
	}, [activeSessionId, lastActive, contextLimit]);
};

export const useDerivedSessionStats = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);

	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const session = state.sessionsById[activeSessionId ?? ''];
		if (!session) {
			return {
				requestCount: 0,
				totalDuration: 0,
				subagentCount: 0,
			};
		}

		let requestCount = 0;
		let totalDuration = 0;
		for (const message of session.runtimeMessageRecords) {
			if (message.role !== 'assistant') continue;
			const tokens = message.tokens;
			const total =
				typeof tokens?.total === 'number'
					? tokens.total
					: (tokens?.input ?? 0) +
						(tokens?.output ?? 0) +
						(tokens?.reasoning ?? 0) +
						(tokens?.cacheRead ?? 0) +
						(tokens?.cacheWrite ?? 0);
			if (total > 0) {
				requestCount += 1;
			}

			const createdAt = message.createdAt;
			const completedAt = message.completedAt;
			if (
				typeof createdAt === 'number' &&
				typeof completedAt === 'number' &&
				completedAt >= createdAt
			) {
				totalDuration += completedAt - createdAt;
			}
		}

		let subagentCount = 0;
		for (const item of projectSessionMessages(state, session.id)) {
			if (item.kind === 'task_card') {
				subagentCount += 1;
			}
		}

		return {
			requestCount,
			totalDuration,
			subagentCount,
		};
	}, [activeSessionId, lastActive]);
};

// ============================================
// Chat Store Selectors
// ============================================

/**
 * Lightweight structural comparator for projected message arrays.
 * Checks length, IDs, kinds, timestamps, and subtask-specific fields
 * (status, tokens, diffStats) — enough to detect meaningful changes
 * without the cost of a full deep-equal traversal.
 */
function messagesStructurallyEqual(prev: RenderNode[], next: RenderNode[]): boolean {
	if (prev.length !== next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		const p = prev[i];
		const n = next[i];
		if (p.id !== n.id || p.kind !== n.kind || p.timestamp !== n.timestamp) return false;
		// For subtask nodes, check fields that change during streaming
		if (p.kind === 'task_card' && n.kind === 'task_card') {
			const pt = p as RenderTaskCardNode;
			const nt = n as RenderTaskCardNode;
			const ps = pt.childSummary;
			const ns = nt.childSummary;
			if (
				pt.status !== nt.status ||
				ps.tokens?.total !== ns.tokens?.total ||
				ps.diffStats.added !== ns.diffStats.added ||
				ps.diffStats.removed !== ns.diffStats.removed ||
				ps.childCount !== ns.childCount ||
				pt.result !== nt.result
			) {
				return false;
			}
		}
		// For assistant messages, check streaming state and content length
		if (p.kind === 'assistant' && n.kind === 'assistant') {
			const pa = p as RenderAssistantMessage;
			const na = n as RenderAssistantMessage;
			if (pa.isStreaming !== na.isStreaming || pa.content.length !== na.content.length) {
				return false;
			}
		}
		// For tool_use, check running state
		if (p.kind === 'tool_use' && n.kind === 'tool_use') {
			const pt = p as RenderToolUseMessage;
			const nt = n as RenderToolUseMessage;
			if (pt.isRunning !== nt.isRunning || pt.status !== nt.status) return false;
		}
	}
	return true;
}

/** Select messages array for active session.
 * Subscribes to session's lastActive — re-renders when the session changes.
 * No tree-wide subscription: child sessions are rendered by their own components. */
export const useMessages = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);

	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const next = projectSessionMessages(state, activeSessionId);
		if (messagesStructurallyEqual(prevRef.current, next)) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [activeSessionId, lastActive]);
};

/** Select whether active session has any messages (lightweight — avoids subscribing to full array) */
export const useHasMessages = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);
	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const session = state.sessionsById[activeSessionId ?? ''];
		return projectRuntimeMessages(session).length > 0;
	}, [activeSessionId, lastActive]);
};

/**
 * Subscribe to a child session's projected messages independently.
 * Each TaskCardItem calls this hook with its childSessionId — the component
 * re-renders only when that specific child session changes, not the whole tree.
 */
export const useChildSessionMessages = (childSessionId: string | undefined) => {
	const lastActive = useChatStore((state: ChatState) =>
		childSessionId ? state.sessionsById[childSessionId]?.lastActive : 0,
	);
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);

	return useMemo(() => {
		void lastActive;
		if (!childSessionId) return EMPTY_MESSAGES;
		const state = useChatStore.getState();
		const next = projectSessionMessages(state, childSessionId);
		if (messagesStructurallyEqual(prevRef.current, next)) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [childSessionId, lastActive]);
};

/** Subscribe to a child session's title independently. */
export const useChildSessionTitle = (childSessionId: string | undefined) =>
	useChatStore((state: ChatState) =>
		childSessionId ? state.sessionsById[childSessionId]?.title : undefined,
	);

/** Select processing state for active session */
export const useIsProcessing = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isProcessing ?? false);

/** Select auto-retrying state for active session */
export const useIsAutoRetrying = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.isAutoRetrying ?? false);

/** Select retry info for active session */
export const useRetryInfo = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.retryInfo ?? null);

/** Select active session ID */
export const useActiveSessionId = () => useChatStore((state: ChatState) => state.activeSessionId);

/** Select status for active session */
export const useChatStatus = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.status ?? 'Ready');

/** Select streaming tool ID for active session */
export const useStreamingToolId = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.streamingToolId ?? null);

/** Select current tool activity for active session */
export const useToolActivity = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.toolActivity ?? null);

/** Select editing message ID */
export const useEditingMessageId = () => useChatStore((state: ChatState) => state.editingMessageId);

/** Select edit draft for a specific message (returns undefined if no draft) */
export const useEditDraft = (messageId: string | undefined) =>
	useChatStore((state: ChatState) => (messageId ? state.editDrafts[messageId] : undefined));

/** Select chat input state and setter (active session) */
export const useChatInputState = () => {
	const updateSession = useChatStore((state: ChatState) => state.actions.updateSession);
	const input = useChatStore((state: ChatState) => getActiveSession(state)?.input ?? '');
	const setInput = useCallback((value: string) => updateSession({ input: value }), [updateSession]);
	return { input, setInput };
};

/** Select only the input string (primitive — no unnecessary re-renders) */
export const useStoreInput = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.input ?? '');

/** Select chat actions only (stable references) */
export const useChatActions = () => useChatStore((state: ChatState) => state.actions);

/** Aggregate subagent token totals from task_card summaries.
 * Each TaskCardItem independently renders its child — we only need
 * the top-level childSummary.tokens for the parent session stats. */
export const useSubagentTokenTotals = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);
	const prevRef = useRef(0);

	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const items = projectSessionMessages(state, activeSessionId);
		const usageValues: Array<number | undefined> = [];
		for (const msg of items) {
			if (msg.kind !== 'task_card') continue;
			const node = msg as RenderTaskCardNode;
			if (node.childSummary.tokens?.total) {
				usageValues.push(node.childSummary.tokens.total);
			}
		}
		const next = sumUsageValues(usageValues);
		if (next === prevRef.current) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [activeSessionId, lastActive]);
};

/** Select active model ID derived from the latest assistant record with a model. */
export const useActiveModelID = () => {
	const session = useChatStore((state: ChatState) => getActiveSession(state));
	return useMemo(() => {
		if (!session) return undefined;
		for (let i = session.runtimeMessageRecords.length - 1; i >= 0; i--) {
			const modelId = session.runtimeMessageRecords[i]?.modelId;
			if (typeof modelId === 'string' && modelId) {
				return modelId;
			}
		}
		return undefined;
	}, [session]);
};

/** Select per-turn token data for active session */
const EMPTY_TURN_TOKENS: Record<string, TokenUsage> = {};
export const useTurnTokens = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.turnTokens ?? EMPTY_TURN_TOKENS);

/** Select turn tokens for a specific message ID (avoids full-map subscription) */
export const useMessageTurnTokens = (messageId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!messageId) return undefined;
		return getActiveSession(state)?.turnTokens[messageId];
	});

/** Whether the last message is an assistant message that is actively streaming */
export const useIsLastMessageStreaming = () => {
	const activeSessionId = useChatStore((state: ChatState) => state.activeSessionId);
	const lastActive = useChatStore((state: ChatState) =>
		activeSessionId ? state.sessionsById[activeSessionId]?.lastActive : 0,
	);

	return useMemo(() => {
		void lastActive;
		const state = useChatStore.getState();
		const session = state.sessionsById[activeSessionId ?? ''];
		if (!session || !session.isProcessing) return false;
		const msgs = projectRuntimeMessages(session);
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i];
			if (msg.kind === 'assistant') {
				return !!msg.isStreaming;
			}
			if (msg.kind === 'user') return false;
		}
		return false;
	}, [activeSessionId, lastActive]);
};

/** Context usage percentage, rounded to 1% to reduce rerender frequency */
export const useContextPercentage = () => {
	const metrics = useSessionContextMetrics();
	return Math.floor(metrics.context?.usage ?? 0);
};

/** Select restore commits for active session */
export const useRestoreCommits = () =>
	useChatStore(state => getActiveSession(state)?.restoreCommits ?? EMPTY_COMMITS);

/** Select unrevert available state for active session */
export const useUnrevertAvailable = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.unrevertAvailable ?? false);

/** Select the message ID from which subsequent messages are reverted (dimmed) */
export const useRevertedFromMessageId = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.revertedFromMessageId ?? null);

/** Select prompt improver loading state */
export const useIsImprovingPrompt = () =>
	useChatStore((state: ChatState) => state.isImprovingPrompt);

/** Select prompt improver request ID */
export const useImprovingPromptRequestId = () =>
	useChatStore((state: ChatState) => state.improvingPromptRequestId);

/** Select prompt versions (original + improved) for toggle support */
export const usePromptVersions = () => useChatStore((state: ChatState) => state.promptVersions);

/** Select changed files panel state (active session) — totalStats removed to prevent cascading rerenders */
export const useChangedFilesState = () =>
	useChatStore(
		useShallow((state: ChatState) => ({
			changedFiles: getActiveSession(state)?.changedFiles ?? EMPTY_CHANGED_FILES,
			cumulativeDiffs: getActiveSession(state)?.cumulativeDiffs ?? EMPTY_CUMULATIVE_DIFFS,
		})),
	);

export const useHasTodos = () =>
	useChatStore((state: ChatState) => {
		const todos = getActiveSession(state)?.todos;
		return Array.isArray(todos) && todos.length > 0;
	});

/** Select canonical todo state from the active session */
export const useTodoState = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.todos ?? null);

export const usePendingPermissions = () =>
	useChatStore(
		useShallow(
			(state: ChatState) => getActiveSession(state)?.pendingPermissions ?? EMPTY_PERMISSIONS,
		),
	);

export const usePendingQuestions = () =>
	useChatStore(
		useShallow((state: ChatState) => {
			const questions = getActiveSession(state)?.pendingQuestions ?? EMPTY_QUESTIONS;
			if (questions.length === 0) return EMPTY_QUESTIONS;
			const pending = questions.filter(q => !('resolved' in q && q.resolved));
			return pending.length === 0 ? EMPTY_QUESTIONS : pending;
		}),
	);

export const useQuestionRequestByToolUseId = (toolUseId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		return getActiveSession(state)?.pendingQuestions.find(
			request => request.tool?.callID === toolUseId,
		);
	});

// ============================================
// Tool-specific Selectors (active session)
// ============================================

export const useToolResultByToolId = (toolUseId: string | undefined, sessionId?: string) => {
	const session = useChatStore((state: ChatState) => {
		const targetId = sessionId || state.activeSessionId;
		return targetId ? state.sessionsById[targetId] : undefined;
	});

	return useMemo(() => {
		if (!session || !toolUseId) return undefined;

		for (const parts of Object.values(session.runtimeMessagePartsById)) {
			for (const part of parts) {
				if (part.type !== 'tool' || part.callId !== toolUseId) continue;
				const status = part.state?.status;
				if (status !== 'completed' && status !== 'error') continue;
				return {
					id: `res-${toolUseId}`,
					type: 'tool_result' as const,
					toolUseId,
					toolName: part.toolName || 'unknown',
					content: part.state?.output || '',
					isError: status === 'error',
					title: part.state?.title,
					metadata:
						part.state?.metadata && typeof part.state.metadata === 'object'
							? (part.state.metadata as Record<string, unknown>)
							: undefined,
					timestamp:
						typeof part.completedAt === 'number'
							? new Date(part.completedAt).toISOString()
							: typeof part.createdAt === 'number'
								? new Date(part.createdAt).toISOString()
								: undefined,
				} satisfies ToolResultView;
			}
		}

		return undefined;
	}, [session, toolUseId]);
};

export const useAccessRequestByToolUseId = (toolUseId: string | undefined) => {
	const pending = useChatStore((state: ChatState) => {
		if (!toolUseId) return undefined;
		return getActiveSession(state)?.pendingPermissions.find(
			request => request.tool?.callID === toolUseId,
		);
	});

	return useMemo(() => {
		if (!pending) return undefined;
		return {
			id: `access-${pending.id}`,
			type: 'access_request' as const,
			requestId: pending.id,
			tool: pending.permission,
			input: pending.metadata,
			pattern: pending.patterns[0],
			toolUseId: pending.tool?.callID,
			resolved: false,
			approved: false,
			metadata: pending.metadata,
			timestamp:
				typeof pending.metadata?.timestamp === 'string'
					? pending.metadata.timestamp
					: new Date().toISOString(),
		} as const;
	}, [pending]);
};

/**
 * Find the first unresolved access_request related to a subtask.
 * Matches by:
 *  1. toolUseId — permission on the `task` tool itself (before child session exists)
 *  2. childSessionId — permission from inside the running child session
 */
export const useSubtaskAccessRequest = useAccessRequestByToolUseId;

// ============================================
// UI Store Selectors
// ============================================

export const useActiveModal = () => useUIStore((state: UIState) => state.activeModal);

export const useFilePickerState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showFilePicker: state.showFilePicker,
			fileFilter: state.fileFilter,
			workspaceFiles: state.workspaceFiles,
			setShowFilePicker: state.actions.setShowFilePicker,
			setFileFilter: state.actions.setFileFilter,
		})),
	);

/** Lightweight file picker controls — excludes workspaceFiles to avoid re-renders */
export const useFilePickerControls = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showFilePicker: state.showFilePicker,
			setShowFilePicker: state.actions.setShowFilePicker,
			setFileFilter: state.actions.setFileFilter,
		})),
	);

export const useSlashCommandsState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showSlashCommands: state.showSlashCommands,
			slashFilter: state.slashFilter,
			setShowSlashCommands: state.actions.setShowSlashCommands,
			setSlashFilter: state.actions.setSlashFilter,
		})),
	);

export const useModelDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showModelDropdown: state.showModelDropdown,
			setShowModelDropdown: state.actions.setShowModelDropdown,
		})),
	);

export const useHistoryDropdownState = () =>
	useUIStore(
		useShallow((state: UIState) => ({
			showHistoryDropdown: state.showHistoryDropdown,
			setShowHistoryDropdown: state.actions.setShowHistoryDropdown,
			conversationList: state.conversationList,
		})),
	);

export const useUIActions = () => useUIStore(state => state.actions);

// ============================================
// Settings Store Selectors
// ============================================

export const useMcpServers = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.mcpServers));

// PERF: chatStore.actions is a stable reference (created once in zustand create()),
// so we read it once outside the hook to avoid subscribing to chatStore on every render.
const _chatActions = () => useChatStore.getState().actions;

export const useModelSelection = () => {
	const chatActions = _chatActions();

	const setSessionAgent = useCallback(
		(agent: string | undefined, sessionId?: string) =>
			chatActions.updateSession({ agent }, sessionId),
		[chatActions],
	);
	const setSessionModel = useCallback(
		(model: string | undefined, sessionId?: string) =>
			chatActions.updateSession({ model }, sessionId),
		[chatActions],
	);

	return useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			selectedModel: state.selectedModel,
			proxyEndpoints: state.proxyEndpoints,
			opencodeProviders: state.opencodeProviders,
			enabledOpenCodeModels: state.enabledOpenCodeModels,
			disabledProviders: state.disabledProviders,
			getModelVariant: state.actions.getModelVariant,
			setModelVariant: state.actions.setModelVariant,
			setSelectedModel: state.actions.setSelectedModel,
			getSessionAgent: chatActions.getSessionAgent,
			setSessionAgent,
			getSessionModel: chatActions.getSessionModel,
			setSessionModel,
		})),
	);
};

export const useMainSettings = () =>
	useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			workspaceName: state.workspaceName,
			platformInfo: state.platformInfo,
			selectedModel: state.selectedModel,
			setSettings: state.actions.setSettings,
		})),
	);

export const useSettingsActions = () => useSettingsStore(state => state.actions);

const DEFAULT_CONTEXT_WINDOW = 200000;

export const useModelContextWindow = () =>
	useSettingsStore((state: SettingsState) => {
		const { selectedModel, opencodeProviders, proxyEndpoints } = state;
		const parsed = parseModelId(selectedModel);
		if (parsed) {
			// Check proxy endpoint models
			if (
				parsed.providerId === 'proxy' ||
				parsed.providerId === 'oai' ||
				parsed.providerId.startsWith('oai-')
			) {
				for (const endpoint of proxyEndpoints) {
					const epModel = endpoint.models.find(m => m.id === parsed.modelId);
					if (epModel?.contextLength) return epModel.contextLength;
				}
			}
			// Check OpenCode providers (includes models.dev metadata)
			const provider = opencodeProviders.find(
				(p: { id: string; models: Array<{ id: string; limit?: { context?: number } }> }) =>
					p.id === parsed.providerId,
			);
			if (provider) {
				const model = provider.models.find(
					(m: { id: string; limit?: { context?: number } }) => m.id === parsed.modelId,
				);
				if (model?.limit?.context) return model.limit.context;
			}
		}
		// Fallback: check proxy endpoint models by raw ID
		for (const endpoint of proxyEndpoints) {
			const epModel = endpoint.models.find(
				(m: { id: string; contextLength?: number }) => m.id === selectedModel,
			);
			if (epModel?.contextLength) return epModel.contextLength;
		}
		return DEFAULT_CONTEXT_WINDOW;
	});

/** All transient notifications (top overlay) */
export const useTransientNotifications = () =>
	useUIStore((state: UIState) => state.notifications ?? EMPTY_NOTIFICATIONS);

// ============================================
// Message Queue Selectors
// ============================================

import type { QueuedMessageData } from '../../common/protocol';

const EMPTY_QUEUE: QueuedMessageData[] = [];

/** Select queued messages for active session */
export const useQueuedMessages = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.queuedMessages ?? EMPTY_QUEUE);

/** Whether the active session has queued messages */
export const useHasQueuedMessages = () =>
	useChatStore((state: ChatState) => (getActiveSession(state)?.queuedMessages?.length ?? 0) > 0);

/** Draft attachments restored from a cancelled queued message */
export const useDraftAttachments = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.draftAttachments);

/** Draft agent restored from a cancelled queued message */
export const useDraftAgent = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.draftAgent);

/** Reactive selector for the active session's agent (build = undefined, plan = 'plan', etc.) */
export const useSessionAgent = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.agent);

/** Reactive selector for the active session's model override. */
export const useSessionModel = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.model);

/** Reactive selector for the effective model's thinking effort variant. */
export const useSessionVariant = () => {
	const activeSessionModel = useChatStore((state: ChatState) => getActiveSession(state)?.model);
	const activeSessionAgent = useChatStore((state: ChatState) => getActiveSession(state)?.agent);
	return useSettingsStore((state: SettingsState) => {
		const effectiveModel = activeSessionModel ?? state.selectedModel;
		if (!effectiveModel || effectiveModel === 'default') return undefined;
		const variants = getAvailableModelVariants(
			state.opencodeProviders,
			effectiveModel,
			state.proxyEndpoints,
		);
		const selected = state.modelVariants[effectiveModel];
		const agentId = activeSessionAgent ?? 'build';
		const configured = getConfiguredAgentVariant({
			agent:
				state.agents.items.find(agent => agent.id === agentId) ??
				state.subagents.items.find(agent => agent.name === agentId),
			effectiveModel,
			variants,
		});
		return resolveEffectiveVariant({ variants, selected, configured });
	});
};

/** Reactive selector for the active session's auto-accept permissions toggle. */
export const useSessionAutoAccept = () =>
	useChatStore((state: ChatState) => getActiveSession(state)?.autoAccept ?? false);

// ============================================
// Relation Selectors
// ============================================

const EMPTY_CHILDREN: string[] = [];

/** Get direct child session IDs for a given parent session. */
export const useSessionChildren = (sessionId: string | undefined) =>
	useChatStore((state: ChatState) =>
		sessionId ? (state.childSessionIdsByParentId[sessionId] ?? EMPTY_CHILDREN) : EMPTY_CHILDREN,
	);

/** Get the child session ID spawned by a task tool call. */
export const useTaskChildSession = (toolCallId: string | undefined) =>
	useChatStore((state: ChatState) => {
		if (!toolCallId) return undefined;
		for (const session of Object.values(state.sessionsById)) {
			for (const parts of Object.values(session.runtimeMessagePartsById)) {
				for (const part of parts) {
					if (part.type !== 'tool' || part.callId !== toolCallId) continue;
					const metadata =
						part.state?.metadata && typeof part.state.metadata === 'object'
							? (part.state.metadata as { sessionId?: string })
							: undefined;
					if (typeof metadata?.sessionId === 'string') {
						return metadata.sessionId;
					}
				}
			}
		}
		return undefined;
	});

/** Get the originating tool call ID for a child session. */
export const useOriginatingToolCall = (sessionId: string | undefined) =>
	useChatStore((state: ChatState) =>
		sessionId ? state.originatingToolCallBySessionId[sessionId] : undefined,
	);

/** Get descendant count for a session from derived relations. */
export const useDescendantCount = (sessionId: string | undefined) =>
	useChatStore((state: ChatState) => (sessionId ? countSessionDescendants(state, sessionId) : 0));

/** Get all descendants of a session (BFS traversal over store graph). */
export function useSessionDescendants(sessionId: string | undefined): string[] {
	return useChatStore(
		useCallback(
			(state: ChatState) => {
				if (!sessionId) return EMPTY_CHILDREN;
				const result: string[] = [];
				const queue = [sessionId];
				const visited = new Set<string>();
				visited.add(sessionId);
				let head = 0;
				while (head < queue.length) {
					const current = queue[head++];
					if (!current) break;
					const children = state.childSessionIdsByParentId[current];
					if (!children) continue;
					for (const childId of children) {
						if (visited.has(childId)) continue;
						visited.add(childId);
						result.push(childId);
						queue.push(childId);
					}
				}
				return result.length > 0 ? result : EMPTY_CHILDREN;
			},
			[sessionId],
		),
	);
}

/** Get lineage (ancestry chain) from a session up to root. */
export function useSessionLineage(sessionId: string | undefined): string[] {
	return useChatStore(
		useCallback(
			(state: ChatState) => {
				if (!sessionId) return EMPTY_CHILDREN;
				const lineage: string[] = [];
				let current = sessionId;
				let depth = 0;
				while (depth < 50) {
					const parentId = state.sessionsById[current]?.parentSessionId;
					if (!parentId) break;
					lineage.push(parentId);
					current = parentId;
					depth++;
				}
				return lineage.length > 0 ? lineage : EMPTY_CHILDREN;
			},
			[sessionId],
		),
	);
}

function aggregateSessionTokens(session: ChatSession | undefined): TokenUsage | undefined {
	if (!session) return undefined;
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let total = 0;
	let durationMs = 0;
	for (const usage of Object.values(session.turnTokens)) {
		input += usage.input ?? 0;
		output += usage.output ?? 0;
		cacheRead += usage.cacheRead ?? 0;
		total += usage.total ?? usage.usage ?? 0;
		durationMs += usage.durationMs ?? 0;
	}
	if (input === 0 && output === 0 && total === 0 && cacheRead === 0 && durationMs === 0) {
		return undefined;
	}
	return { input, output, total, cacheRead, durationMs };
}

function countSessionDescendants(state: ChatState, sessionId: string): number {
	let count = 0;
	const queue = [...(state.childSessionIdsByParentId[sessionId] ?? [])];
	const visited = new Set<string>();
	let head = 0;
	while (head < queue.length) {
		const current = queue[head++];
		if (!current || visited.has(current)) continue;
		visited.add(current);
		count += 1;
		queue.push(...(state.childSessionIdsByParentId[current] ?? []));
	}
	return count;
}
