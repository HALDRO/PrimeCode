/**
 * @file groupSections - Pure utility for grouping messages into sections
 * @description Extracted from App.tsx for testability. Groups chat messages into
 *              user-message sections with their responses, marks sections
 *              after the revert point as dimmed, and pre-computes per-section stats
 *              so the frontend components stay dumb renderers.
 */

import { groupToolMessages } from '../components/chat/SimpleTool';
import type { ChangedFile, Message } from '../store';

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
	userMessage: Message & { type: 'user' };
	responses: (Message | Message[])[];
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
	msgs: Message[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
	changedFiles: ChangedFile[] = [],
	turnTokens: Record<
		string,
		{ input: number; output: number; total: number; cacheRead: number; durationMs?: number }
	> = {},
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
	let currentResponses: Message[] = [];
	let sectionIndex = 0;
	let pastRevertPoint = false;

	// Build cumulative diffs lookup (file → {additions, deletions}) for per-file override.
	// When available, these represent the real git diff (original→current) and are more
	// accurate than per-edit old_string/new_string sums.
	const cumulativeMap = new Map<string, { additions: number; deletions: number }>();
	for (const d of cumulativeDiffs) {
		cumulativeMap.set(d.file, { additions: d.additions, deletions: d.deletions });
	}

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

	for (const msg of visibleMsgs) {
		if (msg.type === 'user') {
			if (currentSection) {
				currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
				currentSection.stats = computeSectionStats(
					currentSection,
					currentResponses,
					changedFilesMap,
					cumulativeMap,
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
				userMessage: msg as Message & { type: 'user' },
				responses: [],
				sectionIndex: sectionIndex++,
				isReverted: pastRevertPoint,
				isRevertPoint: isThisRevertPoint,
				stats: null as unknown as SectionStats, // computed after responses are collected
			};
		} else if (currentSection) {
			currentResponses.push(msg);
		}
	}

	if (currentSection) {
		currentSection.responses = groupToolMessages(currentResponses, mcpServerNames, isProcessing);
		currentSection.stats = computeSectionStats(
			currentSection,
			currentResponses,
			changedFilesMap,
			cumulativeMap,
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

/** Compute stats for a single section from its raw (flat) responses */
function computeSectionStats(
	section: MessageSection,
	rawResponses: Message[],
	changedFilesMap: Map<string, ChangedFile[]>,
	cumulativeMap: Map<string, { additions: number; deletions: number }>,
	isLast: boolean,
	turnTokens: Record<
		string,
		{ input: number; output: number; total: number; cacheRead: number; durationMs?: number }
	> = {},
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

	// File changes: iterate tool_use messages and look up in the Map (O(1) per lookup).
	// When cumulativeDiffs are available, use them for per-file stats so that
	// the numbers match ChangedFilesPanel (git diff original→current).
	let fileChanges: SectionStats['fileChanges'] = null;
	const hasCumulative = cumulativeMap.size > 0;

	if (changedFilesMap.size > 0) {
		let added = 0;
		let removed = 0;
		const filesSet = new Set<string>();

		// Collect all file paths touched by tool_use messages in this turn
		const collectFiles = (toolUseId: string) => {
			const files = changedFilesMap.get(toolUseId);
			if (!files) return;
			for (const file of files) {
				filesSet.add(file.filePath);
				if (!hasCumulative) {
					// No cumulative diffs — use per-edit stats
					added += file.linesAdded;
					removed += file.linesRemoved;
				}
			}
		};

		for (const msg of rawResponses) {
			if (msg.type === 'tool_use' && 'toolUseId' in msg) {
				collectFiles(msg.toolUseId);
			}
			if (msg.type === 'subtask' && msg.transcript) {
				for (const child of msg.transcript) {
					if (child.type === 'tool_use' && 'toolUseId' in child) {
						collectFiles((child as { toolUseId: string }).toolUseId);
					}
				}
			}
		}

		// When cumulative diffs are available, use them for accurate per-file stats.
		// This matches how ChangedFilesPanel computes its totals.
		if (hasCumulative && filesSet.size > 0) {
			for (const filePath of filesSet) {
				const cumulative = cumulativeMap.get(filePath);
				if (cumulative) {
					added += cumulative.additions;
					removed += cumulative.deletions;
				}
			}
		}

		if (filesSet.size > 0) {
			fileChanges = { added, removed, files: filesSet.size };
		}
	}

	// Token count: only use real per-turn data from the backend. No fallback/heuristic.
	let tokenCount: number | null = null;
	const userMsgId = section.userMessage.id;
	const realTokens = userMsgId ? turnTokens[userMsgId] : undefined;
	if (realTokens && realTokens.total > 0) {
		tokenCount = realTokens.total;
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
