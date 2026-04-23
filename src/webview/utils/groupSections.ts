/**
 * @file groupSections - Pure utility for grouping messages into sections
 * @description Extracted from App.tsx for testability. Groups chat messages into
 *              user-message sections with their responses, marks sections
 *              after the revert point as dimmed, and pre-computes per-section stats
 *              so the frontend components stay dumb renderers.
 */

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
import type { ChangedFile, RenderNode, RenderUserMessage, TokenUsage } from '../store';

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
		// Mark the last group array with shouldCollapse if flush was triggered by a boundary
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
		// Non-bridge, non-tool message: flush the buffer.
		// If this message triggers collapse, mark the last flushed group.
		flushTools(shouldTriggerCollapse(response));
		grouped.push(response);
	}

	// Trailing group (live/streaming) — no boundary, no collapse
	flushTools(false);
	return grouped;
}

/** Pre-computed stats for a section — eliminates O(n) scans in UserMessage */
export interface SectionStats {
	isFirst: boolean;
	isLast: boolean;
	/** Timestamp (ms) of the next user message, or null if last section */
	nextUserMessageTs: number | null;
	/** Timestamp (ms) of the last assistant/tool response in this turn, or null */
	lastResponseTs: number | null;
	/** File change aggregates for this turn's tool_use messages */
	fileChanges: { added: number; removed: number; files: number } | null;
	/** Estimated token count for this turn */
	tokenCount: number | null;
	/** Real processing duration from backend (ms), or null if unavailable */
	durationMs: number | null;
}

/**
 * Section represents a user message and all subsequent messages until the next user message.
 */
export interface MessageSection {
	userMessage: RenderUserMessage;
	responses: GroupedResponseItem[];
	sectionIndex: number;
	/** True when this section is at or after the revert point — responses should be dimmed */
	isReverted: boolean;
	/** True only on the exact section the user clicked Restore on (for Unrevert button placement) */
	isRevertPoint: boolean;
	/** Pre-computed stats for this section */
	stats: SectionStats;
}

/**
 * Group messages into sections with pre-computed stats.
 *
 * Each section starts with a user message and contains all responses until the
 * next user message. When `revertedFromMessageId` is set, the section that owns
 * that message ID AND all sections after it are marked `isReverted: true`.
 *
 * Stats (timing, file changes, tokens) are computed here so that UserMessage
 * components receive them as props and don't need to scan the store themselves.
 */
export const groupMessagesIntoSections = (
	msgs: RenderNode[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
	changedFiles: ChangedFile[] = [],
	turnTokens: Record<string, TokenUsage> = {},
	isProcessing = false,
	cumulativeDiffs: Array<{
		file: string;
		additions: number;
		deletions: number;
		status?: string;
	}> = [],
): MessageSection[] => {
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));
	// Collect sections with their raw (ungrouped) responses
	const sections: MessageSection[] = [];
	let currentSection: MessageSection | null = null;
	let currentResponses: RenderNode[] = [];
	let sectionIndex = 0;
	let pastRevertPoint = false;

	// NOTE: cumulativeDiffs are NOT used for per-turn stats. They represent the
	// session-wide git diff (original→current) and would cause double-counting
	// if applied to individual turns. Per-turn stats use only the per-edit
	// changedFiles entries matched by toolUseId.

	// PERFORMANCE: Create a lookup map for changed files by toolUseId once per render cycle
	// This prevents nested O(N^2) loops inside computeSectionStats.
	// Uses an array per key because apply_patch can touch multiple files with one toolUseId.
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

	// Collect any messages that arrive before the first user message (e.g. system
	// messages, assistant messages from fast responses, error messages). These are
	// stored as "orphan" responses and will be attached to the first user section
	// so they are never silently dropped.
	const orphanedMessages: RenderNode[] = [];

	for (const msg of visibleMsgs) {
		if (msg.kind === 'user') {
			if (currentSection) {
				currentSection.responses = groupRenderResponses(currentResponses, mcpServerNames);
				currentSection.stats = computeSectionStats(
					currentSection,
					currentResponses,
					changedFilesMap,
					false,
					turnTokens,
					cumulativeDiffs,
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
				stats: null as unknown as SectionStats, // computed after responses are collected
			};

			// Prepend any orphaned messages that arrived before this first user message
			if (orphanedMessages.length > 0) {
				currentResponses.push(...orphanedMessages);
				orphanedMessages.length = 0;
			}
		} else if (currentSection) {
			currentResponses.push(msg);
		} else {
			// No user message yet — collect as orphan so it's not lost
			orphanedMessages.push(msg);
		}
	}

	if (currentSection) {
		currentSection.responses = groupRenderResponses(currentResponses, mcpServerNames, isProcessing);
		currentSection.stats = computeSectionStats(
			currentSection,
			currentResponses,
			changedFilesMap,
			true,
			turnTokens,
			cumulativeDiffs,
		);
		sections.push(currentSection);
	}

	// Second pass: fill in isFirst/isLast and nextUserMessageTs.
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
	changedFilesMap: Map<string, ChangedFile[]>,
	isLast: boolean,
	turnTokens: Record<string, TokenUsage> = {},
	_cumulativeDiffs: Array<{
		file: string;
		additions: number;
		deletions: number;
		status?: string;
	}> = [],
): SectionStats {
	const userTs = new Date(section.userMessage.message.time.created).getTime();

	// Last response timestamp
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
		const actionType =
			response.normalizedEntry?.entryType &&
			typeof response.normalizedEntry.entryType === 'object' &&
			'actionType' in response.normalizedEntry.entryType
				? response.normalizedEntry.entryType.actionType
				: buildToolActionType(response.toolName, response.rawInput ?? {});
		const resolvedChanges = resolveFileChanges({
			actionType,
			toolResultMetadata: response.metadata,
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

		const changedFiles = changedFilesMap.get(response.toolUseId) ?? [];
		for (const file of changedFiles) {
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

	// Token count: use only the authoritative per-turn usage figure from the backend.
	const userMsgId = section.userMessage.id;
	const realTokens = userMsgId ? turnTokens[userMsgId] : undefined;
	const tokenCount = getTurnUsageTokenCount(realTokens);

	// Duration: prefer real per-turn data from the backend
	const durationMs = getTurnUsageDuration(realTokens);

	return {
		isFirst: false, // filled in second pass
		isLast,
		nextUserMessageTs: null, // filled in second pass
		lastResponseTs,
		fileChanges,
		tokenCount,
		durationMs,
	};
}
