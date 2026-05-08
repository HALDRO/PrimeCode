import type { AssistantMessage, Message, Part, ToolPart } from '@opencode-ai/sdk/v2/client';
import { extractCanonicalTaskResult, stripTaskResultDisplayMetadata } from '../../common';
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
	type RenderSystemEventNode,
	type RenderTaskCardNode,
	type RenderTaskResultNode,
	type RenderThinkingMessage,
	type RenderToolUseMessage,
	type RenderUserMessage,
	type SessionStore,
	type TokenUsage,
} from './chatStore';
import { computeAssistantUsage, computeAssistantUsageSummary } from './sessionUsage';

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
	allMessagesRef: SessionStore['messages'];
	partsRef: Record<string, Part[]>;
	sessionsRef: SessionStore['sessions'];
	sessionStatusRef: SessionStore['sessionStatus'];
	childSessionIdsRef: SessionStore['childSessionIdsByParentId'];
	originatingToolCallRef: SessionStore['originatingToolCallBySessionId'];
	sessionModelRef: SessionStore['sessionModel'];
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
const OMO_INTERNAL_INITIATOR_MARKER = '<!-- OMO_INTERNAL_INITIATOR -->';
const OMO_INTERNAL_INITIATOR_PATTERN = /\n*<!--\s*OMO_INTERNAL_INITIATOR\s*-->\s*/g;
const SYSTEM_REMINDER_OPEN_PATTERN = /<system-reminder>/i;
const SYSTEM_REMINDER_BLOCK_PATTERN = /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/i;
const OHMY_SYSTEM_DIRECTIVE_PATTERN = /\[SYSTEM DIRECTIVE:\s*OH-MY-OPENCODE[^\]\r\n]*(?:\]|$)/i;

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

function getTextPartContent(part: Part): string | undefined {
	return part.type === 'text' && 'text' in part && typeof part.text === 'string'
		? part.text
		: undefined;
}

function firstNonEmptyLine(text: string): string | undefined {
	return text
		.split('\n')
		.map(line => line.trim())
		.find(Boolean);
}

function stripInternalReminderTransport(text: string): string {
	return text.replace(OMO_INTERNAL_INITIATOR_PATTERN, '').trim();
}

function extractSystemReminderBody(text: string): string | undefined {
	const match = text.match(SYSTEM_REMINDER_BLOCK_PATTERN);
	return match?.[1]?.trim();
}

function getSystemEventTitle(source: RenderSystemEventNode['source'], content: string): string {
	const firstLine = firstNonEmptyLine(content) ?? '';
	if (/^\[BACKGROUND TASK\b/i.test(firstLine)) return 'Background Task';
	if (/^\[ALL BACKGROUND TASKS\b/i.test(firstLine)) return 'Background Tasks';
	if (/^\[SYSTEM DIRECTIVE:/i.test(firstLine)) return 'System Directive';
	return source === 'ohmy' ? 'OhMy System Event' : 'System Reminder';
}

function parseSystemEventText(
	text: string,
	options: { synthetic?: boolean } = {},
): Pick<RenderSystemEventNode, 'source' | 'title' | 'content'> | null {
	const hasOhmyMarker = text.includes(OMO_INTERNAL_INITIATOR_MARKER);
	const withoutTransport = stripInternalReminderTransport(text);
	const reminderBody = extractSystemReminderBody(withoutTransport);
	const hasSystemReminder =
		options.synthetic && SYSTEM_REMINDER_OPEN_PATTERN.test(withoutTransport);
	const hasOhmyDirective = OHMY_SYSTEM_DIRECTIVE_PATTERN.test(withoutTransport);

	if (!hasOhmyMarker && !hasSystemReminder && !hasOhmyDirective) return null;

	const source: RenderSystemEventNode['source'] =
		hasOhmyMarker || hasOhmyDirective ? 'ohmy' : 'generic';
	const content = (reminderBody ?? withoutTransport).trim();
	if (!content) return null;

	return {
		source,
		title: getSystemEventTitle(source, content),
		content,
	};
}

function isSystemEventPart(part: Part): boolean {
	const text = getTextPartContent(part);
	return text
		? parseSystemEventText(text, { synthetic: Boolean('synthetic' in part && part.synthetic) }) !==
				null
		: false;
}

function materializeSystemEventNode(input: {
	message: Message;
	part: Part;
	text: string;
	partIndex: number;
	parentMessageId?: string;
}): RenderSystemEventNode | undefined {
	const parsed = parseSystemEventText(input.text, {
		synthetic: Boolean('synthetic' in input.part && input.part.synthetic),
	});
	if (!parsed) return undefined;
	return {
		kind: 'system_event',
		id: `system-event-${input.part.id || `${input.message.id}-${input.partIndex}`}`,
		type: 'system_event',
		timestamp: new Date(input.message.time.created).toISOString(),
		parentMessageId: input.parentMessageId,
		messageId: input.message.id,
		partId: input.part.id,
		...parsed,
	};
}

function isOhmySystemEventPart(part: Part): boolean {
	const text = getTextPartContent(part);
	if (!text) return false;
	return (
		parseSystemEventText(text, {
			synthetic: Boolean('synthetic' in part && part.synthetic),
		})?.source === 'ohmy'
	);
}

function isInternalReminderMessage(parts: Part[]): boolean {
	const textParts = parts.filter(part => getTextPartContent(part)?.trim());
	return textParts.length > 0 && textParts.every(isOhmySystemEventPart);
}

function buildInternalReminderParentMap(
	messages: Message[],
	parts: Record<string, Part[]>,
): Map<string, string> {
	const parentByReminderId = new Map<string, string>();
	let lastRealUserMessageId: string | undefined;

	for (const message of messages) {
		if (message.role !== 'user') continue;
		if (isInternalReminderMessage(parts[message.id] ?? [])) {
			if (lastRealUserMessageId) parentByReminderId.set(message.id, lastRealUserMessageId);
			continue;
		}
		lastRealUserMessageId = message.id;
	}

	return parentByReminderId;
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
			cacheWrite: msg.tokens.cache.write,
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

function getTaskResultOutput(part: ToolPart): string | undefined {
	const output = 'output' in part.state ? part.state.output : undefined;
	return typeof output === 'string' && output.trim() ? output.trim() : undefined;
}

function extractTaskResultArtifact(raw: string): {
	content: string;
	taskIdLine?: string;
} | null {
	const canonical = extractCanonicalTaskResult(raw).trim();
	if (!canonical) return null;
	const taskIdMatch = raw.match(/^task_id:\s*[^\r\n<]*/m);
	const taskIdLine = taskIdMatch?.[0]?.trim();
	const taskResultContent = stripTaskResultDisplayMetadata(canonical);
	const separatorPayload = taskResultContent.match(/(?:^|\n)---\s*\n([\s\S]*)$/)?.[1]?.trim();
	const content = separatorPayload || taskResultContent;
	if (!content && !taskIdLine) return null;
	return { content, taskIdLine };
}

function extractTaskResultDisplayContent(raw: string): string {
	return stripTaskResultDisplayMetadata(extractCanonicalTaskResult(raw));
}

function materializeTaskResultNode(input: {
	parentSessionId: string;
	parentMessageId?: string;
	toolCallId: string;
	childSessionId?: string;
	timestamp: string;
	rawOutput: string | undefined;
	displayOutput?: string;
	parentToolPartId?: string;
	childAssistantMessageId?: string;
	childAssistantPartId?: string;
}): RenderTaskResultNode | undefined {
	if (!input.rawOutput) return undefined;
	const artifact = extractTaskResultArtifact(input.rawOutput);
	if (!artifact) return undefined;
	const displayContent = input.displayOutput
		? extractTaskResultDisplayContent(input.displayOutput)
		: undefined;
	return {
		kind: 'task_result',
		id: `task-result-${input.toolCallId}`,
		type: 'task_result',
		parentSessionId: input.parentSessionId,
		parentMessageId: input.parentMessageId,
		toolCallId: input.toolCallId,
		childSessionId: input.childSessionId,
		timestamp: input.timestamp,
		content: displayContent || artifact.content,
		...(artifact.taskIdLine ? { taskIdLine: artifact.taskIdLine } : {}),
		source: {
			parentToolPartId: input.parentToolPartId,
			childAssistantMessageId: input.childAssistantMessageId,
			childAssistantPartId: input.childAssistantPartId,
		},
	};
}

interface TaskResultProjection {
	nodesByFirstPartId: Map<string, RenderTaskResultNode>;
	consumedPartIds: Set<string>;
}

interface TaskPartIndex {
	byCallId: Map<string, ToolPart>;
	byChildSessionId: Map<string, ToolPart>;
}

function getToolPartMetadata(toolPart: ToolPart): Record<string, unknown> | undefined {
	return (toolPart.metadata ??
		('metadata' in toolPart.state
			? ((toolPart.state as { metadata?: Record<string, unknown> }).metadata ?? undefined)
			: undefined)) as Record<string, unknown> | undefined;
}

function getTaskStringField(
	input: Record<string, unknown>,
	metadata: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const inputValue = input[key];
		if (typeof inputValue === 'string' && inputValue.trim()) return inputValue.trim();
		const metadataValue = metadata?.[key];
		if (typeof metadataValue === 'string' && metadataValue.trim()) return metadataValue.trim();
	}
	return undefined;
}

function getTaskId(
	input: Record<string, unknown>,
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	const explicitTaskId = getTaskStringField(input, metadata, 'taskId', 'task_id');
	if (explicitTaskId) return explicitTaskId;
	const output = typeof input.output === 'string' ? input.output : undefined;
	const outputTaskId = output?.match(/^task_id:\s*([^\r\n<]+)/m)?.[1]?.trim();
	return outputTaskId || undefined;
}

function buildTaskPartIndex(parts: Record<string, Part[]>): TaskPartIndex {
	const byCallId = new Map<string, ToolPart>();
	const byChildSessionId = new Map<string, ToolPart>();
	for (const messageParts of Object.values(parts)) {
		for (const part of messageParts) {
			if (part.type !== 'tool') continue;
			const toolPart = part as ToolPart;
			if (toolPart.tool.toLowerCase() !== 'task') continue;
			byCallId.set(toolPart.callID, toolPart);
			const metadata = getToolPartMetadata(toolPart);
			const childSessionId =
				typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined;
			if (childSessionId) byChildSessionId.set(childSessionId, toolPart);
		}
	}
	return { byCallId, byChildSessionId };
}

function buildTerminalTaskResultProjection(
	state: Pick<SessionStore, 'originatingToolCallBySessionId' | 'messages'>,
	messages: Message[],
	parts: Record<string, Part[]>,
	sessionId: string,
	taskPartIndex: TaskPartIndex,
): TaskResultProjection {
	const mappedToolCallId = state.originatingToolCallBySessionId[sessionId];
	const projection: TaskResultProjection = {
		nodesByFirstPartId: new Map(),
		consumedPartIds: new Set(),
	};
	const parentTaskPart =
		taskPartIndex.byChildSessionId.get(sessionId) ??
		(mappedToolCallId ? taskPartIndex.byCallId.get(mappedToolCallId) : undefined);

	if (!parentTaskPart || parentTaskPart.state.status !== 'completed') return projection;
	const parentMessage = state.messages[parentTaskPart.sessionID]?.find(
		message => message.id === parentTaskPart.messageID,
	);
	const parentTaskParentMessageId =
		parentMessage && isAssistantMessage(parentMessage) ? parentMessage.parentID : undefined;

	const orderedParts: Array<{ message: Message; part: Part; index: number }> = [];
	for (const message of messages) {
		for (const part of parts[message.id] ?? []) {
			orderedParts.push({ message, part, index: orderedParts.length });
		}
	}

	let lastToolIndex = -1;
	for (const entry of orderedParts) {
		if (entry.part.type === 'tool') lastToolIndex = entry.index;
	}

	const terminalTextParts = orderedParts.filter(entry => {
		if (entry.index <= lastToolIndex) return false;
		if (!isAssistantMessage(entry.message)) return false;
		if (entry.part.type !== 'text' || !('text' in entry.part)) return false;
		const text = entry.part.text;
		if (typeof text !== 'string' || !text.trim()) return false;
		return !(('synthetic' in entry.part && entry.part.synthetic) as boolean);
	});
	if (terminalTextParts.length === 0) return projection;

	const content = terminalTextParts
		.map(entry =>
			entry.part.type === 'text' ? extractTaskResultDisplayContent(entry.part.text) : '',
		)
		.map(text => text.trim())
		.filter(Boolean)
		.join('\n\n');
	if (!content) return projection;

	const first = terminalTextParts[0];
	for (const entry of terminalTextParts) {
		projection.consumedPartIds.add(entry.part.id);
	}
	const node = materializeTaskResultNode({
		parentSessionId: parentTaskPart.sessionID,
		parentMessageId: parentTaskParentMessageId,
		toolCallId: parentTaskPart.callID,
		childSessionId: sessionId,
		timestamp: new Date((first.message as AssistantMessage).time.created).toISOString(),
		rawOutput: getTaskResultOutput(parentTaskPart) ?? content,
		displayOutput: content,
		parentToolPartId: parentTaskPart.id,
		childAssistantMessageId: first.message.id,
		childAssistantPartId: first.part.id,
	});
	if (node) projection.nodesByFirstPartId.set(first.part.id, node);
	return projection;
}
function projectMessages(
	messages: Message[],
	parts: Record<string, Part[]>,
	taskResultProjection: TaskResultProjection = {
		nodesByFirstPartId: new Map(),
		consumedPartIds: new Set(),
	},
): RenderNode[] {
	if (messages.length === 0) return [];

	const nodes: RenderNode[] = [];
	const internalReminderParentByMessageId = buildInternalReminderParentMap(messages, parts);
	const assistantByParent = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (isAssistantMessage(message) && message.parentID) {
			assistantByParent.set(message.parentID, message);
		}
	}

	for (const msg of messages) {
		const msgParts = parts[msg.id] ?? [];
		const internalReminderParentMessageId = internalReminderParentByMessageId.get(msg.id);

		if (msg.role === 'user') {
			const userParts = msgParts.filter(part => !isSystemEventPart(part));
			const systemEventNodes = msgParts.flatMap((part, partIndex) => {
				const text = getTextPartContent(part);
				const node = text
					? materializeSystemEventNode({
							message: msg,
							part,
							text,
							partIndex,
							parentMessageId: internalReminderParentMessageId,
						})
					: undefined;
				return node ? [node] : [];
			});

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

			if (userParts.length > 0 || compaction || systemEventNodes.length === 0) {
				nodes.push({
					...(msg as Message),
					kind: 'user',
					message: msg,
					parts: userParts,
					...(compaction ? { compaction } : {}),
				} satisfies RenderUserMessage);
			}

			nodes.push(...systemEventNodes);
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
		const parentMessageId = assistantMsg.parentID
			? (internalReminderParentByMessageId.get(assistantMsg.parentID) ?? assistantMsg.parentID)
			: undefined;

		for (const part of msgParts) {
			const taskResultArtifact = taskResultProjection.nodesByFirstPartId.get(part.id);
			if (taskResultArtifact) {
				nodes.push({ ...taskResultArtifact, timestamp });
				continue;
			}
			if (taskResultProjection.consumedPartIds.has(part.id)) continue;

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
					parentMessageId,
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
					parentMessageId,
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
					parentMessageId,
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
	state: Pick<
		SessionStore,
		| 'messages'
		| 'childSessionIdsByParentId'
		| 'originatingToolCallBySessionId'
		| 'sessionModel'
		| 'sessionStatus'
	>,
	taskPartIndex: TaskPartIndex,
): RenderNode[] {
	const items: RenderNode[] = [];

	for (const item of baseItems) {
		if (item.kind === 'tool_use' && item.toolName.toLowerCase() === 'task') {
			const toolCallId = item.toolUseId;
			let taskInput: Record<string, unknown> = {};
			let taskOutput: string | undefined;
			let taskMetadata: Record<string, unknown> | undefined;
			const taskToolPart = taskPartIndex.byCallId.get(toolCallId);
			if (taskToolPart) {
				taskInput =
					'input' in taskToolPart.state &&
					taskToolPart.state.input &&
					typeof taskToolPart.state.input === 'object'
						? (taskToolPart.state.input as Record<string, unknown>)
						: {};
				taskOutput = 'output' in taskToolPart.state ? getTaskResultOutput(taskToolPart) : undefined;
				taskMetadata = getToolPartMetadata(taskToolPart);
			}
			const metadataSessionId =
				typeof taskMetadata?.sessionId === 'string' ? taskMetadata.sessionId : undefined;
			const childSessionId =
				metadataSessionId ??
				Object.entries(state.originatingToolCallBySessionId).find(
					([, callId]) => callId === toolCallId,
				)?.[0];
			const childStats = computeDerivedSessionStats(state, childSessionId);
			const childUsage = computeAssistantUsage(
				childSessionId ? state.messages[childSessionId] : undefined,
			);
			const metadataModel =
				taskMetadata && typeof taskMetadata.model === 'object'
					? (taskMetadata.model as { providerID?: string; modelID?: string })
					: undefined;
			const childModelId =
				(childSessionId ? state.sessionModel[childSessionId] : undefined) ??
				(metadataModel?.providerID && metadataModel?.modelID
					? `${metadataModel.providerID}/${metadataModel.modelID}`
					: undefined);

			const node: RenderTaskCardNode = {
				kind: 'task_card',
				id: toolCallId,
				toolCallId,
				parentSessionId: sessionId,
				parentMessageId: item.parentMessageId,
				timestamp: item.timestamp,
				status: item.status ?? 'running',
				agent: typeof taskInput.subagent_type === 'string' ? taskInput.subagent_type : undefined,
				description: typeof taskInput.description === 'string' ? taskInput.description : undefined,
				prompt: typeof taskInput.prompt === 'string' ? taskInput.prompt : undefined,
				category: getTaskStringField(taskInput, taskMetadata, 'category'),
				command: getTaskStringField(taskInput, taskMetadata, 'command'),
				taskId: getTaskId({ ...taskInput, output: taskOutput }, taskMetadata),
				result: undefined,
				startTime: item.timestamp,
				childSessionId,
				childSummary: {
					title: typeof taskInput.description === 'string' ? taskInput.description : undefined,
					modelId: childModelId,
					durationMs: childStats.totalDuration || undefined,
					tokens: childUsage,
					diffStats: { added: 0, removed: 0 },
					childCount: childStats.subagentCount,
				},
			};
			items.push(node);
			continue;
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

function getSummaryFileChanges(message: Message): SectionStats['fileChanges'] {
	const diffs = (
		message as Message & {
			summary?: { diffs?: Array<{ file?: unknown; additions?: unknown; deletions?: unknown }> };
		}
	).summary?.diffs;
	if (!Array.isArray(diffs) || diffs.length === 0) return null;

	let added = 0;
	let removed = 0;
	const files = new Set<string>();
	for (const diff of diffs) {
		if (typeof diff.file !== 'string' || !diff.file) continue;
		const additions = typeof diff.additions === 'number' ? diff.additions : 0;
		const deletions = typeof diff.deletions === 'number' ? diff.deletions : 0;
		if (additions === 0 && deletions === 0) continue;
		added += additions;
		removed += deletions;
		files.add(diff.file);
	}

	return added > 0 || removed > 0 ? { added, removed, files: files.size } : null;
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
	const fileChanges = getSummaryFileChanges(section.userMessage.message);

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
	const visited = new Set<string>([sessionId]);
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
	for (const currentSessionId of sessionIds) {
		const summary = computeAssistantUsageSummary(state.messages[currentSessionId]);
		requestCount += summary.requestCount;
		totalDuration += summary.durationMs;
	}
	return {
		requestCount,
		totalDuration,
		subagentCount: sessionIds.length - 1,
	};
}

export function deriveSessionView(
	state: Pick<
		SessionStore,
		| 'messages'
		| 'parts'
		| 'sessions'
		| 'sessionStatus'
		| 'sessionModel'
		| 'childSessionIdsByParentId'
		| 'originatingToolCallBySessionId'
	>,
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
		cached.allMessagesRef === state.messages &&
		cached.partsRef === state.parts &&
		cached.sessionsRef === state.sessions &&
		cached.sessionStatusRef === state.sessionStatus &&
		cached.childSessionIdsRef === state.childSessionIdsByParentId &&
		cached.originatingToolCallRef === state.originatingToolCallBySessionId &&
		cached.sessionModelRef === state.sessionModel &&
		cached.mcpKey === mcpKey
	) {
		return cached.view;
	}

	const taskPartIndex = buildTaskPartIndex(state.parts);
	const taskResultProjection = buildTerminalTaskResultProjection(
		state,
		messages,
		state.parts,
		sessionId,
		taskPartIndex,
	);
	const rawNodes = projectMessages(messages, state.parts, taskResultProjection);
	const nodes = materializeTaskCards(sessionId, rawNodes, state, taskPartIndex);
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
		allMessagesRef: state.messages,
		partsRef: state.parts,
		sessionsRef: state.sessions,
		sessionStatusRef: state.sessionStatus,
		childSessionIdsRef: state.childSessionIdsByParentId,
		originatingToolCallRef: state.originatingToolCallBySessionId,
		sessionModelRef: state.sessionModel,
		mcpKey,
		view,
	});
	return view;
}
