import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { resolveModelDisplayName } from '../../../common';
import { extractInlineAttachmentMatches } from '../../../common/inlineAttachments';
import { getDisplayDurationMs } from '../../../common/tokenStats';
import { useElapsedTimer } from '../../hooks/useElapsedTimer';
import { cn } from '../../lib/cn';
import {
	type RenderUserMessage,
	useActiveModelID,
	useChatActions,
	useCompactionMessage,
	useEditDraft,
	useEditingMessageId,
	useIsProcessing,
	useMessageTurnTokens,
	useSessionModel,
} from '../../store';
import type { SectionStats } from '../../store/projector';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIActions } from '../../store/uiStore';
import { copyTextToClipboard } from '../../utils/clipboard';
import { formatDuration, formatTime, formatTokens } from '../../utils/format';
import { Markdown } from '../../utils/markdown';
import { parseMessageSegments } from '../../utils/messageParser';
import { extractPromptFromParts } from '../../utils/promptParts';
import { useSessionMessage, useVSCode } from '../../utils/vscode';
import { ToolCard } from '../chat/ToolCard';
import { ClockIcon, CopyIcon, TimerIcon, TokensIcon, Undo2Icon, WandIcon } from '../icons';
import { IconButton, InlineAttachmentChip, type StatItem, StatsDisplay, Tooltip } from '../ui';
import { AttachmentsBar } from './AttachmentsBar';
import { ChatInput } from './ChatInput';

interface UserMessageProps {
	message: RenderUserMessage;
	/** True when this section is the exact revert point (for Unrevert button placement) */
	isRevertPoint?: boolean;
	/** Pre-computed section stats from groupMessagesIntoSections */
	stats: SectionStats;
}

interface MessageCompaction {
	type: 'compaction';
	messageId: string;
	auto?: boolean;
	summary?: string;
	partId?: string;
	assistantMessageId?: string;
	isStreaming?: boolean;
	completedAt?: number;
}

const CompactionCard = React.memo<{ compaction: MessageCompaction }>(({ compaction }) => {
	const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
	const hasSummary = Boolean(compaction.summary?.trim());
	const hasLiveBody = hasSummary || Boolean(compaction.isStreaming);
	// Once the user manually toggles, respect their choice.
	// Otherwise auto-expand only while actively streaming.
	const expanded = manualExpanded ?? Boolean(compaction.isStreaming);

	// When streaming finishes, auto-collapse unless user explicitly expanded.
	const prevStreamingRef = useRef(compaction.isStreaming);
	useEffect(() => {
		if (prevStreamingRef.current && !compaction.isStreaming && manualExpanded === null) {
			// Streaming just ended — collapse automatically
			setManualExpanded(false);
		}
		prevStreamingRef.current = compaction.isStreaming;
	}, [compaction.isStreaming, manualExpanded]);

	const status = hasSummary
		? compaction.isStreaming
			? 'Updating conversation summary...'
			: 'Conversation compacted into this summary.'
		: 'Compacting conversation...';

	return (
		<ToolCard
			headerLeft={
				<>
					<span className="toolcard-leading-icon flex items-center justify-center w-[18px] h-[18px] shrink-0 text-vscode-descriptionForeground">
						<WandIcon size={14} className={cn(compaction.isStreaming && 'animate-pulse')} />
					</span>
					<div className="min-w-0 flex items-center gap-1.5 text-sm overflow-hidden">
						<span className="text-vscode-descriptionForeground truncate">{status}</span>
					</div>
				</>
			}
			headerRight={
				hasSummary ? (
					<div
						className="opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100"
						onMouseDown={e => e.stopPropagation()}
						onClick={e => e.stopPropagation()}
					>
						<IconButton
							icon={<CopyIcon size={14} />}
							onClick={e => {
								e.stopPropagation();
								void copyTextToClipboard(compaction.summary || '');
							}}
							title="Copy summary"
							size={20}
						/>
					</div>
				) : undefined
			}
			isCollapsible={hasLiveBody}
			expanded={hasLiveBody ? expanded : false}
			onToggle={
				hasLiveBody
					? () => setManualExpanded(prev => !(prev ?? Boolean(compaction.isStreaming)))
					: undefined
			}
			body={
				hasLiveBody && expanded ? (
					<div className="px-(--gap-4) py-(--gap-3) bg-vscode-editor-background/35 border-t border-(--tool-border-color)">
						{hasSummary ? (
							<Markdown
								content={compaction.summary || ''}
								isStreaming={compaction.isStreaming}
								className="[&_p]:!text-sm [&_li]:!text-sm"
							/>
						) : (
							<div className="text-sm text-vscode-descriptionForeground">Preparing summary...</div>
						)}
					</div>
				) : undefined
			}
			className="mt-(--gap-2)"
		/>
	);
});
CompactionCard.displayName = 'CompactionCard';

const RestoreButton = React.memo<{ onRestore: () => void }>(({ onRestore }) => {
	const { showConfirmDialog } = useUIActions();

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			showConfirmDialog({
				title: 'Restore Checkpoint',
				message:
					'This will restore all files to their state before this message and remove all subsequent messages from the conversation.',
				confirmLabel: 'Restore',
				cancelLabel: 'Cancel',
				onConfirm: onRestore,
			});
		},
		[onRestore, showConfirmDialog],
	);

	return (
		<Tooltip content="Restore to this message" position="top" delay={200}>
			<button
				type="button"
				onClick={handleClick}
				className="flex items-center justify-center w-6 h-6 rounded hover:bg-vscode-list-hoverBackground text-vscode-foreground opacity-70 hover:opacity-100 transition-all cursor-pointer"
			>
				<Undo2Icon size={15} />
			</button>
		</Tooltip>
	);
});
RestoreButton.displayName = 'RestoreButton';

const UnrevertButton = React.memo<{
	onUnrevert: () => void;
}>(({ onUnrevert }) => {
	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onUnrevert();
		},
		[onUnrevert],
	);

	return (
		<Tooltip content="Undo the last revert" position="top" delay={200}>
			<button
				type="button"
				onClick={handleClick}
				className="flex items-center justify-center h-5 px-1.5 mt-px rounded text-xs font-medium bg-(--alpha-10) hover:bg-vscode-list-hoverBackground text-vscode-foreground opacity-80 hover:opacity-100 transition-all cursor-pointer"
			>
				Unrevert
			</button>
		</Tooltip>
	);
});
UnrevertButton.displayName = 'UnrevertButton';

const MessageStats = React.memo<{
	fileChanges: { added: number; removed: number; files: number } | null;
	messageId: string;
	timestamp: string;
	processingTimeFallbackMs: number | null;
	isProcessing: boolean;
	staticTokenCount: number | null;
	modelName: string;
}>(
	({
		fileChanges,
		messageId,
		timestamp,
		processingTimeFallbackMs,
		isProcessing,
		staticTokenCount,
		modelName,
	}) => {
		const liveTurnTokens = useMessageTurnTokens(messageId);
		const liveElapsed = useElapsedTimer(isProcessing, timestamp);

		// Simple token display: live total if available, otherwise static (pre-computed from store).
		// No refs, no caching, no complex fallback chains.
		const liveUsage =
			typeof liveTurnTokens?.usage === 'number' && liveTurnTokens.usage > 0
				? liveTurnTokens.usage
				: null;
		const tokenCount = isProcessing ? liveUsage : (liveUsage ?? staticTokenCount);

		const durationMs = getDisplayDurationMs({
			liveDurationMs: undefined,
			statsDurationMs: processingTimeFallbackMs ?? undefined,
			isProcessing,
			liveElapsedMs: liveElapsed,
		});
		const processingTime = durationMs ? formatDuration(durationMs) : null;

		// Left side items: model name, then file changes
		const leftItems: StatItem[] = [];

		leftItems.push({
			key: 'model',
			value: <span className="truncate">{modelName}</span>,
			tooltip: `Model: ${modelName}`,
		});

		if (fileChanges) {
			leftItems.push({
				key: 'files',
				tooltip: `${fileChanges.files} file${fileChanges.files > 1 ? 's' : ''} changed`,
				value: (
					<>
						{fileChanges.added > 0 && (
							<span className="text-(--changed-files-added)">+{fileChanges.added}</span>
						)}
						{fileChanges.removed > 0 && (
							<span className="text-(--changed-files-removed)">-{fileChanges.removed}</span>
						)}
					</>
				),
			});
		}

		// Right side items: tokens, duration, time
		const rightItems: StatItem[] = [];

		if (tokenCount) {
			rightItems.push({
				key: 'tokens',
				icon: <TokensIcon size={12} />,
				value: formatTokens(tokenCount),
				tooltip: 'Total tokens used for this message',
			});
		}

		if (processingTime) {
			rightItems.push({
				key: 'duration',
				icon: <TimerIcon size={12} />,
				value: processingTime,
				tooltip: 'Processing time',
				variant: 'success',
			});
		}

		rightItems.push({
			key: 'time',
			icon: <ClockIcon size={12} />,
			value: formatTime(timestamp),
			tooltip: 'Time sent',
		});

		return (
			<div className="flex items-center justify-between w-full gap-(--gap-2)">
				<StatsDisplay
					mode="message"
					items={leftItems}
					className="min-w-0 shrink !h-auto !mt-0 !px-0 !pt-0 !pb-0 self-end"
				/>
				<StatsDisplay
					mode="message"
					items={rightItems}
					className="shrink-0 !h-auto !mt-0 !px-0 !pt-0 !pb-0 self-end"
				/>
			</div>
		);
	},
);
MessageStats.displayName = 'MessageStats';

/**
 * Renders message text with command highlights for /command patterns
 * Only highlights valid commands from the provided set
 */
const MessageTextWithCommands: React.FC<{
	text: string;
	validCommands: Set<string>;
	validSubagents: Set<string>;
}> = React.memo(({ text, validCommands, validSubagents }) => {
	const { postMessage } = useVSCode();
	const segments = parseMessageSegments(text, validCommands, validSubagents);
	const inlineMatches = useMemo(() => extractInlineAttachmentMatches(text), [text]);

	const renderInlineChip = useCallback(
		(inlineMatch: (typeof inlineMatches)[number]) => (
			<InlineAttachmentChip
				key={`inline-${inlineMatch.start}-${inlineMatch.end}`}
				match={inlineMatch}
				onOpen={(filePath, startLine, endLine) => {
					postMessage({
						type: 'openFile',
						filePath,
						startLine,
						endLine,
					});
				}}
			/>
		),
		[postMessage],
	);

	const renderSegmentContent = useCallback(
		(segment: (typeof segments)[number]) => {
			const overlappingMatches = inlineMatches.filter(
				match => match.start >= segment.start && match.end <= segment.end,
			);
			if (overlappingMatches.length === 0) return segment.content;

			const parts: React.ReactNode[] = [];
			let cursor = segment.start;
			for (const inlineMatch of overlappingMatches) {
				if (inlineMatch.start > cursor) {
					parts.push(text.slice(cursor, inlineMatch.start));
				}
				parts.push(renderInlineChip(inlineMatch));
				cursor = inlineMatch.end;
			}
			if (cursor < segment.end) {
				parts.push(text.slice(cursor, segment.end));
			}
			return parts;
		},
		[inlineMatches, renderInlineChip, text],
	);

	return (
		<>
			{segments.map(segment => {
				const segmentKey = `${segment.type}-${segment.start}-${segment.end}`;
				if (segment.type === 'command') {
					return (
						<span
							key={segmentKey}
							className="rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
							style={{
								color: 'var(--vscode-editorGutter-modifiedBackground)',
								backgroundColor:
									'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 15%, transparent)',
							}}
						>
							{renderSegmentContent(segment)}
						</span>
					);
				}
				if (segment.type === 'subagent') {
					return (
						<span
							key={segmentKey}
							className="text-blue-400 rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
							style={{
								backgroundColor: 'color-mix(in srgb, #60a5fa 15%, transparent)',
							}}
						>
							{renderSegmentContent(segment)}
						</span>
					);
				}
				return <span key={segmentKey}>{renderSegmentContent(segment)}</span>;
			})}
		</>
	);
});
MessageTextWithCommands.displayName = 'MessageTextWithCommands';

const useStickyMessageSettings = () =>
	useSettingsStore(
		useShallow(state => ({
			opencodeProviders: state.opencodeProviders,
			proxyEndpoints: state.proxyEndpoints,
			agentResources: state.resources.agent.items,
		})),
	);

export const UserMessage: React.FC<UserMessageProps> = React.memo(
	({ message, isRevertPoint = false, stats }) => {
		const { postMessage } = useVSCode();
		const { postSessionMessage } = useSessionMessage();

		// Use optimized selectors to prevent unnecessary re-renders
		const editingMessageId = useEditingMessageId();

		const isProcessing = useIsProcessing();
		const sessionModel = useSessionModel();
		const chatActions = useChatActions();
		const { setEditingMessageId } = chatActions;
		const activeModelID = useActiveModelID();
		const { opencodeProviders, proxyEndpoints, agentResources } = useStickyMessageSettings();

		const validCommands = useMemo(() => new Set<string>(['compact']), []);
		const validSubagents = useMemo(
			() =>
				new Set(
					agentResources
						.filter(agent => !agent.disabled && !agent.hidden)
						.map(agent => agent.name.toLowerCase()),
				),
			[agentResources],
		);

		// Stats come from props (pre-computed in groupMessagesIntoSections)
		const isLastUserMessage = stats.isLast;
		const fileChangesStats = stats.fileChanges;
		const tokenStats = stats.tokenCount;
		const isProcessingLastMessage = isProcessing && isLastUserMessage;

		const reconstructedPrompt = useMemo(
			() => extractPromptFromParts(message.parts),
			[message.parts],
		);

		// User prompt resources are reconstructed from canonical OpenCode parts:
		// text/file mentions use source metadata; images are data-url file parts.
		const { images: attachedImages, text: messageText } = useMemo(() => {
			return {
				images: reconstructedPrompt.images,
				text: reconstructedPrompt.text,
			};
		}, [reconstructedPrompt]);
		const liveCompaction = useCompactionMessage(message.id) as MessageCompaction | undefined;
		const compaction = liveCompaction ?? (message.compaction as MessageCompaction | undefined);

		// Get human-readable model name from model ID
		const allProxyModels = useMemo(() => proxyEndpoints.flatMap(ep => ep.models), [proxyEndpoints]);
		const getModelDisplayName = useCallback(
			(modelId: string): string => {
				if (!modelId || modelId === 'default') {
					return 'Default';
				}
				return resolveModelDisplayName(modelId, opencodeProviders, allProxyModels);
			},
			[opencodeProviders, allProxyModels],
		);

		const isEditing = editingMessageId === message.id;
		const editDraft = useEditDraft(message.id);
		const [editText, setEditText] = useState(editDraft ?? messageText);
		const contentRef = useRef<HTMLDivElement>(null);
		const editContainerRef = useRef<HTMLDivElement>(null);
		const prevIsEditingRef = useRef(false);
		const handleCancelRef = useRef<() => void>(() => {});

		const handleCancel = useCallback(() => {
			// Save draft to store so it survives cancel
			if (message.id && editText !== messageText) {
				chatActions.setEditDraft(message.id, editText);
			}
			setEditingMessageId(null);
		}, [setEditingMessageId, message.id, editText, messageText, chatActions]);

		// Keep ref in sync so outside click always calls the latest version
		handleCancelRef.current = handleCancel;

		// Initialize editText only when entering edit mode (false → true transition)
		useEffect(() => {
			if (isEditing && !prevIsEditingRef.current) {
				setEditText(editDraft ?? messageText);
			}
			prevIsEditingRef.current = isEditing;
		}, [isEditing, editDraft, messageText]);

		// Outside click handler — separate effect, stable deps via ref
		useEffect(() => {
			if (!isEditing) return undefined;

			const handleOutsideClick = (e: MouseEvent) => {
				if (editContainerRef.current && !editContainerRef.current.contains(e.target as Node)) {
					const isDropdownClick = (e.target as HTMLElement).closest(
						'[data-radix-popper-content-wrapper], .dropdown-menu',
					);
					if (!isDropdownClick) {
						handleCancelRef.current();
					}
				}
			};

			document.addEventListener('mousedown', handleOutsideClick);
			return () => document.removeEventListener('mousedown', handleOutsideClick);
		}, [isEditing]);

		const { showConfirmDialog } = useUIActions();

		const doSendUpdate = useCallback(
			(
				text: string,
				shouldRestore: boolean,
				currentAttachments?: {
					files: string[];
					codeSnippets: Array<{
						filePath: string;
						startLine: number;
						endLine: number;
						content: string;
					}>;
					images: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
				},
			) => {
				const files = currentAttachments?.files ?? [];
				const snippets = currentAttachments?.codeSnippets ?? [];
				const images = currentAttachments?.images ?? attachedImages;

				const editAttachments = {
					files: files.length > 0 ? files : undefined,
					codeSnippets: snippets.length > 0 ? snippets : undefined,
					images: images.length > 0 ? images : undefined,
				};
				const hasAttachments =
					editAttachments.files || editAttachments.codeSnippets || editAttachments.images;

				postSessionMessage({
					type: 'sendMessage',
					text,
					model: sessionModel,
					attachments: hasAttachments ? editAttachments : undefined,
					...(message.id
						? {
								messageID: message.id,
								editMode: shouldRestore ? 'revert' : 'history_only',
							}
						: {}),
				});
				// Clear the draft — edit was successfully sent
				if (message.id) {
					chatActions.clearEditDraft(message.id);
				}
				setEditingMessageId(null);
			},
			[
				message.id,
				chatActions,
				postSessionMessage,
				setEditingMessageId,
				attachedImages,
				sessionModel,
			],
		);

		const handleSendUpdate = useCallback(
			(
				text: string,
				currentAttachments?: {
					files: string[];
					codeSnippets: Array<{
						filePath: string;
						startLine: number;
						endLine: number;
						content: string;
					}>;
					images: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
				},
			) => {
				const hasAttachments = Boolean(
					currentAttachments &&
						(currentAttachments.files.length > 0 ||
							currentAttachments.codeSnippets.length > 0 ||
							currentAttachments.images.length > 0),
				);
				if (!text.trim() && !hasAttachments) {
					return;
				}
				if (message.id) {
					showConfirmDialog({
						title: 'Edit Message History?',
						message:
							'This will remove this message and everything after it, then send the edited message here. If later assistant turns changed files, choose whether to restore files to the state before this message first.',
						confirmLabel: 'Restore files and send',
						cancelLabel: 'Only replace history',
						onConfirm: () => doSendUpdate(text, true, currentAttachments),
						onSecondary: () => doSendUpdate(text, false, currentAttachments),
					});
				} else {
					doSendUpdate(text, false, currentAttachments);
				}
			},
			[message.id, doSendUpdate, showConfirmDialog],
		);

		const handleRestore = useCallback(() => {
			if (message.id && message.message.sessionID) {
				postSessionMessage({
					type: 'restoreMessage',
					sessionId: message.message.sessionID,
					messageId: message.id,
				});
			}
		}, [message.id, message.message.sessionID, postSessionMessage]);

		const handleUnrevert = useCallback(() => {
			if (!message.message.sessionID) return;
			postSessionMessage({ type: 'unrevert', sessionId: message.message.sessionID });
		}, [message.message.sessionID, postSessionMessage]);

		const showUnrevert = isRevertPoint;
		const showRestore = Boolean(message.id) && !isRevertPoint;

		if (isEditing) {
			return (
				<div ref={editContainerRef} className="w-full mb-(--message-gap)">
					<ChatInput
						value={editText}
						onChange={setEditText}
						onSend={handleSendUpdate}
						onCancel={handleCancel}
						autoFocus
						hideFilesPanel
						hideContextBar
						sendDisabled={isProcessing}
						placeholder="Edit your message..."
						initialImages={attachedImages}
					/>
				</div>
			);
		}

		// When a compaction card is present, hide the regular message bubble
		// and only show the CompactionCard.
		if (compaction) {
			return (
				<div className="w-full mb-(--message-gap) px-0">
					<CompactionCard
						key={compaction.partId ?? compaction.assistantMessageId ?? compaction.messageId}
						compaction={compaction}
					/>
				</div>
			);
		}

		return (
			<div className="w-full mb-(--message-gap) px-0">
				<div
					className={cn(
						'flex flex-col relative w-full bg-(--input-bg) border border-(--input-border) rounded-(--input-radius) overflow-hidden transition-all duration-150 ease-out',
					)}
				>
					<div className="flex-1 min-w-0 flex flex-col relative">
						{/* Restore/Unrevert buttons in top-right corner - mutually exclusive */}
						{(showRestore || showUnrevert) && (
							<div className="absolute top-1 right-1.5 flex items-center gap-1 z-10">
								{showUnrevert && <UnrevertButton onUnrevert={handleUnrevert} />}
								{showRestore && <RestoreButton onRestore={handleRestore} />}
							</div>
						)}
						<button
							type="button"
							onClick={() => message.id && setEditingMessageId(message.id)}
							className={cn(
								'w-full bg-transparent border-none text-left font-(family-name:--vscode-font-family) text-vscode-foreground',
								'p-(--gap-3)_(--gap-6)_(--gap-1)_(--gap-6)',
								showRestore || showUnrevert ? 'pr-20' : '',
								'cursor-pointer',
							)}
						>
							<div className="px-(--gap-3) py-(--gap-1-5)">
								{attachedImages.length > 0 && (
									<div className="mb-(--gap-2)">
										<AttachmentsBar
											images={attachedImages.map(img => ({
												id: img.id,
												name: img.name,
												dataUrl: img.dataUrl,
												path: img.path,
											}))}
											files={[]}
											codeSnippets={[]}
											onOpenFile={(path, startLine, endLine) => {
												postMessage({ type: 'openFile', filePath: path, startLine, endLine });
											}}
											inline
											maxRows={2}
										/>
									</div>
								)}
								<div
									ref={contentRef}
									className={cn(
										'text-(length:--font-size-base) leading-tight wrap-break-word overflow-anywhere whitespace-pre-wrap overflow-hidden line-clamp-3',
									)}
								>
									<MessageTextWithCommands
										text={messageText}
										validCommands={validCommands}
										validSubagents={validSubagents}
									/>
								</div>
							</div>
						</button>
						<div className="flex items-end text-sm px-(--gap-4) pt-0 pb-(--gap-1-5) bg-(--input-bg)">
							<MessageStats
								fileChanges={fileChangesStats}
								messageId={message.id}
								timestamp={new Date(message.message.time.created).toISOString()}
								processingTimeFallbackMs={stats.durationMs}
								isProcessing={isProcessingLastMessage}
								staticTokenCount={tokenStats}
								modelName={getModelDisplayName(
									(message.message.role === 'user' ? message.message.model?.modelID : undefined) ||
										activeModelID ||
										'',
								)}
							/>
						</div>
					</div>
				</div>
			</div>
		);
	},
);

UserMessage.displayName = 'UserMessage';
