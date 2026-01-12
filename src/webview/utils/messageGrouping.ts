import { isMcpTool, isToolInList, NON_GROUPABLE_TOOLS } from '../constants';
import type { Message } from '../store/chatStore';

/**
 * Check if a tool can be grouped with others
 * Only lightweight tools (Read, Grep, Glob, LS) can be grouped
 * Heavy tools (Bash, TodoWrite, MCP, Edit/Write/MultiEdit) are shown individually
 */
export const isGroupableTool = (msg: Message, mcpServerNames: string[]): boolean => {
	if (msg.type !== 'tool_use' && msg.type !== 'tool_result') {
		return false;
	}
	const toolName = msg.toolName || '';

	// MCP tools should not be grouped
	if (isMcpTool(toolName, mcpServerNames)) {
		return false;
	}

	return !isToolInList(toolName, NON_GROUPABLE_TOOLS);
};

/**
 * Group consecutive groupable tool/toolResult messages together
 * Non-groupable tools are rendered individually
 */
export const groupToolMessages = (
	msgs: Message[],
	mcpServerNames: string[],
): (Message | Message[])[] => {
	const result: (Message | Message[])[] = [];
	let currentToolGroup: Message[] = [];

	const flushGroup = () => {
		if (currentToolGroup.length > 0) {
			result.push(currentToolGroup);
			currentToolGroup = [];
		}
	};

	for (const msg of msgs) {
		if (msg.type === 'tool_use' || msg.type === 'tool_result') {
			if (isGroupableTool(msg, mcpServerNames)) {
				currentToolGroup.push(msg);
			} else {
				flushGroup();
				result.push([msg]);
			}
		} else {
			flushGroup();
			result.push(msg);
		}
	}

	flushGroup();
	return result;
};

/**
 * Check if a message represents "content" that should cause preceding tool groups to collapse.
 * Includes:
 * - Text content (assistant messages)
 * - Thinking blocks
 * - Non-groupable "heavy" tools (Bash, Edit, Write, etc.)
 */
export const shouldTriggerCollapse = (msg: Message): boolean => {
	if (msg.type === 'assistant' || msg.type === 'thinking') {
		return true;
	}

	if (msg.type === 'tool_use') {
		const toolName = msg.toolName || '';
		return isToolInList(toolName, NON_GROUPABLE_TOOLS);
	}

	return false;
};
