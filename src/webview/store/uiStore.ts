/**
 * @file UI store - Zustand state management for UI state
 * @description Centralized state for modals, dropdowns, and other UI elements.
 * Session-specific data (changedFiles, restoreCommits, stats) has been moved to chatStore.
 */

import { create } from 'zustand';
import type { ConversationIndexEntry, PlatformInfo, SessionInfo, WorkspaceFile } from '../../types';

export type { ConversationIndexEntry, SessionInfo, WorkspaceFile };

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
	setFilePickerSearch: (search: string) => void;
	setWorkspaceFiles: (files: WorkspaceFile[]) => void;
	setConversationList: (list: ConversationIndexEntry[]) => void;
	setSessionInfo: (info: SessionInfo | null) => void;
	setWorkspaceName: (name: string) => void;
	setPlatformInfo: (info: PlatformInfo | null) => void;
	setShowSlashCommands: (show: boolean) => void;
	setSlashFilter: (filter: string) => void;
	setShowFilePicker: (show: boolean) => void;
	setFileFilter: (filter: string) => void;
	setShowModelDropdown: (show: boolean) => void;
	setShowHistoryDropdown: (show: boolean) => void;
	showConfirmDialog: (data: ConfirmDialogData) => void;
	hideConfirmDialog: () => void;
}

export interface UIState {
	activeModal: ModalType;
	filePickerSearch: string;
	workspaceFiles: WorkspaceFile[];
	conversationList: ConversationIndexEntry[];

	sessionInfo: SessionInfo | null;
	workspaceName: string;
	platformInfo: PlatformInfo | null;

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

export const useUIStore = create<UIState>(set => ({
	activeModal: null,
	filePickerSearch: '',
	workspaceFiles: [],
	conversationList: [],

	sessionInfo: null,
	workspaceName: '',
	platformInfo: null,

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
		setFilePickerSearch: filePickerSearch => set({ filePickerSearch }),
		setWorkspaceFiles: workspaceFiles => set({ workspaceFiles }),
		setConversationList: conversationList => set({ conversationList }),
		setSessionInfo: sessionInfo => set({ sessionInfo }),
		setWorkspaceName: workspaceName => set({ workspaceName }),
		setPlatformInfo: platformInfo => set({ platformInfo }),
		setShowSlashCommands: showSlashCommands => set({ showSlashCommands }),
		setSlashFilter: slashFilter => set({ slashFilter }),
		setShowFilePicker: showFilePicker => set({ showFilePicker }),
		setFileFilter: fileFilter => set({ fileFilter }),
		setShowModelDropdown: showModelDropdown => set({ showModelDropdown }),
		setShowHistoryDropdown: showHistoryDropdown => set({ showHistoryDropdown }),

		// Confirm dialog actions
		showConfirmDialog: data => set({ confirmDialog: data }),
		hideConfirmDialog: () => set({ confirmDialog: null }),
	},
}));

export const useUIActions = () => useUIStore(state => state.actions);
