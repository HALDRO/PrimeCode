/**
 * @file groupSections - Pure utility for grouping messages into sections
 * @description Extracted from App.tsx for testability. Groups chat messages into
 *              user-message sections with their responses, marks sections
 *              after the revert point as dimmed, and pre-computes per-section stats
 *              so the frontend components stay dumb renderers.
 */

import { type GroupedResponseItem, groupToolMessages } from '../components/chat/SimpleTool';
import type { ChangedFile, RenderMessage, RenderUserMessage, TokenUsage } from '../store';

function groupRenderResponses(
	responses: RenderMessage[],
	mcpServerNames: string[],
	isProcessing = false,
): GroupedResponseItem[] {
	const grouped: GroupedResponseItem[] = [];
	let toolBuffer: RenderMessage[] = [];

	const flushTools = () => {
		if (toolBuffer.length === 0) return;
		grouped.push(
			...(groupToolMessages(toolBuffer, mcpServerNames, isProcessing) as
				| RenderMessage[]
				| RenderMessage[][]),
		);
		toolBuffer = [];
	};

	for (const response of responses) {
		if (response.kind === 'tool_use') {
			toolBuffer.push(response);
			continue;
		}
		flushTools();
		grouped.push(response);
	}

	flushTools();
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
	msgs: RenderMessage[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
	changedFiles: ChangedFile[] = [],
	turnTokens: Record<string, TokenUsage> = {},
	isProcessing = false,
	_cumulativeDiffs: Array<{
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
	let currentResponses: RenderMessage[] = [];
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
	const orphanedMessages: RenderMessage[] = [];

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
		);
		sections.push(currentSection);
	}

	// Second pass: fill in isFirst/isLast, nextUserMessageTs, and convert
	// cumulative token snapshots to per-turn deltas.
	// CLI sends cumulative `total` (context window size at each step), so
	// subtracting the previous turn's total gives the real tokens spent on
	// this specific turn.
	let prevTotal = 0;
	for (let i = 0; i < sections.length; i++) {
		sections[i].stats.isFirst = i === 0;
		sections[i].stats.isLast = i === sections.length - 1;
		sections[i].stats.nextUserMessageTs =
			i < sections.length - 1 ? new Date(sections[i + 1].userMessage.timestamp).getTime() : null;

		// Convert cumulative snapshot → per-turn delta
		const snap = sections[i].stats.tokenCount;
		if (snap !== null && snap > 0) {
			const delta = Math.max(0, snap - prevTotal);
			prevTotal = snap;
			sections[i].stats.tokenCount = delta > 0 ? delta : null;
		}
	}

	return sections;
};

/** Compute stats for a single section from its raw responses */
function computeSectionStats(
	section: MessageSection,
	rawResponses: RenderMessage[],
	changedFilesMap: Map<string, ChangedFile[]>,
	isLast: boolean,
	turnTokens: Record<string, TokenUsage> = {},
): SectionStats {
	const userTs = new Date(section.userMessage.timestamp).getTime();

	// Last response timestamp
	let lastResponseTs: number | null = null;
	for (const msg of rawResponses) {
		const t = new Date(msg.timestamp).getTime();
		if (t > userTs && (lastResponseTs === null || t > lastResponseTs)) {
			lastResponseTs = t;
		}
	}

	// File changes: use userMessage.summary.diffs from OpenCode history.
	// This matches the official OpenCode UI for turn-level change summaries.
	let fileChanges: SectionStats['fileChanges'] = null;
	const summaryDiffs = section.userMessage.summary?.diffs;

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
	} else {
		let added = 0;
		let removed = 0;
		let files = 0;
		for (const response of rawResponses) {
			if (response.kind !== 'tool_use') continue;
			const changed = changedFilesMap.get(response.toolUseId);
			if (!changed?.length) continue;
			files += changed.length;
			for (const file of changed) {
				added += file.linesAdded;
				removed += file.linesRemoved;
			}
		}
		if (added > 0 || removed > 0 || files > 0) {
			fileChanges = { added, removed, files };
		}
	}

	// Token count: only use real per-turn data from the backend. No fallback/heuristic.
	let tokenCount: number | null = null;
	const userMsgId = section.userMessage.id;
	const realTokens = userMsgId ? turnTokens[userMsgId] : undefined;
	const totalTokens = realTokens?.total;
	if (typeof totalTokens === 'number' && totalTokens > 0) {
		tokenCount = totalTokens;
	}

	// Duration: prefer real per-turn data from the backend
	let durationMs: number | null = null;
	if (realTokens?.durationMs && realTokens.durationMs > 0) {
		durationMs = realTokens.durationMs;
	}

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
