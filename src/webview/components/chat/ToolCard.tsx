/**
 * @file ToolCard - minimal unified tool UI
 * @description Minimal, reusable card for displaying tool calls/results in the chat.
 * Uses NormalizedEntry (ViewModel) for clean data access, falling back to legacy helpers only if needed.
 */

import React, { type ReactNode, useMemo, useState } from 'react';
// @ts-expect-error - normalizedEvents path issue in webview tsconfig
import type { NormalizedEntry } from '../../../../common/normalizedEvents';
import { computeDiffStats } from '../../../common/diffStats';
import { isMcpTool, isToolMatch } from '../../constants';
import { cn } from '../../lib/cn';
import { useAccessRequestByToolUseId, useMcpServers, useToolResultByToolId } from '../../store';
import type { Message as WebviewMessage } from '../../store/chatStore';
import { formatToolName, getShortFileName } from '../../utils/format';
import { useVSCode } from '../../utils/vscode';
import { ChevronDownIcon, CopyIcon, McpIcon, TerminalIcon, WandIcon } from '../icons';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { Button, IconButton, Tooltip } from '../ui';
import { InlineToolAccessGate } from './InlineToolAccessGate';
import { getDiffContentHeight, parseUnifiedDiffSnapshots, SimpleDiff } from './SimpleDiff';
import { InlineToolLine } from './SimpleTool';

export const TOOL_CARD_CLASSES =
	'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden';

export const TOOL_CARD_HEADER_CLASSES =
	'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) bg-(--tool-bg-header) select-none';

const DEFAULT_TEXT_PREVIEW_LINES = 6;

type ToolUse = Extract<WebviewMessage, { type: 'tool_use' }>;
type ToolResult = Extract<WebviewMessage, { type: 'tool_result' }>;
type AccessRequestMessage = Extract<WebviewMessage, { type: 'access_request' }>;

type FileEditChange = {
	type?: string;
	content?: string;
	unifiedDiff?: string;
	oldContent?: string;
	newContent?: string;
};

type FileEditAction = {
	type: 'FileEdit';
	path?: string;
	changes?: FileEditChange[];
};

type ResolvedDiffData = {
	oldContent: string;
	newContent: string;
	effectiveFilePath: string;
	name: string;
	hasDeleteChange: boolean;
};

const inlinePreview = (text: string, maxLines: number) => {
	const lines = text.split('\n');
	if (lines.length <= maxLines) return { preview: text, needsExpand: false };
	return { preview: lines.slice(-maxLines).join('\n'), needsExpand: true };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

const getStringFromRecord = (
	record: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined => {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
};

const resolveFileEditAction = (actionType: unknown): FileEditAction | null => {
	const record = asRecord(actionType);
	if (!record || record.type !== 'FileEdit') return null;

	const changesRaw = record.changes;
	const changes = Array.isArray(changesRaw)
		? changesRaw.map(change => asRecord(change) as FileEditChange).filter(Boolean)
		: [];

	return {
		type: 'FileEdit',
		path: typeof record.path === 'string' ? record.path : undefined,
		changes,
	};
};

const resolveDiffFromAccessMetadata = (
	accessRequest: AccessRequestMessage | undefined,
): { oldContent: string; newContent: string; filePath?: string } | null => {
	const accessRequestRecord = asRecord(accessRequest as unknown);
	const metadata = asRecord(accessRequestRecord?.metadata);
	const diffText = getStringFromRecord(metadata, ['diff']);
	if (!diffText) return null;

	const parsedSnapshots = parseUnifiedDiffSnapshots(diffText);
	const filePath = getStringFromRecord(metadata, ['filepath', 'filePath', 'path']);
	if (parsedSnapshots) {
		return {
			oldContent: parsedSnapshots.oldContent,
			newContent: parsedSnapshots.newContent,
			filePath,
		};
	}

	return {
		oldContent: '',
		newContent: diffText,
		filePath,
	};
};

const resolveDiffData = (params: {
	actionType: unknown;
	toolResult: ToolResult | undefined;
	accessRequest: AccessRequestMessage | undefined;
	fallbackFilePath?: string;
}): ResolvedDiffData => {
	let oldContent = '';
	let newContent = '';
	let effectiveFilePath = '';
	let hasDeleteChange = false;

	const fileEditAction = resolveFileEditAction(params.actionType);

	if (fileEditAction) {
		effectiveFilePath = fileEditAction.path ?? '';
		const primaryChange = fileEditAction.changes?.[0];
		if (primaryChange) {
			hasDeleteChange = primaryChange.type === 'Delete';
			if (primaryChange.type === 'Write' && typeof primaryChange.content === 'string') {
				newContent = primaryChange.content;
			} else if (primaryChange.type === 'Edit' && typeof primaryChange.unifiedDiff === 'string') {
				newContent = primaryChange.unifiedDiff;
			} else if (primaryChange.type === 'Replace') {
				oldContent = primaryChange.oldContent ?? '';
				newContent = primaryChange.newContent ?? '';
			}
		}
	}

	const toolResultMetadata = asRecord(params.toolResult?.metadata);
	const metadataFilePath = getStringFromRecord(toolResultMetadata, [
		'filepath',
		'filePath',
		'path',
	]);

	const metadataFileDiffRaw = toolResultMetadata?.filediff;
	const metadataFileDiff = Array.isArray(metadataFileDiffRaw)
		? asRecord(metadataFileDiffRaw.find(item => item && typeof item === 'object'))
		: asRecord(metadataFileDiffRaw);

	if (metadataFileDiff) {
		const before = getStringFromRecord(metadataFileDiff, ['before']);
		const after = getStringFromRecord(metadataFileDiff, ['after']);
		if (before !== undefined || after !== undefined) {
			oldContent = before ?? '';
			newContent = after ?? '';
		}

		const filediffPath = getStringFromRecord(metadataFileDiff, ['filepath', 'filePath', 'path']);
		if (!effectiveFilePath && filediffPath) {
			effectiveFilePath = filediffPath;
		}
	}

	if (!newContent && !oldContent) {
		const metadataUnifiedDiff = getStringFromRecord(toolResultMetadata, ['diff']);
		if (metadataUnifiedDiff) {
			const parsedSnapshots = parseUnifiedDiffSnapshots(metadataUnifiedDiff);
			if (parsedSnapshots) {
				oldContent = parsedSnapshots.oldContent;
				newContent = parsedSnapshots.newContent;
			} else {
				newContent = metadataUnifiedDiff;
			}
		}
	}

	if (!newContent && !oldContent) {
		const accessDiff = resolveDiffFromAccessMetadata(params.accessRequest);
		if (accessDiff) {
			oldContent = accessDiff.oldContent;
			newContent = accessDiff.newContent;
			if (!effectiveFilePath && accessDiff.filePath) {
				effectiveFilePath = accessDiff.filePath;
			}
		}
	}

	if (!effectiveFilePath && metadataFilePath) {
		effectiveFilePath = metadataFilePath;
	}
	if (!effectiveFilePath && params.fallbackFilePath) {
		effectiveFilePath = params.fallbackFilePath;
	}

	return {
		oldContent,
		newContent,
		effectiveFilePath,
		name: effectiveFilePath ? getShortFileName(effectiveFilePath) : 'unknown',
		hasDeleteChange,
	};
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

export interface ToolCardProps {
	headerLeft: ReactNode;
	headerRight?: ReactNode;
	body?: ReactNode;
	isCollapsible?: boolean;
	expanded?: boolean;
	onToggle?: () => void;
	className?: string;
}

export const ToolCard: React.FC<ToolCardProps> = ({
	headerLeft,
	headerRight,
	body,
	isCollapsible = false,
	expanded = false,
	onToggle,
	className,
}) => {
	const canToggle = Boolean(isCollapsible && onToggle);
	return (
		<div className={cn(TOOL_CARD_CLASSES, 'group', className)}>
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
			{body}
		</div>
	);
};

interface ToolCardMessageProps {
	message: ToolUse;
	toolResult?: ToolResult;
	defaultExpanded?: boolean;
}

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
		const content = toolResult?.content ?? '';

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

		const [expanded, setExpanded] = useState(defaultExpanded ?? false);
		const [diffExpanded, setDiffExpanded] = useState(defaultExpanded ?? false);

		if (!toolName) return null;

		// Inline Card: Default for everything except MCP, Bash, File Edits, and tools with Access Requests
		const hasAccessRequest = Boolean(accessRequest);
		if (!isMcp && !isBash && !isFileEdit && !hasAccessRequest) {
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
			const resolved = resolveDiffData({
				actionType,
				toolResult,
				accessRequest: accessRequest as AccessRequestMessage | undefined,
				fallbackFilePath: filePath,
			});

			const oldContent = resolved.oldContent;
			const newContent = resolved.newContent;
			const effectiveFilePath = resolved.effectiveFilePath;
			const name = resolved.name;

			const hasContent = newContent || oldContent || resolved.hasDeleteChange;

			if (hasContent) {
				const stats = computeDiffStats(oldContent, newContent);
				const maxHeight = 120;
				const needsExpand =
					getDiffContentHeight(oldContent, newContent, {
						collapseUnchanged: false,
					}) > maxHeight;
				const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;

				return (
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
						expanded={diffExpanded || Boolean(showAccessGate)}
						onToggle={() => setDiffExpanded(prev => !prev)}
						body={
							<div className="relative">
								<div className={cn(accessRequest?.resolved === false ? 'pb-2' : undefined)}>
									<SimpleDiff
										original={oldContent}
										modified={newContent}
										maxHeight={maxHeight}
										expanded={diffExpanded}
										collapseUnchanged={!diffExpanded}
									/>
								</div>
								{showAccessGate && (
									<div className="px-(--tool-content-padding) py-2 border-t border-(--border-subtle)">
										<InlineToolAccessGate
											requestId={accessRequest?.requestId}
											messageId={accessRequest?.id}
											tool={accessRequest?.tool || toolName}
											input={accessRequest?.input || rawInput || {}}
											pattern={accessRequest?.pattern}
											className="py-1"
											hideDetails={true}
										/>
									</div>
								)}
								{accessRequest?.resolved && (
									<div className="px-(--tool-content-padding) py-1 border-t border-(--border-subtle)">
										<span className="text-xs text-vscode-foreground opacity-60">
											{accessRequest.approved ? 'Approved' : 'Denied'}
										</span>
									</div>
								)}
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
					/>
				);
			}
		}

		// 2) MCP / Bash / Generic Card
		const icon = isMcp ? (
			<ToolCardLeadingIcon>
				<McpIcon size={14} className="text-[#3b82f6] shrink-0" />
			</ToolCardLeadingIcon>
		) : isBash ? (
			<ToolCardLeadingIcon>
				<TerminalIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		) : (
			<ToolCardLeadingIcon>
				<WandIcon size={14} className="shrink-0" />
			</ToolCardLeadingIcon>
		);
		const label = isMcp ? 'MCP' : formatToolName(toolName);

		// Meta extraction
		let meta = '';
		if (actionType?.type === 'CommandRun') meta = actionType.command;
		else if (isBash) meta = (rawInput as { command?: string })?.command || '';
		else if (isMcp) meta = rawInput ? JSON.stringify(rawInput) : '';

		const fullText = content || '';
		const { preview, needsExpand } = inlinePreview(fullText, DEFAULT_TEXT_PREVIEW_LINES);
		const shownText = expanded || !needsExpand ? fullText : preview;
		const hasBody = shownText.trim().length > 0;
		const showAccessGate = accessRequest && !accessRequest.resolved && accessRequest.requestId;
		const showAccessStatus = accessRequest?.resolved;

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
				isCollapsible={
					(needsExpand && hasBody) || Boolean(showAccessGate) || Boolean(showAccessStatus)
				}
				expanded={expanded || Boolean(showAccessGate)}
				onToggle={() => setExpanded(prev => !prev)}
				body={
					hasBody || showAccessGate || showAccessStatus ? (
						<div className="flex flex-col">
							{hasBody && (
								<div className="p-(--tool-content-padding) bg-(--tool-bg-header)">
									<pre
										className={cn(
											'm-0 text-sm leading-(--line-height-code) whitespace-pre',
											isError ? 'text-error opacity-100' : 'text-vscode-foreground opacity-90',
										)}
									>
										{shownText}
									</pre>
								</div>
							)}
							{showAccessGate && (
								<div className="px-(--tool-content-padding) py-2 border-t border-(--border-subtle)">
									<InlineToolAccessGate
										requestId={accessRequest?.requestId}
										messageId={accessRequest?.id}
										tool={accessRequest?.tool || toolName}
										input={accessRequest?.input || rawInput || {}}
										pattern={accessRequest?.pattern}
										hideDetails={true}
									/>
								</div>
							)}
							{showAccessStatus && (
								<div className="px-(--tool-content-padding) py-1 border-t border-(--border-subtle)">
									<span className="text-xs text-vscode-foreground opacity-60">
										{accessRequest?.approved ? 'Approved' : 'Denied'}
									</span>
								</div>
							)}
						</div>
					) : undefined
				}
			/>
		);
	},
);

ToolCardMessage.displayName = 'ToolCardMessage';

export const ToolCardGroup: React.FC<{ messages: WebviewMessage[] }> = ({ messages }) => {
	const toolUseMessages = useMemo(
		() => messages.filter(m => m.type === 'tool_use') as ToolUse[],
		[messages],
	);
	const localToolResults = useMemo(() => {
		const results: Record<string, ToolResult | undefined> = {};
		for (const msg of messages) {
			if (msg.type === 'tool_result' && msg.toolUseId) {
				results[msg.toolUseId] = msg as ToolResult;
			}
		}
		return results;
	}, [messages]);

	if (toolUseMessages.length === 0) return null;

	return (
		<>
			{toolUseMessages.map(msg => (
				<div key={msg.id} className="mb-(--tool-block-margin)">
					<ToolCardMessage message={msg} toolResult={localToolResults[msg.toolUseId]} />
				</div>
			))}
		</>
	);
};
