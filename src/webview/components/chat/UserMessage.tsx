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
import { useShallow } from 'zustand/react/shallow';
import { CLI_COMMANDS, OPENCODE_COMMANDS } from '../../constants';
import { cn } from '../../lib/cn';
import { type CommitInfo, type Message, useChatActions, useChatStore } from '../../store/chatStore';
import {
	useActiveSessionId,
	useEditingMessageId,
	useIsProcessing,
	useRestoreCommits,
	useUnrevertAvailable,
} from '../../store/selectors';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIActions } from '../../store/uiStore';
import { formatDuration, formatTime, formatTokens, getShortFileName } from '../../utils/format';
import { STANDARD_MODELS } from '../../utils/models';
import { useSessionMessage, useVSCode } from '../../utils/vscode';
import { ClockIcon, TimerIcon, TokensIcon, Undo2Icon } from '../icons';
import { ChatInput } from '../input/ChatInput';
import { Badge, type StatItem, StatsDisplay, Tooltip } from '../ui';

interface UserMessageProps {
	message: Message & { type: 'user' };
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
				className="flex items-center justify-center w-5 h-5 rounded hover:bg-vscode-list-hoverBackground text-vscode-foreground opacity-70 hover:opacity-100 transition-all cursor-pointer"
			>
				<Undo2Icon size={14} />
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
const MessageTextWithCommands: React.FC<{ text: string; validCommands: Set<string> }> = React.memo(
	({ text, validCommands }) => {
		const components: React.ReactNode[] = [];
		const regex = /\/([a-zA-Z][a-zA-Z0-9_-]*)/g;
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
		while ((match = regex.exec(text)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			const command = match[0];
			const commandName = match[1].toLowerCase();

			// Text before command
			if (start > lastIndex) {
				components.push(<span key={`text-${lastIndex}`}>{text.substring(lastIndex, start)}</span>);
			}

			// Only highlight if command is valid
			if (validCommands.has(commandName)) {
				components.push(
					<span
						key={`cmd-${start}`}
						className="text-warning rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
						style={{
							backgroundColor:
								'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 15%, transparent)',
						}}
					>
						{command}
					</span>,
				);
			} else {
				// Not a valid command, render as plain text
				components.push(<span key={`text-${start}`}>{command}</span>);
			}

			lastIndex = end;
		}

		// Remaining text
		if (lastIndex < text.length) {
			components.push(<span key={`text-${lastIndex}`}>{text.substring(lastIndex)}</span>);
		}

		return <>{components}</>;
	},
);
MessageTextWithCommands.displayName = 'MessageTextWithCommands';

export const UserMessage: React.FC<UserMessageProps> = React.memo(({ message }) => {
	const { postMessage } = useVSCode();
	const { postSessionMessage } = useSessionMessage();

	// Use optimized selectors to prevent unnecessary re-renders
	const editingMessageId = useEditingMessageId();
	const restoreCommits = useRestoreCommits();
	const unrevertAvailable = useUnrevertAvailable();
	const activeSessionId = useActiveSessionId();

	const isProcessing = useIsProcessing();
	const chatActions = useChatActions();
	const { setEditingMessageId } = chatActions;
	const { selectedModel, opencodeProviders } = useSettingsStore();
	const provider = useSettingsStore(state => state.provider);
	const customCommands = useSettingsStore(state => state.commands.custom);

	// Build set of valid command names for highlighting
	const validCommands = useMemo(() => {
		const cliCommands = provider === 'opencode' ? OPENCODE_COMMANDS : CLI_COMMANDS;
		return new Set([
			...cliCommands.map(cmd => cmd.name.toLowerCase()),
			...customCommands.map(cmd => cmd.name.toLowerCase()),
		]);
	}, [provider, customCommands]);

	// Derived state selector - calculates all primitive stats in one go using stable values
	const stats = useChatStore(
		useShallow(state => {
			const { messages, changedFiles } = state;
			const msgIndex = messages.findIndex(m => m.id === message.id);

			// 1. Check if last user message
			let isLast = false;
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].type === 'user') {
					isLast = messages[i].id === message.id;
					break;
				}
			}

			if (msgIndex === -1) {
				return {
					isLastUserMessage: false,
					nextUserMessageTs: null as number | null,
					lastAssistantMessageTs: null as number | null,
					fileAddedCount: 0,
					fileRemovedCount: 0,
					filesChangedCount: 0,
					tokenCount: null as number | null,
					hasTokenCount: false,
				};
			}

			// 3. Stats timestamps
			// We DO NOT calculate duration/time strings here to avoid unstable returns or Date.now() dependency
			let nextUserTs: number | null = null;
			let lastAsstTs: number | null = null;

			// Check next user message for duration
			for (let i = msgIndex + 1; i < messages.length; i++) {
				if (messages[i].type === 'user') {
					nextUserTs = new Date(messages[i].timestamp).getTime();
					break;
				}
			}

			if (!nextUserTs) {
				// Find last assistant timestamp if no next user msg
				let lastMsgTimestamp = new Date(message.timestamp).getTime();
				for (let i = msgIndex + 1; i < messages.length; i++) {
					if (messages[i].type === 'user') {
						break;
					}
					const t = new Date(messages[i].timestamp).getTime();
					if (t > lastMsgTimestamp) {
						lastMsgTimestamp = t;
					}
				}
				if (lastMsgTimestamp > new Date(message.timestamp).getTime()) {
					lastAsstTs = lastMsgTimestamp;
				}
			}

			// 4. File Changes (Counts only)
			// Returning objects here ({added: 1, removed: 1}) causes ref instability if not careful.
			// Returning primitive counts is safer.
			let fAdded = 0;
			let fRemoved = 0;
			let fCount = 0;

			const toolUseIds: string[] = [];
			for (let i = msgIndex + 1; i < messages.length; i++) {
				if (messages[i].type === 'user') {
					break;
				}
				const msg = messages[i];
				if (msg.type === 'tool_use' && 'toolUseId' in msg) {
					toolUseIds.push(msg.toolUseId);
				}
			}

			if (toolUseIds.length > 0) {
				const filesChanged = new Set<string>();
				for (const file of changedFiles) {
					if (toolUseIds.includes(file.toolUseId)) {
						fAdded += file.linesAdded;
						fRemoved += file.linesRemoved;
						filesChanged.add(file.filePath);
					}
				}
				fCount = filesChanged.size;
			}

			// 5. Token Stats
			let tCount: number | null = null;
			let hasTCount = false;

			if ('tokenCount' in message && message.tokenCount) {
				tCount = message.tokenCount as number;
				hasTCount = true;
			} else {
				let totalTokens = 0;
				for (let i = msgIndex + 1; i < messages.length; i++) {
					if (messages[i].type === 'user') {
						break;
					}
					const msg = messages[i];
					if (msg.type === 'tool_result' && 'estimatedTokens' in msg && msg.estimatedTokens) {
						totalTokens += msg.estimatedTokens;
					}
					if (msg.type === 'assistant' && 'content' in msg && msg.content) {
						totalTokens += Math.ceil(msg.content.length / 4);
					}
				}
				if (totalTokens > 0) {
					tCount = totalTokens;
					hasTCount = true;
				}
			}

			return {
				isLastUserMessage: isLast,
				nextUserMessageTs: nextUserTs,
				lastAssistantMessageTs: lastAsstTs,
				fileAddedCount: fAdded,
				fileRemovedCount: fRemoved,
				filesChangedCount: fCount,
				tokenCount: tCount,
				hasTokenCount: hasTCount,
			};
		}),
	);

	// Reconstruct complex objects in component to maintain stability
	const fileChangesStats = useMemo(() => {
		if (stats.filesChangedCount === 0) {
			return null;
		}
		return {
			added: stats.fileAddedCount,
			removed: stats.fileRemovedCount,
			files: stats.filesChangedCount,
		};
	}, [stats.fileAddedCount, stats.fileRemovedCount, stats.filesChangedCount]);

	const tokenStats = stats.hasTokenCount ? stats.tokenCount : null;
	const isLastUserMessage = stats.isLastUserMessage;

	// Calculate processing time locally
	const processingTime = useMemo(() => {
		const messageTimestamp = new Date(message.timestamp).getTime();

		if (stats.nextUserMessageTs) {
			return formatDuration(stats.nextUserMessageTs - messageTimestamp);
		}

		if (stats.lastAssistantMessageTs) {
			return formatDuration(stats.lastAssistantMessageTs - messageTimestamp);
		}

		if (isProcessing && isLastUserMessage) {
			// This will be updated by the forceUpdate interval
			return formatDuration(Date.now() - messageTimestamp);
		}

		return null;
	}, [
		stats.nextUserMessageTs,
		stats.lastAssistantMessageTs,
		isProcessing,
		isLastUserMessage,
		message.timestamp,
		// forceUpdate is triggered externally by interval, ensuring re-render for live timer
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

			// For standard Claude models
			const standardModel = STANDARD_MODELS.find(m => m.id === modelId);
			if (standardModel) {
				return standardModel.name;
			}

			return modelId;
		},
		[opencodeProviders],
	);

	const restoreCommit = useMemo(() => {
		// Prefer OpenCode checkpoints when present (they support native revert + workspace restore metadata).
		const byMessage = restoreCommits.filter(c => c.associatedMessageId === message.id);
		return byMessage.find(c => c.isOpenCodeCheckpoint) || byMessage[0];
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
				// Use the same logic as handleRestore to properly distinguish OpenCode vs git checkpoints
				if (restoreCommit.isOpenCodeCheckpoint && restoreCommit.sessionId) {
					postMessage('restoreCommit', {
						data: {
							messageId: restoreCommit.sha,
							sessionId: restoreCommit.sessionId,
							cliSessionId: restoreCommit.cliSessionId,
							associatedMessageId: restoreCommit.associatedMessageId,
						},
					});
				} else {
					postMessage('restoreCommit', { data: restoreCommit.sha });
				}
			}
			// When editing and sending, delete messages immediately (not just mark as reverted)
			if (message.id) {
				chatActions.deleteMessagesFromId(message.id);
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

			postSessionMessage('sendMessage', {
				text,
				planMode: false,
				attachments: hasAttachments ? editAttachments : undefined,
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
			// OpenCode checkpoints carry session metadata; git commits do not.
			if (restoreCommit.isOpenCodeCheckpoint && restoreCommit.sessionId) {
				// For OpenCode: use native SDK revert with messageId
				// sessionId is UI session ID for SessionManager lookup
				// cliSessionId is CLI session ID for SDK revert (passed as part of data)
				// associatedMessageId is the user message ID that triggered this checkpoint
				// SDK reverts files, UI keeps user message for inline editing
				postMessage('restoreCommit', {
					data: {
						messageId: restoreCommit.sha, // sha contains messageId for OpenCode
						sessionId: restoreCommit.sessionId, // UI session ID
						cliSessionId: restoreCommit.cliSessionId, // CLI session ID for SDK
						associatedMessageId: restoreCommit.associatedMessageId, // User message ID
					},
				});
			} else {
				// For Claude CLI: use git-based restore with commitSha
				postMessage('restoreCommit', { data: restoreCommit.sha });
			}

			// Clear revertedFromMessageId - we're doing a full restore, not marking for later
			chatActions.markRevertedFromMessageId(null);
		}
	}, [restoreCommit, postMessage, chatActions]);

	const handleUnrevert = useCallback(() => {
		// Get cliSessionId from the last OpenCode checkpoint if available
		const lastOpenCodeCheckpoint = restoreCommits.find(c => c.isOpenCodeCheckpoint);
		postMessage('unrevert', {
			data: {
				sessionId: activeSessionId,
				cliSessionId: lastOpenCodeCheckpoint?.cliSessionId,
			},
		});
	}, [postMessage, activeSessionId, restoreCommits]);

	// Show unrevert button only on the last user message when unrevert is available
	// BUT don't show both restore and unrevert at the same time - unrevert takes priority
	const showUnrevert = isLastUserMessage && unrevertAvailable;
	// Show restore only if unrevert is not available (they are mutually exclusive)
	const showRestore = restoreCommit && !showUnrevert;

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
		<div className="w-full mb-(--message-gap) px-0">
			<div className="flex flex-col relative w-full bg-(--input-bg) border border-(--input-border) shadow-[0_2px_12px_rgba(0,0,0,0.4)] rounded-(--input-radius) overflow-hidden transition-all duration-150 ease-out">
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
						className="text-vscode-font-size leading-tight wrap-break-word overflow-anywhere whitespace-pre-wrap overflow-hidden line-clamp-3 px-(--gap-3) py-(--gap-1-5)"
					>
						{(attachedFiles.length > 0 ||
							attachedSnippets.length > 0 ||
							attachedImages.length > 0) && (
							<span className="inline-flex flex-wrap gap-(--gap-1-5) align-middle mr-1">
								{/* Images */}
								{attachedImages.map(img => (
									<Badge
										key={img.id}
										label={img.name}
										iconName={img.name}
										title={img.name}
										backgroundColor="rgba(64, 165, 255, 0.15)"
									/>
								))}
								{/* Files */}
								{attachedFiles.map(filePath => (
									<Badge
										key={filePath}
										label={getShortFileName(filePath)}
										iconName={getShortFileName(filePath)}
										onClick={() => {
											postMessage('openFile', { filePath });
										}}
										title={filePath}
									/>
								))}
								{/* Code snippets */}
								{attachedSnippets.map(snippet => (
									<Badge
										key={`${snippet.filePath}:${snippet.startLine}-${snippet.endLine}`}
										label={`${getShortFileName(snippet.filePath)} (${snippet.startLine}-${snippet.endLine})`}
										iconName={getShortFileName(snippet.filePath)}
										onClick={() => {
											postMessage('openFile', {
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
						<MessageTextWithCommands text={messageText} validCommands={validCommands} />
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
});

UserMessage.displayName = 'UserMessage';
