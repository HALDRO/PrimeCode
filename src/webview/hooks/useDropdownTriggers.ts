/**
 * @file useDropdownTriggers — Dropdown state management for slash commands and file picker
 * @description Manages open/close state, anchor positioning, and filter text for
 *              slash commands and file picker dropdowns triggered from CM6 editor.
 */

import { useCallback, useRef, useState } from 'react';
import type { AnchorRectLike, TriggerCallbacks } from '../components/input';
import { useFilePickerControls, useSlashCommandsState } from '../store';

interface DropdownTriggerState {
	// Slash commands
	slashCommandsAnchorRect: AnchorRectLike | null;
	slashButtonAnchorElement: HTMLElement | null;
	setSlashButtonAnchorElement: (el: HTMLElement | null) => void;
	// File picker
	filePickerAnchorRect: AnchorRectLike | null;
	fileButtonAnchorElement: HTMLElement | null;
	setFileButtonAnchorElement: (el: HTMLElement | null) => void;
	filePickerTriggerIndex: number | null;
	// Trigger callbacks for CM6 extension
	triggerCallbacks: TriggerCallbacks;
	// Actions
	openSlashFromButton: (anchor: HTMLElement) => void;
	openFilePickerFromButton: (anchor: HTMLElement) => void;
}

export function useDropdownTriggers(): DropdownTriggerState {
	const { showSlashCommands, setShowSlashCommands, setSlashFilter } = useSlashCommandsState();
	const { showFilePicker, setShowFilePicker, setFileFilter } = useFilePickerControls();

	const [slashCommandsAnchorRect, setSlashCommandsAnchorRect] = useState<AnchorRectLike | null>(
		null,
	);
	const [slashButtonAnchorElement, setSlashButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);
	const [filePickerAnchorRect, setFilePickerAnchorRect] = useState<AnchorRectLike | null>(null);
	const [fileButtonAnchorElement, setFileButtonAnchorElement] = useState<HTMLElement | null>(null);
	const filePickerTriggerIndexRef = useRef<number | null>(null);

	// CM6 trigger callbacks
	const onSlashTrigger = useCallback(
		(_pos: number, filter: string, rect: AnchorRectLike | null) => {
			setShowSlashCommands(true);
			setSlashFilter(filter);
			setSlashButtonAnchorElement(null);
			setSlashCommandsAnchorRect(rect);
		},
		[setShowSlashCommands, setSlashFilter],
	);

	const onSlashUpdate = useCallback(
		(filter: string) => {
			setSlashFilter(filter);
		},
		[setSlashFilter],
	);

	const onSlashClose = useCallback(() => {
		if (showSlashCommands) {
			setShowSlashCommands(false);
			setSlashFilter('');
			setSlashCommandsAnchorRect(null);
		}
	}, [showSlashCommands, setShowSlashCommands, setSlashFilter]);

	const onAtTrigger = useCallback(
		(pos: number, filter: string, rect: AnchorRectLike | null) => {
			filePickerTriggerIndexRef.current = pos;
			setShowFilePicker(true);
			setFileFilter(filter);
			setFileButtonAnchorElement(null);
			setFilePickerAnchorRect(rect);
		},
		[setShowFilePicker, setFileFilter],
	);

	const onAtUpdate = useCallback(
		(filter: string) => {
			setFileFilter(filter);
		},
		[setFileFilter],
	);

	const onAtClose = useCallback(() => {
		if (showFilePicker) {
			setShowFilePicker(false);
			setFileFilter('');
			setFilePickerAnchorRect(null);
			filePickerTriggerIndexRef.current = null;
		}
	}, [showFilePicker, setShowFilePicker, setFileFilter]);

	const triggerCallbacks: TriggerCallbacks = {
		onSlashTrigger,
		onSlashUpdate,
		onSlashClose,
		onAtTrigger,
		onAtUpdate,
		onAtClose,
	};

	const openSlashFromButton = useCallback(
		(anchor: HTMLElement) => {
			setSlashButtonAnchorElement(anchor);
			setShowSlashCommands(!showSlashCommands);
			setSlashFilter('');
		},
		[showSlashCommands, setShowSlashCommands, setSlashFilter],
	);

	const openFilePickerFromButton = useCallback(
		(anchor: HTMLElement) => {
			setFileButtonAnchorElement(anchor);
			setShowFilePicker(!showFilePicker);
			setFileFilter('');
		},
		[showFilePicker, setShowFilePicker, setFileFilter],
	);

	return {
		slashCommandsAnchorRect,
		slashButtonAnchorElement,
		setSlashButtonAnchorElement,
		filePickerAnchorRect,
		fileButtonAnchorElement,
		setFileButtonAnchorElement,
		filePickerTriggerIndex: filePickerTriggerIndexRef.current,
		triggerCallbacks,
		openSlashFromButton,
		openFilePickerFromButton,
	};
}
