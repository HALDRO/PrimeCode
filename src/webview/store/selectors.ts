/**
 * @file Zustand selectors for the SDK-native chat store.
 */

import type {
	AssistantMessage,
	Message,
	SnapshotFileDiff,
	ToolPart,
} from '@opencode-ai/sdk/v2/client';
import { useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { parseModelId } from '../../common';
import type { QueuedMessageData } from '../../common/protocol';
import { computeTurnUsage, sumUsageValues } from '../../common/tokenStats';
import {
	getAvailableModelVariants,
	getConfiguredAgentVariant,
	resolveEffectiveVariant,
} from '../lib/modelVariants';
import {
	type ChangedFile,
	type RenderAssistantMessage,
	type RenderCompactionMessage,
	type RenderNode,
	type SessionStore,
	type TokenUsage,
	type ToolResultView,
	useChatStore,
} from './chatStore';
import { collectDescendantSessionIds, computeDerivedSessionStats } from './projector';
import { type SettingsState, useSettingsStore } from './settingsStore';
import type { TransientNotification } from './uiStore';
import { type UIState, useUIStore } from './uiStore';

const EMPTY_MESSAGES: RenderNode[] = [];
const EMPTY_CHANGED_FILES: ChangedFile[] = [];
const EMPTY_CUMULATIVE_DIFFS: Array<{
	file: string;
	additions: number;
	deletions: number;
	status?: string;
}> = [];
const EMPTY_NOTIFICATIONS: TransientNotification[] = [];
const EMPTY_PERMISSIONS: import('@opencode-ai/sdk/v2/client').PermissionRequest[] = [];
const EMPTY_QUESTIONS: import('@opencode-ai/sdk/v2/client').QuestionRequest[] = [];
const EMPTY_TURN_TOKENS: Record<string, TokenUsage> = {};
const EMPTY_QUEUE: QueuedMessageData[] = [];
const EMPTY_CHILDREN: string[] = [];
const EMPTY_SDK_MESSAGES: Message[] = [];
const EMPTY_SESSION_DIFFS: SnapshotFileDiff[] = [];
const DEFAULT_CONTEXT_WINDOW = 200000;

function isAssistantMessage(msg: Message): msg is AssistantMessage {
	return msg.role === 'assistant';
}

function getAssistantTokenTotal(msg: AssistantMessage): number {
	const t = msg.tokens;
	return (
		(t.input ?? 0) +
		(t.output ?? 0) +
		(t.reasoning ?? 0) +
		(t.cache?.read ?? 0) +
		(t.cache?.write ?? 0)
	);
}

function getAssistantSnapshotTotal(msg: AssistantMessage): number {
	return getAssistantTokenTotal(msg);
}

function computeAssistantUsage(messages: Message[] | undefined): TokenUsage | undefined {
	if (!messages || messages.length === 0) return undefined;

	let previousSessionSnapshotTotal = 0;
	let usageTotal = 0;
	let latestInput = 0;
	let latestOutput = 0;
	let latestCacheRead = 0;
	let durationMs = 0;

	for (const msg of messages) {
		if (!isAssistantMessage(msg)) continue;

		const snapshotTotal = getAssistantSnapshotTotal(msg);
		if (snapshotTotal > 0) {
			const usage = computeTurnUsage(msg.tokens, { previousSessionSnapshotTotal });
			usageTotal += usage.usageTokens;
			previousSessionSnapshotTotal = usage.nextSessionSnapshotTotal;
			latestInput = msg.tokens.input ?? 0;
			latestOutput = msg.tokens.output ?? 0;
			latestCacheRead = msg.tokens.cache?.read ?? 0;
		}

		if (typeof msg.time.completed === 'number') {
			durationMs += msg.time.completed - msg.time.created;
		}
	}

	if (usageTotal <= 0) return undefined;

	return {
		input: latestInput,
		output: latestOutput,
		total: usageTotal,
		usage: usageTotal,
		cacheRead: latestCacheRead,
		durationMs,
	};
}

function buildTurnTokenMap(messages: Message[] | undefined): Record<string, TokenUsage> {
	if (!messages || messages.length === 0) return EMPTY_TURN_TOKENS;

	const turnTokens: Record<string, TokenUsage> = {};
	let previousSessionSnapshotTotal = 0;

	for (const msg of messages) {
		if (!isAssistantMessage(msg) || !msg.parentID) continue;

		const existing = turnTokens[msg.parentID];
		const previousTurnSnapshotTotal =
			typeof existing?.total === 'number' && existing.total > 0 ? existing.total : undefined;

		const usage = computeTurnUsage(msg.tokens, {
			previousTurnSnapshotTotal,
			previousSessionSnapshotTotal,
		});
		if (usage.totalTokens > 0) {
			previousSessionSnapshotTotal = usage.nextSessionSnapshotTotal;
		}

		const durationMs =
			typeof msg.time.completed === 'number' ? msg.time.completed - msg.time.created : undefined;

		turnTokens[msg.parentID] = {
			input: msg.tokens.input,
			output: msg.tokens.output,
			total: usage.totalTokens > 0 ? usage.totalTokens : (existing?.total ?? 0),
			usage: (existing?.usage ?? 0) + usage.usageTokens,
			cacheRead: msg.tokens.cache.read,
			durationMs: (existing?.durationMs ?? 0) + (durationMs ?? 0),
		};
	}

	return Object.keys(turnTokens).length > 0 ? turnTokens : EMPTY_TURN_TOKENS;
}

export const projectRuntimeMessages = (_session: unknown): RenderNode[] => EMPTY_MESSAGES;

// Re-export pure functions from projector for backward compatibility
export { collectDescendantSessionIds, computeDerivedSessionStats } from './projector';

// ---------------------------------------------------------------------------
// Component-level subscription hooks (Phase 1.4)
// These allow components to subscribe to individual nodes/sections
// instead of the entire message list, reducing re-renders during streaming.
// ---------------------------------------------------------------------------

const EMPTY_NODE_IDS: string[] = [];

/** Subscribe to the ordered list of RenderNode IDs for the active session. */
export const useNodeIds = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return EMPTY_NODE_IDS;
		return state.materializedViews[sid]?.nodeIds ?? EMPTY_NODE_IDS;
	});

/** Subscribe to a single RenderNode by ID from the active session's materialized view. */
export const useRenderNode = (nodeId: string) =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.materializedViews[sid]?.nodesById[nodeId];
	});

/** Subscribe to a single RenderNode by ID from a specific session's materialized view. */
export const useSessionRenderNode = (sessionId: string | undefined, nodeId: string) =>
	useChatStore((state: SessionStore) => {
		if (!sessionId) return undefined;
		return state.materializedViews[sessionId]?.nodesById[nodeId];
	});

/** Subscribe to the materialized view version тАФ useful for knowing when any update happened. */
export const useMaterializedVersion = (sessionId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!sessionId) return 0;
		return state.materializedViews[sessionId]?.version ?? 0;
	});

// ---------------------------------------------------------------------------

function countSessionDescendants(state: SessionStore, sessionId: string): number {
	return collectDescendantSessionIds(state, sessionId).length;
}

function messagesStructurallyEqual(prev: RenderNode[], next: RenderNode[]): boolean {
	if (prev.length !== next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		const p = prev[i];
		const n = next[i];
		if (p.id !== n.id || p.kind !== n.kind) return false;
		if (p.kind === 'task_card' && n.kind === 'task_card') {
			if (
				p.status !== n.status ||
				p.childSessionId !== n.childSessionId ||
				p.childSummary.title !== n.childSummary.title ||
				p.childSummary.tokens?.total !== n.childSummary.tokens?.total ||
				p.result !== n.result
			) {
				return false;
			}
		}
		if (p.kind === 'assistant' && n.kind === 'assistant') {
			if (p.isStreaming !== n.isStreaming || p.content !== n.content) return false;
		}
		if (p.kind === 'tool_use' && n.kind === 'tool_use') {
			if (
				p.isRunning !== n.isRunning ||
				p.status !== n.status ||
				p.resultContent !== n.resultContent
			)
				return false;
		}
	}
	return true;
}

export const useMessages = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const view = useChatStore((state: SessionStore) => {
		if (!activeSessionId) return undefined;
		return state.materializedViews[activeSessionId];
	});
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);
	return useMemo(() => {
		if (!view || view.nodeIds.length === 0) return EMPTY_MESSAGES;
		// Reconstruct ordered array from nodesById using nodeIds
		const next: RenderNode[] = [];
		for (const id of view.nodeIds) {
			const node = view.nodesById[id];
			if (node) next.push(node);
		}
		if (next.length === 0) return EMPTY_MESSAGES;
		// For delta-only updates, check if the array is structurally the same
		if (!view.lastUpdateWasStructural && messagesStructurallyEqual(prevRef.current, next)) {
			return prevRef.current;
		}
		prevRef.current = next;
		return next;
	}, [view]);
};

export const useHasMessages = () => {
	const messages = useMessages();
	return messages.length > 0;
};

export const useChildSessionMessages = (childSessionId: string | undefined) => {
	const view = useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.materializedViews[childSessionId];
	});
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);
	return useMemo(() => {
		if (!childSessionId || !view || view.nodeIds.length === 0) return EMPTY_MESSAGES;
		const next: RenderNode[] = [];
		for (const id of view.nodeIds) {
			const node = view.nodesById[id];
			if (node) next.push(node);
		}
		if (next.length === 0) return EMPTY_MESSAGES;
		if (!view.lastUpdateWasStructural && messagesStructurallyEqual(prevRef.current, next)) {
			return prevRef.current;
		}
		prevRef.current = next;
		return next;
	}, [childSessionId, view]);
};

export const useChildSessionTitle = (childSessionId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessions.find(s => s.id === childSessionId)?.title;
	});

export const useChildSessionAgent = (childSessionId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessionAgent[childSessionId];
	});

export const useChildSessionSlug = (childSessionId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessions.find(s => s.id === childSessionId)?.slug;
	});

export const useChildSessionSummary = (childSessionId: string | undefined) => {
	const session = useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessions.find(s => s.id === childSessionId);
	});
	const status = useChatStore((state: SessionStore) =>
		childSessionId ? state.sessionStatus[childSessionId] : undefined,
	);
	const messages = useChatStore((state: SessionStore) =>
		childSessionId ? (state.messages[childSessionId] ?? EMPTY_SDK_MESSAGES) : EMPTY_SDK_MESSAGES,
	);
	const childCount = useChatStore((state: SessionStore) =>
		childSessionId ? countSessionDescendants(state, childSessionId) : 0,
	);

	return useMemo(() => {
		const summary = session?.summary;
		const diffStats = {
			added:
				summary?.additions ??
				(summary?.diffs ?? EMPTY_SESSION_DIFFS).reduce((sum, d) => sum + d.additions, 0),
			removed:
				summary?.deletions ??
				(summary?.diffs ?? EMPTY_SESSION_DIFFS).reduce((sum, d) => sum + d.deletions, 0),
		};

		const tokens = computeAssistantUsage(messages);

		return {
			title: session?.title,
			isIdle: status?.type === 'idle',
			diffStats,
			childCount,
			tokens,
			durationMs: tokens?.durationMs,
		};
	}, [childCount, messages, session?.summary, session?.title, status?.type]);
};

export const useIsProcessing = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return false;
		const status = state.sessionStatus[sid];
		return status?.type === 'busy' || status?.type === 'retry';
	});

export const useIsAutoRetrying = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return false;
		return state.sessionStatus[sid]?.type === 'retry';
	});

export const useRetryInfo = () =>
	useChatStore(
		useShallow((state: SessionStore) => {
			const sid = state.activeSessionId;
			if (!sid) return null;
			const status = state.sessionStatus[sid];
			if (status?.type !== 'retry') return null;
			return { attempt: status.attempt, message: status.message, nextRetryAt: String(status.next) };
		}),
	);

export const useActiveSessionId = () =>
	useChatStore((state: SessionStore) => state.activeSessionId);

export const useChatStatus = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return 'Ready';
		const status = state.sessionStatus[sid];
		if (!status) return 'Ready';
		if (status.type === 'busy') return 'Working...';
		if (status.type === 'retry') return 'RetryingтАж';
		return 'Ready';
	});

export const useStreamingToolId = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return null;
		const msgs = state.messages[sid];
		if (!msgs) return null;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const parts = state.parts[msgs[i].id];
			if (!parts) continue;
			for (let j = parts.length - 1; j >= 0; j--) {
				const p = parts[j];
				if (p.type === 'tool' && (p as ToolPart).state.status === 'running') {
					return (p as ToolPart).callID;
				}
			}
		}
		return null;
	});

export const useToolActivity = () =>
	useChatStore(
		useShallow((state: SessionStore) => {
			const sid = state.activeSessionId;
			if (!sid) return null;
			const msgs = state.messages[sid];
			if (!msgs) return null;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const parts = state.parts[msgs[i].id];
				if (!parts) continue;
				for (let j = parts.length - 1; j >= 0; j--) {
					const p = parts[j];
					if (p.type === 'tool' && (p as ToolPart).state.status === 'running') {
						const tp = p as ToolPart;
						return { toolName: tp.tool, label: `Running ${tp.tool}...`, toolUseId: tp.callID };
					}
				}
			}
			return null;
		}),
	);

export const useEditingMessageId = () =>
	useChatStore((state: SessionStore) => state.editingMessageId);
export const useEditDraft = (messageId: string | undefined) =>
	useChatStore((state: SessionStore) => (messageId ? state.editDrafts[messageId] : undefined));

export const useChatInputState = () => {
	const actions = useChatStore((state: SessionStore) => state.actions);
	const input = useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.sessionInput[sid] ?? '') : '';
	});
	const setInput = useCallback((value: string) => actions.updateSessionInput(value), [actions]);
	return useMemo(() => ({ input, setInput }), [input, setInput]);
};

export const useStoreInput = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.sessionInput[sid] ?? '') : '';
	});

export const useChatActions = () => useChatStore((state: SessionStore) => state.actions);

export const useSubagentTokenTotals = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const { childSessionIdsByParentId, allMessages } = useChatStore(
		useShallow((state: SessionStore) => ({
			childSessionIdsByParentId: state.childSessionIdsByParentId,
			allMessages: state.messages,
		})),
	);
	const prevRef = useRef(0);
	const descendantSessionIds = useMemo(() => {
		if (!activeSessionId) return EMPTY_CHILDREN;
		return collectDescendantSessionIds(
			{
				childSessionIdsByParentId,
			} as SessionStore,
			activeSessionId,
		);
	}, [activeSessionId, childSessionIdsByParentId]);
	return useMemo(() => {
		const usageValues: Array<number | undefined> = [];

		for (const childSessionId of descendantSessionIds) {
			const msgs = allMessages[childSessionId];
			usageValues.push(computeAssistantUsage(msgs)?.usage);
		}

		const next = sumUsageValues(usageValues);
		if (next === prevRef.current) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [allMessages, descendantSessionIds]);
};

export const useActiveModelID = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		const msgs = state.messages[sid];
		if (!msgs) return undefined;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const msg = msgs[i];
			if (isAssistantMessage(msg) && msg.modelID) return msg.modelID;
		}
		return undefined;
	});

export const useTurnTokens = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const messages = useChatStore((state: SessionStore) =>
		activeSessionId ? state.messages[activeSessionId] : undefined,
	);
	return useMemo(() => buildTurnTokenMap(messages), [messages]);
};

export const useMessageTurnTokens = (messageId: string | undefined) =>
	useChatStore(
		useShallow((state: SessionStore) => {
			if (!messageId) return undefined;
			const sid = state.activeSessionId;
			if (!sid) return undefined;
			const msgs = state.messages[sid];
			return buildTurnTokenMap(msgs)[messageId];
		}),
	);

export const useCompactionMessage = (messageId: string | undefined) => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const messages = useChatStore((state: SessionStore) =>
		activeSessionId ? (state.messages[activeSessionId] ?? EMPTY_SDK_MESSAGES) : EMPTY_SDK_MESSAGES,
	);
	const partsByMessageId = useChatStore((state: SessionStore) => state.parts);
	const prevRef = useRef<RenderCompactionMessage | undefined>(undefined);
	return useMemo(() => {
		if (!messageId || !activeSessionId) return undefined;
		const parts = partsByMessageId[messageId] ?? [];
		const compactionPart = parts.find(p => p.type === 'compaction');
		if (!compactionPart) return undefined;
		const assistantMsg = messages.find(
			m => isAssistantMessage(m) && (m as AssistantMessage).parentID === messageId,
		) as AssistantMessage | undefined;
		const assistantParts = assistantMsg ? (partsByMessageId[assistantMsg.id] ?? []) : [];
		const summary = assistantParts
			.filter(p => p.type === 'text' && 'text' in p)
			.map(p => ('text' in p ? String(p.text)?.trim() : '') || '')
			.filter(Boolean)
			.join('\n\n');
		const next: RenderCompactionMessage = {
			type: 'compaction',
			messageId,
			auto: compactionPart.type === 'compaction' ? compactionPart.auto : undefined,
			summary: summary || undefined,
			partId: compactionPart.id,
			assistantMessageId: assistantMsg?.id,
			isStreaming: assistantMsg ? typeof assistantMsg.time.completed !== 'number' : true,
			completedAt: assistantMsg?.time.completed,
		};
		const prev = prevRef.current;
		if (
			prev?.messageId === next.messageId &&
			prev?.isStreaming === next.isStreaming &&
			prev?.completedAt === next.completedAt &&
			(prev?.summary ?? '') === (next.summary ?? '')
		) {
			return prev;
		}
		prevRef.current = next;
		return next;
	}, [activeSessionId, messageId, messages, partsByMessageId]);
};

export const useIsLastMessageStreaming = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const messages = useMessages();
	const status = useChatStore((state: SessionStore) =>
		activeSessionId ? state.sessionStatus[activeSessionId] : undefined,
	);
	return useMemo(() => {
		if (!activeSessionId) return false;
		if (!status || status.type !== 'busy') return false;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].kind === 'assistant')
				return !!(messages[i] as RenderAssistantMessage).isStreaming;
			if (messages[i].kind === 'user') return false;
		}
		return false;
	}, [activeSessionId, messages, status]);
};

export const useContextPercentage = () => {
	const metrics = useSessionContextMetrics();
	return Math.floor(metrics.context?.usage ?? 0);
};

export const useRevertedFromMessageId = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return null;
		const session = state.sessions.find(item => item.id === sid);
		return session?.revert?.messageID ?? null;
	});

export const useIsImprovingPrompt = () =>
	useChatStore((state: SessionStore) => state.isImprovingPrompt);
export const useImprovingPromptRequestId = () =>
	useChatStore((state: SessionStore) => state.improvingPromptRequestId);
export const usePromptVersions = () => useChatStore((state: SessionStore) => state.promptVersions);

export const useChangedFilesState = () => {
	const rawDiffs = useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.sessionDiff[sid] : undefined;
	});

	const cumulativeDiffs = useMemo(() => {
		if (!rawDiffs || rawDiffs.length === 0) return EMPTY_CUMULATIVE_DIFFS;
		return rawDiffs.map(d => ({
			file: d.file,
			additions: d.additions,
			deletions: d.deletions,
			status: d.status,
		}));
	}, [rawDiffs]);

	return useMemo(() => ({ changedFiles: EMPTY_CHANGED_FILES, cumulativeDiffs }), [cumulativeDiffs]);
};

export const useIsActiveChildSession = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return false;
		const session = state.sessions.find(s => s.id === sid);
		return !!session?.parentID;
	});

export const useHasTodos = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return false;
		const todos = state.todos[sid];
		return Array.isArray(todos) && todos.length > 0;
	});

export const useTodoState = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.todos[sid] ?? null) : null;
	});

export const usePendingPermissions = () =>
	useChatStore(
		useShallow((state: SessionStore) => {
			const sid = state.activeSessionId;
			return sid ? (state.permissions[sid] ?? EMPTY_PERMISSIONS) : EMPTY_PERMISSIONS;
		}),
	);

export const usePendingQuestions = () =>
	useChatStore(
		useShallow((state: SessionStore) => {
			const sid = state.activeSessionId;
			const questions = sid ? (state.questions[sid] ?? EMPTY_QUESTIONS) : EMPTY_QUESTIONS;
			if (questions.length === 0) return EMPTY_QUESTIONS;
			return questions;
		}),
	);

export const useQuestionRequestByToolUseId = (toolUseId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!toolUseId) return undefined;
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.questions[sid]?.find(q => q.tool?.callID === toolUseId);
	});

export const useToolResultByToolId = (toolUseId: string | undefined, sessionId?: string) => {
	const targetSessionId = useChatStore((state: SessionStore) => sessionId || state.activeSessionId);
	const messages = useChatStore((state: SessionStore) =>
		targetSessionId ? (state.messages[targetSessionId] ?? EMPTY_SDK_MESSAGES) : EMPTY_SDK_MESSAGES,
	);
	const parts = useChatStore((state: SessionStore) => state.parts);
	const prevRef = useRef<ToolResultView | undefined>(undefined);
	return useMemo(() => {
		if (!toolUseId) return undefined;
		for (const msg of messages) {
			const messageParts = parts[msg.id];
			if (!messageParts) continue;
			for (const part of messageParts) {
				if (part.type !== 'tool') continue;
				const tp = part as ToolPart;
				if (tp.callID !== toolUseId) continue;
				const status = tp.state.status;
				if (status !== 'completed' && status !== 'error') continue;
				const output = 'output' in tp.state ? ((tp.state as { output?: string }).output ?? '') : '';
				const title = 'title' in tp.state ? (tp.state as { title?: string }).title : undefined;
				const metadata =
					tp.metadata ??
					('metadata' in tp.state
						? (tp.state as { metadata?: Record<string, unknown> }).metadata
						: undefined);
				const next: ToolResultView = {
					id: `res-${toolUseId}`,
					type: 'tool_result',
					toolUseId,
					toolName: tp.tool,
					content: output,
					isError: status === 'error',
					title,
					metadata: metadata as Record<string, unknown> | undefined,
				};
				const prev = prevRef.current;
				if (
					prev &&
					prev.toolUseId === next.toolUseId &&
					prev.content === next.content &&
					prev.isError === next.isError &&
					prev.title === next.title
				) {
					return prev;
				}
				prevRef.current = next;
				return next;
			}
		}
		return undefined;
	}, [messages, parts, toolUseId]);
};

export const useAccessRequestByToolUseId = (toolUseId: string | undefined) => {
	const pending = useChatStore((state: SessionStore) => {
		if (!toolUseId) return undefined;
		const sid = state.activeSessionId;
		if (!sid) return undefined;
		return state.permissions[sid]?.find(r => r.tool?.callID === toolUseId);
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
				typeof pending.metadata?.timestamp === 'string' ? pending.metadata.timestamp : pending.id,
		} as const;
	}, [pending]);
};

export const useSubtaskAccessRequest = useAccessRequestByToolUseId;

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
export const useMcpServers = () =>
	useSettingsStore(useShallow((state: SettingsState) => state.mcpServers));

const _chatActions = () => useChatStore.getState().actions;

export const useModelSelection = () => {
	const chatActions = _chatActions();
	const setSessionAgent = useCallback(
		(agent: string | undefined, sessionId?: string) =>
			chatActions.updateSessionAgent(agent, sessionId),
		[chatActions],
	);
	const setSessionModel = useCallback(
		(model: string | undefined, sessionId?: string) =>
			chatActions.updateSessionModel(model, sessionId),
		[chatActions],
	);
	return useSettingsStore(
		useShallow((state: SettingsState) => ({
			provider: state.provider,
			lastSelectedModel: state.lastSelectedModel,
			proxyEndpoints: state.proxyEndpoints,
			opencodeProviders: state.opencodeProviders,
			enabledOpenCodeModels: state.enabledOpenCodeModels,
			disabledProviders: state.disabledProviders,
			getModelVariant: state.actions.getModelVariant,
			setModelVariant: state.actions.setModelVariant,
			setLastSelectedModel: state.actions.setLastSelectedModel,
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
			lastSelectedModel: state.lastSelectedModel,
			setSettings: state.actions.setSettings,
		})),
	);

export const useSettingsActions = () => useSettingsStore(state => state.actions);

export const useModelContextWindow = () =>
	useChatStore((chatState: SessionStore) => {
		const sid = chatState.activeSessionId;
		const sessionModel = sid ? chatState.sessionModel[sid] : undefined;
		if (!sessionModel) return DEFAULT_CONTEXT_WINDOW;
		const { opencodeProviders, proxyEndpoints } = useSettingsStore.getState();
		const parsed = parseModelId(sessionModel);
		if (parsed) {
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
		for (const endpoint of proxyEndpoints) {
			const epModel = endpoint.models.find(
				(m: { id: string; contextLength?: number }) => m.id === sessionModel,
			);
			if (epModel?.contextLength) return epModel.contextLength;
		}
		return DEFAULT_CONTEXT_WINDOW;
	});

export const useTransientNotifications = () =>
	useUIStore((state: UIState) => state.notifications ?? EMPTY_NOTIFICATIONS);

export const useQueuedMessages = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.queuedMessages[sid] ?? EMPTY_QUEUE) : EMPTY_QUEUE;
	});

export const useHasQueuedMessages = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.queuedMessages[sid]?.length ?? 0) > 0 : false;
	});

export const useDraftAttachments = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.draftAttachments[sid] : undefined;
	});

export const useDraftAgent = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.draftAgent[sid] : undefined;
	});

export const useSessionAgent = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.sessionAgent[sid] : undefined;
	});

export const useSessionModel = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.sessionModel[sid] : undefined;
	});

export const useSessionVariant = () => {
	const activeSessionModel = useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.sessionModel[sid] : undefined;
	});
	const activeSessionAgent = useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? state.sessionAgent[sid] : undefined;
	});
	return useSettingsStore((state: SettingsState) => {
		const sessionModelId = activeSessionModel;
		if (!sessionModelId || sessionModelId === 'default') return undefined;
		const variants = getAvailableModelVariants(
			state.opencodeProviders,
			sessionModelId,
			state.proxyEndpoints,
		);
		const selected = state.modelVariants[sessionModelId];
		const agentId = activeSessionAgent ?? 'build';
		const configured = getConfiguredAgentVariant({
			agent:
				state.agents.items.find(agent => agent.id === agentId) ??
				state.subagents.items.find(agent => agent.name === agentId),
			effectiveModel: sessionModelId,
			variants,
		});
		return resolveEffectiveVariant({ variants, selected, configured });
	});
};

export const useSessionAutoAccept = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.sessionAutoAccept[sid] ?? false) : false;
	});

export const useSessionChildren = (sessionId: string | undefined) =>
	useChatStore((state: SessionStore) =>
		sessionId ? (state.childSessionIdsByParentId[sessionId] ?? EMPTY_CHILDREN) : EMPTY_CHILDREN,
	);

export const useTaskChildSession = (toolCallId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!toolCallId) return undefined;
		for (const [childId, callId] of Object.entries(state.originatingToolCallBySessionId)) {
			if (callId === toolCallId) return childId;
		}
		return undefined;
	});

export const useOriginatingToolCall = (sessionId: string | undefined) =>
	useChatStore((state: SessionStore) =>
		sessionId ? state.originatingToolCallBySessionId[sessionId] : undefined,
	);

export const useDescendantCount = (sessionId: string | undefined) =>
	useChatStore((state: SessionStore) =>
		sessionId ? countSessionDescendants(state, sessionId) : 0,
	);

export function useSessionDescendants(sessionId: string | undefined): string[] {
	return useChatStore(
		useCallback(
			(state: SessionStore) => {
				if (!sessionId) return EMPTY_CHILDREN;
				const result = collectDescendantSessionIds(state, sessionId);
				return result.length > 0 ? result : EMPTY_CHILDREN;
			},
			[sessionId],
		),
	);
}

export function useSessionLineage(sessionId: string | undefined): string[] {
	return useChatStore(
		useCallback(
			(state: SessionStore) => {
				if (!sessionId) return EMPTY_CHILDREN;
				const lineage: string[] = [];
				let current = sessionId;
				let depth = 0;
				while (depth < 50) {
					const session = state.sessions.find(s => s.id === current);
					const parentId = session?.parentID;
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

const EMPTY_CONTEXT_METRICS: ContextMetricsResult = { context: undefined, totalCost: 0 };
const EMPTY_DERIVED_STATS = { requestCount: 0, totalDuration: 0, subagentCount: 0 };

type ContextMetricsResult = {
	totalCost: number;
	context:
		| {
				limit: number;
				input: number;
				output: number;
				reasoning: number;
				cacheRead: number;
				cacheWrite: number;
				total: number;
				usage: number | null;
		  }
		| undefined;
};

export const useSessionContextMetrics = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const messages = useChatStore((state: SessionStore) =>
		activeSessionId ? (state.messages[activeSessionId] ?? EMPTY_SDK_MESSAGES) : EMPTY_SDK_MESSAGES,
	);
	const contextLimit = useModelContextWindow();
	const prevRef = useRef<ContextMetricsResult>(EMPTY_CONTEXT_METRICS);
	return useMemo(() => {
		if (!activeSessionId) return EMPTY_CONTEXT_METRICS;
		let lastAssistantTokens: AssistantMessage['tokens'] | undefined;
		let totalCost = 0;
		for (const msg of messages) {
			if (!isAssistantMessage(msg)) continue;
			totalCost += msg.cost ?? 0;
			const t = msg.tokens;
			const total = t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
			if (total > 0) lastAssistantTokens = t;
		}
		if (!lastAssistantTokens) {
			if (prevRef.current.totalCost === totalCost && prevRef.current.context === undefined)
				return prevRef.current;
			const next: ContextMetricsResult = { context: undefined, totalCost };
			prevRef.current = next;
			return next;
		}
		const t = lastAssistantTokens;
		const total = t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
		const next = {
			totalCost,
			context: {
				limit: contextLimit,
				input: t.input,
				output: t.output,
				reasoning: t.reasoning,
				cacheRead: t.cache.read,
				cacheWrite: t.cache.write,
				total,
				usage: contextLimit > 0 ? Math.min((total / contextLimit) * 100, 100) : null,
			},
		};
		const prev = prevRef.current;
		if (
			prev.totalCost === next.totalCost &&
			prev.context?.total === next.context.total &&
			prev.context?.limit === next.context.limit
		) {
			return prev;
		}
		prevRef.current = next;
		return next;
	}, [activeSessionId, messages, contextLimit]);
};

export const useDerivedSessionStats = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const { messages, childSessionIdsByParentId } = useChatStore(
		useShallow((state: SessionStore) => ({
			messages: state.messages,
			childSessionIdsByParentId: state.childSessionIdsByParentId,
		})),
	);
	const prevRef = useRef(EMPTY_DERIVED_STATS);
	const statsInput = useMemo(() => {
		if (!activeSessionId) return EMPTY_DERIVED_STATS;
		return computeDerivedSessionStats(
			{
				messages,
				childSessionIdsByParentId,
			} as SessionStore,
			activeSessionId,
		);
	}, [activeSessionId, childSessionIdsByParentId, messages]);
	return useMemo(() => {
		const next = statsInput;
		const prev = prevRef.current;
		if (
			prev.requestCount === next.requestCount &&
			prev.totalDuration === next.totalDuration &&
			prev.subagentCount === next.subagentCount
		) {
			return prev;
		}
		prevRef.current = next;
		return next;
	}, [statsInput]);
};

