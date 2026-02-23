/**
 * @file ToolCard - minimal unified tool UI
 * @description Minimal, reusable card for displaying tool calls/results in the chat.
 * Uses NormalizedEntry (ViewModel) for clean data access, falling back to legacy helpers only if needed.
 */

import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import React, { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type {
	LspDiagnostic,
	LspDiagnosticsByFile,
	NormalizedEntry,
} from '../../../common/normalizedTypes';

import { getMcpToolDisplayInfo, isMcpTool, isToolMatch } from '../../constants';
import { cn } from '../../lib/cn';
import { useAccessRequestByToolUseId, useMcpServers, useToolResultByToolId } from '../../store';
import type { Message as WebviewMessage } from '../../store/chatStore';
import { formatToolName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import {
	AlertCircleIcon,
	ChevronDownIcon,
	CopyIcon,
	GlobeIcon,
	McpIcon,
	TerminalIcon,
	WandIcon,
} from '../icons';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Button, CollapseOverlay, IconButton, Tooltip } from '../ui';
import { AccessGate } from './AccessGate';
import { getDiffContentHeight, resolveDiffData, SimpleDiff } from './SimpleDiff';
import { InlineToolLine, SimpleTool } from './SimpleTool';

const TOOL_CARD_CLASSES = 'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg';

const TOOL_CARD_HEADER_CLASSES =
	'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none';

const PREVIEW_MAX_HEIGHT = 120;

/** Scroll an OverlayScrollbars viewport to the bottom. */
const scrollToBottom = (instance: OverlayScrollbars) => {
	const viewport = instance.elements().viewport;
	if (viewport) viewport.scrollTop = viewport.scrollHeight;
};

type ToolUse = Extract<WebviewMessage, { type: 'tool_use' }>;
type ToolResult = Extract<WebviewMessage, { type: 'tool_result' }>;

const ToolCardLeadingIcon: React.FC<{ children: ReactNode; className?: string }> = ({
	children,
	className,
}) => (
	<span
		className={cn(
			'toolcard-leading-icon flex items-center justify-center w-[18px] h-[18px] shrink-0',
			'transition-opacity duration-150 ease-out',
			className,
		)}
	>
		{children}
	</span>
);

interface ToolCardProps {
	headerLeft: ReactNode;
	headerRight?: ReactNode;
	body?: ReactNode;
	accessGate?: ReactNode;
	isCollapsible?: boolean;
	expanded?: boolean;
	/**
	 * Controls whether the bottom collapse overlay is allowed to appear.
	 * Useful for “preview” modes where the card is open but should not show the overlay.
	 */
	showCollapseOverlay?: boolean;
	onToggle?: () => void;
	className?: string;
}

export const ToolCard: React.FC<ToolCardProps> = ({
	headerLeft,
	headerRight,
	body,
	accessGate,
	isCollapsible = false,
	expanded = false,
	showCollapseOverlay = true,
	onToggle,
	className,
}) => {
	const canToggle = Boolean(isCollapsible && onToggle);
	return (
		<div className="relative">
			<div className={cn(TOOL_CARD_CLASSES, 'group overflow-hidden', className)}>
				<div
					role={canToggle ? 'button' : undefined}
					tabIndex={canToggle ? 0 : undefined}
					onClick={canToggle ? onToggle : undefined}
					className={cn(
						TOOL_CARD_HEADER_CLASSES,
						canToggle && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
						'group/toolcard-header',
					)}
				>
					<div className="relative flex items-center gap-1.5 min-w-0">
						{canToggle && (
							<div
								className={cn(
									'absolute left-0 top-1/2 -translate-y-1/2',
									'flex items-center justify-center w-5 h-5',
									'opacity-0 transition-opacity duration-150 ease-out',
									'group-hover/toolcard-header:opacity-90',
								)}
							>
								<ChevronDownIcon
									size={14}
									className={cn(
										'transition-transform duration-150 ease-out',
										expanded && 'rotate-180',
									)}
								/>
							</div>
						)}
						<div
							className={cn(
								'flex items-center gap-1.5 min-w-0',
								canToggle && 'group-hover/toolcard-header:[&_.toolcard-leading-icon]:opacity-0',
							)}
						>
							{headerLeft}
						</div>
					</div>
					<div className="flex items-center gap-1.5 shrink-0 ml-auto">{headerRight}</div>
				</div>
				{body && (
					<div className="relative">
						{body}
						{canToggle && showCollapseOverlay && (
							<CollapseOverlay visible={expanded} onCollapse={onToggle as () => void} />
						)}
					</div>
				)}
			</div>
			{accessGate}
		</div>
	);
};

interface ToolCardMessageProps {
	message: ToolUse;
	toolResult?: ToolResult;
	defaultExpanded?: boolean;
}

// ---------------------------------------------------------------------------
// LSP Diagnostics Display
// ---------------------------------------------------------------------------

/**
 * Extract diagnostics from tool result metadata.
 * OpenCode sends `metadata.diagnostics: Record<string, Diagnostic[]>` on edit/write/apply_patch.
 */
function extractDiagnosticsFromMeta(
	metadata: Record<string, unknown> | undefined,
): LspDiagnosticsByFile | undefined {
	if (!metadata) return undefined;
	const raw = metadata.diagnostics;
	if (!raw || typeof raw !== 'object') return undefined;
	const result: LspDiagnosticsByFile = {};
	for (const [filePath, diags] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(diags)) continue;
		const valid = diags.filter(
			(d): d is LspDiagnostic => d && typeof d === 'object' && 'message' in d && 'range' in d,
		);
		// Only show errors (severity === 1)
		const errors = valid.filter(d => d.severity === 1);
		if (errors.length > 0) result[filePath] = errors;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Group diagnostics by message, collecting locations for each unique error */
function groupDiagnosticsByMessage(
	diagnostics: LspDiagnosticsByFile,
): Array<{ message: string; locations: Array<{ file: string; line: number; character: number }> }> {
	const groups = new Map<string, Array<{ file: string; line: number; character: number }>>();
	for (const [filePath, diags] of Object.entries(diagnostics)) {
		for (const d of diags) {
			const key = d.message;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)?.push({
				file: filePath,
				// Convert 0-based LSP positions to 1-based for UI display
				line: d.range.start.line + 1,
				character: d.range.start.character + 1,
			});
		}
	}
	return Array.from(groups.entries()).map(([message, locations]) => ({ message, locations }));
}

/** Renders LSP error diagnostics below a file edit card, grouped by message */
const DiagnosticsDisplay: React.FC<{ diagnostics: LspDiagnosticsByFile }> = ({ diagnostics }) => {
	const groups = useMemo(() => groupDiagnosticsByMessage(diagnostics), [diagnostics]);
	if (groups.length === 0) return null;

	const totalErrors = groups.reduce((sum, g) => sum + g.locations.length, 0);

	return (
		<div className="mt-1">
			<SimpleTool
				icon={<AlertCircleIcon size={14} />}
				label={`${totalErrors} ${totalErrors === 1 ? 'error' : 'errors'}`}
				isError
			>
				<div className="flex flex-col gap-0.5">
					{groups.map(group => (
						<div key={group.message} className="flex items-center gap-1.5 text-sm">
							{group.locations.length > 1 && (
								<span className="text-error font-medium whitespace-nowrap">
									x{group.locations.length}
								</span>
							)}
							{group.locations.length === 1 && (
								<span className="text-error font-medium whitespace-nowrap">
									[{group.locations[0].line}:{group.locations[0].character}]
								</span>
							)}
							<span className="text-vscode-descriptionForeground truncate">{group.message}</span>
						</div>
					))}
				</div>
			</SimpleTool>
		</div>
	);
};

// ---------------------------------------------------------------------------
// FileEditCard — extracted from ToolCardMessage for clarity
// ---------------------------------------------------------------------------

interface FileEditCardProps {
	actionType: unknown;
	toolResult: ToolResult | undefined;
	accessRequest: ReturnType<typeof useAccessRequestByToolUseId>;
	filePath: string | undefined;
	toolName: string;
	rawInput: unknown;
	diffExpanded: boolean;
	onToggleDiff: () => void;
	diagnostics: LspDiagnosticsByFile | undefined;
	postMessage: ReturnType<typeof useVSCode>['postMessage'];
}

const FileEditCard: React.FC<FileEditCardProps> = ({
	actionType,
	toolResult,
	accessRequest,
	filePath,
	toolName,
	rawInput,
	diffExpanded,
	onToggleDiff,
	diagnostics,
	postMessage,
}) => {
	const resolved = useMemo(
		() =>
			resolveDiffData({
				actionType,
				toolResultMetadata: toolResult?.metadata,
				accessRequestRaw: accessRequest,
				fallbackFilePath: filePath,
			}),
		[actionType, toolResult?.metadata, accessRequest, filePath],
	);

	const { lines, effectiveFilePath, name, hasDeleteChange, stats } = resolved;
	const hasContent = lines.length > 0 || hasDeleteChange;

	if (!hasContent) return null;

	const maxHeight = 120;
	const needsExpand = getDiffContentHeight(lines) > maxHeight;
	const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;

	return (
		<>
			<ToolCard
				headerLeft={
					<>
						<ToolCardLeadingIcon>
							<FileTypeIcon name={name} size={14} />
						</ToolCardLeadingIcon>
						<Tooltip content="Open file in editor" position="top" delay={200}>
							<button
								type="button"
								onClick={e => {
									e.stopPropagation();
									if (effectiveFilePath)
										postMessage({ type: 'openFile', filePath: effectiveFilePath });
								}}
								className="text-sm cursor-pointer text-vscode-foreground bg-none border-none p-0 opacity-90 whitespace-nowrap overflow-hidden text-ellipsis"
							>
								{name}
							</button>
						</Tooltip>
						{stats.added > 0 && <span className="text-success">+{stats.added}</span>}
						{stats.removed > 0 && <span className="text-error">−{stats.removed}</span>}
					</>
				}
				headerRight={
					<Button
						variant="tool"
						size="sm"
						height={20}
						onClick={e => {
							e.stopPropagation();
							if (effectiveFilePath)
								postMessage({
									type: 'openFileDiff',
									filePath: effectiveFilePath,
									oldContent: '',
									newContent: '',
								});
						}}
						title="Open in diff editor"
						className="font-bold uppercase tracking-wider text-xs text-vscode-foreground opacity-100 px-1"
					>
						Diff
					</Button>
				}
				isCollapsible={needsExpand || Boolean(showAccessGate)}
				expanded={diffExpanded}
				onToggle={onToggleDiff}
				body={
					<div className="relative">
						<div className={cn(accessRequest?.resolved === false ? 'pb-2' : undefined)}>
							<SimpleDiff lines={lines} maxHeight={maxHeight} expanded={diffExpanded} />
						</div>
						<div
							className={cn(
								'absolute right-(--tool-content-padding) bottom-0',
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover:opacity-100',
							)}
						>
							<IconButton
								icon={<CopyIcon size={14} />}
								onClick={e => {
									e.stopPropagation();
									const content = lines
										.filter(l => l.type === 'added' || l.type === 'unchanged')
										.map(l => l.content)
										.join('\n');
									navigator.clipboard.writeText(content);
								}}
								title="Copy"
								size={20}
							/>
						</div>
					</div>
				}
				accessGate={
					showAccessGate ? (
						<AccessGate
							requestId={accessRequest?.requestId}
							messageId={accessRequest?.id}
							tool={accessRequest?.tool || toolName}
							input={accessRequest?.input || rawInput || {}}
							pattern={accessRequest?.pattern}
							hideDetails={true}
						/>
					) : undefined
				}
			/>
			{diagnostics && <DiagnosticsDisplay diagnostics={diagnostics} />}
		</>
	);
};

export const ToolCardMessage: React.FC<ToolCardMessageProps> = React.memo(
	({ message, toolResult: providedToolResult, defaultExpanded }) => {
		const { postMessage } = useVSCode();
		const mcpServers = useMcpServers();
		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

		const { toolUseId, filePath, rawInput } = message;
		const toolName = message.toolName ?? '';
		const selectorToolResult = useToolResultByToolId(providedToolResult ? undefined : toolUseId);
		const toolResult = providedToolResult ?? selectorToolResult;
		const accessRequest = useAccessRequestByToolUseId(toolUseId);
		const normalizedEntry = (message as unknown as { normalizedEntry?: NormalizedEntry })
			.normalizedEntry;

		const isError = toolResult?.isError ?? false;
		const content = toolResult?.content || '';

		// --- Logic Simplification: Determine Card Type ---
		// 1. Check NormalizedEntry
		let actionType = null;
		if (
			normalizedEntry?.entryType &&
			typeof normalizedEntry.entryType === 'object' &&
			'actionType' in normalizedEntry.entryType
		) {
			actionType = normalizedEntry.entryType.actionType;
		}

		const isMcp = isMcpTool(toolName, mcpServerNames);
		const isBash = isToolMatch(toolName, 'Bash') || actionType?.type === 'CommandRun';
		const isSummarize = toolName === 'Summarize Conversation';

		// Use normalized ActionType for diff/file-edit style tools
		const isFileEdit = actionType?.type === 'FileEdit';
		const isApplyPatch = actionType?.type === 'ApplyPatch' || isToolMatch(toolName, 'apply_patch');
		const isDiffTool = isFileEdit || isApplyPatch;
		const isWebSearch = actionType?.type === 'WebSearch' || toolName.toLowerCase() === 'websearch';
		const isWebFetch = actionType?.type === 'WebFetch' || toolName.toLowerCase() === 'webfetch';

		const isRunning = message.isRunning ?? !toolResult;
		const [expanded, setExpanded] = useState(defaultExpanded ?? false);
		const [diffExpanded, setDiffExpanded] = useState(defaultExpanded ?? false);

		// Extract LSP diagnostics from tool result metadata
		const diagnostics = useMemo(
			() => extractDiagnosticsFromMeta(toolResult?.metadata as Record<string, unknown> | undefined),
			[toolResult?.metadata],
		);

		if (!toolName) return null;

		// Inline Card: Default for everything except MCP, Bash, Diff tools, WebSearch, WebFetch, Summarize, and tools with Access Requests
		const hasAccessRequest = Boolean(accessRequest);
		if (
			!isMcp &&
			!isBash &&
			!isDiffTool &&
			!isWebSearch &&
			!isWebFetch &&
			!isSummarize &&
			!hasAccessRequest
		) {
			return (
				<InlineToolLine
					toolName={toolName}
					rawInput={rawInput}
					content={content}
					isError={isError}
					defaultExpanded={defaultExpanded}
					normalizedEntry={normalizedEntry}
				/>
			);
		}

		// 1) Diff Card (File Edits / Apply Patch)
		if (isDiffTool) {
			return (
				<FileEditCard
					actionType={actionType}
					toolResult={toolResult}
					accessRequest={accessRequest}
					filePath={filePath}
					toolName={toolName}
					rawInput={rawInput}
					diffExpanded={diffExpanded}
					onToggleDiff={() => setDiffExpanded(prev => !prev)}
					diagnostics={diagnostics}
					postMessage={postMessage}
				/>
			);
		}

		// 2) MCP / Bash / WebSearch / WebFetch / Generic Card
		const icon = isMcp ? (
			<ToolCardLeadingIcon>
				<McpIcon size={14} className="text-[#3b82f6] shrink-0" />
			</ToolCardLeadingIcon>
		) : isBash ? (
			<ToolCardLeadingIcon>
				<TerminalIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : isWebSearch || isWebFetch ? (
			<ToolCardLeadingIcon>
				<GlobeIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : isSummarize ? (
			<ToolCardLeadingIcon>
				<WandIcon size={14} className={cn('shrink-0', isRunning && 'animate-pulse')} />
			</ToolCardLeadingIcon>
		) : (
			<ToolCardLeadingIcon>
				<WandIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		);
		// MCP display info: extract server + tool name from the raw tool identifier
		const mcpInfo = isMcp ? getMcpToolDisplayInfo(toolName, mcpServerNames) : null;

		const label = isWebSearch
			? 'Web Search'
			: isWebFetch
				? 'Fetch'
				: isMcp
					? 'MCP'
					: formatToolName(toolName);
		// For MCP tools, show server name and tool name as secondary labels: "MCP · context7-mcp · resolve-library-id"
		const mcpServerLabel = isMcp ? (mcpInfo?.server ?? '') : '';
		const mcpToolLabel = isMcp ? (mcpInfo?.tool ?? toolName) : '';
		const displayLabel = isSummarize && isRunning ? `${label}...` : label;

		// Meta extraction
		let meta = '';
		if (actionType?.type === 'CommandRun') meta = actionType.command;
		else if (isBash) meta = (rawInput as { command?: string })?.command || '';
		else if (isWebSearch && actionType?.type === 'WebSearch') meta = actionType.query;
		else if (isWebSearch) meta = (rawInput as { query?: string })?.query || '';
		else if (isWebFetch && actionType?.type === 'WebFetch') meta = actionType.url;
		else if (isWebFetch) meta = (rawInput as { url?: string })?.url || '';
		else if (isMcp) meta = rawInput ? JSON.stringify(rawInput) : '';

		const fullText = content || message.streamingOutput || '';
		const hasBody = fullText.trim().length > 0;
		const lineCount = hasBody ? fullText.split('\n').length : 0;
		const needsExpand = lineCount > 6;
		const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;

		// Auto-scroll streaming output to bottom
		const streamingViewportRef = useRef<HTMLElement | null>(null);
		const handleOsInitialized = (instance: OverlayScrollbars) => {
			streamingViewportRef.current = instance.elements().viewport;
			scrollToBottom(instance);
		};
		useEffect(() => {
			if (!isRunning || !message.streamingOutput) return;
			const el = streamingViewportRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		}, [isRunning, message.streamingOutput]);

		return (
			<ToolCard
				headerLeft={
					<>
						{icon}
						<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap">
							{displayLabel}
						</span>
						{mcpServerLabel && (
							<span className="text-sm text-vscode-foreground opacity-70 whitespace-nowrap">
								· {mcpServerLabel}
							</span>
						)}
						{mcpToolLabel && (
							<span className="text-sm text-vscode-foreground opacity-50 whitespace-nowrap">
								· {mcpToolLabel}
							</span>
						)}
						{meta && (
							<span className="text-sm text-vscode-foreground opacity-70 truncate">{meta}</span>
						)}
					</>
				}
				headerRight={
					meta ? (
						<div
							className={cn(
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover:opacity-100',
							)}
						>
							<IconButton
								icon={<CopyIcon size={14} />}
								onClick={e => {
									e.stopPropagation();
									navigator.clipboard.writeText(meta);
								}}
								title="Copy request"
								size={20}
							/>
						</div>
					) : undefined
				}
				isCollapsible={(needsExpand && hasBody) || Boolean(showAccessGate)}
				expanded={expanded}
				onToggle={() => setExpanded(prev => !prev)}
				body={
					hasBody ? (
						<div className="relative">
							<OverlayScrollbarsComponent
								style={{ maxHeight: expanded ? undefined : `${PREVIEW_MAX_HEIGHT}px` }}
								className="bg-(--tool-bg-header)"
								options={{
									scrollbars: {
										theme: 'os-theme-dark',
										autoHide: 'scroll',
										autoHideDelay: 800,
										clickScroll: true,
									},
									overflow: { x: 'scroll', y: 'scroll' },
								}}
								events={{ initialized: handleOsInitialized }}
								defer
							>
								<div className="p-(--tool-content-padding)">
									<pre
										className={cn(
											'm-0 text-sm leading-(--line-height-code) whitespace-pre',
											isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-90',
										)}
									>
										{fullText}
									</pre>
								</div>
							</OverlayScrollbarsComponent>
							<div
								className={cn(
									'absolute right-(--tool-content-padding) bottom-0',
									'opacity-0 transition-opacity duration-150 ease-out',
									'group-hover:opacity-100',
								)}
							>
								<IconButton
									icon={<CopyIcon size={14} />}
									onClick={e => {
										e.stopPropagation();
										navigator.clipboard.writeText(fullText);
									}}
									title="Copy"
									size={20}
								/>
							</div>
						</div>
					) : undefined
				}
				accessGate={
					showAccessGate ? (
						<AccessGate
							requestId={accessRequest?.requestId}
							messageId={accessRequest?.id}
							tool={accessRequest?.tool || toolName}
							input={accessRequest?.input || rawInput || {}}
							pattern={accessRequest?.pattern}
							hideDetails={true}
						/>
					) : undefined
				}
			/>
		);
	},
);

ToolCardMessage.displayName = 'ToolCardMessage';
