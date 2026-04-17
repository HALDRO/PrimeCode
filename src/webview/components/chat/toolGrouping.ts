/**
 * @file toolGrouping — pure logic for grouping consecutive lightweight tool messages
 * @description Extracted from SimpleTool.tsx to separate pure grouping logic from UI components.
 * This module has no React dependencies — it operates on derived render message arrays only.
 */

import type { NormalizedEntry } from '../../../common/normalizedTypes';
import { isMcpTool, isNonGroupableTool } from '../../constants';
import type { RenderMessage } from '../../store';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MIN_SIMPLE_TOOL_GROUP_SIZE = 3;
const MAX_BRIDGE_MESSAGE_LENGTH = 200;
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
export interface ToolGroup extends Array<RenderMessage> {
	isLive?: boolean;
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

const isGroupableTool = (msg: RenderMessage, mcpServerNames: string[]): boolean => {
	if (msg.kind !== 'tool_use') {
		return false;
	}

	const toolName = msg.toolName || '';

	if (isMcpTool(toolName, mcpServerNames)) {
		return false;
	}

	return !isNonGroupableTool(toolName);
};

const getToolUseCount = (msgs: RenderMessage[]): number => {
	const uniqueToolUseIds = new Set<string>();
	for (const msg of msgs) {
		if (msg.kind !== 'tool_use') continue;
		if (!msg.toolUseId) continue;
		uniqueToolUseIds.add(msg.toolUseId);
	}
	return uniqueToolUseIds.size;
};

export const isBridgeMessage = (msg: RenderMessage): boolean => {
	if (msg.kind === 'thinking') return true;
	if (msg.kind === 'assistant') {
		const content = (msg as { content?: string }).content || '';
		return content.length <= MAX_BRIDGE_MESSAGE_LENGTH;
	}
	return false;
};

const stripTrailingBridges = (group: RenderMessage[]): RenderMessage[] => {
	const stripped: RenderMessage[] = [];
	while (group.length > 0 && isBridgeMessage(group[group.length - 1])) {
		const msg = group.pop();
		if (msg) stripped.unshift(msg);
	}
	return stripped;
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
	msgs: RenderMessage[],
	mcpServerNames: string[],
	isStreaming = false,
): (RenderMessage | RenderMessage[])[] => {
	const result: (RenderMessage | RenderMessage[])[] = [];
	let currentToolGroup: RenderMessage[] = [];

	const flushGroup = (reason: 'boundary' | 'final') => {
		if (currentToolGroup.length === 0) return;

		const trailingBridges = stripTrailingBridges(currentToolGroup);

		const toolUseCount = getToolUseCount(currentToolGroup);
		const canGroup = toolUseCount >= MIN_SIMPLE_TOOL_GROUP_SIZE;

		if (canGroup) {
			if (reason === 'final' && isStreaming) {
				(currentToolGroup as ToolGroup).isLive = true;
			}
			result.push(currentToolGroup);
		} else {
			result.push(...currentToolGroup);
		}

		result.push(...trailingBridges);

		currentToolGroup = [];
	};

	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i];

		if (isGroupableTool(msg, mcpServerNames)) {
			currentToolGroup.push(msg);
			continue;
		}

		if (isBridgeMessage(msg) && currentToolGroup.length > 0) {
			currentToolGroup.push(msg);
			continue;
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

const shouldTriggerCollapse = (msg: RenderMessage): boolean => {
	if (msg.kind === 'assistant' || msg.kind === 'thinking') {
		return true;
	}

	if (msg.kind === 'subtask') {
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

export type GroupedResponseItem = RenderMessage | RenderMessage[];

const itemTriggersCollapse = (item: GroupedResponseItem): boolean => {
	if (Array.isArray(item)) {
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
