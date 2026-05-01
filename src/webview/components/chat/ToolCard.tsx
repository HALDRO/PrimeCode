/**
 * @file ToolCard - minimal unified tool UI
 * @description Minimal, reusable card for displaying tool calls/results in the chat.
 * Uses NormalizedEntry (ViewModel) for clean data access.
 */

import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import React, { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActionType, LspDiagnosticsByFile } from '../../../common/normalizedTypes';
import { buildToolActionType, extractLspDiagnostics } from '../../../common/normalizedTypes';
import { pathsReferToSameFile } from '../../../utils/path';
import {
	getMcpToolDisplayInfo,
	isFileEditTool,
	isMcpTool,
	isToolMatch,
	resolveToolName,
	TOOL_CARD_EXPANDED_MAX_HEIGHT,
	TOOL_CARD_PREVIEW_MAX_HEIGHT,
} from '../../constants';
import { useElapsedTimer } from '../../hooks/useElapsedTimer';
import { cn } from '../../lib/cn';
import {
	type RenderToolUseMessage,
	type ToolResultView,
	useAccessRequestByToolUseId,
	useMcpServers,
	useQuestionRequestByToolUseId,
	useToolPartByToolUseId,
	useToolResultByToolId,
} from '../../store';
import { copyTextToClipboard } from '../../utils/clipboard';
import { formatDuration, formatToolName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import {
	AlertCircleIcon,
	ChevronDownIcon,
	CopyIcon,
	GlobeIcon,
	McpIcon,
	TerminalIcon,
	TimerIcon,
	WandIcon,
} from '../icons';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Button, CollapseOverlay, IconButton, PathChip, Tooltip } from '../ui';
import { AccessGate } from './AccessGate';
import { QuestionCard } from './QuestionCard';
import type { ResolvedFileChange } from './SimpleDiff';
import { getDiffContentHeight, resolveFileChanges, SimpleDiff } from './SimpleDiff';
import { InlineToolLine, SimpleTool } from './SimpleTool';

const TOOL_CARD_CLASSES = 'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg';

const TOOL_CARD_HEADER_CLASSES =
	'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none';

/** Module-level constant — avoids recreating nested object on every render */
const OVERLAY_SCROLLBAR_OPTIONS = {
	scrollbars: {
		theme: 'os-theme-dark' as const,
		autoHide: 'scroll' as const,
		autoHideDelay: 800,
		clickScroll: true,
	},
	overflow: { x: 'scroll' as const, y: 'scroll' as const },
};

/** Scroll an OverlayScrollbars viewport to the bottom. */
const scrollToBottom = (instance: OverlayScrollbars) => {
	const viewport = instance.elements().viewport;
	if (viewport) viewport.scrollTop = viewport.scrollHeight;
};

const getFileChangeCardKey = (change: ResolvedFileChange, index: number) =>
	change.filePath || `${change.name}-${index}`;

type ToolUse = RenderToolUseMessage;
type ToolResult = ToolResultView;

type ToolCardCategory = 'inline' | 'mcp' | 'bash' | 'diff' | 'websearch' | 'webfetch' | 'summarize';

const RAW_INLINE_KNOWN_TOOLS = new Set([
	'read',
	'grep',
	'glob',
	'list',
	'skill',
	'todowrite',
	'todoread',
	'task',
]);

const getActionType = (
	normalizedEntry: ToolUse['normalizedEntry'],
	toolName: string,
	rawInput: unknown,
): ActionType | null => {
	if (
		normalizedEntry?.entryType &&
		typeof normalizedEntry.entryType === 'object' &&
		'actionType' in normalizedEntry.entryType
	) {
		return normalizedEntry.entryType.actionType;
	}
	return buildToolActionType(toolName, (rawInput as Record<string, unknown>) ?? {});
};

const getToolCardCategory = (
	toolName: string,
	actionType: ActionType | null,
	mcpServerNames: string[],
	hasDiff: boolean,
	isSummarize: boolean,
	hasAccessRequest: boolean,
): ToolCardCategory => {
	if (hasDiff) return 'diff';
	if (actionType?.type === 'CommandRun' || isToolMatch(toolName, 'Bash')) return 'bash';
	if (actionType?.type === 'WebSearch' || toolName.toLowerCase() === 'websearch')
		return 'websearch';
	if (actionType?.type === 'WebFetch' || toolName.toLowerCase() === 'webfetch') return 'webfetch';
	if (isMcpTool(toolName, mcpServerNames)) return 'mcp';
	if (isSummarize) return 'summarize';
	if (hasAccessRequest) return 'mcp';
	const canonical = resolveToolName(toolName);
	return !canonical || RAW_INLINE_KNOWN_TOOLS.has(canonical) ? 'inline' : 'diff';
};

export const shouldHideRunningFileEditTool = (
	_actionType: ActionType | null,
	_toolName: string,
	isRunning: boolean,
	hasRenderableDiff: boolean,
): boolean => {
	if (!isRunning || hasRenderableDiff) return false;
	return false;
};

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
		<div className="relative animate-fade-slide-in">
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
					<div className="flex items-center gap-1.5 shrink-0 ml-auto z-10 -mr-(--tool-header-padding) pr-1">
						{headerRight}
					</div>
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
	toolUse: ToolUse;
	toolResult?: ToolResult;
	defaultExpanded?: boolean;
	sessionId?: string;
}

// ---------------------------------------------------------------------------
// LSP Diagnostics Display
// ---------------------------------------------------------------------------

function flattenDiagnostics(
	diagnostics: LspDiagnosticsByFile,
): Array<{ file: string; line: number; character: number; message: string }> {
	const seen = new Set<string>();
	const entries: Array<{ file: string; line: number; character: number; message: string }> = [];

	for (const [filePath, diags] of Object.entries(diagnostics)) {
		for (const d of diags) {
			const line = d.range.start.line + 1;
			const character = d.range.start.character + 1;
			const key = `${filePath}:${line}:${character}:${d.message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			entries.push({
				file: filePath,
				line,
				character,
				message: d.message,
			});
		}
	}

	return entries;
}

const DiagnosticsDisplay: React.FC<{
	diagnostics: LspDiagnosticsByFile;
	postMessage: ReturnType<typeof useVSCode>['postMessage'];
}> = ({ diagnostics, postMessage }) => {
	const entries = useMemo(() => flattenDiagnostics(diagnostics), [diagnostics]);
	if (entries.length === 0) return null;

	const totalErrors = entries.length;

	return (
		<div className="mt-1">
			<SimpleTool
				icon={<AlertCircleIcon size={14} />}
				label={`${totalErrors} ${totalErrors === 1 ? 'error' : 'errors'}`}
				isError
			>
				<div className="flex flex-col gap-0.5">
					{entries.map(entry => (
						<div
							key={`${entry.file}:${entry.line}:${entry.character}:${entry.message}`}
							className="flex items-center gap-1.5 min-w-0 text-sm"
						>
							<PathChip
								path={entry.file}
								title={`${entry.file}:${entry.line}:${entry.character}`}
								onClick={() =>
									postMessage({
										type: 'openFile',
										filePath: entry.file,
										startLine: entry.line,
										endLine: entry.line,
									})
								}
							/>
							<span className="text-error font-medium whitespace-nowrap">
								[{entry.line}:{entry.character}]
							</span>
							<span className="text-vscode-descriptionForeground truncate">{entry.message}</span>
						</div>
					))}
				</div>
			</SimpleTool>
		</div>
	);
};

function getDiagnosticsForFile(
	filePath: string | undefined,
	diagnostics: LspDiagnosticsByFile | undefined,
): LspDiagnosticsByFile | undefined {
	if (!filePath || !diagnostics) return undefined;
	if (diagnostics[filePath]) {
		return { [filePath]: diagnostics[filePath] };
	}

	for (const [diagnosticPath, items] of Object.entries(diagnostics)) {
		if (pathsReferToSameFile(diagnosticPath, filePath)) {
			return { [filePath]: items };
		}
	}

	return undefined;
}

function getApplyPatchDiagnosticsForCard(params: {
	change: ResolvedFileChange;
	changeIndex: number;
	totalChanges: number;
	isApplyPatch: boolean;
	diagnostics: LspDiagnosticsByFile | undefined;
}): LspDiagnosticsByFile | undefined {
	const { change, changeIndex, totalChanges, isApplyPatch, diagnostics } = params;
	if (!diagnostics) return undefined;

	if (!isApplyPatch || totalChanges <= 1) {
		return getDiagnosticsForFile(change.filePath, diagnostics);
	}

	return changeIndex === totalChanges - 1 ? diagnostics : undefined;
}

// ---------------------------------------------------------------------------
// FileEditCard — extracted from ToolCardMessage for clarity
// ---------------------------------------------------------------------------

interface FileEditCardProps {
	change: ResolvedFileChange;
	accessRequest: ReturnType<typeof useAccessRequestByToolUseId>;
	toolName: string;
	rawInput: unknown;
	diffExpanded: boolean;
	onToggleDiff: () => void;
	diagnostics: LspDiagnosticsByFile | undefined;
	postMessage: ReturnType<typeof useVSCode>['postMessage'];
	isRunning?: boolean;
}

const FileEditCard: React.FC<FileEditCardProps> = ({
	change,
	accessRequest,
	toolName,
	rawInput,
	diffExpanded,
	onToggleDiff,
	diagnostics,
	postMessage,
	isRunning = false,
}) => {
	const {
		lines,
		filePath: effectiveFilePath,
		name,
		diffText,
		hasDeleteChange,
		stats,
		firstChangedLine,
	} = change;
	const hasContent = lines.length > 0 || hasDeleteChange;
	const hasDiagnostics = Boolean(diagnostics && Object.keys(diagnostics).length > 0);

	if (!hasContent && !isRunning && !hasDiagnostics) return null;

	const maxHeight = TOOL_CARD_PREVIEW_MAX_HEIGHT;
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
						<Tooltip content={effectiveFilePath || name} position="top" delay={200}>
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
									line: firstChangedLine,
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
							{hasContent ? (
								<SimpleDiff lines={lines} maxHeight={maxHeight} expanded={diffExpanded} />
							) : (
								<div className="bg-(--tool-bg-header) text-vscode-descriptionForeground text-sm px-3 py-2 italic">
									{hasDiagnostics
										? 'Diff unavailable, but LSP diagnostics were reported.'
										: 'Preparing diff...'}
								</div>
							)}
						</div>
						<div
							className={cn(
								'absolute right-(--tool-content-padding) bottom-0',
								'opacity-0 transition-opacity duration-150 ease-out',
								'group-hover:opacity-100',
							)}
						>
							{hasContent && diffText.trim() ? (
								<IconButton
									icon={<CopyIcon size={14} />}
									onClick={e => {
										e.stopPropagation();
										void copyTextToClipboard(diffText);
									}}
									title="Copy diff"
									size={20}
									className="bg-(--surface-base)/80 backdrop-blur-sm"
								/>
							) : null}
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
			{diagnostics && <DiagnosticsDisplay diagnostics={diagnostics} postMessage={postMessage} />}
		</>
	);
};

export const ToolCardMessage: React.FC<ToolCardMessageProps> = React.memo(
	({ toolUse, toolResult: providedToolResult, defaultExpanded, sessionId }) => {
		const { postMessage } = useVSCode();
		const mcpServers = useMcpServers();
		const mcpServerNames = useMemo(() => Object.keys(mcpServers || {}), [mcpServers]);

		const { toolUseId, filePath } = toolUse;
		const toolName = toolUse.toolName ?? '';
		const toolPart = useToolPartByToolUseId(toolUseId, sessionId);
		const rawInput =
			toolPart &&
			'input' in toolPart.state &&
			toolPart.state.input &&
			typeof toolPart.state.input === 'object'
				? (toolPart.state.input as Record<string, unknown>)
				: {};
		const liveToolOutput =
			toolPart && 'output' in toolPart.state ? (toolPart.state.output ?? '') : '';
		const liveToolMetadata = (toolPart?.metadata ??
			('metadata' in (toolPart?.state ?? {})
				? ((toolPart?.state as { metadata?: Record<string, unknown> } | undefined)?.metadata ??
					undefined)
				: undefined)) as Record<string, unknown> | undefined;
		const selectorToolResult = useToolResultByToolId(
			providedToolResult ? undefined : toolUseId,
			sessionId,
		);
		const syntheticToolResult: ToolResult | undefined =
			providedToolResult ??
			selectorToolResult ??
			(toolUse.status === 'completed' || toolUse.status === 'error'
				? {
						id: `res-${toolUseId}`,
						type: 'tool_result',
						toolUseId,
						toolName,
						content: liveToolOutput || '',
						isError: toolUse.status === 'error',
						title: toolUse.title,
						metadata: liveToolMetadata,
						timestamp: toolUse.timestamp,
					}
				: undefined);
		const toolResult = syntheticToolResult;
		const accessRequest = useAccessRequestByToolUseId(toolUseId);
		const pendingQuestionFromStore = useQuestionRequestByToolUseId(toolUseId);
		const normalizedEntry = toolUse.normalizedEntry;

		const isError = toolResult?.isError ?? false;
		const content = toolResult?.content || '';

		const actionType = getActionType(normalizedEntry, toolName, rawInput);
		const isSummarize = toolName === 'Summarize Conversation';

		// Use normalized ActionType for diff/file-edit style tools
		const isFileEdit = actionType?.type === 'FileEdit' || isFileEditTool(toolName);
		const isApplyPatch = actionType?.type === 'ApplyPatch' || isToolMatch(toolName, 'apply_patch');
		const isDiffTool = isFileEdit || isApplyPatch;
		const isQuestionTool = toolName.toLowerCase() === 'question';
		// Per-tool diff cards render from the current tool metadata payload.
		// Session-level changed-file ownership is tracked separately in `session.diff`.
		const streamingMetadata = liveToolMetadata;
		const effectiveMetadata = toolResult?.metadata ?? streamingMetadata;
		// Diagnostics may arrive on live tool state before a final tool_result is materialized.
		const diagnostics = useMemo(
			() => extractLspDiagnostics(effectiveMetadata as Record<string, unknown> | undefined),
			[effectiveMetadata],
		);
		const fileChanges = useMemo(
			() =>
				resolveFileChanges({
					actionType,
					toolResultMetadata: effectiveMetadata,
					fallbackFilePath: filePath,
				}),
			[actionType, effectiveMetadata, filePath],
		);
		const canRenderDiffCard = isDiffTool && fileChanges.length > 0;
		const canRenderDiffPreview = canRenderDiffCard;
		const hasAccessRequest = Boolean(accessRequest);
		const category = getToolCardCategory(
			toolName,
			actionType,
			mcpServerNames,
			canRenderDiffCard,
			isSummarize,
			hasAccessRequest,
		);
		const isMcp = category === 'mcp';
		const isBash = category === 'bash';
		const isWebSearch = category === 'websearch';
		const isWebFetch = category === 'webfetch';
		const isRunning =
			toolUse.status === 'pending' ||
			toolUse.status === 'running' ||
			(toolUse.isRunning ?? !toolResult);
		const questionRequest = useMemo(() => {
			if (!isQuestionTool) return undefined;

			const input = rawInput as Record<string, unknown> | undefined;
			const rawQuestions = input?.questions;
			if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return undefined;

			const questions = rawQuestions.filter(
				(question): question is import('../../../common').QuestionInfo =>
					Boolean(
						question &&
							typeof question === 'object' &&
							'question' in question &&
							'header' in question &&
							'options' in question,
					),
			);
			if (questions.length === 0) return undefined;

			const answersRaw = (effectiveMetadata as { answers?: unknown } | undefined)?.answers;
			const answers = Array.isArray(answersRaw)
				? answersRaw.filter(
						(answer): answer is string[] =>
							Array.isArray(answer) && answer.every(item => typeof item === 'string'),
					)
				: undefined;

			const isCompleted = !isRunning && Boolean(toolResult);

			return {
				id: toolUseId,
				sessionID: '',
				questions,
				tool: {
					messageID: toolUseId,
					callID: toolUseId,
				},
				resolved: isCompleted,
				...(answers ? { answers } : {}),
			} satisfies import('../../../common').SessionQuestionRequest;
		}, [effectiveMetadata, isQuestionTool, rawInput, toolUseId, isRunning, toolResult]);
		const shouldHideWhileRunning = shouldHideRunningFileEditTool(
			actionType,
			toolName,
			isRunning,
			canRenderDiffCard,
		);
		const liveElapsed = useElapsedTimer(isRunning, toolUse.timestamp);
		const [expanded, setExpanded] = useState(defaultExpanded ?? false);
		const [expandedDiffKeys, setExpandedDiffKeys] = useState<Set<string>>(() => new Set());

		// --- All hooks must be called unconditionally, before any early returns ---
		const meta = useMemo(() => {
			if (actionType?.type === 'CommandRun') return actionType.command;
			if (actionType?.type === 'WebSearch') return actionType.query;
			if (actionType?.type === 'WebFetch') return actionType.url;
			if (isBash) return (rawInput as { command?: string })?.command || '';
			if (isWebSearch) return (rawInput as { query?: string })?.query || '';
			if (isWebFetch) return (rawInput as { url?: string })?.url || '';
			if (isMcp) return rawInput ? JSON.stringify(rawInput) : '';
			return '';
		}, [actionType, isBash, isWebSearch, isWebFetch, isMcp, rawInput]);

		const fullText = content || liveToolOutput || '';
		const hasBody = fullText.trim().length > 0;
		const lineCount = useMemo(
			() => (hasBody ? fullText.split('\n').length : 0),
			[hasBody, fullText],
		);

		const streamingViewportRef = useRef<HTMLElement | null>(null);
		const handleOsInitialized = useCallback((instance: OverlayScrollbars) => {
			streamingViewportRef.current = instance.elements().viewport;
			scrollToBottom(instance);
		}, []);
		useEffect(() => {
			if (!isRunning || !fullText) return;
			const el = streamingViewportRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		}, [fullText, isRunning]);

		if (!toolName) return null;
		if (shouldHideWhileRunning) return null;

		if (isQuestionTool) {
			// Prefer store's pending question (has correct requestId "que...").
			// Fall back to questionRequest from tool input for resolved state.
			const effectiveRequest = pendingQuestionFromStore ?? questionRequest;
			if (!effectiveRequest) return null;
			return <QuestionCard request={effectiveRequest} />;
		}

		if (category === 'inline') {
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
		if (canRenderDiffPreview) {
			return (
				<div className="flex flex-col gap-1">
					{fileChanges.map((change, i) => {
						const cardKey = getFileChangeCardKey(change, i);
						const diffExpanded = defaultExpanded ?? expandedDiffKeys.has(cardKey);
						return (
							<FileEditCard
								key={cardKey}
								change={change}
								accessRequest={i === 0 ? accessRequest : undefined}
								toolName={toolName}
								rawInput={rawInput}
								diffExpanded={diffExpanded}
								onToggleDiff={() =>
									setExpandedDiffKeys(prev => {
										const next = new Set(prev);
										if (next.has(cardKey)) {
											next.delete(cardKey);
										} else {
											next.add(cardKey);
										}
										return next;
									})
								}
								diagnostics={getApplyPatchDiagnosticsForCard({
									change,
									changeIndex: i,
									totalChanges: fileChanges.length,
									isApplyPatch,
									diagnostics,
								})}
								postMessage={postMessage}
							/>
						);
					})}
				</div>
			);
		}

		if (isDiffTool && diagnostics) {
			return <DiagnosticsDisplay diagnostics={diagnostics} postMessage={postMessage} />;
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
		const displayLabel = isBash ? '' : isSummarize && isRunning ? `${label}...` : label;

		const needsExpand = lineCount > 6;
		const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;

		// Non-diff tool cards stay collapsed by default and expand into a bounded,
		// scrollable body. Diff/file-change cards keep their dedicated preview mode.
		const alwaysCollapsible = hasBody;

		return (
			<ToolCard
				headerLeft={
					<>
						{icon}
						{displayLabel && (
							<span className="text-sm text-vscode-foreground opacity-90 whitespace-nowrap">
								{displayLabel}
							</span>
						)}
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
							<Tooltip content={meta} position="top" delay={300} maxWidth={400}>
								<span className="text-sm text-vscode-foreground opacity-70 truncate">{meta}</span>
							</Tooltip>
						)}
					</>
				}
				headerRight={
					<div className="flex items-center gap-2">
						{isRunning && liveElapsed > 0 && (
							<span className="flex items-center gap-1 text-xs text-vscode-descriptionForeground shrink-0">
								<TimerIcon size={11} />
								{formatDuration(liveElapsed)}
							</span>
						)}
						{meta && (
							<div
								className={cn(
									'opacity-0 transition-opacity duration-150 ease-out z-10',
									'group-hover:opacity-100',
								)}
							>
								<IconButton
									icon={<CopyIcon size={14} />}
									onClick={e => {
										e.stopPropagation();
										void copyTextToClipboard(meta);
									}}
									title="Copy request"
									size={20}
								/>
							</div>
						)}
					</div>
				}
				isCollapsible={alwaysCollapsible || (needsExpand && hasBody) || Boolean(showAccessGate)}
				expanded={expanded}
				onToggle={() => setExpanded(prev => !prev)}
				body={
					hasBody && expanded ? (
						<div className="relative">
							<OverlayScrollbarsComponent
								style={{
									maxHeight: TOOL_CARD_EXPANDED_MAX_HEIGHT,
								}}
								className="bg-(--tool-bg-header)"
								options={OVERLAY_SCROLLBAR_OPTIONS}
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
										void copyTextToClipboard(fullText);
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
