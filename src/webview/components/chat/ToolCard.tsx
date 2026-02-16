/**
 * @file ToolCard - minimal unified tool UI
 * @description Minimal, reusable card for displaying tool calls/results in the chat.
 * Uses NormalizedEntry (ViewModel) for clean data access, falling back to legacy helpers only if needed.
 */

import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import React, { type ReactNode, useMemo, useState } from 'react';
import type {
	LspDiagnostic,
	LspDiagnosticsByFile,
	NormalizedEntry,
} from '../../../common/normalizedTypes';

import { isMcpTool, isToolMatch } from '../../constants';
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
import {
	computeSimpleStats,
	getDiffContentHeight,
	resolveDiffData,
	SimpleDiff,
} from './SimpleDiff';
import { InlineToolLine } from './SimpleTool';

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

const MAX_DIAGNOSTICS_PER_FILE = 3;

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
		const errors = valid.filter(d => d.severity === 1).slice(0, MAX_DIAGNOSTICS_PER_FILE);
		if (errors.length > 0) result[filePath] = errors;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Renders LSP error diagnostics below a file edit card */
const DiagnosticsDisplay: React.FC<{ diagnostics: LspDiagnosticsByFile }> = ({ diagnostics }) => {
	const entries = Object.entries(diagnostics);
	if (entries.length === 0) return null;

	return (
		<div className="mt-1 ml-2 mb-(--tool-utility-block-margin)">
			{entries.map(([filePath, diags]) => (
				<div key={filePath} className="flex flex-col gap-0.5">
					{diags.map(d => (
						<div
							key={`${filePath}-${d.range.start.line}:${d.range.start.character}-${d.message.slice(0, 20)}`}
							className="flex items-center gap-1.5 text-sm"
						>
							<AlertCircleIcon size={12} className="text-error shrink-0" />
							<span className="text-error font-medium whitespace-nowrap">
								[{d.range.start.line}:{d.range.start.character}]
							</span>
							<span className="text-vscode-descriptionForeground truncate">{d.message}</span>
						</div>
					))}
				</div>
			))}
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
	const resolved = resolveDiffData({
		actionType,
		toolResultMetadata: toolResult?.metadata,
		accessRequestRaw: accessRequest,
		fallbackFilePath: filePath,
	});

	const { oldContent, newContent, effectiveFilePath, name, hasDeleteChange } = resolved;
	const hasContent = newContent || oldContent || hasDeleteChange;

	if (!hasContent) return null;

	const stats = computeSimpleStats(oldContent, newContent);
	const maxHeight = 120;
	const needsExpand = getDiffContentHeight(oldContent, newContent) > maxHeight;
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
									oldContent,
									newContent,
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
							<SimpleDiff
								original={oldContent}
								modified={newContent}
								maxHeight={maxHeight}
								expanded={diffExpanded}
							/>
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
									navigator.clipboard.writeText(newContent);
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

		// Use normalized ActionType for file edits
		const isFileEdit = actionType?.type === 'FileEdit';
		const isWebSearch = actionType?.type === 'WebSearch' || toolName.toLowerCase() === 'websearch';

		const [expanded, setExpanded] = useState(defaultExpanded ?? false);
		const [diffExpanded, setDiffExpanded] = useState(defaultExpanded ?? false);

		// Extract LSP diagnostics from tool result metadata
		const diagnostics = useMemo(
			() => extractDiagnosticsFromMeta(toolResult?.metadata as Record<string, unknown> | undefined),
			[toolResult?.metadata],
		);

		if (!toolName) return null;

		// Inline Card: Default for everything except MCP, Bash, File Edits, WebSearch, and tools with Access Requests
		const hasAccessRequest = Boolean(accessRequest);
		if (!isMcp && !isBash && !isFileEdit && !isWebSearch && !hasAccessRequest) {
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

		// 1) Diff Card (File Edits)
		if (isFileEdit) {
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

		// 2) MCP / Bash / WebSearch / Generic Card
		const icon = isMcp ? (
			<ToolCardLeadingIcon>
				<McpIcon size={14} className="text-[#3b82f6] shrink-0" />
			</ToolCardLeadingIcon>
		) : isBash ? (
			<ToolCardLeadingIcon>
				<TerminalIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : isWebSearch ? (
			<ToolCardLeadingIcon>
				<GlobeIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : (
			<ToolCardLeadingIcon>
				<WandIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		);
		const label = isWebSearch ? 'Web Search' : isMcp ? 'MCP' : formatToolName(toolName);

		// Meta extraction
		let meta = '';
		if (actionType?.type === 'CommandRun') meta = actionType.command;
		else if (isBash) meta = (rawInput as { command?: string })?.command || '';
		else if (isWebSearch && actionType?.type === 'WebSearch') meta = actionType.query;
		else if (isWebSearch) meta = (rawInput as { query?: string })?.query || '';
		else if (isMcp) meta = rawInput ? JSON.stringify(rawInput) : '';

		const fullText = content || '';
		const hasBody = fullText.trim().length > 0;
		const lineCount = hasBody ? fullText.split('\n').length : 0;
		const needsExpand = lineCount > 6;
		const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;

		return (
			<ToolCard
				headerLeft={
					<>
						{icon}
						<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap">
							{label}
						</span>
						{meta && (
							<span className="text-sm text-vscode-foreground opacity-70 truncate">{meta}</span>
						)}
					</>
				}
				headerRight={
					hasBody ? (
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
									navigator.clipboard.writeText(fullText);
								}}
								title="Copy"
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
							events={{ initialized: scrollToBottom }}
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
