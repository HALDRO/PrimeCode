/**
 * @file ToolGroup - collapsible group of tool messages
 * @description Groups multiple tool messages into a collapsible section when there are
 *              more than one tool call. Shows summary of tool types and counts. Uses CollapsibleSection
 *              for consistent expand/collapse behavior. Only renders tool_use messages -
 *              ToolResultMessage finds related tool_result internally.
 *              Auto-expands when tools are running, auto-collapses when model starts
 *              doing something else (text, edit tools, bash, etc).
 */

import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FILE_EDIT_TOOLS, isMcpTool, isToolInList, isToolMatch } from '../../constants';
import type { Message } from '../../store/chatStore';
import { useMcpServers, useToolResults } from '../../store/selectors';
import { CollapsibleSection } from '../ui';
import { ToolMessage } from './ToolMessage';
import { ToolResultMessage } from './ToolResultMessage';

const INITIAL_VISIBLE_COUNT = 15;

interface ToolGroupProps {
	messages: Message[];
	/** Whether there's content after this group (text, edit tools, bash, etc) */
	hasFollowingContent?: boolean;
}

const getToolName = (msg: Message): string => {
	if (msg.type === 'tool_use' || msg.type === 'tool_result') {
		return msg.toolName || 'Unknown';
	}
	return 'Unknown';
};

const formatToolNameForGroup = (name: string, mcpServerNames: string[]): string => {
	if (isMcpTool(name, mcpServerNames)) {
		return 'MCP';
	}
	return name.replace(/([a-z])([A-Z])/g, '$1 $2');
};

const countToolTypes = (messages: Message[], mcpServerNames: string[]): Map<string, number> => {
	const counts = new Map<string, number>();

	for (const msg of messages) {
		if (msg.type === 'tool_use') {
			const toolName = getToolName(msg);
			const displayName = formatToolNameForGroup(toolName, mcpServerNames);
			counts.set(displayName, (counts.get(displayName) || 0) + 1);
		}
	}

	return counts;
};

const generateSummary = (counts: Map<string, number>): string => {
	const parts: string[] = [];
	for (const [name, count] of counts) {
		parts.push(`${count} ${name}`);
	}
	return parts.join(', ');
};

/**
 * Check if tool should use ToolMessage (Edit/Write/TodoWrite) or ToolResultMessage (all others)
 */
const shouldUseToolMessage = (toolName: string): boolean => {
	// File edit tools and TodoWrite use ToolMessage for their specialized UI
	return isToolInList(toolName, FILE_EDIT_TOOLS) || isToolMatch(toolName, 'TodoWrite');
};

export const ToolGroup: React.FC<ToolGroupProps> = ({ messages, hasFollowingContent = false }) => {
	const mcpServers = useMcpServers();
	const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);
	const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
	const [manuallyToggled, setManuallyToggled] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const wasRunningRef = useRef(false);
	const hadFollowingContentRef = useRef(false);

	// Filter to only tool_use messages (ToolResultMessage finds results internally)
	const toolUseMessages = useMemo(
		() =>
			messages.filter(msg => msg.type === 'tool_use') as Extract<Message, { type: 'tool_use' }>[],
		[messages],
	);

	// Get tool IDs for checking completion status
	const toolIds = useMemo(() => toolUseMessages.map(msg => msg.toolUseId), [toolUseMessages]);

	// Get all tool results to check completion status
	const toolResults = useToolResults(toolIds);

	// Check if any tools are still running (no result yet)
	const hasRunningTools = useMemo(() => {
		return toolIds.some(id => !toolResults[id]);
	}, [toolIds, toolResults]);

	// Check if any tools have errors
	const hasErrors = useMemo(() => {
		return Object.values(toolResults).some(result => result?.isError);
	}, [toolResults]);

	// Auto-expand when tools start running
	// Auto-collapse when model starts doing something else (text, edit, bash, etc)
	useEffect(() => {
		if (manuallyToggled) return;

		if (hasRunningTools && !wasRunningRef.current) {
			// Tools started running - expand
			setIsExpanded(true);
			wasRunningRef.current = true;
		} else if (hasFollowingContent && !hadFollowingContentRef.current && !hasErrors) {
			// Model started doing something else (text, edit, bash) - collapse
			setIsExpanded(false);
			hadFollowingContentRef.current = true;
		}
	}, [hasRunningTools, hasFollowingContent, hasErrors, manuallyToggled]);

	const handleToggle = () => {
		setManuallyToggled(true);
		setIsExpanded(prev => !prev);
	};

	const toolCounts = countToolTypes(messages, mcpServerNames);
	const totalTools = Array.from(toolCounts.values()).reduce((a, b) => a + b, 0);
	const summary = generateSummary(toolCounts);

	// Count completed and errors for status display
	const completedCount = Object.keys(toolResults).length;
	const errorCount = Object.values(toolResults).filter(r => r?.isError).length;

	// Single tool - render without grouping
	if (totalTools <= 1) {
		return (
			<>
				{toolUseMessages.map(msg => (
					<div
						key={msg.id}
						className={
							isToolMatch(msg.toolName, 'Grep') ||
							isToolMatch(msg.toolName, 'Glob') ||
							isToolMatch(msg.toolName, 'LS')
								? 'mb-(--tool-utility-block-margin)'
								: 'mb-(--tool-block-margin)'
						}
					>
						{shouldUseToolMessage(msg.toolName) ? (
							<ToolMessage message={msg} />
						) : (
							<ToolResultMessage message={msg} />
						)}
					</div>
				))}
			</>
		);
	}

	// Build status indicator
	const statusText = hasRunningTools
		? `${completedCount}/${totalTools}`
		: errorCount > 0
			? `${errorCount} error${errorCount > 1 ? 's' : ''}`
			: '';

	// Multiple tools - render as collapsible group
	return (
		<div className="mb-(--tool-utility-block-margin)">
			<CollapsibleSection
				header={
					<span className="opacity-70 flex items-center gap-2">
						<span>
							{totalTools} operations: {summary}
						</span>
						{statusText && (
							<span
								className={
									hasRunningTools
										? 'text-vscode-foreground opacity-60'
										: errorCount > 0
											? 'text-error'
											: ''
								}
							>
								{statusText}
							</span>
						)}
					</span>
				}
				headerStyle={{
					color: 'var(--vscode-descriptionForeground)',
				}}
				expanded={isExpanded}
				onToggle={handleToggle}
			>
				{toolUseMessages.slice(0, visibleCount).map(msg => (
					<div key={msg.id}>
						{shouldUseToolMessage(msg.toolName) ? (
							isToolMatch(msg.toolName, 'TodoWrite') ? (
								<ToolMessage message={msg} />
							) : (
								<ToolMessage message={msg} defaultExpanded={false} />
							)
						) : (
							<ToolResultMessage message={msg} defaultExpanded={false} />
						)}
					</div>
				))}
				{visibleCount < toolUseMessages.length && (
					<button
						type="button"
						onClick={() => setVisibleCount((prev: number) => prev + INITIAL_VISIBLE_COUNT)}
						className="w-full py-1.5 mt-1 text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground hover:bg-vscode-toolbar-hoverBackground rounded cursor-pointer border-none bg-transparent transition-colors"
					>
						Show {toolUseMessages.length - visibleCount} more operations...
					</button>
				)}
			</CollapsibleSection>
		</div>
	);
};

export default ToolGroup;
