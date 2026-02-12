/**
 * @file NotificationOverlay - transient notification stack rendered above input area
 * @description Ephemeral overlay for error/interrupted/system notices.
 *              Notifications are not part of chat history and are dismissed independently.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import {
	useActiveSessionId,
	useIsAutoRetrying,
	useIsProcessing,
	useRetryInfo,
	useTransientNotifications,
	useUIActions,
} from '../../store';
import type { TransientNotification } from '../../store/uiStore';
import { useSessionMessage } from '../../utils/vscode';
import { AlertCircleIcon, CloseIcon, ImprovePromptIcon, PauseIcon, PlayIcon } from '../icons';
import { IconButton } from '../ui';

function splitTitleDetails(content: string): { title: string; details: string } {
	const trimmed = content.trim();
	if (!trimmed) return { title: 'Notification', details: '' };
	const lines = trimmed.split('\n');
	if (lines.length <= 1) return { title: trimmed, details: '' };
	return { title: lines[0] ?? 'Notification', details: lines.slice(1).join('\n').trim() };
}

function getNotificationUI(type: TransientNotification['type']): {
	icon: React.ReactNode;
	accentColor: string;
	resumeLabel: string;
	canResume: boolean;
} {
	switch (type) {
		case 'error':
			return {
				icon: <AlertCircleIcon size={15} />,
				accentColor: 'var(--color-error)',
				resumeLabel: 'Resume',
				canResume: true,
			};
		case 'interrupted':
			return {
				icon: <PauseIcon size={15} />,
				accentColor: 'var(--color-warning, #f0ad4e)',
				resumeLabel: 'Continue',
				canResume: true,
			};
		default:
			return {
				icon: <ImprovePromptIcon size={15} />,
				accentColor: 'var(--color-accent)',
				resumeLabel: 'OK',
				canResume: false,
			};
	}
}

const NotificationCard: React.FC<{
	notification: TransientNotification;
	canResumeGlobal: boolean;
	showRetryBadge: boolean;
	isAutoRetrying: boolean;
	retryInfo: { attempt: number; message: string; nextRetryAt?: string } | null;
	onResume: () => void;
	onDismiss: (id: string) => void;
}> = ({
	notification,
	canResumeGlobal,
	showRetryBadge,
	isAutoRetrying,
	retryInfo,
	onResume,
	onDismiss,
}) => {
	const { title, details } = useMemo(
		() => splitTitleDetails(notification.content),
		[notification.content],
	);
	const [expanded, setExpanded] = useState(false);
	const ui = useMemo(() => getNotificationUI(notification.type), [notification.type]);
	const hasDetails = Boolean(details);
	const canResume = canResumeGlobal && ui.canResume && !isAutoRetrying;

	return (
		<div className="mb-(--gap-1)">
			<div
				className={cn(
					'border rounded-lg overflow-hidden bg-(--tool-bg-header) relative pointer-events-auto',
				)}
				style={{
					borderColor: `color-mix(in srgb, ${ui.accentColor} 25%, transparent)`,
				}}
			>
				<div
					className="absolute left-0 top-0 bottom-0 w-[3px]"
					style={{ backgroundColor: ui.accentColor }}
				/>

				<div
					className={cn(
						'flex items-center justify-between w-full px-(--tool-header-padding) pl-3 py-1 bg-(--tool-bg-header) select-none',
						hasDetails && 'cursor-pointer hover:bg-vscode-toolbar-hoverBackground',
					)}
					onClick={hasDetails ? () => setExpanded(v => !v) : undefined}
					role={hasDetails ? 'button' : undefined}
					tabIndex={hasDetails ? 0 : undefined}
					onKeyDown={
						hasDetails
							? e => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										setExpanded(v => !v);
									}
								}
							: undefined
					}
				>
					<div className="flex items-center gap-2 min-w-0 flex-1">
						<span className="shrink-0" style={{ color: ui.accentColor }}>
							{ui.icon}
						</span>
						<span className="text-sm text-vscode-foreground font-(family-name:--vscode-font-family) truncate">
							{title}
						</span>
					</div>

					<div className="flex items-center gap-1 shrink-0 ml-2">
						{showRetryBadge && isAutoRetrying && retryInfo && (
							<span
								className="text-xs font-medium px-2 py-0.5 rounded"
								style={{
									backgroundColor:
										'color-mix(in srgb, var(--color-info, #3498db) 15%, transparent)',
									color: 'var(--color-info, #3498db)',
								}}
								title={retryInfo.nextRetryAt ? `Next retry at ${retryInfo.nextRetryAt}` : undefined}
							>
								Retrying… ({retryInfo.attempt})
							</span>
						)}

						{canResume && (
							<button
								type="button"
								onClick={e => {
									e.stopPropagation();
									onResume();
								}}
								className={cn(
									'flex items-center gap-1 px-2 h-(--btn-height) rounded text-xs font-medium',
									'border-none cursor-pointer hover:opacity-85',
								)}
								style={{
									backgroundColor: `color-mix(in srgb, ${ui.accentColor} 15%, transparent)`,
									color: ui.accentColor,
								}}
								title="Continue execution"
							>
								<PlayIcon size={10} />
								<span>{ui.resumeLabel}</span>
							</button>
						)}

						<IconButton
							icon={<CloseIcon size={14} />}
							onClick={e => {
								e.stopPropagation();
								onDismiss(notification.id);
							}}
							title="Dismiss"
							size={20}
							className="opacity-70 hover:opacity-100"
						/>
					</div>
				</div>

				{expanded && hasDetails && (
					<div
						className={cn(
							'px-3 py-2 border-t border-(--border-subtle)',
							'text-md leading-relaxed text-vscode-foreground/80',
							'font-mono whitespace-pre-wrap wrap-break-word',
							'max-h-(--content-max-height-lg) overflow-y-auto',
						)}
					>
						{details}
					</div>
				)}
			</div>
		</div>
	);
};

export const NotificationOverlay: React.FC = () => {
	const notifications = useTransientNotifications();
	const activeSessionId = useActiveSessionId();
	const isProcessing = useIsProcessing();
	const isAutoRetrying = useIsAutoRetrying();
	const retryInfo = useRetryInfo();
	const { dismissNotification, clearNotifications } = useUIActions();
	const { postSessionMessage } = useSessionMessage();

	const canResume = Boolean(activeSessionId) && !isProcessing;
	const previousSessionIdRef = useRef<string | undefined>(activeSessionId);

	const handleResume = useCallback(() => {
		if (!canResume) return;
		postSessionMessage({ type: 'sendMessage', text: 'Continue from where you left off.' });
		clearNotifications();
	}, [canResume, clearNotifications, postSessionMessage]);

	// Auto-dismiss transient notices when configured.
	useEffect(() => {
		const timers: number[] = [];
		for (const n of notifications) {
			if (!n.autoDismissMs || n.autoDismissMs <= 0) continue;
			timers.push(
				window.setTimeout(() => {
					dismissNotification(n.id);
				}, n.autoDismissMs),
			);
		}
		return () => {
			for (const t of timers) {
				window.clearTimeout(t);
			}
		};
	}, [notifications, dismissNotification]);

	// Overlay notifications are session-scoped and should reset on session switch.
	useEffect(() => {
		if (previousSessionIdRef.current !== activeSessionId) {
			clearNotifications();
			previousSessionIdRef.current = activeSessionId;
		}
	}, [activeSessionId, clearNotifications]);

	if (!notifications.length) {
		return null;
	}

	return (
		<div className="px-(--content-padding-x) pt-(--gap-2) pb-(--gap-1) pointer-events-none">
			<div className="flex flex-col-reverse gap-(--gap-1) items-stretch">
				{notifications.map((n, index) => {
					const level = notifications.length - index;
					return (
						<div
							key={n.id}
							style={{
								zIndex: 30 + level,
								opacity: index === 0 ? 1 : Math.max(0.65, 1 - index * 0.12),
								transform: `translateY(${index * -2}px)`,
							}}
						>
							<NotificationCard
								notification={n}
								canResumeGlobal={canResume}
								showRetryBadge={index === 0}
								isAutoRetrying={isAutoRetrying}
								retryInfo={retryInfo}
								onResume={handleResume}
								onDismiss={dismissNotification}
							/>
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default NotificationOverlay;
