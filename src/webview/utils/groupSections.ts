/**
 * @file groupSections - Pure utility for grouping messages into sections
 * @description Extracted from App.tsx for testability. Groups chat messages into
 *              user-message sections with their responses, and marks sections
 *              after the revert point as dimmed.
 */

import { groupToolMessages } from '../components/chat/SimpleTool';
import type { Message } from '../store';

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
}

/**
 * Group messages into sections.
 *
 * Each section starts with a user message and contains all responses until the
 * next user message. When `revertedFromMessageId` is set, the section that owns
 * that message ID AND all sections after it are marked `isReverted: true`.
 */
export const groupMessagesIntoSections = (
	msgs: Message[],
	mcpServerNames: string[],
	revertedFromMessageId: string | null,
): MessageSection[] => {
	const visibleMsgs = msgs.filter(m => !('hidden' in m && m.hidden));
	const sections: MessageSection[] = [];
	let currentSection: MessageSection | null = null;
	let currentResponses: Message[] = [];
	let sectionIndex = 0;
	let pastRevertPoint = false;

	for (const msg of visibleMsgs) {
		if (msg.type === 'user') {
			if (currentSection) {
				currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
				sections.push(currentSection);
				currentResponses = [];
			}
			// Check if this user message is the revert point BEFORE creating the section
			const isThisRevertPoint =
				!!revertedFromMessageId && !pastRevertPoint && msg.id === revertedFromMessageId;
			if (isThisRevertPoint) {
				pastRevertPoint = true;
			}
			currentSection = {
				userMessage: msg as Message & { type: 'user' },
				responses: [],
				sectionIndex: sectionIndex++,
				isReverted: pastRevertPoint,
				isRevertPoint: isThisRevertPoint,
			};
		} else if (currentSection) {
			currentResponses.push(msg);
		}
	}

	if (currentSection) {
		currentSection.responses = groupToolMessages(currentResponses, mcpServerNames);
		sections.push(currentSection);
	}

	return sections;
};
