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
): MessageSection[] => {
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));
	// Collect sections with their raw (ungrouped) responses
	const sections: MessageSection[] = [];
	let currentSection: MessageSection | null = null;
	let currentResponses: Message[] = [];
	let sectionIndex = 0;
	let pastRevertPoint = false;

	for (const msg of visibleMsgs) {
		if (msg.type === 'user') {
			if (currentSection) {
				currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
				currentSection.stats = computeSectionStats(
					currentSection,
					currentResponses,
					changedFiles,
					false,
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
		currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
		currentSection.stats = computeSectionStats(
			currentSection,
			currentResponses,
			changedFiles,
			true,
		);
		sections.push(currentSection);
	}

	// Second pass: fill in isFirst/isLast and nextUserMessageTs
	for (let i = 0; i < sections.length; i++) {
		sections[i].stats.isFirst = i === 0;
		sections[i].stats.isLast = i === sections.length - 1;
		sections[i].stats.nextUserMessageTs =
			i < sections.length - 1 ? new Date(sections[i + 1].userMessage.timestamp).getTime() : null;
	}

	return sections;
};

/** Compute stats for a single section from its raw (flat) responses */
function computeSectionStats(
	section: MessageSection,
	rawResponses: Message[],
	changedFiles: ChangedFile[],
	isLast: boolean,
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

	// File changes: collect toolUseIds from this section's tool_use messages
	let fileChanges: SectionStats['fileChanges'] = null;
	const toolUseIds: string[] = [];
	for (const msg of rawResponses) {
		if (msg.type === 'tool_use' && 'toolUseId' in msg) {
			toolUseIds.push(msg.toolUseId);
		}
	}
	if (toolUseIds.length > 0 && changedFiles.length > 0) {
		let added = 0;
		let removed = 0;
		const filesSet = new Set<string>();
		for (const file of changedFiles) {
			if (toolUseIds.includes(file.toolUseId)) {
				added += file.linesAdded;
				removed += file.linesRemoved;
				filesSet.add(file.filePath);
			}
		}
		if (filesSet.size > 0) {
			fileChanges = { added, removed, files: filesSet.size };
		}
	}

	// Token count: prefer message.tokenCount, fallback to estimatedTokens + content heuristic
	let tokenCount: number | null = null;
	const userMsg = section.userMessage as Record<string, unknown>;
	if (userMsg.tokenCount && typeof userMsg.tokenCount === 'number') {
		tokenCount = userMsg.tokenCount;
	} else {
		let total = 0;
		for (const msg of rawResponses) {
			if (msg.type === 'tool_result' && 'estimatedTokens' in msg && msg.estimatedTokens) {
				total += msg.estimatedTokens;
			}
			if (msg.type === 'assistant' && 'content' in msg && msg.content) {
				total += Math.ceil(msg.content.length / 4);
			}
		}
		if (total > 0) tokenCount = total;
	}

	return {
		isFirst: false, // filled in second pass
		isLast,
		nextUserMessageTs: null, // filled in second pass
		lastResponseTs,
		fileChanges,
		tokenCount,
	};
}
