/**
 * @file ErrorMessage - Chat error/interruption notification component
 * @description Premium error display component for chat messages with actionable controls.
 *              Features Resume button to continue model execution, dismiss functionality,
 *              copy error text, and collapsible details. Supports both error and interrupted
 *              message types with appropriate styling. Consistent with project's tool message
 *              styling while maintaining clear visual hierarchy.
 */

import type React from 'react';
import { useCallback, useState } from 'react';
import { cn } from '../../lib/cn';
import type { Message } from '../../store/chatStore';
import {
	AlertCircleIcon,
	CheckIcon,
	CloseIcon,
	CopyIcon,
	ExpandCollapseIcon,
	ImprovePromptIcon,
	PauseIcon,
	PlayIcon,
} from '../icons';
import { IconButton } from '../ui';

type ErrorOrInterruptedMessage =
	| Extract<Message, { type: 'error' }>
	| Extract<Message, { type: 'interrupted' }>;

type SystemNoticeMessage = Extract<Message, { type: 'system_notice' }>;

type ErrorLikeMessage = ErrorOrInterruptedMessage | SystemNoticeMessage;

interface ErrorMessageProps {
	message: ErrorLikeMessage;
	/** Callback to resume/retry the model execution */
	onResume?: () => void;
	/** Callback to dismiss/remove the error from chat */
	onDismiss?: (messageId: string) => void;
	/** Whether resume action is available (e.g., session is not processing) */
	canResume?: boolean;
	/** Whether SDK is auto-retrying (OpenCode) */
	isAutoRetrying?: boolean;
	/** Retry info when auto-retrying */
	retryInfo?: { attempt: number; message: string; nextRetryAt?: string } | null;
}

/**
 * Parse error content to extract title and details
 */
function parseErrorContent(content: string): {
	title: string;
	details?: string;
	isMultiline: boolean;
} {
	const lines = content.trim().split('\n');
	const isMultiline = lines.length > 1;

	if (isMultiline) {
		return {
			title: lines[0],
			details: lines.slice(1).join('\n').trim(),
			isMultiline: true,
		};
	}

	// Truncate long single-line errors for title
	const maxTitleLength = 120;
	if (content.length > maxTitleLength) {
		return {
			title: `${content.slice(0, maxTitleLength)}...`,
			details: content,
			isMultiline: false,
		};
	}

	return {
		title: content,
		isMultiline: false,
	};
}

export const ErrorMessage: React.FC<ErrorMessageProps> = ({
	message,
	onResume,
	onDismiss,
	canResume = true,
	isAutoRetrying = false,
	retryInfo = null,
}) => {
	const [expanded, setExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const isSystemNotice = message.type === 'system_notice';
	const isInterrupted = message.type === 'interrupted';
	const reason = isInterrupted ? (message as { reason?: string }).reason : undefined;

	// Get appropriate content and title based on type
	const content = (message as { content?: string }).content || 'An unknown error occurred';
	const parsed = parseErrorContent(content);
	const hasDetails = !!parsed.details;

	// Customize display based on message type
	const getDisplayInfo = () => {
		if (isSystemNotice) {
			return {
				icon: <ImprovePromptIcon size={15} />,
				title: parsed.title,
				accentColor: 'var(--color-accent)',
				gradientFrom: 'var(--color-accent)',
				gradientTo: 'color-mix(in srgb, var(--color-accent) 70%, black)',
				resumeLabel: 'Resume',
			};
		}

		if (!isInterrupted) {
			return {
				icon: <AlertCircleIcon size={15} />,
				title: parsed.title,
				accentColor: 'var(--color-error)',
				gradientFrom: 'var(--color-error)',
				gradientTo: 'color-mix(in srgb, var(--vscode-errorForeground) 80%, black)',
				resumeLabel: 'Resume',
			};
		}

		switch (reason) {
			case 'user_stopped':
				return {
					icon: <PauseIcon size={15} />,
					title: 'Stopped by user',
					accentColor: 'var(--color-warning, #f0ad4e)',
					gradientFrom: 'var(--color-warning, #f0ad4e)',
					gradientTo:
						'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 80%, black)',
					resumeLabel: 'Continue',
				};
			case 'cli_crash':
				return {
					icon: <AlertCircleIcon size={15} />,
					title: 'CLI process crashed unexpectedly',
					accentColor: 'var(--color-error)',
					gradientFrom: 'var(--color-error)',
					gradientTo: 'color-mix(in srgb, var(--vscode-errorForeground) 80%, black)',
					resumeLabel: 'Retry',
				};
			case 'connection_lost':
				return {
					icon: <AlertCircleIcon size={15} />,
					title: 'Connection lost',
					accentColor: 'var(--color-error)',
					gradientFrom: 'var(--color-error)',
					gradientTo: 'color-mix(in srgb, var(--vscode-errorForeground) 80%, black)',
					resumeLabel: 'Reconnect',
				};
			case 'timeout':
				return {
					icon: <AlertCircleIcon size={15} />,
					title: 'Request timed out',
					accentColor: 'var(--color-warning, #f0ad4e)',
					gradientFrom: 'var(--color-warning, #f0ad4e)',
					gradientTo:
						'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 80%, black)',
					resumeLabel: 'Retry',
				};
			default:
				return {
					icon: <PauseIcon size={15} />,
					title: parsed.title,
					accentColor: 'var(--color-warning, #f0ad4e)',
					gradientFrom: 'var(--color-warning, #f0ad4e)',
					gradientTo:
						'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 80%, black)',
					resumeLabel: 'Continue',
				};
		}
	};

	const displayInfo = getDisplayInfo();

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			try {
				await navigator.clipboard.writeText(content);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			} catch (err) {
				console.error('Failed to copy error:', err);
			}
		},
		[content],
	);

	const handleDismiss = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (message.id && onDismiss) {
				onDismiss(message.id);
			}
		},
		[message.id, onDismiss],
	);

	const handleResume = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onResume?.();
		},
		[onResume],
	);

	return (
		<div className="mb-(--message-gap)">
			<div
				className={cn(
					'border rounded-lg overflow-hidden transition-all duration-200',
					'bg-(--tool-bg-header) relative',
				)}
				style={{
					borderColor: `color-mix(in srgb, ${displayInfo.accentColor} 25%, transparent)`,
				}}
			>
				{/* Left accent bar */}
				<div
					className="absolute left-0 top-0 bottom-0 w-(--border-indicator)"
					style={{
						background: `linear-gradient(to bottom, ${displayInfo.gradientFrom}, ${displayInfo.gradientTo})`,
					}}
				/>
				{/* Header */}
				<div
					className={cn(
						'flex items-center justify-between w-full h-(--tool-header-height) px-(--tool-header-padding) pl-3',
						'bg-(--tool-bg-header) border-none text-inherit select-none',
						hasDetails && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
						'transition-colors',
					)}
					onClick={hasDetails ? () => setExpanded(!expanded) : undefined}
					onKeyDown={
						hasDetails
							? e => {
									if (e.key === 'Enter' || e.key === ' ') {
										setExpanded(!expanded);
									}
								}
							: undefined
					}
					role={hasDetails ? 'button' : undefined}
					tabIndex={hasDetails ? 0 : undefined}
				>
					{/* Left side: icon + title */}
					<div className="flex items-center gap-2 min-w-0 flex-1">
						<span
							className="flex items-center justify-center shrink-0"
							style={{ color: displayInfo.accentColor }}
						>
							{displayInfo.icon}
						</span>
						<span className="text-sm text-vscode-foreground font-(family-name:--vscode-font-family) truncate">
							{displayInfo.title}
						</span>
					</div>

					{/* Right side: actions */}
					<div className="flex items-center gap-0.5 shrink-0 ml-2">
						{/* Auto-retry indicator (OpenCode SDK) */}
						{isAutoRetrying && retryInfo && (
							<div
								className={cn(
									'flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium',
									'animate-pulse',
								)}
								style={{
									backgroundColor: `color-mix(in srgb, var(--color-info, #3498db) 15%, transparent)`,
									color: 'var(--color-info, #3498db)',
								}}
								title={retryInfo.nextRetryAt ? `Next retry at ${retryInfo.nextRetryAt}` : undefined}
							>
								<span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
								<span>Retrying... (attempt {retryInfo.attempt})</span>
							</div>
						)}

						{/* Resume button - hidden when auto-retrying */}
						{onResume && canResume && !isAutoRetrying && (
							<button
								type="button"
								onClick={handleResume}
								className={cn(
									'flex items-center justify-center flex-wrap gap-1 px-2 mx-1 h-(--btn-height) rounded text-xs font-medium',
									'hover:opacity-80 transition-colors',
									'border-none cursor-pointer align-middle',
								)}
								style={{
									backgroundColor: `color-mix(in srgb, ${displayInfo.accentColor} 15%, transparent)`,
									color: displayInfo.accentColor,
								}}
								title={`${displayInfo.resumeLabel} execution`}
							>
								<PlayIcon size={10} />
								<span>{displayInfo.resumeLabel}</span>
							</button>
						)}

						{/* Copy button */}
						<IconButton
							icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
							onClick={handleCopy}
							title={copied ? 'Copied!' : isSystemNotice ? 'Copy' : 'Copy error'}
							size={20}
							className="opacity-70 hover:opacity-100"
						/>

						{/* Dismiss button */}
						{onDismiss && (
							<IconButton
								icon={<CloseIcon size={14} />}
								onClick={handleDismiss}
								title={isSystemNotice ? 'Dismiss' : 'Dismiss error'}
								size={20}
								className="opacity-70 hover:opacity-100"
							/>
						)}

						{/* Expand/collapse for details */}
						{hasDetails && (
							<button
								type="button"
								className="flex items-center justify-center w-5 h-5 opacity-70 hover:opacity-100 shrink-0 bg-transparent border-none cursor-pointer p-0"
								onClick={e => {
									e.stopPropagation();
									setExpanded(!expanded);
								}}
								aria-label={expanded ? 'Collapse' : 'Expand'}
							>
								<ExpandCollapseIcon
									size={14}
									className={cn(
										'transition-transform duration-150 ease-out',
										expanded && 'rotate-180',
									)}
								/>
							</button>
						)}
					</div>
				</div>

				{/* Expanded details */}
				{expanded && hasDetails && (
					<div
						className={cn(
							'px-3 py-2 border-t border-(--border-subtle)',
							'text-md leading-relaxed text-vscode-foreground/80',
							'font-mono whitespace-pre-wrap wrap-break-word',
							'max-h-(--content-max-height-lg) overflow-y-auto',
						)}
					>
						{parsed.details}
					</div>
				)}
			</div>
		</div>
	);
};

export default ErrorMessage;
