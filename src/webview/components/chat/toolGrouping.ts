/**
 * @file toolGrouping — pure logic for grouping consecutive lightweight tool messages
 * @description Extracted from SimpleTool.tsx to separate pure grouping logic from UI components.
 * This module has no React dependencies — it operates on Message arrays only.
 */

import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { isMcpTool, isNonGroupableTool } from '../../constants';
import type { Message } from '../../store/chatStore';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIN_SIMPLE_TOOL_GROUP_SIZE = 3;
const MAX_BRIDGE_MESSAGE_LENGTH = 200;

// -----------------------------------------------------------------------------
// Live tool group tracking
// -----------------------------------------------------------------------------

/**
 * WeakSet of grouped Message[] arrays that were created as trailing streaming groups.
 * SimpleToolGroup checks this to enable preview mode (maxHeight + auto-scroll).
 */
export const liveToolGroups = new WeakSet<Message[]>();

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const isGroupableTool = (msg: Message, mcpServerNames: string[]): boolean => {
	if (msg.type !== 'tool_use' && msg.type !== 'tool_result') {
		return false;
	}
	const toolName = msg.toolName || '';

	if (isMcpTool(toolName, mcpServerNames)) {
		return false;
	}

	return !isNonGroupableTool(toolName);
};

const getToolUseCount = (msgs: Message[]): number =>
	msgs.reduce((count, msg) => count + (msg.type === 'tool_use' ? 1 : 0), 0);

/** Whether a message can act as a bridge between two tool groups */
export const isBridgeMessage = (msg: Message): boolean => {
	if (msg.type === 'thinking') return true;
	if (msg.type === 'assistant') {
		const content = (msg as { content?: string }).content || '';
		return content.length <= MAX_BRIDGE_MESSAGE_LENGTH;
	}
	return false;
};

/**
 * Look ahead from position `start` to see if there are groupable tools
 * after a sequence of bridge messages (assistant/thinking).
 * Returns the index of the next groupable tool, or -1 if none found.
 */
const findNextGroupableToolIndex = (
	msgs: Message[],
	start: number,
	mcpServerNames: string[],
): number => {
	for (let i = start; i < msgs.length; i++) {
		const msg = msgs[i];
		if (isGroupableTool(msg, mcpServerNames)) return i;
		if (!isBridgeMessage(msg)) return -1;
	}
	return -1;
};

// -----------------------------------------------------------------------------
// Main grouping function
// -----------------------------------------------------------------------------

/**
 * Group consecutive lightweight tool runs.
 *
 * Groups uninterrupted sequences of groupable tool_use/tool_result messages.
 * Assistant and thinking messages between two groupable tool sequences are
 * absorbed into the group as "bridge" messages — they are preserved and
 * rendered inside the group, not removed.
 *
 * Any other non-tool message (heavy tool, subtask, etc.) acts as a hard
 * boundary that flushes the current group.
 *
 * When streaming, trailing tool runs are also grouped for preview mode.
 */
export const groupToolMessages = (
	msgs: Message[],
	mcpServerNames: string[],
	isStreaming = false,
): (Message | Message[])[] => {
	const result: (Message | Message[])[] = [];
	let currentToolGroup: Message[] = [];

	const flushGroup = (reason: 'boundary' | 'final') => {
		if (currentToolGroup.length === 0) return;

		const toolUseCount = getToolUseCount(currentToolGroup);
		const canGroup = toolUseCount >= MIN_SIMPLE_TOOL_GROUP_SIZE;

		if (canGroup) {
			if (reason === 'final' && isStreaming) {
				liveToolGroups.add(currentToolGroup);
			}
			result.push(currentToolGroup);
		} else {
			result.push(...currentToolGroup);
		}

		currentToolGroup = [];
	};

	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i];

		if (isGroupableTool(msg, mcpServerNames)) {
			currentToolGroup.push(msg);
			continue;
		}

		// Bridge messages (assistant/thinking) — absorb into group if tools follow
		if (isBridgeMessage(msg) && currentToolGroup.length > 0) {
			const nextToolIdx = findNextGroupableToolIndex(msgs, i + 1, mcpServerNames);
			if (nextToolIdx !== -1) {
				// Absorb this bridge message and all bridges up to the next tool
				for (let j = i; j < nextToolIdx; j++) {
					currentToolGroup.push(msgs[j]);
				}
				i = nextToolIdx - 1; // loop will i++ to nextToolIdx
				continue;
			}

			// While streaming, trailing bridge messages are kept in the group so it
			// stays "live" and doesn't collapse prematurely. If more tools arrive on
			// the next render cycle the bridge will already be inside the group.
			if (isStreaming) {
				currentToolGroup.push(msg);
				continue;
			}
		}

		// Hard boundary — flush and emit as-is
		flushGroup('boundary');
		result.push(msg);
	}

	flushGroup('final');
	return result;
};

// -----------------------------------------------------------------------------
// Collapse helpers
// -----------------------------------------------------------------------------

const shouldTriggerCollapse = (msg: Message): boolean => {
	if (msg.type === 'assistant' || msg.type === 'thinking') {
		return true;
	}

	if (msg.type === 'tool_use') {
		const toolName = msg.toolName || '';
		if (isNonGroupableTool(toolName)) return true;
		// TaskResult (via normalizedEntry) should also trigger collapse
		const entry = (msg as { normalizedEntry?: NormalizedEntry }).normalizedEntry;
		if (
			entry?.entryType &&
			typeof entry.entryType === 'object' &&
			'actionType' in entry.entryType &&
			entry.entryType.actionType.type === 'TaskResult'
		) {
			return true;
		}
	}

	return false;
};

type GroupedResponseItem = Message | Message[];

const itemTriggersCollapse = (item: GroupedResponseItem): boolean => {
	if (Array.isArray(item)) {
		// Bridge messages (assistant/thinking) inside a grouped array are not collapse triggers —
		// they were absorbed as connectors between tool sequences.
		return item.some(msg => !isBridgeMessage(msg) && shouldTriggerCollapse(msg));
	}
	return shouldTriggerCollapse(item);
};

export const shouldCollapseGroupedItem = (items: GroupedResponseItem[], index: number): boolean => {
	const current = items[index];
	if (!Array.isArray(current)) return false;
	if (getToolUseCount(current) < MIN_SIMPLE_TOOL_GROUP_SIZE) return false;

	for (let i = index + 1; i < items.length; i++) {
		if (itemTriggersCollapse(items[i])) {
			return true;
		}
	}

	return false;
};

/**
 * Pre-compute collapse flags for all items in a single O(n) reverse pass.
 * Returns a boolean[] where result[i] === shouldCollapseGroupedItem(items, i).
 * This eliminates the O(n²) cost of calling shouldCollapseGroupedItem per item during render.
 */
export const precomputeCollapseFlags = (items: GroupedResponseItem[]): boolean[] => {
	const flags = new Array<boolean>(items.length);
	let hasCollapseTriggerAhead = false;

	for (let i = items.length - 1; i >= 0; i--) {
		const current = items[i];
		if (Array.isArray(current) && getToolUseCount(current) >= MIN_SIMPLE_TOOL_GROUP_SIZE) {
			flags[i] = hasCollapseTriggerAhead;
		} else {
			flags[i] = false;
		}
		if (itemTriggersCollapse(current)) {
			hasCollapseTriggerAhead = true;
		}
	}

	return flags;
};
