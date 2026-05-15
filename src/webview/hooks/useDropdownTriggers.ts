/**
 * @file useDropdownTriggers — Per-input dropdown trigger state for ChatInput
 * @description Manages instance-local open/close state, filters, trigger indices, and
 *              anchor positioning for slash commands and file picker dropdowns triggered
 *              from a single CM6 editor. This prevents multiple ChatInput instances from
 *              reacting to the same transient trigger state while preserving shared data sources.
 */

import { useCallback, useRef, useState } from 'react';
import type { AnchorRectLike, TriggerCallbacks } from '../components/input';

interface DropdownTriggerState {
	// Slash commands
	showSlashCommands: boolean;
	slashFilter: string;
	setShowSlashCommands: (show: boolean) => void;
	setSlashFilter: (filter: string) => void;
	slashCommandsAnchorRect: AnchorRectLike | null;
	slashButtonAnchorElement: HTMLElement | null;
	setSlashButtonAnchorElement: (el: HTMLElement | null) => void;
	slashCommandTriggerIndex: number | null;
	// File picker
	showFilePicker: boolean;
	fileFilter: string;
	setShowFilePicker: (show: boolean) => void;
	setFileFilter: (filter: string) => void;
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
	const [showSlashCommands, setShowSlashCommands] = useState(false);
	const [slashFilter, setSlashFilter] = useState('');
	const [showFilePicker, setShowFilePicker] = useState(false);
	const [fileFilter, setFileFilter] = useState('');

	const [slashCommandsAnchorRect, setSlashCommandsAnchorRect] = useState<AnchorRectLike | null>(
		null,
	);
	const [slashButtonAnchorElement, setSlashButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);
	const slashCommandTriggerIndexRef = useRef<number | null>(null);
	const [filePickerAnchorRect, setFilePickerAnchorRect] = useState<AnchorRectLike | null>(null);
	const [fileButtonAnchorElement, setFileButtonAnchorElement] = useState<HTMLElement | null>(null);
	const filePickerTriggerIndexRef = useRef<number | null>(null);

	// CM6 trigger callbacks
	const onSlashTrigger = useCallback((pos: number, filter: string, rect: AnchorRectLike | null) => {
		slashCommandTriggerIndexRef.current = pos;
		setShowSlashCommands(true);
		setSlashFilter(filter);
		setSlashButtonAnchorElement(null);
		setSlashCommandsAnchorRect(rect);
	}, []);

	const onSlashUpdate = useCallback((filter: string) => {
		setSlashFilter(filter);
	}, []);

	const onSlashClose = useCallback(() => {
		if (showSlashCommands) {
			setShowSlashCommands(false);
			setSlashFilter('');
			setSlashCommandsAnchorRect(null);
			slashCommandTriggerIndexRef.current = null;
		}
	}, [showSlashCommands]);

	const onAtTrigger = useCallback((pos: number, filter: string, rect: AnchorRectLike | null) => {
		filePickerTriggerIndexRef.current = pos;
		setShowFilePicker(true);
		setFileFilter(filter);
		setFileButtonAnchorElement(null);
		setFilePickerAnchorRect(rect);
	}, []);

	const onAtUpdate = useCallback((filter: string) => {
		setFileFilter(filter);
	}, []);

	const onAtClose = useCallback(() => {
		if (showFilePicker) {
			setShowFilePicker(false);
			setFileFilter('');
			setFilePickerAnchorRect(null);
			filePickerTriggerIndexRef.current = null;
		}
	}, [showFilePicker]);

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
		[showSlashCommands],
	);

	const openFilePickerFromButton = useCallback(
		(anchor: HTMLElement) => {
			setFileButtonAnchorElement(anchor);
			setShowFilePicker(!showFilePicker);
			setFileFilter('');
		},
		[showFilePicker],
	);

	return {
		showSlashCommands,
		slashFilter,
		setShowSlashCommands,
		setSlashFilter,
		slashCommandsAnchorRect,
		slashButtonAnchorElement,
		setSlashButtonAnchorElement,
		slashCommandTriggerIndex: slashCommandTriggerIndexRef.current,
		showFilePicker,
		fileFilter,
		setShowFilePicker,
		setFileFilter,
		filePickerAnchorRect,
		fileButtonAnchorElement,
		setFileButtonAnchorElement,
		filePickerTriggerIndex: filePickerTriggerIndexRef.current,
		triggerCallbacks,
		openSlashFromButton,
		openFilePickerFromButton,
	};
}
