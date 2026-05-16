/**
 * @file UI store - Zustand state management for transient UI state
 * @description Manages modals, dropdowns, file picker, slash commands, conversation list,
 * confirm dialogs and server connectivity. Persistent data (workspaceName, platformInfo,
 * sessionInfo, stats) has been moved to settingsStore/chatStore respectively.
 */

import { create } from 'zustand';
import type { ConversationIndexEntry, ExtensionMessage, WorkspaceFile } from '../../common';
import { generateId } from '../../common';

// Re-export types from chatStore for backward compatibility
export type { ChangedFile } from './chatStore';
export type { ConversationIndexEntry, WorkspaceFile };

export type ModalType = 'settings' | 'history' | 'access' | 'mcp' | null;

export interface ConfirmDialogData {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	/** Optional explicit secondary action. Closing the dialog does not trigger it. */
	onSecondary?: () => void;
	/** When true, Enter does not auto-confirm and the user must choose explicitly. */
	requireExplicitChoice?: boolean;
	onCancel?: () => void;
}

export interface UIActions {
	setActiveModal: (modal: ModalType) => void;
	setWorkspaceFiles: (files: WorkspaceFile[]) => void;
	setConversationList: (list: ConversationIndexEntry[]) => void;
	setServerUrl: (url: string | null, revision?: number) => void;
	setWorkspaceRoot: (workspaceRoot: string | null) => void;
	setServerStatus: (status: 'connected' | 'disconnected' | 'error') => void;
	setShowSlashCommands: (show: boolean) => void;
	setSlashFilter: (filter: string) => void;
	setShowFilePicker: (show: boolean) => void;
	setFileFilter: (filter: string) => void;
	setShowModelDropdown: (show: boolean) => void;
	setShowHistoryDropdown: (show: boolean) => void;
	showConfirmDialog: (data: ConfirmDialogData) => void;
	hideConfirmDialog: () => void;

	// Transient notifications (overlay)
	pushNotification: (notification: TransientNotificationInput) => void;
	dismissNotification: (id?: string) => void;
	clearNotifications: () => void;

	handleExtensionMessage: (message: ExtensionMessage) => void;
}

/**
 * Error severity levels inspired by OpenCode's error categorization:
 * - critical: ProviderAuthError, ContextOverflowError — unrecoverable, needs user action
 * - error: APIError, UnknownError — something went wrong, may be retryable
 * - warning: MessageOutputLengthError, transient issues
 * - info: system notices, non-error information
 */
export type NotificationSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface TransientNotification {
	id: string;
	type: 'error' | 'system_notice';
	content: string;
	reason?: string;
	errorCode?: string;
	sessionId?: string;
	severity: NotificationSeverity;
	timestamp: string;
	createdAt: number;
	/** How many times this same notification was received */
	count: number;
	/** Auto-dismiss after this many ms (undefined => no auto-dismiss) */
	autoDismissMs?: number;
}

type TransientNotificationInput = Omit<
	TransientNotification,
	'id' | 'createdAt' | 'severity' | 'count'
> & {
	id?: string;
	createdAt?: number;
	severity?: NotificationSeverity;
};

/**
 * Infer severity from notification type and content.
 * Based on OpenCode's error categorization:
 * - ProviderAuthError, ContextOverflow → critical
 * - APIError, spawn failures → error
 * - OutputLength, transient → warning
 * - system_notice → info
 */
function inferSeverity(type: TransientNotification['type'], content: string): NotificationSeverity {
	if (type === 'system_notice') return 'info';
	const lower = content.toLowerCase();
	// Critical: auth failures, context overflow, quota exhausted
	if (
		/\bauth\b/.test(lower) ||
		/\bapi[_ ]?key\b/.test(lower) ||
		/\bcontext[_ ]?(length[_ ]?exceeded|overflow)\b/.test(lower) ||
		/\b(quota|insufficient[_ ]?quota)\b/.test(lower) ||
		lower.includes('providerautherror') ||
		lower.includes('contextoverflowerror')
	) {
		return 'critical';
	}
	// Warning: output length, rate limits
	if (
		/\boutput[_ ]?length\b/.test(lower) ||
		/\brate[_ ]?limit\b/.test(lower) ||
		lower.includes('too many requests')
	) {
		return 'warning';
	}
	return 'error';
}

export interface UIState {
	activeModal: ModalType;
	workspaceFiles: WorkspaceFile[];
	conversationList: ConversationIndexEntry[];

	serverUrl: string | null;
	workspaceRoot: string | null;
	serverStatus: 'connected' | 'disconnected' | 'error';

	/** Connection details from the extension (populated on demand). */
	connectionDetails: {
		serverUrl: string | null;
		isServerOwner: boolean;
		uptime: number | null;
		port: number | null;
	} | null;

	showSlashCommands: boolean;
	slashFilter: string;
	showFilePicker: boolean;
	fileFilter: string;
	showModelDropdown: boolean;
	showHistoryDropdown: boolean;

	// Transient notifications (top overlay)
	notifications: TransientNotification[];

	// Confirm dialog
	confirmDialog: ConfirmDialogData | null;

	actions: UIActions;
}

export const useUIStore = create<UIState>((set, get) => ({
	activeModal: null,
	workspaceFiles: [],
	conversationList: [],

	serverUrl: null,
	workspaceRoot: null,
	serverStatus: 'disconnected',

	connectionDetails: null,

	showSlashCommands: false,
	slashFilter: '',
	showFilePicker: false,
	fileFilter: '',
	showModelDropdown: false,
	showHistoryDropdown: false,

	// Transient notifications
	notifications: [],

	// Confirm dialog
	confirmDialog: null,

	actions: {
		setActiveModal: activeModal => set({ activeModal }),
		setWorkspaceFiles: workspaceFiles => set({ workspaceFiles }),
		setConversationList: conversationList => set({ conversationList }),
		setServerUrl: serverUrl =>
			set(state => {
				const nextUrl = serverUrl && serverUrl.trim().length > 0 ? serverUrl : null;
				if (state.serverUrl === nextUrl) return state;
				return {
					serverUrl: nextUrl,
					connectionDetails: nextUrl === null ? null : state.connectionDetails,
				};
			}),
		setWorkspaceRoot: workspaceRoot =>
			set(state => (state.workspaceRoot === workspaceRoot ? state : { workspaceRoot })),
		setServerStatus: serverStatus =>
			set(state => (state.serverStatus === serverStatus ? state : { serverStatus })),
		setShowSlashCommands: showSlashCommands => set({ showSlashCommands }),
		setSlashFilter: slashFilter => set({ slashFilter }),
		setShowFilePicker: showFilePicker => set({ showFilePicker }),
		setFileFilter: fileFilter => set({ fileFilter }),
		setShowModelDropdown: showModelDropdown => set({ showModelDropdown }),
		setShowHistoryDropdown: showHistoryDropdown => set({ showHistoryDropdown }),

		showConfirmDialog: data => set({ confirmDialog: data }),
		hideConfirmDialog: () => set({ confirmDialog: null }),

		pushNotification: notification => {
			const id = notification.id || generateId('notif');
			const createdAt = notification.createdAt ?? Date.now();
			// Protocol-provided severity takes precedence over inference
			const severity =
				notification.severity ?? inferSeverity(notification.type, notification.content);
			set(state => {
				// Deduplicate within the same session/global scope only.
				const existingIdx = state.notifications.findIndex(
					n =>
						n.type === notification.type &&
						n.content === notification.content &&
						n.sessionId === notification.sessionId,
				);
				if (existingIdx !== -1) {
					const updated = [...state.notifications];
					updated[existingIdx] = {
						...updated[existingIdx],
						count: updated[existingIdx].count + 1,
						createdAt,
						timestamp: notification.timestamp,
						errorCode: notification.errorCode ?? updated[existingIdx].errorCode,
						sessionId: notification.sessionId ?? updated[existingIdx].sessionId,
					};
					return { notifications: updated };
				}

				return {
					notifications: [
						{
							id,
							type: notification.type,
							content: notification.content,
							reason: notification.reason,
							errorCode: notification.errorCode,
							sessionId: notification.sessionId,
							severity,
							timestamp: notification.timestamp,
							createdAt,
							count: 1,
							autoDismissMs: notification.autoDismissMs,
						},
						...state.notifications,
					],
				};
			});
		},

		dismissNotification: id =>
			set(state => {
				if (!id) return { notifications: state.notifications.slice(1) };
				return { notifications: state.notifications.filter(n => n.id !== id) };
			}),

		clearNotifications: () => set({ notifications: [] }),

		handleExtensionMessage: (message: ExtensionMessage) => {
			const { actions, activeModal, showHistoryDropdown } = get();

			switch (message.type) {
				case 'requestNewSession':
					window.dispatchEvent(new CustomEvent('primecode:new-session'));
					break;

				case 'openHistory':
					set({ showHistoryDropdown: !showHistoryDropdown });
					break;

				case 'openSettings':
					actions.setActiveModal(activeModal === 'settings' ? null : 'settings');
					break;

				case 'workspaceFiles':
					if (Array.isArray(message.data)) {
						actions.setWorkspaceFiles(message.data as WorkspaceFile[]);
					}
					break;

				case 'imagePath':
					if (message.data?.filePath) {
						const path = message.data.filePath;
						window.dispatchEvent(new CustomEvent('image-captured', { detail: path }));
					}
					break;

				case 'serverInfo':
					if (message.data) {
						const { url, workspaceRoot } = message.data as {
							url: string;
							workspaceRoot?: string;
						};
						actions.setServerUrl(url);
						if (typeof workspaceRoot === 'string') {
							actions.setWorkspaceRoot(workspaceRoot || null);
						}
					}
					break;

				case 'connectionDetails':
					set({ connectionDetails: message.data as UIState['connectionDetails'] });
					break;

				case 'showNotification': {
					const data = message.data as
						| {
								notification?: {
									type?: string;
									content?: string;
									severity?: string;
									errorCode?: string;
									sessionId?: string;
									timestamp?: string;
									reason?: string;
								};
						  }
						| undefined;
					const n = data?.notification;
					if (n?.content) {
						actions.pushNotification({
							type: (n.type === 'system_notice' ? 'system_notice' : 'error') as
								| 'error'
								| 'system_notice',
							content: n.content,
							severity: n.severity as NotificationSeverity | undefined,
							timestamp: n.timestamp ?? new Date().toISOString(),
							reason: n.reason,
							errorCode: n.errorCode,
							sessionId: n.sessionId,
						});
					}
					break;
				}

				default:
					break;
			}
		},
	},
}));

export const useUIActions = () => useUIStore(state => state.actions);
