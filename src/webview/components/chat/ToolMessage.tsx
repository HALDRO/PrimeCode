/**
 * @file ToolMessage - displays file edit tools and TodoWrite in chat
 * @description Renders Edit/Write/MultiEdit tools with Monaco diff viewer.
 *              TodoWrite shows an expandable task list, but auto-expands only once (when first created)
 *              and while streaming; later updates default to a compact header.
 *              Other tools are handled by ToolResultMessage.
 *              Supports streaming updates for file edits and token estimation display.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { FILE_EDIT_TOOLS, isMcpTool, isToolInList, isToolMatch } from '../../constants';
import { cn } from '../../lib/cn';
import {
	type Message,
	useAccessRequestByToolId,
	useMcpServers,
	useStreamingToolId,
} from '../../store';
import { getShortFileName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import {
	CopyIcon,
	ExpandCollapseIcon,
	ExternalLinkIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from '../icons';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Button, CollapseOverlay, IconButton, Tooltip } from '../ui';
import { InlineToolAccessGate } from './InlineToolAccessGate';
import { getDiffContentHeight, getDiffStats, SimpleDiff } from './SimpleDiff';

interface TodoItem {
	id?: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

interface ToolMessageProps {
	message: Extract<Message, { type: 'tool_use' }>;
	defaultExpanded?: boolean;
}

export const ToolMessage: React.FC<ToolMessageProps> = React.memo(
	({ message, defaultExpanded }) => {
		const { postMessage } = useVSCode();
		const streamingToolId = useStreamingToolId();
		const mcpServers = useMcpServers();
		const { toolName, filePath, rawInput, toolUseId } = message;
		// userExpanded: null = use auto logic, true/false = user override
		// defaultExpanded only affects the auto logic fallback, not the user override state
		const [userExpanded, setUserExpanded] = useState<boolean | null>(null);

		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

		// Optimized selectors - only rerender when specific message changes
		const accessRequest = useAccessRequestByToolId(toolUseId);

		const isStreaming = toolUseId === streamingToolId;
		const hasTodos = useMemo(
			() =>
				isToolMatch(toolName, 'TodoWrite') &&
				rawInput &&
				'todos' in rawInput &&
				Array.isArray(rawInput.todos),
			[toolName, rawInput],
		);

		const isFileEditTool = useMemo(
			() =>
				isToolInList(toolName, FILE_EDIT_TOOLS) &&
				rawInput &&
				(rawInput.old_string !== undefined ||
					rawInput.new_string !== undefined ||
					rawInput.old_str !== undefined ||
					rawInput.new_str !== undefined ||
					rawInput.oldString !== undefined ||
					rawInput.newString !== undefined ||
					rawInput.content !== undefined),
			[toolName, rawInput],
		);

		const getDefaultExpanded = useCallback(() => {
			// If defaultExpanded is explicitly set (e.g., in ToolGroup), use it
			if (defaultExpanded !== undefined) {
				return defaultExpanded;
			}
			// Auto-expand during streaming; TodoWrite expands only on initial creation
			if (isFileEditTool && isStreaming) {
				return true;
			}
			if (hasTodos) {
				const isInitialTodoCreate = (rawInput as { merge?: unknown } | null)?.merge === false;
				return isStreaming || isInitialTodoCreate;
			}
			return false;
		}, [defaultExpanded, isFileEditTool, isStreaming, hasTodos, rawInput]);

		const expanded = userExpanded ?? getDefaultExpanded();

		const toggleExpanded = useCallback(() => {
			setUserExpanded(prev => !(prev ?? expanded));
		}, [expanded]);

		const handleFileClick = useCallback(
			(e?: React.MouseEvent) => {
				if (e) {
					e.stopPropagation();
				}
				if (filePath) {
					postMessage('openFile', { filePath });
				}
			},
			[filePath, postMessage],
		);

		// MCP tools are handled by ToolResultMessage
		const isMcp = useMemo(() => isMcpTool(toolName, mcpServerNames), [toolName, mcpServerNames]);

		if (!toolName) {
			return null;
		}

		if (isMcp) {
			return null;
		}

		// Only handle file edit tools and TodoWrite - everything else goes to ToolResultMessage
		if (!isFileEditTool && !hasTodos) {
			return null;
		}

		// 'hidden' check removed for same reason as ToolResultMessage - visibility is controlled by parent list filtering.
		// if (message.hidden) return null;

		// ==========================================================================
		// File Edit Tools (Edit/Write/MultiEdit)
		// ==========================================================================
		if (isFileEditTool && rawInput) {
			const oldContent =
				(rawInput.old_string as string) ||
				(rawInput.old_str as string) ||
				(rawInput.oldString as string) ||
				'';
			const newContent =
				(rawInput.new_string as string) ||
				(rawInput.new_str as string) ||
				(rawInput.newString as string) ||
				(rawInput.content as string) ||
				'';

			const stats = getDiffStats(oldContent, newContent);
			const fileName = filePath ? getShortFileName(filePath) : 'unknown';
			const maxHeight = 120;
			const contentHeight = getDiffContentHeight(oldContent, newContent);
			const needsExpand = contentHeight > maxHeight;

			return (
				<div>
					<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
						<div
							role={needsExpand ? 'button' : undefined}
							tabIndex={needsExpand ? 0 : undefined}
							onClick={needsExpand ? toggleExpanded : undefined}
							onKeyDown={
								needsExpand
									? e => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												toggleExpanded();
											}
										}
									: undefined
							}
							className={cn(
								'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none',
								'border-b-0',
								needsExpand && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
							)}
						>
							<div className="flex items-center gap-1.5 min-w-0">
								<FileTypeIcon name={fileName} size={14} />
								<Tooltip content="Open file in editor" position="top" delay={200}>
									<button
										type="button"
										onClick={handleFileClick}
										className="text-sm cursor-pointer text-vscode-foreground bg-none border-none p-0 opacity-90 whitespace-nowrap overflow-hidden text-ellipsis"
									>
										{fileName}
									</button>
								</Tooltip>
								{stats.added > 0 && <span className="text-success">+{stats.added}</span>}
								{stats.removed > 0 && <span className="text-error">−{stats.removed}</span>}
							</div>

							<div className="flex items-center gap-0.5 shrink-0 ml-auto">
								<Button
									variant="tool"
									size="sm"
									height={20}
									icon={<ExternalLinkIcon size={14} className="text-vscode-foreground" />}
									onClick={e => {
										e.stopPropagation();
										if (filePath) {
											postMessage('openFileDiff', {
												filePath,
												oldContent,
												newContent,
											});
										}
									}}
									title="Open in diff editor"
									className="font-bold uppercase tracking-wider text-xs text-vscode-foreground opacity-100 px-1"
								>
									Diff
								</Button>
								{needsExpand && (
									<div className="flex items-center justify-center w-5 h-5 opacity-90">
										<ExpandCollapseIcon
											size={14}
											className={cn(
												'transition-transform duration-150 ease-out',
												expanded && 'rotate-180',
											)}
										/>
									</div>
								)}
							</div>
						</div>

						{accessRequest && !isMcpTool(accessRequest.tool, mcpServerNames) && (
							<div className="px-(--tool-header-padding) py-1 border-b border-(--border-subtle) bg-(--tool-bg-header)">
								<InlineToolAccessGate
									requestId={accessRequest.requestId}
									tool={accessRequest.tool}
									input={accessRequest.input}
									pattern={accessRequest.pattern}
								/>
							</div>
						)}

						<div className="relative">
							<SimpleDiff
								original={oldContent}
								modified={newContent}
								maxHeight={maxHeight}
								expanded={expanded}
							/>
							<CollapseOverlay visible={expanded} onCollapse={() => setUserExpanded(false)} />
							<div className="absolute right-(--tool-content-padding) bottom-0">
								<IconButton
									icon={<CopyIcon size={14} />}
									onClick={e => {
										e.stopPropagation();
										navigator.clipboard.writeText(newContent);
									}}
									title="Copy"
									size={20}
								/>
							</div>
						</div>
					</div>
				</div>
			);
		}

		// ==========================================================================
		// TodoWrite - card style like Bash/MCP
		// ==========================================================================
		const rawTodos = (rawInput as { todos?: unknown }).todos;
		const todos = Array.isArray(rawTodos) ? (rawTodos as TodoItem[]) : [];
		const completedCount = todos.filter(t => t.status === 'completed').length;
		const totalCount = todos.length;
		const inProgressTodo = todos.find(t => t.status === 'in_progress');
		const pendingTodo = todos.find(t => t.status === 'pending');
		const lastCompletedTodo = [...todos].reverse().find(t => t.status === 'completed');

		const summaryLabel = (() => {
			if (inProgressTodo) {
				return `In progress: ${inProgressTodo.content}`;
			}
			if (pendingTodo) {
				return `Next: ${pendingTodo.content}`;
			}
			if (lastCompletedTodo) {
				return `Done: ${lastCompletedTodo.content}`;
			}
			return 'No tasks';
		})();

		return (
			<div>
				<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
					<button
						type="button"
						onClick={toggleExpanded}
						className={cn(
							'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) text-sm font-(family-name:--vscode-font-family) bg-transparent border-none cursor-pointer',
							expanded && 'border-b-0',
						)}
					>
						<div className="flex items-center gap-(--gap-2-5) min-w-0">
							<TodoListIcon size={14} className="text-vscode-foreground opacity-80 shrink-0" />
							<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap">
								{completedCount} of {totalCount}
							</span>
							<span className="text-sm text-vscode-foreground opacity-70 truncate">
								{summaryLabel}
							</span>
						</div>
						<div className="flex items-center justify-center w-5 h-5 opacity-90">
							<ExpandCollapseIcon
								size={14}
								className={cn(
									'transition-transform duration-150 ease-out',
									expanded && 'rotate-180',
								)}
							/>
						</div>
					</button>

					{expanded && (
						<div className="relative px-(--tool-header-padding) py-1 bg-(--tool-bg-header)">
							<TodoContent todos={todos} />
							<CollapseOverlay visible={expanded} onCollapse={() => setUserExpanded(false)} />
						</div>
					)}
				</div>
			</div>
		);
	},
);

/** Status icon for todo items */
const TodoStatusIcon: React.FC<{ status: TodoItem['status'] }> = ({ status }) => {
	switch (status) {
		case 'completed':
			return <TodoCheckIcon size={14} className="text-success shrink-0" />;
		case 'in_progress':
			return <TodoProgressIcon size={14} className="text-warning shrink-0" />;
		case 'cancelled':
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-40 shrink-0" />;
		default:
			return <TodoPendingIcon size={14} className="text-vscode-foreground opacity-60 shrink-0" />;
	}
};

const TodoContent: React.FC<{ todos: TodoItem[] }> = ({ todos }) => (
	<div className="flex flex-col gap-1">
		{todos.map(todo => (
			<div key={todo.id || todo.content} className="flex items-center gap-(--gap-2-5)">
				<TodoStatusIcon status={todo.status} />
				<span
					className={cn(
						'text-sm',
						todo.status === 'completed'
							? 'text-vscode-foreground opacity-50 line-through'
							: todo.status === 'cancelled'
								? 'text-vscode-foreground opacity-40 line-through'
								: 'text-vscode-foreground opacity-90',
					)}
				>
					{todo.content}
				</span>
			</div>
		))}
	</div>
);
