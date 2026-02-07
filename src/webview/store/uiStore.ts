/**
 * @file UI store - Zustand state management for transient UI state
 * @description Manages modals, dropdowns, file picker, slash commands, conversation list,
 * confirm dialogs and server connectivity. Persistent data (workspaceName, platformInfo,
 * sessionInfo, stats) has been moved to settingsStore/chatStore respectively.
 */

import { create } from 'zustand';
import type { ConversationIndexEntry, ExtensionMessage, WorkspaceFile } from '../../common';

export type { ConversationIndexEntry, WorkspaceFile };

// Re-export types from chatStore for backward compatibility
export type { ChangedFile, CommitInfo, TokenStats, TotalStats } from './chatStore';

export type ModalType = 'settings' | 'history' | 'access' | 'filePicker' | 'mcp' | null;

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
	handleExtensionMessage: (message: ExtensionMessage) => void;
}

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
			}
		},
	},
}));

export const useUIActions = () => useUIStore(state => state.actions);
