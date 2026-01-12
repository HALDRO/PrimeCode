/**
 * @file ToolResultMessage - unified tool execution display component
 * @description Renders tool execution with all states: waiting, running (with streaming), completed.
 *              Accepts tool_use message and finds related tool_result internally.
 *              Handles Bash, MCP, Grep/Glob/LS with appropriate layouts.
 *              Uses internal helper components to reduce duplication across tool types.
 */

import React, { type ReactNode, useMemo, useState } from 'react';
import {
	FILE_EDIT_TOOLS,
	isMcpTool,
	isThinkTool,
	isToolInList,
	isToolMatch,
} from '../../constants';
import { cn } from '../../lib/cn';
import {
	type Message,
	useAccessRequestByToolId,
	useMcpServers,
	useToolResultByToolId,
} from '../../store';
import { formatDuration, formatToolName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import { ChevronDownIcon, CopyIcon, ExpandCollapseIcon, McpIcon, TerminalIcon } from '../icons';
import { CollapseOverlay, FileLink, IconButton, StatusIndicator } from '../ui';
import { InlineToolAccessGate } from './InlineToolAccessGate';

// ==========================================================================
// Shared constants and helpers
// ==========================================================================

const PREVIEW_LINE_COUNT = 6;
const CARD_CLASSES =
	'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden';
const HEADER_BASE_CLASSES =
	'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none';

/** Calculate preview content and check if expansion is needed */
const getPreviewData = (content: string) => {
	const lines = content.split('\n');
	const lineCount = lines.length;
	const needsExpand = lineCount > PREVIEW_LINE_COUNT;
	return { lines, lineCount, needsExpand };
};

// ==========================================================================
// Shared sub-components
// ==========================================================================

/** Streaming output display during tool execution */
const StreamingOutput: React.FC<{ output: string }> = ({ output }) => (
	<div className="px-(--tool-content-padding) py-2 bg-(--tool-bg-content) max-h-(--content-max-height-lg) overflow-auto">
		<pre className="text-sm text-vscode-foreground whitespace-pre m-0">{output}</pre>
	</div>
);

/** Running indicator with optional streaming */
const RunningIndicator: React.FC = () => (
	<div className="flex items-center gap-1.5 shrink-0">
		<StatusIndicator variant="processing" size={6} />
		<span className="text-sm text-vscode-foreground opacity-70">Running...</span>
	</div>
);

/** Expand/collapse chevron icon */
const ExpandIcon: React.FC<{ expanded: boolean }> = ({ expanded }) => (
	<div className="flex items-center justify-center w-5 h-5 opacity-90">
		<ExpandCollapseIcon
			size={14}
			className={cn('transition-transform duration-150 ease-out', expanded && 'rotate-180')}
		/>
	</div>
);

/** Expandable card header with keyboard support */
const CardHeader: React.FC<{
	children: ReactNode;
	needsExpand: boolean;
	expanded?: boolean;
	onToggle: () => void;
}> = ({ children, needsExpand, expanded = false, onToggle }) => {
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onToggle();
		}
	};

	return (
		<div
			role={needsExpand ? 'button' : undefined}
			tabIndex={needsExpand ? 0 : undefined}
			onClick={needsExpand ? onToggle : undefined}
			onKeyDown={needsExpand ? handleKeyDown : undefined}
			className={cn(
				HEADER_BASE_CLASSES,
				needsExpand && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
				expanded && 'border-b-0',
			)}
		>
			{children}
		</div>
	);
};

/** Content area with pre-formatted text and copy button */
const ContentArea: React.FC<{
	content: string;
	expanded: boolean;
	isError?: boolean;
	onCopy: () => void;
}> = ({ content, expanded, isError, onCopy }) => {
	const { lines } = getPreviewData(content);
	const previewContent = expanded ? content : lines.slice(-PREVIEW_LINE_COUNT).join('\n');

	return (
		<div
			className={cn(
				'relative p-(--tool-content-padding) transition-[max-height] duration-200 ease-linear bg-(--tool-bg-header)',
				expanded
					? 'max-h-(--content-max-height-xl) overflow-auto'
					: 'max-h-auto overflow-x-auto overflow-y-hidden',
			)}
		>
			<pre
				className={cn(
					'm-0 text-sm leading-(--line-height-code) whitespace-pre pr-6',
					isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-90',
				)}
			>
				{previewContent}
			</pre>
			<div className="absolute right-(--tool-content-padding) bottom-0">
				<IconButton
					icon={<CopyIcon size={14} />}
					onClick={e => {
						e.stopPropagation();
						onCopy();
					}}
					title="Copy output"
					size={20}
				/>
			</div>
		</div>
	);
};

interface ToolResultMessageProps {
	/** Tool use message - component finds related result internally */
	message: Extract<Message, { type: 'tool_use' }>;
	/** Whether to expand the result by default */
	defaultExpanded?: boolean;
}

export const ToolResultMessage: React.FC<ToolResultMessageProps> = React.memo(
	({ message, defaultExpanded }) => {
		const { toolName, toolUseId, filePath, rawInput, streamingOutput } = message;

		// Force collapse for Read tool and Bash to avoid wall of text
		// Console output should always start collapsed
		const isRead = useMemo(() => isToolMatch(toolName, 'Read'), [toolName]);
		const isBash = useMemo(() => isToolMatch(toolName, 'Bash'), [toolName]);
		const [expanded, setExpanded] = useState(isRead || isBash ? false : (defaultExpanded ?? true));
		const { postMessage } = useVSCode();
		const mcpServers = useMcpServers();

		// Get MCP server names for OpenCode format detection
		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

		// Optimized selectors - only rerender when specific message changes
		const toolResult = useToolResultByToolId(toolUseId);
		const accessRequest = useAccessRequestByToolId(toolUseId);

		// Extract result data (or defaults for running state)
		const isError = toolResult?.isError ?? false;
		const content = toolResult?.content ?? '';
		const hidden = toolResult?.hidden;
		const title = toolResult?.title;
		const durationMs = toolResult?.durationMs;
		const attachments = toolResult?.attachments;

		// Determine tool state
		const isRunning = !toolResult && !accessRequest;
		const isWaitingPermission = !!accessRequest;
		const isCompleted = !!toolResult;

		// ALL HOOKS MUST BE CALLED BEFORE ANY EARLY RETURNS
		// Calculate values for Grep/Glob/LS/Serena_list_dir tools unconditionally
		const isCollapsibleTool = useMemo(
			() => ['Grep', 'Glob', 'LS', 'Serena_list_dir'].some(t => isToolMatch(toolName, t)),
			[toolName],
		);

		// Serena "think" tools - agent reasoning/reflection
		const isThinkingTool = isThinkTool(toolName);

		const displayText = useMemo(() => {
			const normalizedName = toolName.toLowerCase();
			switch (normalizedName) {
				case 'ls':
				case 'serena_list_dir':
					return filePath || (rawInput as { path?: string })?.path || '';
				case 'glob':
				case 'grep':
					return rawInput?.pattern ? String(rawInput.pattern) : '';
				default:
					return '';
			}
		}, [toolName, filePath, rawInput]);

		const headerLabel = useMemo(() => {
			if (!rawInput) {
				return toolName;
			}
			const normalizedName = toolName.toLowerCase();
			switch (normalizedName) {
				case 'grep': {
					const pattern = rawInput.pattern || '';
					const path = rawInput.path || 'src';
					return `Grepped ${pattern} in ${path}`;
				}
				case 'glob': {
					const lines = content.split('\n').filter(l => l.trim());
					const pattern = rawInput.pattern || '';
					return `Found ${lines.length} files matching ${pattern}`;
				}
				case 'ls':
				case 'serena_list_dir': {
					const path = filePath || rawInput?.path || '.';
					return `Listed ${path}`;
				}
				default:
					return toolName;
			}
		}, [toolName, rawInput, content, filePath]);

		const handleToggle = useMemo(() => () => setExpanded(prev => !prev), []);

		// NOW we can have early returns
		if (!toolName) {
			return null;
		}

		// Hide file edit tools (they have dedicated UI in ToolMessage)
		if (isToolInList(toolName, FILE_EDIT_TOOLS) && !isError) {
			return null;
		}

		// Hide if marked hidden (unless error)
		// Note: hidden visibility is controlled by parent list filtering (App.tsx).
		// ToolResultMessage must still render when nested (e.g., inside SubtaskMessage).
		// So we intentionally do NOT early-return here.
		void hidden;

		const isConsoleOutput = isToolMatch(toolName, 'Bash');
		const isMcp = isMcpTool(toolName, mcpServerNames);

		const dotVariant = isError ? 'error' : isCompleted ? 'info' : 'processing';

		// ==========================================================================
		// Bash console output
		// ==========================================================================
		if (isConsoleOutput) {
			const command = rawInput?.command as string | undefined;
			const handleCopyCommand = (e: React.MouseEvent) => {
				e.stopPropagation();
				if (command) {
					navigator.clipboard.writeText(command);
				}
			};

			const BashHeader: React.FC<{ iconColor: string; rightContent?: ReactNode }> = ({
				iconColor,
				rightContent,
			}) => (
				<>
					<div className="flex items-center gap-1.5 min-w-0">
						<TerminalIcon size={14} className={`${iconColor} shrink-0`} />
						<IconButton
							icon={<CopyIcon size={12} />}
							onClick={handleCopyCommand}
							title="Copy command"
							size={20}
						/>
						<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap overflow-hidden text-ellipsis">
							{command || 'command'}
						</span>
					</div>
					{rightContent}
				</>
			);

			// Waiting for permission
			if (isWaitingPermission && accessRequest) {
				return (
					<div>
						<div className={CARD_CLASSES}>
							<div className={cn(HEADER_BASE_CLASSES, 'border-b-0')}>
								<BashHeader iconColor="text-warning" />
							</div>
							<div className="px-(--tool-header-padding) py-1 bg-(--tool-bg-header)">
								<InlineToolAccessGate
									requestId={accessRequest.requestId}
									tool={accessRequest.tool}
									input={accessRequest.input}
									pattern={accessRequest.pattern}
								/>
							</div>
						</div>
					</div>
				);
			}

			// Running - show output area only if there's streaming output
			if (isRunning) {
				return (
					<div>
						<div className={CARD_CLASSES}>
							<div className={cn(HEADER_BASE_CLASSES, streamingOutput && 'border-b-0')}>
								<BashHeader iconColor="text-warning" rightContent={<RunningIndicator />} />
							</div>
							{streamingOutput && <StreamingOutput output={streamingOutput} />}
						</div>
					</div>
				);
			}

			// Completed - show result
			const { needsExpand } = getPreviewData(content);

			return (
				<div>
					<div className={CARD_CLASSES}>
						<CardHeader needsExpand={needsExpand} expanded={expanded} onToggle={handleToggle}>
							<BashHeader
								iconColor="text-success"
								rightContent={
									<div className="flex items-center gap-0.5 shrink-0 ml-auto">
										<StatusIndicator variant={isError ? 'error' : 'success'} showLabel size={6} />
										{needsExpand && <ExpandIcon expanded={expanded} />}
									</div>
								}
							/>
						</CardHeader>
						{content && (
							<div className="relative">
								<ContentArea
									content={content}
									expanded={expanded}
									isError={isError}
									onCopy={() => navigator.clipboard.writeText(content)}
								/>
								<CollapseOverlay
									visible={expanded && needsExpand}
									onCollapse={() => setExpanded(false)}
									label="Hide"
								/>
							</div>
						)}
					</div>
				</div>
			);
		}

		// ==========================================================================
		// MCP tool output
		// ==========================================================================
		if (isMcp) {
			const mcpArgs = rawInput ? JSON.stringify(rawInput) : '';
			const displayTitle = title || formatToolName(toolName);
			const mcpCall = `${formatToolName(toolName)}${mcpArgs ? ` ${mcpArgs}` : ''}`;

			const handleCopyCall = (e: React.MouseEvent) => {
				e.stopPropagation();
				navigator.clipboard.writeText(mcpCall);
			};
			const handleCopyContent = () => navigator.clipboard.writeText(content);

			const McpHeader: React.FC<{ rightContent?: ReactNode }> = ({ rightContent }) => (
				<>
					<div className="flex items-center gap-1.5 min-w-0">
						<McpIcon size={14} className="text-[#3b82f6] shrink-0" />
						<IconButton
							icon={<CopyIcon size={12} />}
							onClick={handleCopyCall}
							title="Copy call"
							size={20}
						/>
						<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap overflow-hidden text-ellipsis">
							{displayTitle}
							{mcpArgs && <span className="opacity-70 ml-1.5 font-normal">{mcpArgs}</span>}
						</span>
					</div>
					{rightContent}
				</>
			);

			// Running - show output area only if there's streaming output
			if (isRunning) {
				return (
					<div>
						<div className={CARD_CLASSES}>
							<div className={cn(HEADER_BASE_CLASSES, streamingOutput && 'border-b-0')}>
								<McpHeader rightContent={<RunningIndicator />} />
							</div>
							{streamingOutput && <StreamingOutput output={streamingOutput} />}
						</div>
					</div>
				);
			}

			// Completed - show result
			const { needsExpand } = getPreviewData(content);

			return (
				<div>
					<div className={CARD_CLASSES}>
						<CardHeader needsExpand={needsExpand} expanded={expanded} onToggle={handleToggle}>
							<McpHeader
								rightContent={
									<div className="flex items-center gap-1.5 shrink-0 ml-auto">
										{durationMs && durationMs > 0 && (
											<span className="text-xs text-vscode-foreground opacity-70">
												{formatDuration(durationMs)}
											</span>
										)}
										<StatusIndicator variant={isError ? 'error' : 'success'} showLabel size={6} />
										{needsExpand && <ExpandIcon expanded={expanded} />}
									</div>
								}
							/>
						</CardHeader>

						{content && (
							<div className="relative">
								<ContentArea
									content={content}
									expanded={expanded}
									isError={isError}
									onCopy={handleCopyContent}
								/>
								<CollapseOverlay
									visible={expanded && needsExpand}
									onCollapse={() => setExpanded(false)}
									label="Hide"
								/>
							</div>
						)}

						{/* Attachments (e.g., screenshots, generated images) */}
						{attachments && attachments.length > 0 && (
							<div className="p-(--tool-content-padding) border-t border-white/5 flex flex-wrap gap-2">
								{attachments.map(att => {
									const isDataUrl = att.url?.startsWith('data:');
									const isFileUrl = att.url?.startsWith('file://');
									const isImage = att.mime.startsWith('image/');
									const displayName = att.filename || (isImage ? 'image' : att.mime);

									// For data: URLs (base64 images), show inline preview
									if (isDataUrl && isImage) {
										return (
											<div key={att.id} className="flex flex-col gap-1">
												<img
													src={att.url}
													alt={displayName}
													className="max-w-(--content-max-height-lg) max-h-(--content-max-height-md) rounded border border-white/10 object-contain"
												/>
												<span className="text-xs text-vscode-foreground opacity-60">
													{displayName}
												</span>
											</div>
										);
									}

									// For file:// URLs, show as clickable link that opens in VS Code
									if (isFileUrl) {
										const filePath = att.url?.replace('file://', '') || '';
										return (
											<button
												type="button"
												key={att.id}
												onClick={() => postMessage('openFile', { filePath })}
												className="flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-xs cursor-pointer border-none text-vscode-textLink-foreground"
											>
												{isImage ? '🖼️' : '📎'} {displayName}
											</button>
										);
									}

									// For http:// URLs, open in browser
									if (att.url?.startsWith('http')) {
										return (
											<a
												key={att.id}
												href={att.url}
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 rounded text-xs text-vscode-textLink-foreground hover:underline"
											>
												{isImage ? '🖼️' : '📎'} {displayName}
											</a>
										);
									}

									// Fallback: just show the name
									return (
										<div
											key={att.id}
											className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded text-xs"
										>
											<span className="text-vscode-foreground opacity-80">📎 {displayName}</span>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
			);
		}

		// ==========================================================================
		// Grep/Glob/LS/Read collapsible output
		// ==========================================================================
		const getFolderFromPath = (fp: string) => {
			const parts = fp.split(/[/\\]/);
			return parts.length > 1 ? parts[parts.length - 2] : '';
		};

		// ==========================================================================
		// Read file output (Simple File Link)
		// ==========================================================================
		if (isToolMatch(toolName, 'Read')) {
			if (isRunning) {
				return (
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant="processing" size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm">
							Reading {filePath ? filePath.split(/[/\\]/).pop() : 'file'}...
						</span>
					</div>
				);
			}

			if (isError) {
				// Make error message compact - show only filename and short error
				const path = filePath || (rawInput as { path?: string })?.path || '';
				const fileName = path ? path.split(/[/\\]/).pop() : 'file';
				// Extract short error message (remove "Error:" prefix and path)
				const shortError = content
					? content
							.replace(/^Error:\s*/i, '')
							.replace(path, fileName || '')
							.trim()
					: 'File not found';

				return (
					<div className="flex items-center gap-1.5 min-w-0 py-0.5">
						<StatusIndicator variant="error" size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm">Read</span>
						<span className="text-error text-sm truncate">{fileName}</span>
						<span className="text-vscode-descriptionForeground text-sm opacity-70 truncate">
							{shortError}
						</span>
					</div>
				);
			}

			const path = filePath || (rawInput as { path?: string })?.path || '';
			const input = rawInput as { start_line?: number; end_line?: number } | undefined;
			const isPartial = input?.start_line !== undefined || input?.end_line !== undefined;

			const lineCount = content ? content.split('\n').length : 0;
			const actualLineCount = content && content.length > 0 ? lineCount : 0;
			const folder = getFolderFromPath(path);

			return (
				<div className="flex items-center gap-2 min-w-0 py-0.5">
					<div className="flex items-center gap-1.5 shrink-0">
						<StatusIndicator variant={dotVariant} size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm">Read</span>
					</div>

					<div className="shrink-0 min-w-0">
						<FileLink
							path={path}
							folder={folder}
							onClick={() => postMessage('openFile', { filePath: path })}
							compact
						/>
					</div>

					{isPartial && actualLineCount > 0 && (
						<span className="text-vscode-descriptionForeground whitespace-nowrap opacity-80">
							{actualLineCount} lines
						</span>
					)}
				</div>
			);
		}

		// ==========================================================================
		// Serena "think" tools - agent reasoning/reflection (collapsible)
		// ==========================================================================
		if (isThinkingTool) {
			// Extract readable label from tool name (e.g., "serena_think_about_task_adherence" -> "Task Adherence")
			const thinkLabel = toolName
				.toLowerCase()
				.replace(/^serena_think_about_/, '')
				.replace(/_/g, ' ')
				.replace(/\b\w/g, c => c.toUpperCase());

			// Running state
			if (isRunning) {
				return (
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant="processing" size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm italic">
							💭 Thinking about {thinkLabel}...
						</span>
					</div>
				);
			}

			// No result yet
			if (!isCompleted || content.length === 0) {
				return (
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant={isError ? 'error' : 'processing'} size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm italic">
							💭 Thinking about {thinkLabel}...
						</span>
					</div>
				);
			}

			// Completed - show collapsible thought content
			const { needsExpand } = getPreviewData(content);
			const previewContent = expanded
				? content
				: content.slice(0, 200) + (content.length > 200 ? '...' : '');

			return (
				<div>
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant={dotVariant} size={6} />
						<button
							type="button"
							onClick={handleToggle}
							className="flex items-center gap-1.5 bg-none border-none cursor-pointer text-vscode-foreground font-(family-name:--vscode-font-family) text-sm text-left p-0 opacity-90 hover:opacity-100 min-w-0"
						>
							<span className="text-vscode-foreground opacity-90 italic">💭 {thinkLabel}</span>
							{(needsExpand || content.length > 200) && (
								<ChevronDownIcon
									size={14}
									className={cn(
										'opacity-70 transition-transform duration-150',
										expanded && 'rotate-180',
									)}
								/>
							)}
						</button>
					</div>

					{expanded && (
						<div className="pl-(--collapsible-indent) border-l border-white/6 ml-(--gap-1) py-1">
							<pre className="text-sm text-vscode-foreground opacity-70 whitespace-pre-wrap m-0">
								{previewContent}
							</pre>
						</div>
					)}
				</div>
			);
		}

		// ==========================================================================
		// Grep/Glob/LS/Serena_list_dir collapsible output
		// ==========================================================================
		if (isCollapsibleTool) {
			// Running state - show output only if there's streaming output
			if (isRunning) {
				return (
					<div>
						<div className="flex items-center gap-1.5 h-(--tool-header-height)">
							<StatusIndicator variant="processing" size={6} />
							<span className="text-vscode-foreground opacity-90 text-sm">
								{formatToolName(toolName)} {displayText}
							</span>
							<span className="text-sm text-vscode-foreground opacity-70 ml-auto">Running...</span>
						</div>
						{streamingOutput && (
							<div className="pl-(--collapsible-indent) border-l border-white/6 ml-(--gap-1)">
								<pre className="text-sm text-vscode-foreground opacity-70 whitespace-pre m-0 overflow-x-auto">
									{streamingOutput}
								</pre>
							</div>
						)}
					</div>
				);
			}

			// No result yet and no content - show waiting
			if (!isCompleted || content.length === 0) {
				return (
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant={isError ? 'error' : 'processing'} size={6} />
						<span className="text-vscode-foreground opacity-90 text-sm">
							{formatToolName(toolName)} {displayText}
						</span>
						{isError && <span className="text-error ml-auto">{content || 'Error'}</span>}
					</div>
				);
			}

			// Completed - show result
			// Parse Serena_list_dir JSON output: {"dirs": [...], "files": [...]}
			let lines: string[];
			if (isToolMatch(toolName, 'Serena_list_dir')) {
				try {
					const parsed = JSON.parse(content) as { dirs?: string[]; files?: string[] };
					const dirs = (parsed.dirs || []).map(d => `${d}/`);
					const files = parsed.files || [];
					lines = [...dirs, ...files];
				} catch {
					// Fallback to line-based parsing if JSON parse fails
					lines = content.split('\n').filter(l => l.trim());
				}
			} else {
				lines = content.split('\n').filter(l => l.trim());
			}
			const lineCount = lines.length;
			const displayLines = expanded ? lines : lines.slice(-PREVIEW_LINE_COUNT);

			const renderFileEntry = (line: string, idx: number) => {
				const lineKey = `${toolUseId}-line-${idx}`;
				const trimmedLine = line.trim();
				if (!trimmedLine) {
					return null;
				}

				// Handle informational messages that are not file paths
				if (
					trimmedLine.startsWith('Found ') ||
					trimmedLine.startsWith('No files found') ||
					trimmedLine.startsWith('Listed ') ||
					trimmedLine.includes(' results')
				) {
					return (
						<div
							key={lineKey}
							className="px-1 py-0.5 text-xs text-vscode-descriptionForeground opacity-80"
						>
							{trimmedLine}
						</div>
					);
				}

				const grepMatch = trimmedLine.match(/^([^:]+):(\d+):(.*)$/);
				if (grepMatch && isToolMatch(toolName, 'Grep')) {
					const [, fp, lineNum] = grepMatch;
					const folder = getFolderFromPath(fp);
					return (
						<div key={lineKey} className="-mx-1">
							<FileLink
								path={fp}
								line={parseInt(lineNum, 10)}
								folder={folder}
								onClick={() => postMessage('openFile', { filePath: fp })}
								compact
							/>
						</div>
					);
				}

				const isFolder = trimmedLine.endsWith('/') || !trimmedLine.includes('.');
				const folder = getFolderFromPath(trimmedLine);
				return (
					<div key={lineKey} className="-mx-1">
						<FileLink
							path={trimmedLine}
							folder={folder}
							isFolder={isFolder}
							onClick={() => postMessage('openFile', { filePath: trimmedLine })}
							compact
						/>
					</div>
				);
			};

			return (
				<div>
					<div className="flex items-center gap-1.5 h-(--tool-header-height)">
						<StatusIndicator variant={dotVariant} size={6} />
						<button
							type="button"
							onClick={handleToggle}
							className="flex items-center gap-1.5 bg-none border-none cursor-pointer text-vscode-foreground font-(family-name:--vscode-font-family) text-sm text-left p-0 opacity-90 hover:opacity-100 min-w-0"
						>
							<span className="text-vscode-foreground opacity-90 truncate">{headerLabel}</span>
							<ChevronDownIcon
								size={14}
								className={cn(
									'opacity-70 transition-transform duration-150',
									expanded && 'rotate-180',
								)}
							/>
						</button>

						<span className="text-vscode-foreground opacity-90 text-sm shrink-0 ml-auto">
							{lineCount} {lineCount === 1 ? 'file' : 'files'}
						</span>
					</div>

					{expanded && (
						<div className="pl-(--collapsible-indent) border-l border-white/6 ml-(--gap-1)">
							{displayLines.map((line, idx) => renderFileEntry(line, idx))}
						</div>
					)}
				</div>
			);
		}

		// Default simple output
		// Don't render if:
		// 1. Content is empty (e.g., subtask tool calls with no output)
		// 2. Tool is still running without result (avoid showing empty processing dot)
		if (!content || isRunning) {
			return null;
		}

		return (
			<div className="flex gap-1.5 items-center mb-(--tool-block-margin)">
				<StatusIndicator variant={dotVariant} size={6} />
				<div className="flex-1 min-w-0 overflow-x-auto">
					<div
						className={cn(
							'font-(family-name:--font-family-base) text-(length:--font-size-base) whitespace-pre leading-(--line-height-base)',
							isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-85',
						)}
					>
						{content}
					</div>
				</div>
			</div>
		);
	},
);
