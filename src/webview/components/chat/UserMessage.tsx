/**
 * @file UserMessage - displays user messages in chat with sticky positioning
 * @description Renders user messages with structured attachments (files, code snippets, images).
 *              Attachments are stored in message.attachments and displayed as clickable badges.
 *              Falls back to text parsing for legacy messages without structured attachments.
 *              Includes MessageStats with timing, tokens, model info, and file changes.
 *              Uses the unified ChatInput for a full-featured editing experience.
 *              Session-specific data (changedFiles, restoreCommits) now comes from chatStore.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OPENCODE_COMMANDS } from '../../constants';

import { cn } from '../../lib/cn';
import {
	type CommitInfo,
	type Message,
	useChatActions,
	useEditingMessageId,
	useIsProcessing,
	useRestoreCommits,
	useUnrevertAvailable,
} from '../../store';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIActions } from '../../store/uiStore';
import { formatDuration, formatTime, formatTokens, getShortFileName } from '../../utils/format';
import type { SectionStats } from '../../utils/groupSections';
import { parseMessageSegments } from '../../utils/messageParser';
import { STANDARD_MODELS } from '../../utils/models';
import { useSessionMessage, useVSCode } from '../../utils/vscode';
import { ClockIcon, TimerIcon, TokensIcon, Undo2Icon } from '../icons';
import { ChatInput } from '../input/ChatInput';
import { PathChip, type StatItem, StatsDisplay, Tooltip } from '../ui';

interface UserMessageProps {
	message: Message & { type: 'user' };
	/** True when this section is the exact revert point (for Unrevert button placement) */
	isRevertPoint?: boolean;
	/** Pre-computed section stats from groupMessagesIntoSections */
	stats: SectionStats;
}

/**
 * Represents a code snippet attachment with file location and content
 */
interface CodeSnippetAttachment {
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

/**
 * Represents an image attachment
 */
interface ImageAttachment {
	id: string;
	name: string;
	dataUrl: string;
	path?: string;
}

/**
 * Structured attachments from message
 */
interface MessageAttachments {
	files?: string[];
	codeSnippets?: CodeSnippetAttachment[];
	images?: ImageAttachment[];
}

/**
 * Parse message content to extract attached files, code snippets, and remaining text.
 * Used as fallback for legacy messages without structured attachments.
 * Supports two formats:
 * 1. Simple file references: @path/to/file.ts
 * 2. Code snippets with line ranges: @path/to/file.ts (1-10)\n```\ncode\n```
 */
function parseMessageContent(content: string): {
	files: string[];
	codeSnippets: CodeSnippetAttachment[];
	text: string;
} {
	const files: string[] = [];
	const codeSnippets: CodeSnippetAttachment[] = [];
	let text = content;

	// First, extract code snippets with line ranges and code blocks
	// Pattern: @filepath (startLine-endLine)\n```\ncode\n```
	const snippetPattern =
		/@([A-Za-z]:[^\s@(]+|\/[^\s@(]+|[^\s@(]+\.[a-zA-Z0-9]+)\s*\((\d+)-(\d+)\)\n```\n([\s\S]*?)\n```/g;

	let snippetMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
	while ((snippetMatch = snippetPattern.exec(content)) !== null) {
		codeSnippets.push({
			filePath: snippetMatch[1],
			startLine: Number.parseInt(snippetMatch[2], 10),
			endLine: Number.parseInt(snippetMatch[3], 10),
			content: snippetMatch[4],
		});
	}

	// Remove code snippets from text
	if (codeSnippets.length > 0) {
		text = text.replace(snippetPattern, '').trim();
	}

	// Then extract simple file references (without line ranges)
	// Match @path patterns that are NOT followed by (line-line)
	const filePattern = /@([A-Za-z]:[^\s@(]+|\/[^\s@(]+|[^\s@(]+\.[a-zA-Z0-9]+)(?!\s*\(\d+-\d+\))/g;

	let fileMatch: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
	while ((fileMatch = filePattern.exec(text)) !== null) {
		const filePath = fileMatch[1];
		// Only add if it looks like a file path (has extension or is absolute path)
		if (filePath.includes('.') || filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) {
			files.push(filePath);
		}
	}

	// Remove file references from text
	if (files.length > 0) {
		text = text.replace(filePattern, '').trim();
	}

	// Clean up multiple spaces/newlines
	text = text
		.replace(/^\n+/, '')
		.replace(/\n{2,}/g, '\n\n')
		.trim();

	return { files, codeSnippets, text };
}

/**
 * Extract attachments from message - uses structured data if available, falls back to parsing
 */
function getMessageAttachments(message: Message & { type: 'user' }): {
	files: string[];
	codeSnippets: CodeSnippetAttachment[];
	images: ImageAttachment[];
	text: string;
} {
	const attachments = (message as { attachments?: MessageAttachments }).attachments;

	// If we have structured attachments, use them directly
	if (attachments) {
		return {
			files: attachments.files || [],
			codeSnippets: attachments.codeSnippets || [],
			images: attachments.images || [],
			text: message.content,
		};
	}

	// Fallback to parsing for messages without structured attachments
	const parsed = parseMessageContent(message.content);
	return {
		files: parsed.files,
		codeSnippets: parsed.codeSnippets,
		images: [],
		text: parsed.text,
	};
}

const RestoreButton = React.memo<{
	restoreCommit: CommitInfo;
	onRestore: () => void;
}>(({ restoreCommit, onRestore }) => {
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
		<Tooltip
			content={`Restore to checkpoint (${new Date(restoreCommit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`}
			position="top"
			delay={200}
		>
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
	tokenCount: number | null;
	timestamp: string;
	processingTime: string | null;
	modelName: string;
}>(({ fileChanges, tokenCount, timestamp, processingTime, modelName }) => {
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
					<span className="text-(--changed-files-added)">+{fileChanges.added}</span>
					<span className="text-(--changed-files-removed)">-{fileChanges.removed}</span>
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
			tooltip: 'Estimated tokens used',
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
			<StatsDisplay mode="message" items={leftItems} className="min-w-0 shrink" />
			<StatsDisplay mode="message" items={rightItems} className="shrink-0" />
		</div>
	);
});
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
	const segments = parseMessageSegments(text, validCommands, validSubagents);

	return (
		<>
			{segments.map((segment, index) => {
				if (segment.type === 'command') {
					return (
						<span
							key={`${index}-${segment.content}`}
							className="text-warning rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
							style={{
								backgroundColor:
									'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 15%, transparent)',
							}}
						>
							{segment.content}
						</span>
					);
				}
				if (segment.type === 'subagent') {
					return (
						<span
							key={`${index}-${segment.content}`}
							className="text-blue-400 rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
							style={{
								backgroundColor: 'color-mix(in srgb, #60a5fa 15%, transparent)',
							}}
						>
							{segment.content}
						</span>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: Order is static and safe here
					<span key={`${index}-text`}>{segment.content}</span>
				);
			})}
		</>
	);
});
MessageTextWithCommands.displayName = 'MessageTextWithCommands';

export const UserMessage: React.FC<UserMessageProps> = React.memo(
	({ message, isRevertPoint = false, stats }) => {
		const { postMessage } = useVSCode();
		const { postSessionMessage } = useSessionMessage();

		// Use optimized selectors to prevent unnecessary re-renders
		const editingMessageId = useEditingMessageId();
		const restoreCommits = useRestoreCommits();
		const unrevertAvailable = useUnrevertAvailable();

		const isProcessing = useIsProcessing();
		const chatActions = useChatActions();
		const { setEditingMessageId } = chatActions;
		const { selectedModel, opencodeProviders } = useSettingsStore();
		const customCommands = useSettingsStore(state => state.commands.custom);
		const subagents = useSettingsStore(state => state.subagents);

		// Build set of valid command names for highlighting
		const validCommands = useMemo(() => {
			return new Set([
				...OPENCODE_COMMANDS.map(cmd => cmd.name.toLowerCase()),
				...customCommands.map(cmd => cmd.name.toLowerCase()),
			]);
		}, [customCommands]);

		const validSubagents = useMemo(() => {
			return new Set(subagents.items.map(a => a.name.toLowerCase()));
		}, [subagents.items]);

		// Stats come from props (pre-computed in groupMessagesIntoSections)
		const isLastUserMessage = stats.isLast;
		const fileChangesStats = stats.fileChanges;
		const tokenStats = stats.tokenCount;

		// Calculate processing time locally
		const processingTime = useMemo(() => {
			const messageTimestamp = new Date(message.timestamp).getTime();

			if (stats.nextUserMessageTs) {
				return formatDuration(stats.nextUserMessageTs - messageTimestamp);
			}

			if (stats.lastResponseTs) {
				return formatDuration(stats.lastResponseTs - messageTimestamp);
			}

			if (isProcessing && isLastUserMessage) {
				return formatDuration(Date.now() - messageTimestamp);
			}

			return null;
		}, [
			stats.nextUserMessageTs,
			stats.lastResponseTs,
			isProcessing,
			isLastUserMessage,
			message.timestamp,
		]);

		// Parse attachments (prop-based, stable)
		const {
			files: attachedFiles,
			codeSnippets: attachedSnippets,
			images: attachedImages,
			text: messageText,
		} = useMemo(() => getMessageAttachments(message), [message]);

		// Get human-readable model name from model ID
		const getModelDisplayName = useCallback(
			(modelId: string): string => {
				if (!modelId || modelId === 'default') {
					return 'Default';
				}

				// For OpenCode models (format: "providerId/modelId")
				if (modelId.includes('/')) {
					const [providerId, modelIdPart] = modelId.split('/');
					const provider = opencodeProviders.find(p => p.id === providerId);
					if (provider) {
						const model = provider.models.find(m => m.id === modelIdPart);
						if (model) {
							return model.name;
						}
					}
					// Fallback to modelId part if provider/model not found
					return modelIdPart;
				}

				// For standard models
				const standardModel = STANDARD_MODELS.find(m => m.id === modelId);
				if (standardModel) {
					return standardModel.name;
				}

				return modelId;
			},
			[opencodeProviders],
		);

		const restoreCommit = useMemo(() => {
			const byMessage = restoreCommits.filter(c => c.associatedMessageId === message.id);
			return byMessage[0];
		}, [restoreCommits, message.id]);

		const isEditing = editingMessageId === message.id;
		const [editText, setEditText] = useState(messageText); // Use parsed text without file paths
		const contentRef = useRef<HTMLDivElement>(null);
		const editContainerRef = useRef<HTMLDivElement>(null);
		const [, forceUpdate] = useState(0);

		const handleCancel = useCallback(() => {
			setEditingMessageId(null);
		}, [setEditingMessageId]);

		useEffect(() => {
			if (isEditing) {
				setEditText(messageText); // Use parsed text without file paths

				// Handle outside click to cancel editing
				const handleOutsideClick = (e: MouseEvent) => {
					if (editContainerRef.current && !editContainerRef.current.contains(e.target as Node)) {
						// Check if click is on a dropdown or portal (common for menus)
						const isDropdownClick = (e.target as HTMLElement).closest(
							'[data-radix-popper-content-wrapper], .dropdown-menu',
						);
						if (!isDropdownClick) {
							handleCancel();
						}
					}
				};

				document.addEventListener('mousedown', handleOutsideClick);
				return () => document.removeEventListener('mousedown', handleOutsideClick);
			}
			return undefined;
		}, [isEditing, messageText, handleCancel]);

		useEffect(() => {
			if (!isLastUserMessage || !isProcessing) {
				return;
			}
			const interval = setInterval(() => forceUpdate(n => n + 1), 1000);
			return () => clearInterval(interval);
		}, [isLastUserMessage, isProcessing]);

		const { showConfirmDialog } = useUIActions();

		const doSendUpdate = useCallback(
			(text: string, shouldRestore: boolean) => {
				if (shouldRestore && restoreCommit) {
					// Frontend only sends commitId — backend resolves everything else
					postMessage({
						type: 'restoreCommit',
						data: { commitId: restoreCommit.id },
					});
				}
				// When editing and sending, delete messages immediately (not just mark as reverted)
				if (message.id) {
					// This will keep the current message but remove everything after it
					chatActions.deleteMessagesAfterId(message.id);
				}
				// Clear unrevert state - user is sending a new message, unrevert no longer makes sense
				chatActions.setUnrevertAvailable(false);

				// Build attachments from current edit state
				const editAttachments = {
					files: attachedFiles.length > 0 ? attachedFiles : undefined,
					codeSnippets:
						attachedSnippets.length > 0
							? attachedSnippets.map(s => ({
									filePath: s.filePath,
									startLine: s.startLine,
									endLine: s.endLine,
									content: s.content,
								}))
							: undefined,
					images:
						attachedImages.length > 0
							? attachedImages.map(img => ({
									id: img.id,
									name: img.name,
									dataUrl: img.dataUrl,
									path: img.path,
								}))
							: undefined,
				};
				const hasAttachments =
					editAttachments.files || editAttachments.codeSnippets || editAttachments.images;

				postSessionMessage({
					type: 'sendMessage',
					text,
					planMode: false,
					attachments: hasAttachments ? editAttachments : undefined,
					// Pass the ID of the message being edited so the backend knows to replace/truncate history
					messageID: message.id,
				});
				setEditingMessageId(null);
			},
			[
				message.id,
				restoreCommit,
				chatActions,
				postMessage,
				postSessionMessage,
				setEditingMessageId,
				attachedFiles,
				attachedImages,
				attachedSnippets,
			],
		);

		const handleSendUpdate = useCallback(
			(text: string) => {
				if (!text.trim()) {
					return;
				}
				// If unrevert is available, user already did a restore - just send without asking again
				// If there's a checkpoint but no unrevert, ask if they want to restore files
				if (restoreCommit && !unrevertAvailable) {
					showConfirmDialog({
						title: 'Restore Checkpoint?',
						message:
							'Do you want to restore files to their state before this message? This will undo all file changes made after this checkpoint.',
						confirmLabel: 'Restore & Send',
						cancelLabel: 'Send Without Restore',
						onConfirm: () => doSendUpdate(text, true),
						onCancel: () => doSendUpdate(text, false),
					});
				} else {
					// Either no checkpoint, or user already restored (unrevertAvailable=true)
					// In both cases, just send without restore
					doSendUpdate(text, false);
				}
			},
			[restoreCommit, unrevertAvailable, showConfirmDialog, doSendUpdate],
		);

		const handleRestore = useCallback(() => {
			if (restoreCommit) {
				// Frontend only sends commitId — backend resolves everything else
				// Do NOT clear revertedFromMessageId here — the backend will send
				// a 'success' event with the correct revertedFromMessageId.
				postMessage({
					type: 'restoreCommit',
					data: { commitId: restoreCommit.id },
				});
			}
		}, [restoreCommit, postMessage]);

		const handleUnrevert = useCallback(() => {
			// Backend resolves the active session — no need to send sessionId
			postMessage({ type: 'unrevert' });
		}, [postMessage]);

		// Show unrevert on the REVERT POINT section (the message the user clicked Restore on).
		// Show restore on any message that has a checkpoint and is NOT in a reverted state.
		const showUnrevert = isRevertPoint && unrevertAvailable;
		const showRestore = restoreCommit && !isRevertPoint;

		const [isSticky, setIsSticky] = useState(false);
		const containerRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			const el = containerRef.current;
			if (!el) return;

			const scrollParent = el.closest('.os-viewport') || window;

			const checkSticky = () => {
				const rect = el.getBoundingClientRect();
				let parentTop = 0;
				let hasOverlap = false;

				if (scrollParent instanceof Element) {
					parentTop = scrollParent.getBoundingClientRect().top;
					// If the scroll container is scrolled, the sticky element is overlapping content.
					hasOverlap = (scrollParent as HTMLElement).scrollTop > 0;
				} else {
					hasOverlap = window.scrollY > 0;
				}

				const isAtStickyTop = Math.abs(rect.top - parentTop) <= 2;
				setIsSticky(hasOverlap && isAtStickyTop);
			};

			scrollParent.addEventListener('scroll', checkSticky);
			// Also check on resize as layout might change
			window.addEventListener('resize', checkSticky);

			checkSticky(); // Initial check

			return () => {
				scrollParent.removeEventListener('scroll', checkSticky);
				window.removeEventListener('resize', checkSticky);
			};
		}, []);

		if (isEditing) {
			return (
				<div ref={editContainerRef} className="w-full mb-(--message-gap) px-0">
					<ChatInput
						value={editText}
						onChange={setEditText}
						onSend={handleSendUpdate}
						onCancel={handleCancel}
						autoFocus
						hideFilesPanel
						hideContextBar
						placeholder="Edit your message..."
						initialFiles={attachedFiles}
						initialCodeSnippets={attachedSnippets}
						initialImages={attachedImages}
						className="px-0"
					/>
				</div>
			);
		}

		return (
			<div className="w-full mb-(--message-gap) px-0" ref={containerRef}>
				<div
					className={cn(
						'flex flex-col relative w-full bg-(--input-bg) border border-(--input-border) rounded-(--input-radius) overflow-hidden transition-all duration-150 ease-out',
						isSticky ? 'shadow-[0_4px_12px_0px_rgba(0,0,0,0.15)]' : 'shadow-none',
					)}
				>
					{/* Restore/Unrevert buttons in top-right corner - mutually exclusive */}
					{(showRestore || showUnrevert) && (
						<div className="absolute top-1 right-1.5 flex items-center gap-1 z-10">
							{showUnrevert && <UnrevertButton onUnrevert={handleUnrevert} />}
							{showRestore && (
								<RestoreButton restoreCommit={restoreCommit} onRestore={handleRestore} />
							)}
						</div>
					)}
					<button
						type="button"
						onClick={() => !isProcessing && message.id && setEditingMessageId(message.id)}
						disabled={isProcessing}
						className={cn(
							'w-full bg-transparent border-none text-left font-(family-name:--vscode-font-family) text-vscode-foreground',
							'p-(--gap-3)_(--gap-6)_(--gap-1)_(--gap-6)',
							showRestore || showUnrevert ? 'pr-20' : '', // Add padding for buttons
							isProcessing ? 'cursor-default' : 'cursor-pointer',
						)}
					>
						{/* Message content with inline file badges at the beginning */}
						<div
							ref={contentRef}
							className={cn(
								'text-vscode-font-size leading-tight wrap-break-word overflow-anywhere whitespace-pre-wrap overflow-hidden line-clamp-3 px-(--gap-3) py-(--gap-1-5)',
							)}
						>
							{(attachedFiles.length > 0 ||
								attachedSnippets.length > 0 ||
								attachedImages.length > 0) && (
								<span className="inline-flex flex-wrap gap-(--gap-1-5) align-middle mr-1">
									{/* Images */}
									{attachedImages.map(img => (
										<PathChip
											key={img.id}
											path={img.path || img.name}
											label={img.name}
											title={img.name}
											backgroundColor="rgba(64, 165, 255, 0.15)"
										/>
									))}
									{/* Files */}
									{attachedFiles.map(filePath => (
										<PathChip
											key={filePath}
											path={filePath}
											onClick={() => {
												postMessage({ type: 'openFile', filePath });
											}}
											title={filePath}
										/>
									))}
									{/* Code snippets */}
									{attachedSnippets.map(snippet => (
										<PathChip
											key={`${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`}
											path={snippet.filePath}
											label={`${getShortFileName(snippet.filePath)} (${snippet.startLine}-${snippet.endLine})`}
											iconName={snippet.filePath}
											onClick={() => {
												postMessage({
													type: 'openFile',
													filePath: snippet.filePath,
													startLine: snippet.startLine,
													endLine: snippet.endLine,
												});
											}}
											title={`${snippet.filePath}:${snippet.startLine}-${snippet.endLine} (click to open)`}
											backgroundColor="rgba(156, 120, 255, 0.15)"
										/>
									))}
								</span>
							)}
							<MessageTextWithCommands
								text={messageText}
								validCommands={validCommands}
								validSubagents={validSubagents}
							/>
						</div>
					</button>
					<div className="flex items-center text-sm px-1.5 pb-0.5 bg-(--input-bg) pt-1">
						<MessageStats
							fileChanges={fileChangesStats}
							tokenCount={tokenStats}
							timestamp={message.timestamp}
							processingTime={processingTime}
							modelName={getModelDisplayName(message.model || selectedModel)}
						/>
					</div>
				</div>
			</div>
		);
	},
);

UserMessage.displayName = 'UserMessage';
