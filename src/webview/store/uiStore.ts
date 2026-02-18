/**
 * @file UI store - Zustand state management for transient UI state
 * @description Manages modals, dropdowns, file picker, slash commands, conversation list,
 * confirm dialogs and server connectivity. Persistent data (workspaceName, platformInfo,
 * sessionInfo, stats) has been moved to settingsStore/chatStore respectively.
 */

import { create } from 'zustand';
import type {
	ConversationIndexEntry,
	ExtensionMessage,
	SessionEventMessage,
	SessionMessageData,
	WorkspaceFile,
} from '../../common';
import { generateId } from '../../common';

export type { ConversationIndexEntry, WorkspaceFile };

// Re-export types from chatStore for backward compatibility
export type { ChangedFile, CommitInfo, TotalStats } from './chatStore';

export type ModalType = 'settings' | 'history' | 'access' | 'mcp' | null;

export interface ConfirmDialogData {
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	onConfirm: () => void;
	onCancel?: () => void;
}

export interface UIActions {
	setActiveModal: (modal: ModalType) => void;
	setWorkspaceFiles: (files: WorkspaceFile[]) => void;
	setConversationList: (list: ConversationIndexEntry[]) => void;
	setServerUrl: (url: string | null) => void;
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

export interface TransientNotification {
	id: string;
	type: SessionMessageData['type'] & ('error' | 'interrupted' | 'system_notice');
	content: string;
	reason?: string;
	timestamp: string;
	createdAt: number;
	/** Auto-dismiss after this many ms (undefined => no auto-dismiss) */
	autoDismissMs?: number;
}

type TransientNotificationInput = Omit<TransientNotification, 'id' | 'createdAt'> & {
	id?: string;
	createdAt?: number;
};

export interface UIState {
	activeModal: ModalType;
	workspaceFiles: WorkspaceFile[];
	conversationList: ConversationIndexEntry[];

	serverUrl: string | null;
	serverStatus: 'connected' | 'disconnected' | 'error';

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
	serverStatus: 'disconnected',

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
		setServerUrl: serverUrl => set({ serverUrl }),
		setServerStatus: serverStatus => set({ serverStatus }),
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
			set(state => ({
				notifications: [
					{
						id,
						type: notification.type,
						content: notification.content,
						reason: notification.reason,
						timestamp: notification.timestamp,
						createdAt,
						autoDismissMs: notification.autoDismissMs,
					},
					...state.notifications,
				],
			}));
		},

		dismissNotification: id =>
			set(state => {
				if (!id) return { notifications: state.notifications.slice(1) };
				return { notifications: state.notifications.filter(n => n.id !== id) };
			}),

		clearNotifications: () => set({ notifications: [] }),

		handleExtensionMessage: (message: ExtensionMessage) => {
			const actions = get().actions;

			switch (message.type) {
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

				case 'conversationList':
					if (Array.isArray(message.data)) {
						actions.setConversationList(message.data);
					}
					break;

				case 'allConversationsCleared':
					actions.setConversationList([]);
					break;

				case 'serverInfo':
					if (message.data) {
						const { url } = message.data as { url: string };
						if (url) {
							actions.setServerUrl(url);
						}
					}
					break;

				case 'session_event': {
					const event = message as unknown as SessionEventMessage;
					if (event.type !== 'session_event') break;
					if (event.eventType !== 'message') break;
					const msg = (event.payload as { eventType?: unknown; message?: unknown }).message as
						| {
								type?: unknown;
								content?: unknown;
								reason?: unknown;
								timestamp?: unknown;
								id?: unknown;
						  }
						| undefined;
					if (!msg) break;
					const t = msg.type;
					if (t === 'error' || t === 'interrupted' || t === 'system_notice') {
						const content = typeof msg.content === 'string' ? msg.content : '';
						if (!content.trim()) break;
						actions.pushNotification({
							id: typeof msg.id === 'string' ? msg.id : undefined,
							type: t,
							content,
							reason: typeof msg.reason === 'string' ? msg.reason : undefined,
							timestamp:
								typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString(),
							autoDismissMs: t === 'system_notice' ? 6000 : undefined,
						});
					}
					break;
				}

				// Handle batched session events (history replay optimization)
				case 'session_event_batch' as ExtensionMessage['type']: {
					const batch = message as unknown as { messages: unknown[] };
					if (!Array.isArray(batch.messages)) break;
					for (const evt of batch.messages) {
						const event = evt as SessionEventMessage;
						if (event.eventType !== 'message') continue;
						const msg = (event.payload as { eventType?: unknown; message?: unknown }).message as
							| {
									type?: unknown;
									content?: unknown;
									reason?: unknown;
									timestamp?: unknown;
									id?: unknown;
							  }
							| undefined;
						if (!msg) continue;
						const t = msg.type;
						if (t === 'error' || t === 'interrupted' || t === 'system_notice') {
							const content = typeof msg.content === 'string' ? msg.content : '';
							if (!content.trim()) continue;
							actions.pushNotification({
								id: typeof msg.id === 'string' ? msg.id : undefined,
								type: t,
								content,
								reason: typeof msg.reason === 'string' ? msg.reason : undefined,
								timestamp:
									typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString(),
								autoDismissMs: t === 'system_notice' ? 6000 : undefined,
							});
						}
					}
					break;
				}
			}
		},
	},
}));

export const useUIActions = () => useUIStore(state => state.actions);
