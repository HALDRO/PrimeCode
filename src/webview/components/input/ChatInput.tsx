/**
 * @file ChatInputNew — Refactored ChatInput orchestrator using CM6
 * @description Replaces the old textarea+backdrop overlay with CodeMirror 6.
 *              All sub-concerns are extracted into dedicated components and hooks.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	extractInlineAttachmentPayload,
	formatInlineFileReference,
} from '../../../common/inlineAttachments';
import { useChatInputController } from '../../hooks/useChatInputController';
import { useDropdownTriggers } from '../../hooks/useDropdownTriggers';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import {
	chatHighlighter,
	chatKeymap,
	dropHandler,
	inlineAttachmentBehavior,
	pasteHandler,
	triggerDetector,
	validCommandsFacet,
	validSkillsFacet,
	validSubagentsFacet,
} from '.';
import { AttachmentsBar } from './AttachmentsBar';
import { EditorCore, type EditorCoreRef } from './EditorCore';
import { FilePickerDropdown } from './FilePickerDropdown';
import { ImagePreviewModal } from './ImagePreviewModal';
import { InputToolbar } from './InputToolbar';
import { SendButton } from './SendButton';
import { SlashCommandsDropdown } from './SlashCommandsDropdown';

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
	/** When true, the send button is disabled but no stop button is shown. */
	sendDisabled?: boolean;
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
		placeholder = 'Plan, @ for context, / for commands',
		sendDisabled = false,
		initialImages = [],
	}) => {
		const { postMessage } = useVSCode();
		const editorRef = useRef<EditorCoreRef>(null);
		const inputBridgeRef = useRef<{
			inputValue: string;
			setInputValue: (value: string) => void;
		} | null>(null);
		const insertInlineReference = useCallback((filePath: string) => {
			const inlineReference = formatInlineFileReference(filePath, /[\\/]$/.test(filePath));
			if (!inlineReference) return;

			const view = editorRef.current?.view;
			if (view) {
				const selection = view.state.selection.main;
				const docLen = view.state.doc.length;

				// Ensure a single space before the reference if preceded by non-whitespace
				const prefix =
					selection.from > 0 &&
					!/\s/.test(view.state.doc.sliceString(selection.from - 1, selection.from))
						? ' '
						: '';

				// Always add a trailing space so the cursor lands in a clean position
				// for the next attachment or typed text. If there's already a space after,
				// skip the extra one to avoid double-spacing.
				const charAfter =
					selection.to < docLen ? view.state.doc.sliceString(selection.to, selection.to + 1) : '';
				const suffix = charAfter === ' ' ? '' : ' ';

				const insert = `${prefix}${inlineReference}${suffix}`;
				view.dispatch({
					changes: { from: selection.from, to: selection.to, insert },
					selection: { anchor: selection.from + insert.length },
				});
				view.focus();
				return;
			}

			const bridge = inputBridgeRef.current;
			if (!bridge) return;
			const trimmed = bridge.inputValue.trimEnd();
			bridge.setInputValue(`${trimmed}${trimmed ? ' ' : ''}${inlineReference} `);
		}, []);

		const {
			attachedImages,
			isDragOver,
			addFile,
			addImage,
			removeImage,
			clearAll,
			requestBrowseFiles,
			requestBrowseFolders,
			handleDragOver,
			handleDragLeave,
			handleDrop,
			handlePaste,
		} = useFileAttachments({
			initialImages,
			onAttachPath: insertInlineReference,
		});

		const attachments = useMemo(
			() => ({
				images: attachedImages,
				clearAll,
				addFile,
				addImage,
			}),
			[attachedImages, clearAll, addFile, addImage],
		);

		const controller = useChatInputController({
			controlledValue,
			controlledOnChange,
			controlledOnSend,
			attachments,
		});
		const dropdowns = useDropdownTriggers();

		useEffect(() => {
			inputBridgeRef.current = {
				inputValue: controller.inputValue,
				setInputValue: controller.setInputValue,
			};
		}, [controller.inputValue, controller.setInputValue]);

		const [showModelDropdown, setShowModelDropdown] = useState(false);
		const [modelBtnAnchor, setModelBtnAnchor] = useState<HTMLElement | null>(null);
		const [previewImage, setPreviewImage] = useState<{ name: string; dataUrl: string } | null>(
			null,
		);

		const agentResources = useSettingsStore(s => s.resources.agent.items);
		const commandResources = useSettingsStore(s => s.resources.command.items);
		const skillResources = useSettingsStore(s => s.resources.skill.items);

		const validCommands = useMemo(
			() =>
				new Set<string>([
					'compact',
					...commandResources.map(command => command.name.toLowerCase()),
				]),
			[commandResources],
		);
		const validSkillNames = useMemo(
			() => new Set(skillResources.map(skill => skill.name.toLowerCase())),
			[skillResources],
		);
		const validSubagentNames = useMemo(
			() =>
				new Set(
					agentResources
						.filter(
							agent =>
								!agent.disabled &&
								!agent.hidden &&
								(agent.mode === 'subagent' || agent.mode === 'all'),
						)
						.map(agent => agent.name.toLowerCase()),
				),
			[agentResources],
		);

		const setShowSlashCommands = dropdowns.setShowSlashCommands;
		const setShowFilePicker = dropdowns.setShowFilePicker;
		const setSlashFilter = dropdowns.setSlashFilter;
		const setFileFilter = dropdowns.setFileFilter;

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
				const inlineReference = formatInlineFileReference(filePath, /[\\/]$/.test(filePath));

				// Precise @filter removal via CM6 dispatch
				const view = editorRef.current?.view;
				const triggerPos = dropdowns.filePickerTriggerIndex;

				if (view && triggerPos !== null) {
					const currentPos = view.state.selection.main.head;
					const docLen = view.state.doc.length;
					// Add trailing space unless the character after the replaced range is already a space
					const charAfter =
						currentPos < docLen ? view.state.doc.sliceString(currentPos, currentPos + 1) : '';
					const insertText = charAfter === ' ' ? inlineReference : `${inlineReference} `;
					view.dispatch({
						changes: { from: triggerPos, to: currentPos, insert: insertText },
						selection: { anchor: triggerPos + insertText.length },
					});
					view.focus();
				} else {
					// Fallback: string-based removal
					const lastAt = controller.inputValue.lastIndexOf('@');
					if (lastAt >= 0) {
						const before = controller.inputValue.substring(0, lastAt).trimEnd();
						const nextValue = `${before}${before ? ' ' : ''}${inlineReference} `;
						controller.setInputValue(nextValue);
					}
				}

				dropdowns.setShowFilePicker(false);
				dropdowns.setFileFilter('');
			},
			[dropdowns, controller],
		);

		const handleOpenFile = useCallback(
			(filePath: string, startLine?: number, endLine?: number) => {
				postMessage({ type: 'openFile', filePath, startLine, endLine });
			},
			[postMessage],
		);

		const handleSlashCommandSelect = useCallback(
			(insertText: string) => {
				const view = editorRef.current?.view;
				const triggerPos = dropdowns.slashCommandTriggerIndex;
				if (view && triggerPos !== null) {
					const currentPos = view.state.selection.main.head;
					view.dispatch({
						changes: { from: triggerPos, to: currentPos, insert: insertText },
						selection: { anchor: triggerPos + insertText.length },
					});
					view.focus();
					return;
				}

				const lastSlash = controller.inputValue.lastIndexOf('/');
				if (lastSlash < 0) {
					controller.setInputValue(
						controller.inputValue.trim() ? `${controller.inputValue} ${insertText}` : insertText,
					);
					return;
				}
				const before = controller.inputValue.substring(0, lastSlash);
				controller.setInputValue(`${before}${insertText}`);
			},
			[controller, dropdowns.slashCommandTriggerIndex],
		);

		const dropdownsOpen = dropdowns.showSlashCommands || dropdowns.showFilePicker;

		// Stable refs for CM6 callbacks — prevents cmExtensions from being
		// recreated on every keystroke, which would trigger compartment.reconfigure()
		// on every character input (massive perf hit).
		const handleSendRef = useRef(controller.handleSend);
		handleSendRef.current = controller.handleSend;
		const sendDisabledRef = useRef(sendDisabled);
		sendDisabledRef.current = sendDisabled;
		const onCancelRef = useRef(onCancel);
		onCancelRef.current = onCancel;
		const setShowSlashCommandsRef = useRef(dropdowns.setShowSlashCommands);
		setShowSlashCommandsRef.current = dropdowns.setShowSlashCommands;
		const setShowFilePickerRef = useRef(dropdowns.setShowFilePicker);
		setShowFilePickerRef.current = dropdowns.setShowFilePicker;
		const dropdownsOpenRef = useRef(dropdownsOpen);
		dropdownsOpenRef.current = dropdownsOpen;
		const showSlashRef = useRef(dropdowns.showSlashCommands);
		showSlashRef.current = dropdowns.showSlashCommands;
		const showFilePickerRef = useRef(dropdowns.showFilePicker);
		showFilePickerRef.current = dropdowns.showFilePicker;
		const triggerCallbacksRef = useRef(dropdowns.triggerCallbacks);
		triggerCallbacksRef.current = dropdowns.triggerCallbacks;
		const handlePasteRef = useRef(handlePaste);
		handlePasteRef.current = handlePaste;

		// Stable wrappers that read from refs — identity never changes
		const stableOnSubmit = useCallback(() => {
			if (showSlashRef.current || showFilePickerRef.current) return true;
			if (sendDisabledRef.current) return true; // block send but consume the key
			handleSendRef.current();
			return true;
		}, []);
		const stableOnCancel = useCallback(() => {
			if (showSlashRef.current || showFilePickerRef.current) {
				setShowSlashCommandsRef.current(false);
				setShowFilePickerRef.current(false);
				return true;
			}
			if (onCancelRef.current) {
				onCancelRef.current();
				return true;
			}
			return false;
		}, []);
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
		// Only command/subagent/skill sets change when settings update (rare).
		const cmExtensions = useMemo(
			() => [
				history(),
				chatHighlighter,
				inlineAttachmentBehavior,
				dropHandler,
				Prec.high(chatKeymap({ onSubmit: stableOnSubmit, onCancel: stableOnCancel })),
				keymap.of([
					...defaultKeymap,
					...historyKeymap,
					{ key: 'ArrowUp', run: () => stableDropdownsOpen() },
					{ key: 'ArrowDown', run: () => stableDropdownsOpen() },
				]),
				triggerDetector(stableTriggerCallbacks.current),
				pasteHandler(stablePaste),
				validCommandsFacet.of(validCommands),
				validSkillsFacet.of(validSkillNames),
				validSubagentsFacet.of(validSubagentNames),
			],
			[
				validCommands,
				validSkillNames,
				validSubagentNames,
				stableOnSubmit,
				stableOnCancel,
				stableDropdownsOpen,
				stablePaste,
			],
		);

		const inlineAttachmentState = useMemo(
			() => extractInlineAttachmentPayload(controller.inputValue),
			[controller.inputValue],
		);
		const hasInlineAttachments =
			inlineAttachmentState.files.length > 0 || inlineAttachmentState.codeSnippets.length > 0;
		const hasToolbarAttachments = attachedImages.length > 0;

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

						{hasToolbarAttachments && (
							<AttachmentsBar
								images={attachedImages}
								files={[]}
								codeSnippets={[]}
								onRemoveImage={removeImage}
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
							showModelDropdown={showModelDropdown}
							modelButtonAnchorElement={modelBtnAnchor}
							onModelToggle={anchor => {
								setModelBtnAnchor(anchor);
								setShowModelDropdown(!showModelDropdown);
							}}
							onModelClose={() => setShowModelDropdown(false)}
							onBrowseFiles={requestBrowseFiles}
							onBrowseFolders={requestBrowseFolders}
						/>

						{/* Dropdowns triggered by typing @ or / in the editor */}
						{dropdowns.showSlashCommands && (
							<SlashCommandsDropdown
								slashFilter={dropdowns.slashFilter}
								setSlashFilter={dropdowns.setSlashFilter}
								onClose={() => {
									dropdowns.setShowSlashCommands(false);
									dropdowns.setSlashFilter('');
								}}
								anchorElement={dropdowns.slashButtonAnchorElement}
								anchorRect={
									!dropdowns.slashButtonAnchorElement
										? (dropdowns.slashCommandsAnchorRect ?? undefined)
										: undefined
								}
								onInsertCommand={handleSlashCommandSelect}
							/>
						)}
						{dropdowns.showFilePicker && (
							<FilePickerDropdown
								onSelectFile={handleFileSelect}
								fileFilter={dropdowns.fileFilter}
								setFileFilter={dropdowns.setFileFilter}
								onClose={() => {
									dropdowns.setShowFilePicker(false);
									dropdowns.setFileFilter('');
								}}
								anchorElement={dropdowns.fileButtonAnchorElement}
								anchorRect={
									!dropdowns.fileButtonAnchorElement
										? (dropdowns.filePickerAnchorRect ?? undefined)
										: undefined
								}
								showSearch
								searchAutoFocus
							/>
						)}
					</div>

					<SendButton
						isProcessing={sendDisabled ? false : controller.isProcessing}
						hasContent={
							!!(controller.inputValue.trim() || hasInlineAttachments || attachedImages.length > 0)
						}
						onSend={controller.handleSend}
						onStop={controller.handleStop}
						disabled={sendDisabled}
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
