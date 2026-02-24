/**
 * @file ChatInputNew — Refactored ChatInput orchestrator using CM6
 * @description Replaces the old textarea+backdrop overlay with CodeMirror 6.
 *              All sub-concerns are extracted into dedicated components and hooks.
 */

import { keymap } from '@codemirror/view';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatInputController } from '../../hooks/useChatInputController';
import { useDropdownTriggers } from '../../hooks/useDropdownTriggers';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { cn } from '../../lib/cn';
import { useFilePickerControls, useSettingsStore, useSlashCommandsState } from '../../store';
import { useVSCode } from '../../utils/vscode';
import {
	chatHighlighter,
	chatKeymap,
	dropHandler,
	pasteHandler,
	triggerDetector,
	validCommandsFacet,
	validSubagentsFacet,
} from '.';
import { AttachmentsBar } from './AttachmentsBar';
import { EditorCore, type EditorCoreRef } from './EditorCore';
import { ImagePreviewModal } from './ImagePreviewModal';
import { InputToolbar } from './InputToolbar';
import { SendButton } from './SendButton';

interface ChatInputProps {
	value?: string;
	onChange?: (value: string) => void;
	onSend?: (
		text: string,
		currentAttachments?: {
			files: string[];
			codeSnippets: Array<{
				filePath: string;
				startLine: number;
				endLine: number;
				content: string;
			}>;
			images: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
		},
	) => void;
	onCancel?: () => void;
	autoFocus?: boolean;
	className?: string;
	placeholder?: string;
	hideFilesPanel?: boolean;
	hideContextBar?: boolean;
	initialFiles?: string[];
	initialCodeSnippets?: Array<{
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>;
	initialImages?: Array<{
		id: string;
		name: string;
		dataUrl: string;
		path?: string;
	}>;
}

export const ChatInput: React.FC<ChatInputProps> = React.memo(
	({
		value: controlledValue,
		onChange: controlledOnChange,
		onSend: controlledOnSend,
		onCancel,
		autoFocus = false,
		className,
		placeholder = 'Type your message here...',
		initialFiles = [],
		initialCodeSnippets = [],
		initialImages = [],
	}) => {
		const { postMessage } = useVSCode();
		const editorRef = useRef<EditorCoreRef>(null);

		const {
			attachedFiles,
			attachedImages,
			codeSnippets,
			isDragOver,
			addFile,
			removeFile,
			removeImage,
			removeCodeSnippet,
			clearAll,
			handleDragOver,
			handleDragLeave,
			handleDrop,
			handlePaste,
		} = useFileAttachments({ initialFiles, initialCodeSnippets, initialImages });

		const controller = useChatInputController({
			controlledValue,
			controlledOnChange,
			controlledOnSend,
			attachments: {
				files: attachedFiles,
				images: attachedImages,
				codeSnippets,
				clearAll,
				addFile,
			},
		});

		const dropdowns = useDropdownTriggers();
		const { showSlashCommands, setShowSlashCommands, setSlashFilter } = useSlashCommandsState();
		const { showFilePicker, setShowFilePicker, setFileFilter } = useFilePickerControls();
		const [showModelDropdown, setShowModelDropdown] = useState(false);
		const [modelBtnAnchor, setModelBtnAnchor] = useState<HTMLElement | null>(null);
		const [previewImage, setPreviewImage] = useState<{ name: string; dataUrl: string } | null>(
			null,
		);

		const customCommands = useSettingsStore(s => s.commands.custom);
		const cliCommands = useSettingsStore(s => s.commands.cli);
		const subagents = useSettingsStore(s => s.subagents);

		const validCommands = useMemo(
			() =>
				new Set([
					...cliCommands.map(c => c.name.toLowerCase()),
					...customCommands.map(c => c.name.toLowerCase()),
				]),
			[cliCommands, customCommands],
		);
		const validSubagentNames = useMemo(
			() => new Set(subagents.items.map(a => a.name.toLowerCase())),
			[subagents.items],
		);

		useEffect(() => {
			return () => {
				if (controller.isControlled) {
					setShowSlashCommands(false);
					setShowFilePicker(false);
					setShowModelDropdown(false);
					setSlashFilter('');
					setFileFilter('');
				}
			};
		}, [
			controller.isControlled,
			setShowSlashCommands,
			setShowFilePicker,
			setSlashFilter,
			setFileFilter,
		]);

		const handleFileSelect = useCallback(
			(filePath: string) => {
				addFile(filePath);

				// Precise @filter removal via CM6 dispatch
				const view = editorRef.current?.view;
				const triggerPos = dropdowns.filePickerTriggerIndex;

				if (view && triggerPos !== null) {
					const currentPos = view.state.selection.main.head;
					view.dispatch({
						changes: { from: triggerPos, to: currentPos, insert: '' },
					});
					view.focus();
				} else {
					// Fallback: string-based removal
					const lastAt = controller.inputValue.lastIndexOf('@');
					if (lastAt >= 0) {
						controller.setInputValue(controller.inputValue.substring(0, lastAt).trim());
					}
				}

				setShowFilePicker(false);
				setFileFilter('');
			},
			[addFile, dropdowns.filePickerTriggerIndex, controller, setShowFilePicker, setFileFilter],
		);

		const handleOpenFile = useCallback(
			(filePath: string, startLine?: number, endLine?: number) => {
				postMessage({ type: 'openFile', filePath, startLine, endLine });
			},
			[postMessage],
		);

		const dropdownsOpen = showSlashCommands || showFilePicker;

		// Stable refs for CM6 callbacks — prevents cmExtensions from being
		// recreated on every keystroke, which would trigger compartment.reconfigure()
		// on every character input (massive perf hit).
		const handleSendRef = useRef(controller.handleSend);
		handleSendRef.current = controller.handleSend;
		const onCancelRef = useRef(onCancel);
		onCancelRef.current = onCancel;
		const dropdownsOpenRef = useRef(dropdownsOpen);
		dropdownsOpenRef.current = dropdownsOpen;
		const showSlashRef = useRef(showSlashCommands);
		showSlashRef.current = showSlashCommands;
		const showFilePickerRef = useRef(showFilePicker);
		showFilePickerRef.current = showFilePicker;
		const triggerCallbacksRef = useRef(dropdowns.triggerCallbacks);
		triggerCallbacksRef.current = dropdowns.triggerCallbacks;
		const handlePasteRef = useRef(handlePaste);
		handlePasteRef.current = handlePaste;

		// Stable wrappers that read from refs — identity never changes
		const stableOnSubmit = useCallback(() => {
			if (showSlashRef.current || showFilePickerRef.current) return false;
			handleSendRef.current();
			return true;
		}, []);
		const stableOnCancel = useCallback(() => {
			if (showSlashRef.current || showFilePickerRef.current) {
				setShowSlashCommands(false);
				setShowFilePicker(false);
				return true;
			}
			if (onCancelRef.current) {
				onCancelRef.current();
				return true;
			}
			return false;
		}, [setShowSlashCommands, setShowFilePicker]);
		const stableDropdownsOpen = useCallback(() => dropdownsOpenRef.current, []);
		const stableTriggerCallbacks = useRef<typeof dropdowns.triggerCallbacks>({
			onSlashTrigger: (...args) => triggerCallbacksRef.current.onSlashTrigger(...args),
			onSlashUpdate: (...args) => triggerCallbacksRef.current.onSlashUpdate(...args),
			onSlashClose: () => triggerCallbacksRef.current.onSlashClose(),
			onAtTrigger: (...args) => triggerCallbacksRef.current.onAtTrigger(...args),
			onAtUpdate: (...args) => triggerCallbacksRef.current.onAtUpdate(...args),
			onAtClose: () => triggerCallbacksRef.current.onAtClose(),
		});
		const stablePaste = useCallback((e: React.ClipboardEvent) => handlePasteRef.current(e), []);

		// CM6 extensions — created once, never recreated.
		// Only validCommands/validSubagentNames change when settings update (rare).
		const cmExtensions = useMemo(
			() => [
				chatHighlighter,
				dropHandler,
				keymap.of([
					{ key: 'ArrowUp', run: () => stableDropdownsOpen() },
					{ key: 'ArrowDown', run: () => stableDropdownsOpen() },
				]),
				chatKeymap({ onSubmit: stableOnSubmit, onCancel: stableOnCancel }),
				triggerDetector(stableTriggerCallbacks.current),
				pasteHandler(stablePaste),
				validCommandsFacet.of(validCommands),
				validSubagentsFacet.of(validSubagentNames),
			],
			[
				validCommands,
				validSubagentNames,
				stableOnSubmit,
				stableOnCancel,
				stableDropdownsOpen,
				stablePaste,
			],
		);

		const hasAttachments =
			attachedFiles.length > 0 || codeSnippets.length > 0 || attachedImages.length > 0;

		return (
			<div
				className={cn(
					'flex flex-col w-full px-(--layout-padding-x) pb-(--gap-3) items-center justify-center',
					className,
				)}
			>
				<div
					className={cn(
						'w-full bg-(--input-bg) border border-(--input-border) rounded-(--input-radius)',
						'flex flex-row transition-colors duration-150 relative group',
						isDragOver && 'bg-vscode-button-background/10 border-(--input-border-focus)',
					)}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onDrop={handleDrop}
				>
					<div className="flex-1 min-w-0 flex flex-col relative pb-(--gap-0-5)">
						{isDragOver && (
							<div className="absolute inset-0 bg-vscode-button-background/10 rounded-lg flex items-center justify-center z-10 pointer-events-none">
								<div className="text-vscode-textLink-foreground font-medium text-center text-xs leading-relaxed">
									<div>Drop files here</div>
									<div className="opacity-60 text-[10px]">
										Hold Shift when dragging from Explorer
									</div>
								</div>
							</div>
						)}

						{hasAttachments && (
							<AttachmentsBar
								images={attachedImages}
								files={attachedFiles}
								codeSnippets={codeSnippets}
								onRemoveImage={removeImage}
								onRemoveFile={removeFile}
								onRemoveSnippet={removeCodeSnippet}
								onPreviewImage={setPreviewImage}
								onOpenFile={handleOpenFile}
							/>
						)}

						{controller.promptVersions !== null && (
							<div className="flex items-center gap-2 px-(--gap-3) py-(--gap-1) text-xs text-vscode-descriptionForeground border-b border-(--vscode-widget-border) bg-(--alpha-3)">
								<span className="truncate flex-1 opacity-80">
									{controller.promptVersions.showingImproved ? 'Original' : 'Improved'}: {(() => {
										const alt = controller.promptVersions.showingImproved
											? controller.promptVersions.original
											: controller.promptVersions.improved;
										return alt.length > 80 ? `${alt.slice(0, 80)}…` : alt;
									})()}
								</span>
								<button
									type="button"
									className="shrink-0 px-1.5 py-0.5 rounded text-xs hover:bg-(--alpha-5) text-(--color-accent) cursor-pointer"
									onClick={controller.togglePromptVersion}
								>
									{controller.promptVersions.showingImproved ? 'Use original' : 'Use improved'}
								</button>
								<button
									type="button"
									aria-label="Clear version"
									className="shrink-0 px-1.5 py-0.5 rounded text-xs hover:bg-(--alpha-5) opacity-60 cursor-pointer"
									onClick={controller.clearPromptVersions}
								>
									&times;
								</button>
							</div>
						)}

						<EditorCore
							ref={editorRef}
							value={controller.inputValue}
							onChange={controller.setInputValue}
							placeholderText={placeholder}
							autoFocus={autoFocus}
							extensions={cmExtensions}
						/>

						<InputToolbar
							selectedAgent={controller.selectedAgent}
							onAgentChange={controller.setSelectedAgent}
							modelDisplayName={controller.modelDisplayName}
							isImproving={controller.isImproving}
							canImprove={!!controller.inputValue.trim()}
							onImprovePrompt={controller.handleImprovePrompt}
							showSlashCommands={showSlashCommands}
							slashCommandsAnchorRect={dropdowns.slashCommandsAnchorRect}
							slashButtonAnchorElement={dropdowns.slashButtonAnchorElement}
							onSlashToggle={dropdowns.openSlashFromButton}
							showFilePicker={showFilePicker}
							filePickerAnchorRect={dropdowns.filePickerAnchorRect}
							fileButtonAnchorElement={dropdowns.fileButtonAnchorElement}
							onFileToggle={dropdowns.openFilePickerFromButton}
							onFileSelect={handleFileSelect}
							showModelDropdown={showModelDropdown}
							modelButtonAnchorElement={modelBtnAnchor}
							onModelToggle={anchor => {
								setModelBtnAnchor(anchor);
								setShowModelDropdown(!showModelDropdown);
							}}
							onModelClose={() => setShowModelDropdown(false)}
						/>
					</div>

					<SendButton
						isProcessing={controller.isProcessing}
						hasContent={!!(controller.inputValue.trim() || attachedFiles.length > 0)}
						onSend={controller.handleSend}
						onStop={controller.handleStop}
					/>
				</div>

				{previewImage && (
					<ImagePreviewModal
						dataUrl={previewImage.dataUrl}
						name={previewImage.name}
						onClose={() => setPreviewImage(null)}
					/>
				)}
			</div>
		);
	},
);
ChatInput.displayName = 'ChatInput';
