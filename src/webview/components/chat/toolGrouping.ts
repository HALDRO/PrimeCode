/**
 * @file toolGrouping — pure logic for grouping consecutive lightweight tool messages
 * @description Extracted from SimpleTool.tsx to separate pure grouping logic from UI components.
 * This module has no React dependencies — it operates on derived render message arrays only.
 */

import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { isNonGroupableTool } from '../../constants';
import type { RenderNode } from '../../store';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIN_SIMPLE_TOOL_GROUP_SIZE = 2;
const MAX_BRIDGE_MESSAGE_LENGTH = 200;
const ASSISTANT_BRIDGE_BLOCKERS = ['<system-reminder>', '<task_result>', '```'];
// -----------------------------------------------------------------------------
// Live tool group tracking
// -----------------------------------------------------------------------------

/**
 * A grouped tool array with an `isLive` data marker.
 *
 * When `isLive` is true the group is the trailing streaming group —
 * SimpleToolGroup uses this to enable preview mode (maxHeight + auto-scroll).
 *
 * Unlike the previous WeakSet approach, the marker travels with the data
 * and survives array recreation across render cycles, eliminating the
 * expand→collapse→expand flickering caused by lost object identity.
 */
export interface ToolGroup extends Array<RenderNode> {
	isLive?: boolean;
	shouldCollapse?: boolean;
	bridges?: RenderNode[];
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const isGroupableTool = (msg: RenderNode, _mcpServerNames: string[]): boolean => {
	if (msg.kind !== 'tool_use') {
		return false;
	}

	const entry = (msg as { normalizedEntry?: NormalizedEntry }).normalizedEntry;
	if (
		entry?.entryType &&
		typeof entry.entryType === 'object' &&
		'actionType' in entry.entryType &&
		entry.entryType.actionType.type === 'TaskResult'
	) {
		return false;
	}

	const toolName = msg.toolName || '';
	if (toolName.toLowerCase() === 'question') {
		return false;
	}

	return !isNonGroupableTool(toolName);
};

const getToolUseCount = (msgs: RenderNode[]): number => {
	const uniqueToolUseIds = new Set<string>();
	for (const msg of msgs) {
		if (msg.kind !== 'tool_use') continue;
		if (!msg.toolUseId) continue;
		uniqueToolUseIds.add(msg.toolUseId);
	}
	return uniqueToolUseIds.size;
};

export const isBridgeMessage = (msg: RenderNode): boolean => {
	if (msg.kind === 'thinking') return true;
	if (msg.kind !== 'assistant') return false;
	const content = (msg as { content?: string }).content?.trim() ?? '';
	if (!content) return false;
	if (content.length > MAX_BRIDGE_MESSAGE_LENGTH) return false;
	if (/^[-*]\s/m.test(content)) return false;
	if (ASSISTANT_BRIDGE_BLOCKERS.some(token => content.includes(token))) return false;
	return true;
};

const findNextGroupableToolIndex = (
	msgs: RenderNode[],
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
 * Simple algorithm: tools and bridge messages (short assistant / thinking)
 * are accumulated into a group. When a non-bridge message arrives (heavy tool,
 * long assistant, subtask, etc.) the group is flushed. On flush, trailing
 * bridge messages are stripped from the group and emitted separately.
 * `isStreaming` is only used to mark the trailing group as `isLive` for
 * preview mode in SimpleToolGroup.
 */
export const groupToolMessages = (
	msgs: RenderNode[],
	mcpServerNames: string[],
	isStreaming = false,
): (RenderNode | RenderNode[])[] => {
	const result: (RenderNode | RenderNode[])[] = [];
	let currentToolGroup: RenderNode[] = [];

	const flushGroup = (reason: 'boundary' | 'final', collapseOnFlush = false) => {
		if (currentToolGroup.length === 0) return;

		const toolUseCount = getToolUseCount(currentToolGroup);
		const canGroup = toolUseCount >= MIN_SIMPLE_TOOL_GROUP_SIZE;

		if (canGroup) {
			const group = [...currentToolGroup] as ToolGroup;
			group.isLive = reason === 'final' && isStreaming;
			group.shouldCollapse = reason === 'boundary' && collapseOnFlush;
			result.push(group);
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

		if (isBridgeMessage(msg) && currentToolGroup.length > 0) {
			const nextToolIdx = findNextGroupableToolIndex(msgs, i + 1, mcpServerNames);
			if (nextToolIdx !== -1) {
				for (let j = i; j < nextToolIdx; j++) {
					currentToolGroup.push(msgs[j]);
				}
				i = nextToolIdx - 1;
				continue;
			}

			// During streaming, keep trailing bridge messages (assistant/thinking)
			// inside the group — the next tool may still arrive.
			if (isStreaming) {
				currentToolGroup.push(msg);
				continue;
			}
		}

		// Hard boundary — flush first, then emit the trigger/boundary message outside the group.
		flushGroup('boundary', shouldTriggerCollapse(msg));
		result.push(msg);
	}

	flushGroup('final');
	return result;
};

// -----------------------------------------------------------------------------
// Collapse helpers
// -----------------------------------------------------------------------------

export const shouldTriggerCollapse = (msg: RenderNode): boolean => {
	if (msg.kind === 'assistant') {
		return true;
	}

	if (msg.kind === 'task_result') {
		return true;
	}

	if (msg.kind === 'task_card') {
		return true;
	}

	if (msg.kind === 'system_event') {
		return true;
	}

	if (msg.kind === 'tool_use') {
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

export type GroupedResponseItem = RenderNode | RenderNode[];

export const getGroupedItemShouldCollapse = (item: GroupedResponseItem): boolean =>
	Array.isArray(item) ? Boolean((item as ToolGroup).shouldCollapse) : false;

export const shouldCollapseGroupedItem = (items: GroupedResponseItem[], index: number): boolean => {
	return getGroupedItemShouldCollapse(items[index]);
};

/**
 * Pre-compute collapse flags for all items in a single O(n) reverse pass.
 * Returns a boolean[] where result[i] === shouldCollapseGroupedItem(items, i).
 * This eliminates the O(n²) cost of calling shouldCollapseGroupedItem per item during render.
 */
export const precomputeCollapseFlags = (items: GroupedResponseItem[]): boolean[] => {
	return items.map(getGroupedItemShouldCollapse);
};
