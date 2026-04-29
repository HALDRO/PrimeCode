/**
 * @file projector.ts
 * @description Pure projection layer: transforms raw store state into UI-ready view models.
 *
 * Two modes of operation:
 * 1. Full rebuild (projectSession) — called on structural changes (new message, new part, session switch)
 * 2. Incremental delta (applyDelta) — called on message.part.delta (streaming tokens), O(1)
 *
 * This module has NO React or Zustand dependencies — it operates on plain data only.
 * All functions are pure and can be tested independently.
 */

import type { AssistantMessage, Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { computeTurnUsage } from '../../common/tokenStats';
import type {
	RenderAssistantMessage,
	RenderCompactionMessage,
	RenderNode,
	RenderTaskCardNode,
	RenderThinkingMessage,
	RenderToolUseMessage,
	RenderUserMessage,
	SessionStore,
} from './chatStore';

// ---------------------------------------------------------------------------
// MaterializedView — the cached projection output stored in SessionStore
// ---------------------------------------------------------------------------

export interface MaterializedView {
	/** Ordered RenderNode IDs for this session */
	nodeIds: string[];
	/** Individual RenderNode by stable ID */
	nodesById: Record<string, RenderNode>;
	/** Pre-grouped sections for the main chat viewport */
	sections: MessageSection[];
	/** Maps tool part IDs to their node IDs (callID) for delta lookups */
	toolPartIdToCallId: Record<string, string>;
	/** Precomputed per-turn token usage keyed by user message id */
	turnTokensByParentId: Record<string, import('./chatStore').TokenUsage>;
	/** Latest assistant model used in this session */
	activeModelId?: string;
	/** Latest running tool metadata for lightweight status selectors */
	toolActivity: { toolName: string; label: string; toolUseId: string } | null;
	/** Latest running tool call id */
	streamingToolId: string | null;
	/** Whether the last assistant render node is still streaming */
	isLastAssistantStreaming: boolean;
	/** Version counter — bumped on every update (structural or delta) */
	version: number;
	/** True if last update was structural (new message/part added/removed) */
	lastUpdateWasStructural: boolean;
}

const EMPTY_VIEW: MaterializedView = {
	nodeIds: [],
	nodesById: {},
	sections: [],
	toolPartIdToCallId: {},
	turnTokensByParentId: {},
	activeModelId: undefined,
	toolActivity: null,
	streamingToolId: null,
	isLastAssistantStreaming: false,
	version: 0,
	lastUpdateWasStructural: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAssistantMessage(msg: Message): msg is AssistantMessage {
	return msg.role === 'assistant';
}

function buildTurnTokenMap(
	messages: Message[] | undefined,
): Record<string, import('./chatStore').TokenUsage> {
	if (!messages || messages.length === 0) return {};

	const turnTokens: Record<string, import('./chatStore').TokenUsage> = {};
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

	return turnTokens;
}

function getLatestAssistantModelId(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (isAssistantMessage(msg) && msg.modelID) return msg.modelID;
	}
	return undefined;
}

function getRunningToolMeta(
	messages: Message[],
	parts: Record<string, Part[]>,
): { toolName: string; label: string; toolUseId: string } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const messageParts = parts[messages[i].id];
		if (!messageParts) continue;
		for (let j = messageParts.length - 1; j >= 0; j--) {
			const part = messageParts[j];
			if (part.type !== 'tool') continue;
			const toolPart = part as ToolPart;
			if (toolPart.state.status !== 'running') continue;
			return {
				toolName: toolPart.tool,
				label: `Running ${toolPart.tool}...`,
				toolUseId: toolPart.callID,
			};
		}
	}
	return null;
}

function getLastAssistantStreaming(nodes: RenderNode[]): boolean {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		if (node.kind === 'assistant') return Boolean(node.isStreaming);
		if (node.kind === 'user') return false;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Full projection: Message[] + Part[] → RenderNode[]
// This is the existing projectSessionMessages logic, extracted as a pure function.
// ---------------------------------------------------------------------------

function projectMessages(messages: Message[], parts: Record<string, Part[]>): RenderNode[] {
	if (messages.length === 0) return [];

	const nodes: RenderNode[] = [];
	const assistantByParent = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (isAssistantMessage(message) && message.parentID) {
			assistantByParent.set(message.parentID, message);
		}
	}

	for (const msg of messages) {
		const msgParts = parts[msg.id] ?? [];

		if (msg.role === 'user') {
			const compactionPart = msgParts.find(p => p.type === 'compaction');
			let compaction: RenderCompactionMessage | undefined;
			if (compactionPart && compactionPart.type === 'compaction') {
				const assistantMsg = assistantByParent.get(msg.id);
				const assistantParts = assistantMsg ? (parts[assistantMsg.id] ?? []) : [];
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
			const parentParts = parts[msg.parentID] ?? [];
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

				nodes.push({
					kind: 'tool_use',
					id: tp.callID,
					type: 'tool_use',
					toolName: tp.tool,
					toolUseId: tp.callID,
					rawInput: input as Record<string, unknown>,
					streamingOutput: output,
					isRunning,
					status,
					title,
					timestamp,
				} satisfies RenderToolUseMessage);
			}
		}
	}

	return nodes;
}

// ---------------------------------------------------------------------------
// Task card materialization
// ---------------------------------------------------------------------------

function materializeTaskCards(
	sessionId: string,
	baseItems: RenderNode[],
	parts: Record<string, Part[]> = {},
): RenderNode[] {
	const items: RenderNode[] = [];
	let afterCompletedTask = false;

	for (const item of baseItems) {
		if (item.kind === 'tool_use' && item.toolName.toLowerCase() === 'task') {
			const toolCallId = item.toolUseId;
			const taskInput = item.rawInput ?? {};
			let taskMetadata: Record<string, unknown> | undefined;
			let taskResult: string | undefined;
			for (const messageParts of Object.values(parts)) {
				for (const part of messageParts) {
					if (part.type !== 'tool') continue;
					const toolPart = part as ToolPart;
					if (toolPart.callID !== toolCallId) continue;
					taskMetadata = (toolPart.metadata ??
						('metadata' in toolPart.state
							? ((toolPart.state as { metadata?: Record<string, unknown> }).metadata ?? undefined)
							: undefined)) as Record<string, unknown> | undefined;
					taskResult =
						'output' in toolPart.state ? (toolPart.state.output ?? undefined) : undefined;
					break;
				}
				if (taskMetadata || taskResult !== undefined) break;
			}
			const childSessionId =
				typeof taskMetadata?.sessionId === 'string' ? taskMetadata.sessionId : undefined;
			const metadataModel =
				taskMetadata && typeof taskMetadata.model === 'object'
					? (taskMetadata.model as { providerID?: string; modelID?: string })
					: undefined;
			const childModelId =
				metadataModel?.providerID && metadataModel?.modelID
					? `${metadataModel.providerID}/${metadataModel.modelID}`
					: undefined;
			const result =
				item.status === 'completed' && typeof taskResult === 'string'
					? taskResult.trim()
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

	return items;
}

// ---------------------------------------------------------------------------
// Build nodesById index from flat node array
// ---------------------------------------------------------------------------

function buildNodesById(nodes: RenderNode[]): Record<string, RenderNode> {
	const map: Record<string, RenderNode> = {};
	for (const node of nodes) {
		map[node.id] = node;
	}
	return map;
}

// ---------------------------------------------------------------------------
// Public API: Full projection (structural changes)
// ---------------------------------------------------------------------------

/**
 * Full projection rebuild. Called on structural changes:
 * - New message added/removed
 * - New part added/removed (message.part.updated with new part)
 * - Session switch / restore
 * - Part status change (pending → running → completed)
 *
 * This is the "slow path" — O(N) over all messages and parts.
 * Equivalent to the old projectSessionMessages() + materializeTaskCards().
 */
export function projectSession(
	state: SessionStore,
	sessionId: string | undefined,
	mcpServerNames: string[] = [],
): MaterializedView {
	if (!sessionId) return EMPTY_VIEW;
	const messages = state.messages[sessionId];
	if (!messages || messages.length === 0) return EMPTY_VIEW;

	const rawNodes = projectMessages(messages, state.parts);
	const nodes = materializeTaskCards(sessionId, rawNodes, state.parts);
	const nodeIds = nodes.map(n => n.id);
	const nodesById = buildNodesById(nodes);
	const turnTokensByParentId = buildTurnTokenMap(messages);
	const revertedFromMessageId =
		state.sessions.find(session => session.id === sessionId)?.revert?.messageID ?? null;
	const isProcessing = state.sessionStatus[sessionId]?.type === 'busy';
	const sections = groupMessagesIntoSections(
		nodes,
		mcpServerNames,
		revertedFromMessageId,
		[],
		turnTokensByParentId,
		isProcessing,
		state.parts,
	);
	const toolActivity = getRunningToolMeta(messages, state.parts);

	// Build partId → callID mapping for tool parts (needed for delta lookups)
	const toolPartIdToCallId: Record<string, string> = {};
	for (const msg of messages) {
		const msgParts = state.parts[msg.id];
		if (!msgParts) continue;
		for (const part of msgParts) {
			if (part.type === 'tool') {
				toolPartIdToCallId[part.id] = (part as ToolPart).callID;
			}
		}
	}

	return {
		nodeIds,
		nodesById,
		sections,
		toolPartIdToCallId,
		turnTokensByParentId,
		activeModelId: getLatestAssistantModelId(messages),
		toolActivity,
		streamingToolId: toolActivity?.toolUseId ?? null,
		isLastAssistantStreaming: getLastAssistantStreaming(nodes),
		version: 1,
		lastUpdateWasStructural: true,
	};
}

function replaceGroupedResponseNode(
	item: GroupedResponseItem,
	updatedNode: RenderNode,
): GroupedResponseItem | null {
	if (Array.isArray(item)) {
		let changed = false;
		const next = item.map(entry => {
			if (entry.id !== updatedNode.id) return entry;
			changed = true;
			return updatedNode;
		});
		if (!changed) return null;
		return Object.assign(next, {
			...(item as ToolGroup),
		}) as ToolGroup;
	}

	return item.id === updatedNode.id ? updatedNode : null;
}

function patchSectionsForNodeUpdate(
	sections: MessageSection[],
	updatedNode: RenderNode,
): MessageSection[] {
	let changedIndex = -1;
	const nextSections = sections.slice();

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		let sectionChanged = false;
		const nextResponses = section.responses.map(response => {
			const patched = replaceGroupedResponseNode(response, updatedNode);
			if (!patched) return response;
			sectionChanged = true;
			return patched;
		});

		if (!sectionChanged) continue;
		changedIndex = i;
		nextSections[i] = {
			...section,
			responses: nextResponses,
		};
		break;
	}

	return changedIndex === -1 ? sections : nextSections;
}

// ---------------------------------------------------------------------------
// Public API: Incremental delta (streaming tokens) — O(1)
// ---------------------------------------------------------------------------

/**
 * Apply a text/reasoning delta to an existing materialized view.
 * This is the "fast path" — O(1), no iteration over messages/parts.
 *
 * Returns a new MaterializedView with only the affected node replaced.
 * If the node can't be found (shouldn't happen), falls back to null
 * signaling the caller should do a full rebuild.
 */
export function applyDelta(
	prev: MaterializedView,
	partId: string,
	field: string,
	delta: string,
): MaterializedView | null {
	// Find the node that corresponds to this partId.
	// Node IDs follow patterns: `msg-${partId}` for text, `thinking-${partId}` for reasoning.
	const textNodeId = `msg-${partId}`;
	const thinkingNodeId = `thinking-${partId}`;

	let targetId: string | undefined;
	let existingNode: RenderNode | undefined;

	if (prev.nodesById[textNodeId]) {
		targetId = textNodeId;
		existingNode = prev.nodesById[textNodeId];
	} else if (prev.nodesById[thinkingNodeId]) {
		targetId = thinkingNodeId;
		existingNode = prev.nodesById[thinkingNodeId];
	}

	if (!targetId || !existingNode) {
		// Node not found — caller should fall back to full rebuild.
		// This can happen for tool streaming output or other non-text parts.
		return null;
	}

	// Clone only the affected node with the appended delta
	let updatedNode: RenderNode;

	if (existingNode.kind === 'assistant' && field === 'text') {
		updatedNode = {
			...existingNode,
			content: existingNode.content + delta,
		};
	} else if (existingNode.kind === 'thinking' && field === 'text') {
		updatedNode = {
			...existingNode,
			content: existingNode.content + delta,
		};
	} else {
		// Unknown field for this node type — fall back to full rebuild
		return null;
	}

	// Create new nodesById with only the one node replaced
	const nodesById = { ...prev.nodesById, [targetId]: updatedNode };

	return {
		nodeIds: prev.nodeIds, // same array reference — no structural change
		nodesById,
		sections: patchSectionsForNodeUpdate(prev.sections, updatedNode),
		toolPartIdToCallId: prev.toolPartIdToCallId,
		turnTokensByParentId: prev.turnTokensByParentId,
		activeModelId: prev.activeModelId,
		toolActivity: prev.toolActivity,
		streamingToolId: prev.streamingToolId,
		isLastAssistantStreaming:
			updatedNode.kind === 'assistant'
				? getLastAssistantStreaming(
						prev.nodeIds
							.map(id => (id === targetId ? updatedNode : prev.nodesById[id]))
							.filter(Boolean),
					)
				: prev.isLastAssistantStreaming,
		version: prev.version + 1,
		lastUpdateWasStructural: false,
	};
}

/**
 * Apply a tool streaming output delta. Tool nodes use callID as their ID,
 * but delta events arrive with partId. We use the toolPartIdToCallId mapping
 * to resolve the correct node.
 * Returns null if the node isn't found (fall back to full rebuild).
 */
export function applyToolDelta(
	prev: MaterializedView,
	partId: string,
	field: string,
	delta: string,
): MaterializedView | null {
	// Resolve partId → callID via the mapping
	const callID = prev.toolPartIdToCallId[partId] ?? partId;
	const existingNode = prev.nodesById[callID];
	if (!existingNode || existingNode.kind !== 'tool_use') return null;

	if (field !== 'output') return null;

	const updatedNode: RenderToolUseMessage = {
		...existingNode,
		streamingOutput: (existingNode.streamingOutput ?? '') + delta,
	};

	const nodesById = { ...prev.nodesById, [callID]: updatedNode };

	return {
		nodeIds: prev.nodeIds,
		nodesById,
		sections: patchSectionsForNodeUpdate(prev.sections, updatedNode),
		toolPartIdToCallId: prev.toolPartIdToCallId,
		turnTokensByParentId: prev.turnTokensByParentId,
		activeModelId: prev.activeModelId,
		toolActivity: prev.toolActivity,
		streamingToolId: prev.streamingToolId,
		isLastAssistantStreaming: prev.isLastAssistantStreaming,
		version: prev.version + 1,
		lastUpdateWasStructural: false,
	};
}

// ---------------------------------------------------------------------------
// Pure utility functions (moved from selectors.ts)
// ---------------------------------------------------------------------------

const EMPTY_DERIVED_STATS = { requestCount: 0, totalDuration: 0, subagentCount: 0 };

export function collectDescendantSessionIds(
	state: Pick<SessionStore, 'childSessionIdsByParentId'>,
	sessionId: string,
): string[] {
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
	state: Pick<SessionStore, 'messages' | 'childSessionIdsByParentId'>,
	sessionId: string | undefined,
): { requestCount: number; totalDuration: number; subagentCount: number } {
	if (!sessionId) return EMPTY_DERIVED_STATS;
	const sessionIds = [sessionId, ...collectDescendantSessionIds(state, sessionId)];
	let requestCount = 0;
	let totalDuration = 0;
	const emptyMessages: Message[] = [];
	for (const currentSessionId of sessionIds) {
		const messages = state.messages[currentSessionId] ?? emptyMessages;
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

// ---------------------------------------------------------------------------
// Sectioning layer (moved from groupSections.ts)
// Groups RenderNode[] into user-message sections with responses and stats.
// ---------------------------------------------------------------------------

import { buildToolActionType } from '../../common/normalizedTypes';
import { getTurnUsageDuration, getTurnUsageTokenCount } from '../../common/tokenStats';
import { resolveFileChanges } from '../components/chat/SimpleDiff';
import {
	type GroupedResponseItem,
	groupToolMessages,
	isBridgeMessage,
	shouldTriggerCollapse,
	type ToolGroup,
} from '../components/chat/toolGrouping';
import type { ChangedFile, TokenUsage } from './chatStore';

function groupRenderResponses(
	responses: RenderNode[],
	mcpServerNames: string[],
	isProcessing = false,
): GroupedResponseItem[] {
	const grouped: GroupedResponseItem[] = [];
	let toolBuffer: RenderNode[] = [];

	const hasLiveToolInBuffer = () =>
		toolBuffer.some(
			(response): boolean =>
				response.kind === 'tool_use' &&
				(response.isRunning === true ||
					response.status === 'pending' ||
					response.status === 'running' ||
					response.status === undefined),
		);

	const flushTools = (isBoundary: boolean) => {
		if (toolBuffer.length === 0) return;
		const flushed = groupToolMessages(
			toolBuffer,
			mcpServerNames,
			!isBoundary && (isProcessing || hasLiveToolInBuffer()),
		) as (RenderNode | RenderNode[])[];
		if (isBoundary) {
			for (let i = flushed.length - 1; i >= 0; i--) {
				if (Array.isArray(flushed[i])) {
					(flushed[i] as ToolGroup).shouldCollapse = true;
					break;
				}
			}
		}
		grouped.push(...flushed);
		toolBuffer = [];
	};

	for (const response of responses) {
		if (response.kind === 'tool_use') {
			toolBuffer.push(response);
			continue;
		}
		if (toolBuffer.length > 0 && isBridgeMessage(response)) {
			toolBuffer.push(response);
			continue;
		}
		flushTools(shouldTriggerCollapse(response));
		grouped.push(response);
	}

	flushTools(false);
	return grouped;
}

/** Pre-computed stats for a section — eliminates O(n) scans in UserMessage */
export interface SectionStats {
	isFirst: boolean;
	isLast: boolean;
	nextUserMessageTs: number | null;
	lastResponseTs: number | null;
	fileChanges: { added: number; removed: number; files: number } | null;
	tokenCount: number | null;
	durationMs: number | null;
}

export interface MessageSection {
	userMessage: RenderUserMessage;
	responses: GroupedResponseItem[];
	sectionIndex: number;
	isReverted: boolean;
	isRevertPoint: boolean;
	stats: SectionStats;
}

export const groupMessagesIntoSections = (
	msgs: RenderNode[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
	changedFiles: ChangedFile[] = [],
	turnTokens: Record<string, TokenUsage> = {},
	isProcessing = false,
	parts: Record<string, Part[]> = {},
): MessageSection[] => {
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));
	const sections: MessageSection[] = [];
	let currentSection: MessageSection | null = null;
	let currentResponses: RenderNode[] = [];
	let sectionIndex = 0;
	let pastRevertPoint = false;

	const changedFilesMap = new Map<string, ChangedFile[]>();
	if (changedFiles.length > 0) {
		for (const file of changedFiles) {
			const existing = changedFilesMap.get(file.toolUseId);
			if (existing) {
				existing.push(file);
			} else {
				changedFilesMap.set(file.toolUseId, [file]);
			}
		}
	}

	const orphanedMessages: RenderNode[] = [];

	for (const msg of visibleMsgs) {
		if (msg.kind === 'user') {
			if (currentSection) {
				currentSection.responses = groupRenderResponses(currentResponses, mcpServerNames);
				currentSection.stats = computeSectionStats(
					currentSection,
					currentResponses,
					parts,
					changedFilesMap,
					false,
					turnTokens,
				);
				sections.push(currentSection);
				currentResponses = [];
			}
			const isThisRevertPoint =
				!!revertedFromMessageId && !pastRevertPoint && msg.id === revertedFromMessageId;
			if (isThisRevertPoint) pastRevertPoint = true;

			currentSection = {
				userMessage: msg as RenderUserMessage,
				responses: [],
				sectionIndex: sectionIndex++,
				isReverted: pastRevertPoint,
				isRevertPoint: isThisRevertPoint,
				stats: null as unknown as SectionStats,
			};

			if (orphanedMessages.length > 0) {
				currentResponses.push(...orphanedMessages);
				orphanedMessages.length = 0;
			}
		} else if (currentSection) {
			currentResponses.push(msg);
		} else {
			orphanedMessages.push(msg);
		}
	}

	if (currentSection) {
		currentSection.responses = groupRenderResponses(currentResponses, mcpServerNames, isProcessing);
		currentSection.stats = computeSectionStats(
			currentSection,
			currentResponses,
			parts,
			changedFilesMap,
			true,
			turnTokens,
		);
		sections.push(currentSection);
	}

	for (let i = 0; i < sections.length; i++) {
		sections[i].stats.isFirst = i === 0;
		sections[i].stats.isLast = i === sections.length - 1;
		sections[i].stats.nextUserMessageTs =
			i < sections.length - 1
				? new Date(sections[i + 1].userMessage.message.time.created).getTime()
				: null;
	}

	return sections;
};

/** Compute stats for a single section from its raw responses */
function computeSectionStats(
	section: MessageSection,
	rawResponses: RenderNode[],
	parts: Record<string, Part[]>,
	changedFilesMap: Map<string, ChangedFile[]>,
	isLast: boolean,
	turnTokens: Record<string, TokenUsage> = {},
): SectionStats {
	const userTs = new Date(section.userMessage.message.time.created).getTime();

	let lastResponseTs: number | null = null;
	for (const msg of rawResponses) {
		if (!('timestamp' in msg)) continue;
		const t = new Date(msg.timestamp).getTime();
		if (t > userTs && (lastResponseTs === null || t > lastResponseTs)) {
			lastResponseTs = t;
		}
	}

	let fileChanges: SectionStats['fileChanges'] = null;
	let rawDiffAdded = 0;
	let rawDiffRemoved = 0;
	const rawDiffFiles = new Set<string>();

	for (const response of rawResponses) {
		if (response.kind !== 'tool_use') continue;
		let toolMetadata: Record<string, unknown> | undefined;
		for (const messageParts of Object.values(parts)) {
			for (const part of messageParts) {
				if (part.type !== 'tool') continue;
				const toolPart = part as ToolPart;
				if (toolPart.callID !== response.toolUseId) continue;
				toolMetadata = (toolPart.metadata ??
					('metadata' in toolPart.state
						? ((toolPart.state as { metadata?: Record<string, unknown> }).metadata ?? undefined)
						: undefined)) as Record<string, unknown> | undefined;
				break;
			}
			if (toolMetadata) break;
		}
		const actionType =
			response.normalizedEntry?.entryType &&
			typeof response.normalizedEntry.entryType === 'object' &&
			'actionType' in response.normalizedEntry.entryType
				? response.normalizedEntry.entryType.actionType
				: buildToolActionType(response.toolName, response.rawInput ?? {});
		const resolvedChanges = resolveFileChanges({
			actionType,
			toolResultMetadata: toolMetadata,
			fallbackFilePath: response.filePath,
		});
		if (resolvedChanges.length > 0) {
			for (const change of resolvedChanges) {
				rawDiffAdded += change.stats.added;
				rawDiffRemoved += change.stats.removed;
				if (change.filePath || change.name) {
					rawDiffFiles.add(change.filePath || change.name);
				}
			}
			continue;
		}

		const files = changedFilesMap.get(response.toolUseId) ?? [];
		for (const file of files) {
			rawDiffAdded += file.linesAdded;
			rawDiffRemoved += file.linesRemoved;
			rawDiffFiles.add(file.filePath || file.fileName);
		}
	}

	if (rawDiffAdded > 0 || rawDiffRemoved > 0 || rawDiffFiles.size > 0) {
		fileChanges = {
			added: rawDiffAdded,
			removed: rawDiffRemoved,
			files: rawDiffFiles.size,
		};
	}

	const userMsgId = section.userMessage.id;
	const realTokens = userMsgId ? turnTokens[userMsgId] : undefined;
	const tokenCount = getTurnUsageTokenCount(realTokens);
	const durationMs = getTurnUsageDuration(realTokens);

	return {
		isFirst: false,
		isLast,
		nextUserMessageTs: null,
		lastResponseTs,
		fileChanges,
		tokenCount,
		durationMs,
	};
}
