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
	type CommitInfo,
	type RenderAssistantMessage,
	type RenderCompactionMessage,
	type RenderNode,
	type RenderTaskCardNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type SessionStore,
	type TokenUsage,
	type ToolResultView,
	useChatStore,
} from './chatStore';
import { type SettingsState, useSettingsStore } from './settingsStore';
import type { TransientNotification } from './uiStore';
import { type UIState, useUIStore } from './uiStore';

const EMPTY_MESSAGES: RenderNode[] = [];
const EMPTY_COMMITS: CommitInfo[] = [];
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

export function projectSessionMessages(
	state: SessionStore,
	sessionId: string | undefined,
): RenderNode[] {
	if (!sessionId) return EMPTY_MESSAGES;
	const messages = state.messages[sessionId];
	if (!messages || messages.length === 0) return EMPTY_MESSAGES;

	const nodes: RenderNode[] = [];
	const assistantByParent = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (isAssistantMessage(message) && message.parentID) {
			assistantByParent.set(message.parentID, message);
		}
	}

	for (const msg of messages) {
		const msgParts = state.parts[msg.id] ?? [];

		if (msg.role === 'user') {
			const compactionPart = msgParts.find(p => p.type === 'compaction');
			let compaction: RenderCompactionMessage | undefined;
			if (compactionPart && compactionPart.type === 'compaction') {
				const assistantMsg = assistantByParent.get(msg.id);
				const assistantParts = assistantMsg ? (state.parts[assistantMsg.id] ?? []) : [];
				const summary = assistantParts
					.filter(
						p =>
							p.type === 'text' && 'text' in p && !(('synthetic' in p && p.synthetic) as boolean),
					)
					.map(p => ('text' in p ? (p.text as string)?.trim() : '') || '')
					.filter(Boolean)
					.join('\n\n');
				const isStreaming = assistantMsg ? typeof assistantMsg.time.completed !== 'number' : true;
				compaction = {
					type: 'compaction',
					messageId: msg.id,
					auto: compactionPart.auto,
					summary: summary || undefined,
					partId: compactionPart.id,
					assistantMessageId: assistantMsg?.id,
					isStreaming,
					completedAt: assistantMsg?.time.completed,
				};
			}

			nodes.push({
				...(msg as Message),
				kind: 'user',
				message: msg,
				parts: msgParts,
				...(compaction ? { compaction } : {}),
			} satisfies RenderUserMessage);
			continue;
		}

		if (isAssistantMessage(msg) && msg.mode === 'compaction') continue;
		if (isAssistantMessage(msg) && msg.parentID) {
			const parentParts = state.parts[msg.parentID] ?? [];
			if (parentParts.some(p => p.type === 'compaction')) continue;
		}

		const assistantMsg = msg as AssistantMessage;
		const isCompleted = typeof assistantMsg.time.completed === 'number';
		const timestamp = new Date(assistantMsg.time.created).toISOString();

		for (const part of msgParts) {
			if (
				part.type === 'text' &&
				'text' in part &&
				part.text &&
				!(('synthetic' in part && part.synthetic) as boolean)
			) {
				nodes.push({
					kind: 'assistant',
					id: `msg-${part.id}`,
					type: 'assistant',
					content: part.text,
					partId: part.id,
					isStreaming: !isCompleted,
					timestamp,
					agent: assistantMsg.agent,
				} satisfies RenderAssistantMessage);
				continue;
			}

			if (part.type === 'reasoning' && 'text' in part && part.text) {
				const rp = part as import('@opencode-ai/sdk/v2/client').ReasoningPart;
				nodes.push({
					kind: 'thinking',
					id: `thinking-${part.id}`,
					type: 'thinking',
					content: rp.text,
					partId: part.id,
					isStreaming: typeof rp.time.end !== 'number',
					startTime: rp.time.start,
					durationMs: typeof rp.time.end === 'number' ? rp.time.end - rp.time.start : undefined,
					timestamp,
				} satisfies RenderThinkingMessage);
				continue;
			}

			if (part.type === 'tool') {
				const tp = part as ToolPart;
				const status = tp.state.status;
				const isRunning = status === 'pending' || status === 'running';
				const input = 'input' in tp.state ? tp.state.input : {};
				const output = 'output' in tp.state ? (tp.state as { output?: string }).output : undefined;
				const title = 'title' in tp.state ? (tp.state as { title?: string }).title : undefined;
				const metadata =
					tp.metadata ??
					('metadata' in tp.state
						? (tp.state as { metadata?: Record<string, unknown> }).metadata
						: undefined);

				nodes.push({
					kind: 'tool_use',
					id: tp.callID,
					type: 'tool_use',
					toolName: tp.tool,
					toolUseId: tp.callID,
					toolInput: JSON.stringify(input),
					rawInput: input as Record<string, unknown>,
					streamingOutput: output,
					isRunning,
					status,
					title,
					resultContent: output,
					metadata: metadata as Record<string, unknown> | undefined,
					timestamp,
				} satisfies RenderToolUseMessage);
			}
		}
	}

	return materializeTaskCards(state, sessionId, nodes);
}

function materializeTaskCards(
	_state: SessionStore,
	sessionId: string,
	baseItems: RenderNode[],
): RenderNode[] {
	const items: RenderNode[] = [];
	let afterCompletedTask = false;

	for (const item of baseItems) {
		if (item.kind === 'tool_use' && item.toolName.toLowerCase() === 'task') {
			const toolCallId = item.toolUseId;
			const taskInput = item.rawInput ?? {};
			const childSessionId =
				typeof item.metadata?.sessionId === 'string' ? item.metadata.sessionId : undefined;
			const metadataModel =
				item.metadata && typeof item.metadata.model === 'object'
					? (item.metadata.model as { providerID?: string; modelID?: string })
					: undefined;
			const childModelId =
				metadataModel?.providerID && metadataModel?.modelID
					? `${metadataModel.providerID}/${metadataModel.modelID}`
					: undefined;
			const result =
				item.status === 'completed' && typeof item.resultContent === 'string'
					? item.resultContent.trim()
					: undefined;

			const node: RenderTaskCardNode = {
				kind: 'task_card',
				id: toolCallId,
				toolCallId,
				parentSessionId: sessionId,
				parentMessageId: undefined,
				timestamp: item.timestamp,
				status: item.status ?? 'running',
				agent: typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : undefined,
				description: typeof taskInput.description === 'string' ? taskInput.description : undefined,
				prompt: typeof taskInput.prompt === 'string' ? taskInput.prompt : undefined,
				result,
				startTime: item.timestamp,
				childSessionId,
				childSummary: {
					title: typeof taskInput.description === 'string' ? taskInput.description : undefined,
					modelId: childModelId,
					durationMs: undefined,
					tokens: undefined,
					diffStats: { added: 0, removed: 0 },
					childCount: 0,
				},
			};
			items.push(node);
			if (node.status === 'completed') afterCompletedTask = true;
			continue;
		}

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

export const projectRuntimeMessages = (_session: unknown): RenderNode[] => EMPTY_MESSAGES;

function countSessionDescendants(state: SessionStore, sessionId: string): number {
	return collectDescendantSessionIds(state, sessionId).length;
}

export function collectDescendantSessionIds(state: SessionStore, sessionId: string): string[] {
	const queue = [...(state.childSessionIdsByParentId[sessionId] ?? [])];
	const visited = new Set<string>();
	const descendants: string[] = [];
	let head = 0;
	while (head < queue.length) {
		const current = queue[head++];
		if (!current || visited.has(current)) continue;
		visited.add(current);
		descendants.push(current);
		queue.push(...(state.childSessionIdsByParentId[current] ?? []));
	}
	return descendants;
}

export function computeDerivedSessionStats(
	state: SessionStore,
	sessionId: string | undefined,
): { requestCount: number; totalDuration: number; subagentCount: number } {
	if (!sessionId) return EMPTY_DERIVED_STATS;
	const sessionIds = [sessionId, ...collectDescendantSessionIds(state, sessionId)];
	let requestCount = 0;
	let totalDuration = 0;
	for (const currentSessionId of sessionIds) {
		const messages = state.messages[currentSessionId] ?? EMPTY_SDK_MESSAGES;
		for (const msg of messages) {
			if (!isAssistantMessage(msg)) continue;
			const t = msg.tokens;
			const total = t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
			if (total > 0) requestCount += 1;
			if (typeof msg.time.completed === 'number') {
				totalDuration += msg.time.completed - msg.time.created;
			}
		}
	}
	return {
		requestCount,
		totalDuration,
		subagentCount: sessionIds.length - 1,
	};
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
	const trigger = useChatStore(
		useShallow((state: SessionStore) => {
			if (!activeSessionId) return [];
			const msgs = state.messages[activeSessionId] || [];
			return [
				msgs,
				...msgs.map(message => state.parts[message.id]),
				state.sessionStatus[activeSessionId],
			];
		}),
	);
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);
	return useMemo(() => {
		void trigger;
		const state = useChatStore.getState();
		const next = projectSessionMessages(state, activeSessionId);
		if (messagesStructurallyEqual(prevRef.current, next)) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [activeSessionId, trigger]);
};

export const useHasMessages = () => {
	const messages = useMessages();
	return messages.length > 0;
};

export const useChildSessionMessages = (childSessionId: string | undefined) => {
	const trigger = useChatStore(
		useShallow((state: SessionStore) => {
			if (!childSessionId) return [];
			const msgs = state.messages[childSessionId] ?? EMPTY_SDK_MESSAGES;
			return [
				msgs,
				...msgs.map(message => state.parts[message.id]),
				state.sessions,
				state.sessionStatus[childSessionId],
				state.sessionDiff[childSessionId],
				state.childSessionIdsByParentId,
			];
		}),
	);
	const prevRef = useRef<RenderNode[]>(EMPTY_MESSAGES);
	return useMemo(() => {
		void trigger;
		if (!childSessionId) return EMPTY_MESSAGES;
		const next = projectSessionMessages(useChatStore.getState(), childSessionId);
		if (messagesStructurallyEqual(prevRef.current, next)) return prevRef.current;
		prevRef.current = next;
		return next;
	}, [childSessionId, trigger]);
};

export const useChildSessionTitle = (childSessionId: string | undefined) =>
	useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessions.find(s => s.id === childSessionId)?.title;
	});

export const useChildSessionSummary = (childSessionId: string | undefined) => {
	const session = useChatStore((state: SessionStore) => {
		if (!childSessionId) return undefined;
		return state.sessions.find(s => s.id === childSessionId);
	});
	const status = useChatStore((state: SessionStore) =>
		childSessionId ? state.sessionStatus[childSessionId] : undefined,
	);
	const diffs = useChatStore((state: SessionStore) =>
		childSessionId
			? (state.sessionDiff[childSessionId] ?? EMPTY_SESSION_DIFFS)
			: EMPTY_SESSION_DIFFS,
	);
	const messages = useChatStore((state: SessionStore) =>
		childSessionId ? (state.messages[childSessionId] ?? EMPTY_SDK_MESSAGES) : EMPTY_SDK_MESSAGES,
	);
	const childCount = useChatStore((state: SessionStore) =>
		childSessionId ? countSessionDescendants(state, childSessionId) : 0,
	);

	return useMemo(() => {
		const diffStats = diffs.reduce(
			(acc, d) => ({ added: acc.added + d.additions, removed: acc.removed + d.deletions }),
			{ added: 0, removed: 0 },
		);
		let tokens: TokenUsage | undefined;
		if (messages.length > 0) {
			let input = 0;
			let output = 0;
			let cacheRead = 0;
			let total = 0;
			let durationMs = 0;
			for (const msg of messages) {
				if (!isAssistantMessage(msg)) continue;
				const t = msg.tokens;
				input += t.input ?? 0;
				output += t.output ?? 0;
				cacheRead += t.cache?.read ?? 0;
				total += t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
				if (typeof msg.time.completed === 'number') {
					durationMs += msg.time.completed - msg.time.created;
				}
			}
			if (input !== 0 || output !== 0 || total !== 0) {
				tokens = { input, output, total, cacheRead, durationMs };
			}
		}
		return {
			title: session?.title,
			isIdle: status?.type === 'idle',
			diffStats,
			childCount,
			tokens,
			durationMs: tokens?.durationMs,
		};
	}, [childCount, diffs, messages, session?.title, status?.type]);
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
		if (status.type === 'retry') return 'Retrying…';
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
			if (!msgs) continue;
			let lastTotal: number | undefined;
			for (const msg of msgs) {
				if (!isAssistantMessage(msg)) continue;
				const t = msg.tokens;
				lastTotal = t.total ?? t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
			}
			if (lastTotal) usageValues.push(lastTotal);
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

export const useRestoreCommits = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.restoreCommits[sid] ?? EMPTY_COMMITS) : EMPTY_COMMITS;
	});

export const useUnrevertAvailable = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		if (!sid) return false;
		return state.sessionCanUnrevert[sid] ?? false;
	});

export const useRevertedFromMessageId = () =>
	useChatStore((state: SessionStore) => {
		const sid = state.activeSessionId;
		return sid ? (state.revertedFromMessageId[sid] ?? null) : null;
	});

export const useIsImprovingPrompt = () =>
	useChatStore((state: SessionStore) => state.isImprovingPrompt);
export const useImprovingPromptRequestId = () =>
	useChatStore((state: SessionStore) => state.improvingPromptRequestId);
export const usePromptVersions = () => useChatStore((state: SessionStore) => state.promptVersions);

export const useChangedFilesState = () => {
	const activeSessionId = useChatStore((state: SessionStore) => state.activeSessionId);
	const rawDiffs = useChatStore((state: SessionStore) =>
		activeSessionId ? state.sessionDiff[activeSessionId] : undefined,
	);

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

export const useModelContextWindow = () =>
	useSettingsStore((state: SettingsState) => {
		const { selectedModel, opencodeProviders, proxyEndpoints } = state;
		const parsed = parseModelId(selectedModel);
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
				(m: { id: string; contextLength?: number }) => m.id === selectedModel,
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
