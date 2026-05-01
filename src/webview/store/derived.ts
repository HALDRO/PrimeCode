import type { AssistantMessage, Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import {
	computeTurnUsage,
	getTurnUsageDuration,
	getTurnUsageTokenCount,
} from '../../common/tokenStats';
import {
	type GroupedResponseItem,
	groupToolMessages,
	isBridgeMessage,
	shouldTriggerCollapse,
	type ToolGroup,
} from '../components/chat/toolGrouping';
import {
	isSessionProcessing,
	type RenderAssistantMessage,
	type RenderCompactionMessage,
	type RenderNode,
	type RenderTaskCardNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type SessionStore,
	type TokenUsage,
} from './chatStore';

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

export interface SessionDerivedView {
	nodeIds: string[];
	nodesById: Record<string, RenderNode>;
	sections: MessageSection[];
	turnTokensByParentId: Record<string, TokenUsage>;
	activeModelId?: string;
	toolActivity: { toolName: string; label: string; toolUseId: string } | null;
	streamingToolId: string | null;
	isLastAssistantStreaming: boolean;
}

interface SessionDerivedCacheEntry {
	messagesRef: Message[] | undefined;
	partsRef: Record<string, Part[]>;
	sessionsRef: SessionStore['sessions'];
	sessionStatusRef: SessionStore['sessionStatus'];
	mcpKey: string;
	view: SessionDerivedView;
}

const EMPTY_DERIVED_STATS = { requestCount: 0, totalDuration: 0, subagentCount: 0 };
const EMPTY_VIEW: SessionDerivedView = {
	nodeIds: [],
	nodesById: {},
	sections: [],
	turnTokensByParentId: {},
	activeModelId: undefined,
	toolActivity: null,
	streamingToolId: null,
	isLastAssistantStreaming: false,
};
const sessionViewCache = new Map<string, SessionDerivedCacheEntry>();

export function clearSessionViewCache(sessionId: string): void {
	for (const key of sessionViewCache.keys()) {
		if (key === sessionId || key.startsWith(`${sessionId}::`)) {
			sessionViewCache.delete(key);
		}
	}
}

function isAssistantMessage(msg: Message): msg is AssistantMessage {
	return msg.role === 'assistant';
}

function buildTurnTokenMap(messages: Message[] | undefined): Record<string, TokenUsage> {
	if (!messages || messages.length === 0) return {};

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
					parentMessageId: assistantMsg.parentID,
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
					parentMessageId: assistantMsg.parentID,
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
				const title = 'title' in tp.state ? (tp.state as { title?: string }).title : undefined;

				nodes.push({
					kind: 'tool_use',
					id: tp.callID,
					type: 'tool_use',
					parentMessageId: assistantMsg.parentID,
					toolName: tp.tool,
					toolUseId: tp.callID,
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
			let taskInput: Record<string, unknown> = {};
			let taskMetadata: Record<string, unknown> | undefined;
			let taskResult: string | undefined;
			for (const messageParts of Object.values(parts)) {
				for (const part of messageParts) {
					if (part.type !== 'tool') continue;
					const toolPart = part as ToolPart;
					if (toolPart.callID !== toolCallId) continue;
					taskInput =
						'input' in toolPart.state &&
						toolPart.state.input &&
						typeof toolPart.state.input === 'object'
							? (toolPart.state.input as Record<string, unknown>)
							: {};
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

function buildNodesById(nodes: RenderNode[]): Record<string, RenderNode> {
	const map: Record<string, RenderNode> = {};
	for (const node of nodes) {
		map[node.id] = node;
	}
	return map;
}

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

function computeSectionStats(
	section: MessageSection,
	rawResponses: RenderNode[],
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

	const userMsgId = section.userMessage.id;
	const realTokens = userMsgId ? turnTokens[userMsgId] : undefined;
	const tokenCount = getTurnUsageTokenCount(realTokens);
	const durationMs = getTurnUsageDuration(realTokens);
	const summaryDiffs = (
		section.userMessage.message as Message & {
			summary?: { diffs?: Array<{ file: string; additions: number; deletions: number }> };
		}
	).summary?.diffs;

	let fileChanges: SectionStats['fileChanges'] = null;
	if (Array.isArray(summaryDiffs) && summaryDiffs.length > 0) {
		let added = 0;
		let removed = 0;
		const files = new Set<string>();
		for (const diff of summaryDiffs) {
			added += diff.additions || 0;
			removed += diff.deletions || 0;
			if ((diff.additions || 0) > 0 || (diff.deletions || 0) > 0) {
				if (typeof diff.file === 'string' && diff.file) files.add(diff.file);
			}
		}
		if (added > 0 || removed > 0) {
			fileChanges = { added, removed, files: files.size };
		}
	}

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

export function groupMessagesIntoSections(
	msgs: RenderNode[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
	turnTokens: Record<string, TokenUsage> = {},
	isProcessing = false,
): MessageSection[] {
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));
	const sections: MessageSection[] = [];
	const sectionByUserId = new Map<string, MessageSection>();
	const responsesByUserId = new Map<string, RenderNode[]>();
	let sectionIndex = 0;
	let pastRevertPoint = false;

	const orphanedMessages: RenderNode[] = [];

	for (const msg of visibleMsgs) {
		if (msg.kind === 'user') {
			const isThisRevertPoint =
				!!revertedFromMessageId && !pastRevertPoint && msg.id === revertedFromMessageId;
			if (isThisRevertPoint) pastRevertPoint = true;

			const section = {
				userMessage: msg as RenderUserMessage,
				responses: [],
				sectionIndex: sectionIndex++,
				isReverted: pastRevertPoint,
				isRevertPoint: isThisRevertPoint,
				stats: null as unknown as SectionStats,
			};
			sections.push(section);
			sectionByUserId.set(msg.id, section);

			if (orphanedMessages.length > 0) {
				responsesByUserId.set(msg.id, [...orphanedMessages]);
				orphanedMessages.length = 0;
			}
		} else {
			const parentMessageId = 'parentMessageId' in msg ? msg.parentMessageId : undefined;
			if (parentMessageId) {
				const responses = responsesByUserId.get(parentMessageId) ?? [];
				responses.push(msg);
				responsesByUserId.set(parentMessageId, responses);
				continue;
			}

			const lastSection = sections.at(-1);
			if (lastSection) {
				const responses = responsesByUserId.get(lastSection.userMessage.id) ?? [];
				responses.push(msg);
				responsesByUserId.set(lastSection.userMessage.id, responses);
			} else {
				orphanedMessages.push(msg);
			}
		}
	}

	for (let i = 0; i < sections.length; i++) {
		const section = sections[i];
		const rawResponses = responsesByUserId.get(section.userMessage.id) ?? [];
		section.responses = groupRenderResponses(
			rawResponses,
			mcpServerNames,
			i === sections.length - 1 && isProcessing,
		);
		section.stats = computeSectionStats(
			section,
			rawResponses,
			i === sections.length - 1,
			turnTokens,
		);
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
}

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

export function deriveSessionView(
	state: Pick<SessionStore, 'messages' | 'parts' | 'sessions' | 'sessionStatus'>,
	sessionId: string | undefined,
	mcpServerNames: string[] = [],
): SessionDerivedView {
	if (!sessionId) return EMPTY_VIEW;
	const messages = state.messages[sessionId];
	if (!messages || messages.length === 0) return EMPTY_VIEW;
	const mcpKey = mcpServerNames.join('|');
	const cacheKey = `${sessionId}::${mcpKey}`;
	const cached = sessionViewCache.get(cacheKey);
	if (
		cached &&
		cached.messagesRef === messages &&
		cached.partsRef === state.parts &&
		cached.sessionsRef === state.sessions &&
		cached.sessionStatusRef === state.sessionStatus &&
		cached.mcpKey === mcpKey
	) {
		return cached.view;
	}

	const rawNodes = projectMessages(messages, state.parts);
	const nodes = materializeTaskCards(sessionId, rawNodes, state.parts);
	const nodeIds = nodes.map(n => n.id);
	const nodesById = buildNodesById(nodes);
	const turnTokensByParentId = buildTurnTokenMap(messages);
	const revertMessageId =
		state.sessions.find(session => session.id === sessionId)?.revert?.messageID ?? null;
	let revertedFromMessageId: string | null = null;
	if (revertMessageId) {
		for (const message of messages) {
			if (message.id >= revertMessageId) break;
			if (message.role === 'user') revertedFromMessageId = message.id;
		}
		revertedFromMessageId ??= revertMessageId;
	}
	const isProcessing = isSessionProcessing(state, sessionId);
	const sections = groupMessagesIntoSections(
		nodes,
		mcpServerNames,
		revertedFromMessageId,
		turnTokensByParentId,
		isProcessing,
	);
	const toolActivity = getRunningToolMeta(messages, state.parts);

	const view = {
		nodeIds,
		nodesById,
		sections,
		turnTokensByParentId,
		activeModelId: getLatestAssistantModelId(messages),
		toolActivity,
		streamingToolId: toolActivity?.toolUseId ?? null,
		isLastAssistantStreaming: getLastAssistantStreaming(nodes),
	};
	sessionViewCache.set(cacheKey, {
		messagesRef: messages,
		partsRef: state.parts,
		sessionsRef: state.sessions,
		sessionStatusRef: state.sessionStatus,
		mcpKey,
		view,
	});
	return view;
}
