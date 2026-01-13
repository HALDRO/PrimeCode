/**
 * @file ChatInput - Unified message composer component
 * @description A single, highly configurable component for both main chat input and message editing.
 *              Supports attachments, slash commands, file picking, model selection, and plan mode.
 *              Can be used in "controlled" mode (for editing) or "store" mode (for main chat).
 */

import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CLI_COMMANDS, OPENCODE_COMMANDS } from '../../constants';
import { useFileAttachments } from '../../hooks/useFileAttachments';
import { cn } from '../../lib/cn';
import {
	useChatActions,
	useChatInputState,
	useFilePickerState,
	useImprovingPromptRequestId,
	useIsImprovingPrompt,
	useIsProcessing,
	useModelSelection,
	useSettingsStore,
	useSlashCommandsState,
} from '../../store';
import { getShortFileName } from '../../utils/format';
import { STANDARD_MODELS } from '../../utils/models';
import { useSessionMessage, useVSCode } from '../../utils/vscode';
import {
	AgentsIcon,
	AtSignIcon,
	ChevronIcon,
	ImageIcon,
	ImprovePromptIcon,
	LoaderIcon,
	PlanIcon,
	TerminalIcon,
} from '../icons';
import { type AnchorRectLike, Badge, Button, IconButton, TextArea } from '../ui';
import { FilePickerDropdown } from './FilePickerDropdown';
import { ModelDropdown } from './ModelDropdown';
import { SendButton } from './SendButton';
import { SlashCommandsDropdown } from './SlashCommandsDropdown';

/**
 * Computes anchor rect for dropdown positioning at a specific character index.
 */
function getTextareaCaretAnchorRectAtIndex(
	textarea: HTMLTextAreaElement,
	charIndex?: number,
): AnchorRectLike {
	const value = textarea.value ?? '';
	const targetIndex = charIndex ?? textarea.selectionStart ?? value.length;
	const textareaRect = textarea.getBoundingClientRect();
	const computed = window.getComputedStyle(textarea);

	const mirror = document.createElement('div');
	mirror.style.position = 'fixed';
	mirror.style.left = `${textareaRect.left}px`;
	mirror.style.top = `${textareaRect.top}px`;
	mirror.style.width = `${textareaRect.width}px`;
	mirror.style.height = `${textareaRect.height}px`;
	mirror.style.visibility = 'hidden';
	mirror.style.pointerEvents = 'none';
	mirror.style.overflow = 'auto';
	mirror.style.whiteSpace = 'pre-wrap';
	mirror.style.wordWrap = 'break-word';
	mirror.style.overflowWrap = 'break-word';

	mirror.style.fontFamily = computed.fontFamily;
	mirror.style.fontSize = computed.fontSize;
	mirror.style.fontWeight = computed.fontWeight;
	mirror.style.fontStyle = computed.fontStyle;
	mirror.style.letterSpacing = computed.letterSpacing;
	mirror.style.textTransform = computed.textTransform;
	mirror.style.lineHeight = computed.lineHeight;
	mirror.style.textAlign = computed.textAlign;
	mirror.style.direction = computed.direction;
	mirror.style.tabSize = computed.tabSize;

	mirror.style.boxSizing = computed.boxSizing;
	mirror.style.padding = computed.padding;
	mirror.style.border = computed.border;

	mirror.textContent = value.slice(0, targetIndex);
	const marker = document.createElement('span');
	marker.textContent = value.slice(targetIndex) || '\u200b';
	mirror.appendChild(marker);

	document.body.appendChild(mirror);
	mirror.scrollTop = textarea.scrollTop;
	mirror.scrollLeft = textarea.scrollLeft;

	const markerRect = marker.getBoundingClientRect();
	document.body.removeChild(mirror);

	const lineHeight = Number.parseFloat(computed.lineHeight || '') || 18;
	const height = Math.max(1, markerRect.height || lineHeight);
	const left = markerRect.left;
	const top = markerRect.top;

	return {
		left,
		right: left + 1,
		top,
		bottom: top + height,
		width: 1,
		height,
	};
}

interface ChatInputProps {
	/** If provided, use this value instead of the global chat store's input */
	value?: string;
	/** Callback for value changes in controlled mode */
	onChange?: (value: string) => void;
	/** Custom send handler. If not provided, uses the default store-based send. */
	onSend?: (text: string) => void;
	/** Custom cancel handler. Usually used for exiting edit mode. */
	onCancel?: () => void;
	/** Whether the input should automatically focus on mount */
	autoFocus?: boolean;
	/** Additional class names for the container */
	className?: string;
	/** Placeholder text */
	placeholder?: string;
	/** Whether to hide the changed files panel (usually hidden in edit mode) */
	hideFilesPanel?: boolean;
	/** Whether to hide the context bar */
	hideContextBar?: boolean;
	/** Initial attached files (for edit mode) */
	initialFiles?: string[];
	/** Initial code snippets (for edit mode) */
	initialCodeSnippets?: Array<{
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>;
	/** Initial images (for edit mode) */
	initialImages?: Array<{
		id: string;
		name: string;
		dataUrl: string;
		path?: string;
	}>;
}

/**
 * Fullscreen image preview modal with click-outside and close button support.
 * Opens on click, closes on backdrop click or close button.
 */
const ImagePreviewModal: React.FC<{
	dataUrl: string;
	name: string;
	onClose: () => void;
}> = ({ dataUrl, name, onClose }) => {
	const contentRef = useRef<HTMLDivElement>(null);

	// Close on Escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	// Close on click outside content
	const handleBackdropClick = useCallback(
		(e: React.MouseEvent) => {
			if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
				onClose();
			}
		},
		[onClose],
	);

	return (
		<div
			className="fixed inset-0 z-9999 flex items-center justify-center bg-black/(--image-preview-backdrop) animate-fade-in cursor-pointer"
			onClick={handleBackdropClick}
		>
			<div
				ref={contentRef}
				className="relative max-w-(--image-preview-max-vw) max-h-(--image-preview-max-vh) cursor-default animate-preview-in-modal"
			>
				{/* Close button */}
				<button
					type="button"
					onClick={onClose}
					className="absolute -top-(--image-preview-close-offset) -right-(--image-preview-close-offset) z-10 w-(--image-preview-close-size) h-(--image-preview-close-size) flex items-center justify-center rounded-full bg-(--alpha-10) text-vscode-foreground hover:bg-(--alpha-20) hover:text-vscode-foreground transition-colors duration-150 cursor-pointer"
					title="Close"
				>
					<span className="text-sm leading-none">×</span>
				</button>

				{/* Image */}
				<img
					src={dataUrl}
					alt={name}
					className="max-w-(--image-preview-max-vw) max-h-(--image-preview-max-vh) object-contain"
				/>
			</div>
		</div>
	);
};
ImagePreviewModal.displayName = 'ImagePreviewModal';

export const ChatInput: React.FC<ChatInputProps> = ({
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
	const { postSessionMessage } = useSessionMessage();

	// Store-based state
	const { input: storeInput } = useChatInputState();
	const { setInput: setStoreInput, clearRevertedMessages, setImprovingPrompt } = useChatActions();
	const isProcessing = useIsProcessing();
	const { selectedModel, proxyModels, opencodeProviders } = useModelSelection();
	const promptImproveTimeoutSeconds = useSettingsStore(state => state.promptImproveTimeoutSeconds);
	const provider = useSettingsStore(state => state.provider);
	const customCommands = useSettingsStore(state => state.commands.custom);
	const { showSlashCommands, setShowSlashCommands, setSlashFilter } = useSlashCommandsState();
	const { showFilePicker, setShowFilePicker, setFileFilter } = useFilePickerState();
	const [showModelDropdown, setShowModelDropdown] = useState(false);

	// Prompt Improver state from global store
	const isImproving = useIsImprovingPrompt();
	const currentImproveRequestId = useImprovingPromptRequestId();

	// Derived values
	const isControlled = controlledValue !== undefined;
	const inputValue = isControlled ? controlledValue : storeInput;

	// Attachments hook
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
		pendingPasteText,
		clearPendingPaste,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	} = useFileAttachments({ initialFiles, initialCodeSnippets, initialImages });

	// UI Refs and local state
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const filePickerTriggerIndexRef = useRef<number | null>(null);
	const [planMode, setPlanMode] = useState(false);

	const [previewImage, setPreviewImage] = useState<{
		name: string;
		dataUrl: string;
	} | null>(null);
	const [caretAnchorRect, setCaretAnchorRect] = useState<AnchorRectLike | null>(null);
	const [filePickerAnchorRect, setFilePickerAnchorRect] = useState<AnchorRectLike | null>(null);
	const [slashCommandsAnchorRect, setSlashCommandsAnchorRect] = useState<AnchorRectLike | null>(
		null,
	);
	const [slashButtonAnchorElement, setSlashButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);
	const [fileButtonAnchorElement, setFileButtonAnchorElement] = useState<HTMLElement | null>(null);
	const [modelButtonAnchorElement, setModelButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);
	const backdropRef = useRef<HTMLDivElement>(null);

	// Sync scroll between textarea and backdrop
	const handleScroll = useCallback(() => {
		if (textareaRef.current && backdropRef.current) {
			backdropRef.current.scrollTop = textareaRef.current.scrollTop;
			backdropRef.current.scrollLeft = textareaRef.current.scrollLeft;
		}
	}, []);

	// Focus on mount if requested
	useEffect(() => {
		if (autoFocus && textareaRef.current) {
			textareaRef.current.focus();
			const len = textareaRef.current.value.length;
			textareaRef.current.setSelectionRange(len, len);
		}
	}, [autoFocus]);

	// Find all commands in input and calculate their positions for highlighting
	// Only highlight valid commands from CLI_COMMANDS, OPENCODE_COMMANDS, or custom commands
	const commandHighlights = useMemo(() => {
		// Build set of valid command names based on provider
		const cliCommands = provider === 'opencode' ? OPENCODE_COMMANDS : CLI_COMMANDS;
		const validCommandNames = new Set([
			...cliCommands.map(cmd => cmd.name.toLowerCase()),
			...customCommands.map(cmd => cmd.name.toLowerCase()),
		]);

		const highlights: Array<{ start: number; end: number; command: string }> = [];
		const regex = /\/([a-zA-Z][a-zA-Z0-9_-]*)/g;
		let match: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec pattern
		while ((match = regex.exec(inputValue)) !== null) {
			const commandName = match[1].toLowerCase();
			// Only highlight if command exists in valid commands list
			if (validCommandNames.has(commandName)) {
				highlights.push({
					start: match.index,
					end: match.index + match[0].length,
					command: match[0],
				});
			}
		}
		return highlights;
	}, [inputValue, provider, customCommands]);

	// Handle pending paste text fallback - insert text if context was not found
	useEffect(() => {
		if (pendingPasteText) {
			// Wait a short time for clipboardContext response
			const timeout = setTimeout(() => {
				// If still pending after timeout, insert as plain text
				if (pendingPasteText && textareaRef.current) {
					const textarea = textareaRef.current;
					textarea.focus();

					// Use execCommand for proper undo/redo support (Ctrl+Z)
					// This integrates with browser's native undo stack
					document.execCommand('insertText', false, pendingPasteText);

					clearPendingPaste();
				}
			}, 300); // Wait for context response from extension

			return () => clearTimeout(timeout);
		}
		return undefined;
	}, [pendingPasteText, clearPendingPaste]);

	// Caret tracking for dropdowns
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}

		const update = () => {
			setCaretAnchorRect(getTextareaCaretAnchorRectAtIndex(el));
		};

		update();
		el.addEventListener('keyup', update);
		el.addEventListener('click', update);
		el.addEventListener('mouseup', update);
		el.addEventListener('scroll', update);
		window.addEventListener('resize', update);
		window.addEventListener('scroll', update, true);
		return () => {
			el.removeEventListener('keyup', update);
			el.removeEventListener('click', update);
			el.removeEventListener('mouseup', update);
			el.removeEventListener('scroll', update);
			window.removeEventListener('resize', update);
			window.removeEventListener('scroll', update, true);
		};
	}, []);

	// Reset trigger indices when dropdowns close
	useEffect(() => {
		if (!showFilePicker) {
			filePickerTriggerIndexRef.current = null;
			setFilePickerAnchorRect(null);
		}
	}, [showFilePicker]);

	// Position dropdowns accurately
	useLayoutEffect(() => {
		const el = textareaRef.current;
		if (!el || !showFilePicker || filePickerAnchorRect) {
			return;
		}
		const triggerIndex = filePickerTriggerIndexRef.current;
		if (triggerIndex == null) {
			return;
		}
		setFilePickerAnchorRect(getTextareaCaretAnchorRectAtIndex(el, triggerIndex));
	}, [filePickerAnchorRect, showFilePicker]);

	// Cleanup global dropdown states on unmount to prevent them from "leaking"
	// to the main chat input after editing is finished.
	useEffect(() => {
		return () => {
			if (isControlled) {
				setShowSlashCommands(false);
				setShowFilePicker(false);
				setShowModelDropdown(false);
				setSlashFilter('');
				setFileFilter('');
			}
		};
	}, [isControlled, setShowSlashCommands, setShowFilePicker, setSlashFilter, setFileFilter]);

	// Auto-resize textarea
	useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = 'auto';
			el.style.height = `${Math.min(el.scrollHeight, 266)}px`;
		}
	});

	const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value;

		if (isControlled && controlledOnChange) {
			controlledOnChange(value);
		} else {
			setStoreInput(value);
		}

		if (showSlashCommands) {
			const lastSlashIndex = value.lastIndexOf('/');
			if (lastSlashIndex >= 0) {
				const filterText = value.substring(lastSlashIndex);
				if (filterText.includes(' ')) {
					setShowSlashCommands(false);
					setSlashFilter('');
					setSlashCommandsAnchorRect(null);
				} else {
					setSlashFilter(filterText);
				}
			} else {
				setShowSlashCommands(false);
				setSlashFilter('');
				setSlashCommandsAnchorRect(null);
			}
		}

		if (showFilePicker) {
			const triggerIndex = filePickerTriggerIndexRef.current;
			const atIndex = triggerIndex ?? value.lastIndexOf('@');
			if (atIndex >= 0 && value[atIndex] === '@') {
				const filterText = value.substring(atIndex + 1);
				if (filterText.includes(' ')) {
					setShowFilePicker(false);
					setFileFilter('');
					setFilePickerAnchorRect(null);
					filePickerTriggerIndexRef.current = null;
				} else {
					setFileFilter(filterText);
				}
			} else {
				setShowFilePicker(false);
				setFileFilter('');
				setFilePickerAnchorRect(null);
				filePickerTriggerIndexRef.current = null;
			}
		} else {
			const lastChar = value.slice(-1);
			if (lastChar === '@') {
				const prevChar = value.slice(-2, -1);
				if (!prevChar || prevChar === ' ' || prevChar === '\n') {
					if (!filePickerAnchorRect) {
						const atIndex = value.length - 1;
						filePickerTriggerIndexRef.current = atIndex;
						setFilePickerAnchorRect(getTextareaCaretAnchorRectAtIndex(e.target, atIndex));
					}
					setShowFilePicker(true);
					setFileFilter('');
				}
			}
		}
	};

	const handleSend = useCallback(() => {
		const hasContent =
			inputValue.trim() ||
			codeSnippets.length > 0 ||
			attachedFiles.length > 0 ||
			attachedImages.length > 0;

		if (!hasContent || isProcessing) {
			return;
		}

		if (isControlled && controlledOnSend) {
			controlledOnSend(inputValue);
			return;
		}

		// Build structured attachments
		const attachments = {
			files: attachedFiles.length > 0 ? attachedFiles : undefined,
			codeSnippets:
				codeSnippets.length > 0
					? codeSnippets.map(s => ({
							filePath: s.filePath,
							startLine: s.startLine,
							endLine: s.endLine,
							content: s.content,
						}))
					: undefined,
			images:
				attachedImages.length > 0
					? attachedImages.map(img => ({
							id: img.id,
							name: img.name,
							dataUrl: img.dataUrl,
							path: img.path,
						}))
					: undefined,
		};

		// Check if we have any attachments
		const hasAttachments = attachments.files || attachments.codeSnippets || attachments.images;

		postSessionMessage('sendMessage', {
			text: inputValue.trim(),
			planMode,
			attachments: hasAttachments ? attachments : undefined,
		});
		// Clear any messages marked as reverted before sending new message
		clearRevertedMessages();
		setStoreInput('');
		clearAll();
		setPlanMode(false);
	}, [
		inputValue,
		codeSnippets,
		attachedFiles,
		attachedImages,
		isProcessing,
		isControlled,
		controlledOnSend,
		planMode,
		postSessionMessage,
		clearRevertedMessages,
		setStoreInput,
		clearAll,
	]);

	const handleStop = () => postSessionMessage('stopRequest');

	const handleImprovePrompt = useCallback(() => {
		if (isImproving) {
			// Cancel current request
			if (currentImproveRequestId) {
				postMessage('cancelImprovePrompt', { requestId: currentImproveRequestId });
			}
			// Reset state immediately for UI responsiveness
			setImprovingPrompt(false, null);
			return;
		}

		if (!inputValue.trim()) {
			return;
		}

		const requestId = crypto.randomUUID();
		setImprovingPrompt(true, requestId);

		postMessage('improvePromptRequest', {
			text: inputValue,
			requestId,
			model: selectedModel === 'default' ? undefined : selectedModel,
			timeoutMs: Math.max(1000, Math.round(promptImproveTimeoutSeconds * 1000)),
		});
	}, [
		inputValue,
		isImproving,
		currentImproveRequestId,
		postMessage,
		selectedModel,
		promptImproveTimeoutSeconds,
		setImprovingPrompt,
	]);
	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Block Enter when dropdown is open - let dropdown handle selection
		if (e.key === 'Enter' && !e.shiftKey) {
			if (showSlashCommands || showFilePicker) {
				// Don't send message, dropdown will handle Enter for selection
				return;
			}
			e.preventDefault();
			handleSend();
			return;
		}

		if (e.key === 'Escape') {
			if (showSlashCommands || showFilePicker) {
				setShowSlashCommands(false);
				setShowFilePicker(false);
				e.stopPropagation();
			} else if (onCancel) {
				onCancel();
			}
			return;
		}

		if (e.key === '/' && !showSlashCommands && !showFilePicker) {
			setShowSlashCommands(true);
			setSlashFilter('');
			if (textareaRef.current) {
				const slashIndex = textareaRef.current.selectionStart ?? textareaRef.current.value.length;
				setSlashCommandsAnchorRect(
					getTextareaCaretAnchorRectAtIndex(textareaRef.current, slashIndex),
				);
			}
			return;
		}

		if (e.key === '@' && !showFilePicker && !showSlashCommands) {
			const selectionStart = (e.target as HTMLTextAreaElement).selectionStart;
			const text = (e.target as HTMLTextAreaElement).value;
			const prevChar = selectionStart > 0 ? text[selectionStart - 1] : '';

			if (!prevChar || prevChar === ' ' || prevChar === '\n') {
				setShowFilePicker(true);
				setFileFilter('');
				if (textareaRef.current) {
					const atIndex = textareaRef.current.selectionStart ?? textareaRef.current.value.length;
					filePickerTriggerIndexRef.current = atIndex;
					setFilePickerAnchorRect(getTextareaCaretAnchorRectAtIndex(textareaRef.current, atIndex));
				}
				return;
			}
		}
	};

	const handleFileSelect = (filePath: string) => {
		addFile(filePath);
		const lastAtIndex = inputValue.lastIndexOf('@');
		if (lastAtIndex >= 0) {
			const beforeAt = inputValue.substring(0, lastAtIndex);
			const newVal = beforeAt.trim();
			if (isControlled && controlledOnChange) {
				controlledOnChange(newVal);
			} else {
				setStoreInput(newVal);
			}
		}
		setShowFilePicker(false);
		setFileFilter('');
		setFilePickerAnchorRect(null);
		filePickerTriggerIndexRef.current = null;
		setTimeout(() => textareaRef.current?.focus(), 50);
	};

	const getModelDisplayName = () => {
		if (selectedModel === 'default') {
			return 'Default';
		}
		const standardModel = STANDARD_MODELS.find(m => m.id === selectedModel);
		if (standardModel) {
			return standardModel.name;
		}
		const proxyModel = proxyModels.find(m => m.id === selectedModel);
		if (proxyModel) {
			return proxyModel.name;
		}

		// Handle OpenCode models (format: "providerId/modelId")
		if (selectedModel.includes('/')) {
			const [providerId, modelId] = selectedModel.split('/');
			const provider = opencodeProviders.find(p => p.id === providerId);
			if (provider) {
				const model = provider.models.find(m => m.id === modelId);
				if (model) {
					return model.name;
				}
			}
			// Fallback: return just the model part without provider prefix
			return modelId;
		}

		return selectedModel;
	};

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
				{/* Left Side: Attachments, TextArea, Toolbar */}
				<div className="flex-1 min-w-0 flex flex-col relative pb-(--gap-0-5)">
					{isDragOver && (
						<div className="absolute inset-0 bg-vscode-button-background/10 rounded-lg flex items-center justify-center z-10 pointer-events-none">
							<div className="text-vscode-textLink-foreground font-medium">Drop files here</div>
						</div>
					)}

					{/* Attachments */}
					{(attachedFiles.length > 0 || codeSnippets.length > 0 || attachedImages.length > 0) && (
						<div className="flex flex-wrap items-start gap-(--gap-1-5) px-(--gap-3) py-(--gap-1-5) m-(--gap-1-5)_(--gap-3)">
							{/* Images first */}
							{attachedImages.map(img => (
								<div key={img.id} className="relative shrink-0 group/img">
									<button
										type="button"
										onClick={() => setPreviewImage({ name: img.name, dataUrl: img.dataUrl })}
										onMouseDown={e => {
											if (e.button === 1) {
												e.preventDefault();
												removeImage(img.id);
											}
										}}
										className="cursor-pointer bg-transparent border-none p-0 m-0 block"
									>
										<img
											src={img.dataUrl}
											alt={img.name}
											className="w-10 h-(--header-height) object-cover rounded-sm border border-(--alpha-10) transition-all duration-150 hover:border-vscode-focusBorder hover:shadow-[0_0_0_1px_var(--vscode-focusBorder)]"
										/>
									</button>
									<button
										type="button"
										onClick={e => {
											e.stopPropagation();
											removeImage(img.id);
										}}
										className="absolute top-0.5 right-0.5 bg-(--surface-overlay) hover:bg-(--alpha-medium) rounded-[3px] w-4.5 h-4.5 flex items-center justify-center cursor-pointer text-vscode-foreground text-[11px] opacity-0 group-hover/img:opacity-100 transition-opacity duration-150"
									>
										×
									</button>
								</div>
							))}
							{/* Files */}
							{attachedFiles.map(filePath => (
								<Badge
									key={filePath}
									label={getShortFileName(filePath)}
									iconName={getShortFileName(filePath)}
									onRemove={() => removeFile(filePath)}
									onClick={() => postMessage('openFile', { filePath })}
									title={filePath}
								/>
							))}
							{/* Code snippets */}
							{codeSnippets.map(snippet => (
								<Badge
									key={snippet.id}
									label={`${getShortFileName(snippet.filePath)} (${snippet.startLine}-${snippet.endLine})`}
									iconName={getShortFileName(snippet.filePath)}
									onRemove={() => removeCodeSnippet(snippet.id)}
									onClick={() =>
										postMessage('openFile', {
											filePath: snippet.filePath,
											startLine: snippet.startLine,
											endLine: snippet.endLine,
										})
									}
									title={`${snippet.filePath}:${snippet.startLine}-${snippet.endLine} (click to open)`}
									backgroundColor="color-mix(in srgb, var(--vscode-focusBorder) 15%, transparent)"
								/>
							))}
						</div>
					)}

					{/* Text Input Area */}
					<div className="relative w-full min-w-0 grid place-items-stretch">
						{/* Backdrop for highlighting */}
						<div
							ref={backdropRef}
							className={cn(
								'col-start-1 row-start-1',
								'py-(--gap-1-5) px-(--gap-3) min-h-(--input-min-height) max-h-(--input-max-height) scrollbar-gutter-stable',
								'whitespace-pre-wrap wrap-break-word overflow-auto pointer-events-none',
								// Match TextArea styles exactly
								'box-border border-none outline-none font-(family-name:--vscode-font-family) text-vscode-font-size leading-normal overflow-anywhere text-input-text',
								// Text color (for non-highlighted parts) needs to match standard input text
								'scrollbar-hide',
								// Hide scrollbar in backdrop but allow scrolling via sync
								'scrollbar-hide',
							)}
							aria-hidden="true"
						>
							{(() => {
								const elements: React.ReactNode[] = [];
								let lastIndex = 0;
								for (const highlight of commandHighlights) {
									// Text before command
									if (highlight.start > lastIndex) {
										elements.push(
											<span key={`text-${lastIndex}`}>
												{inputValue.substring(lastIndex, highlight.start)}
											</span>,
										);
									}
									// Highlighted command
									elements.push(
										<span
											key={`cmd-${highlight.start}`}
											className="text-warning rounded-sm pl-(--gap-0-5) pr-(--gap-1-5) -ml-(--gap-0-5) -mr-(--gap-1-5)"
											style={{
												backgroundColor:
													'color-mix(in srgb, var(--vscode-editorGutter-modifiedBackground) 15%, transparent)',
											}}
										>
											{highlight.command}
										</span>,
									);
									lastIndex = highlight.end;
								}
								// Remaining text
								if (lastIndex < inputValue.length) {
									elements.push(
										<span key={`text-${lastIndex}`}>{inputValue.substring(lastIndex)}</span>,
									);
								}
								// Handle trailing newline for visual consistency
								if (inputValue.endsWith('\n')) {
									elements.push(<br key="trailing-br" />);
								}
								return elements;
							})()}
						</div>

						{/* Actual Textarea (Transparent) */}
						<TextArea
							ref={textareaRef}
							placeholder={placeholder}
							rows={1}
							value={inputValue}
							onChange={handleInputChange}
							onKeyDown={handleKeyDown}
							onPaste={handlePaste}
							onScroll={handleScroll}
							className={cn(
								'col-start-1 row-start-1 z-10',
								'py-(--gap-1-5) px-(--gap-3) min-h-(--input-min-height) max-h-(--input-max-height) scrollbar-gutter-stable',
								// Make text fully transparent - use both for cross-browser support
								'bg-transparent',
								// Match backdrop styles
								'font-(family-name:--vscode-font-family) text-vscode-font-size leading-normal wrap-break-word overflow-anywhere',
								// Fix placeholder visibility against transparent text
								'placeholder:text-(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))',
								'placeholder:[-webkit-text-fill-color:var(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))]',
							)}
							style={{
								color: 'transparent',
								WebkitTextFillColor: 'transparent',
								caretColor: 'var(--vscode-foreground)',
							}}
							spellCheck={false}
						/>
					</div>

					{/* Bottom Toolbar */}
					<div className="h-(--input-toolbar-height) flex items-center justify-between pl-(--gap-2) pr-0 box-border shrink-0">
						{/* Left Toolbar - can shrink */}
						<div className="flex items-center gap-(--gap-0-5) z-5 min-w-0 overflow-hidden">
							<Button
								variant="ghost"
								size="xs"
								onClick={() => setPlanMode(!planMode)}
								className={cn(
									'h-(--input-toolbar-height) rounded-md select-none text-sm font-(family-name:--vscode-font-family) shrink-0 flex items-center gap-(--gap-2) px-(--gap-1-5) transition-all duration-200 border',
									planMode
										? 'text-vscode-button-background bg-vscode-button-background/10 border-vscode-button-background/30'
										: 'text-vscode-foreground opacity-70 hover:opacity-100 bg-transparent hover:bg-(--alpha-5) border-transparent',
								)}
							>
								<PlanIcon
									size={14}
									className={cn('transition-transform duration-200', planMode && 'scale-110')}
								/>
								<span>Plan</span>
							</Button>

							<div className="relative min-w-0">
								<Button
									variant="ghost"
									size="xs"
									onClick={e => {
										setModelButtonAnchorElement(e.currentTarget as HTMLElement);
										setShowModelDropdown(!showModelDropdown);
									}}
									className={cn(
										'h-(--input-toolbar-height) rounded-md opacity-70 hover:opacity-100 hover:bg-(--alpha-5) text-sm font-(family-name:--vscode-font-family) min-w-0 max-w-full flex items-center gap-(--gap-2) px-(--gap-1-5) transition-all duration-200 border border-transparent',
										showModelDropdown && 'bg-(--alpha-5) opacity-100',
									)}
								>
									<AgentsIcon size={14} className="shrink-0" />
									<span className="truncate">{getModelDisplayName()}</span>
									<ChevronIcon expanded={showModelDropdown} size={10} className="shrink-0" />
								</Button>
								{showModelDropdown && (
									<ModelDropdown
										anchorElement={modelButtonAnchorElement}
										onClose={() => setShowModelDropdown(false)}
									/>
								)}
							</div>
						</div>

						{/* Right Toolbar - fixed, doesn't shrink */}
						<div className="flex items-center gap-0 pr-0 shrink-0">
							<div className="relative">
								<IconButton
									icon={
										isImproving ? (
											<LoaderIcon className="animate-spin" size={14} />
										) : (
											<ImprovePromptIcon
												size={14}
												className="transition-transform duration-200 group-hover/improve:scale-110"
											/>
										)
									}
									onClick={handleImprovePrompt}
									title={isImproving ? 'Cancel improvement' : 'Improve prompt'}
									size={22}
									disabled={!inputValue.trim() && !isImproving}
									className={cn(
										'group/improve',
										isImproving
											? 'opacity-100 text-(--color-accent)'
											: 'text-vscode-foreground opacity-70 hover:opacity-100 hover:text-(--color-accent)',
									)}
								/>
							</div>
							<div className="relative">
								<IconButton
									icon={
										<TerminalIcon
											size={14}
											strokeWidth={2.5}
											className="transition-transform duration-200 group-hover/terminal:scale-110"
										/>
									}
									onClick={e => {
										setSlashButtonAnchorElement(e.currentTarget as HTMLElement);
										setShowSlashCommands(!showSlashCommands);
										setSlashFilter('');
									}}
									title="Slash commands (/)"
									size={22}
									className="group/terminal text-vscode-foreground opacity-70 hover:opacity-100"
								/>
								{showSlashCommands && (
									<SlashCommandsDropdown
										anchorElement={slashButtonAnchorElement || textareaRef.current}
										anchorRect={
											!slashButtonAnchorElement
												? (slashCommandsAnchorRect ?? caretAnchorRect)
												: undefined
										}
									/>
								)}
							</div>
							<div className="relative">
								<IconButton
									icon={
										<AtSignIcon
											size={14}
											strokeWidth={2.5}
											className="transition-transform duration-200 group-hover/at:scale-110"
										/>
									}
									onClick={e => {
										setFileButtonAnchorElement(e.currentTarget as HTMLElement);
										setShowFilePicker(!showFilePicker);
										setFileFilter('');
									}}
									title="Reference files (@)"
									size={22}
									className="group/at text-vscode-foreground opacity-70 hover:opacity-100"
								/>
								{showFilePicker && (
									<FilePickerDropdown
										onSelectFile={handleFileSelect}
										anchorElement={fileButtonAnchorElement || textareaRef.current}
										anchorRect={!fileButtonAnchorElement ? filePickerAnchorRect : undefined}
									/>
								)}
							</div>
							<IconButton
								icon={
									<ImageIcon
										size={14}
										strokeWidth={2.5}
										className="transition-transform duration-200 group-hover/image:scale-110"
									/>
								}
								onClick={() => postMessage('selectImageFile')}
								title="Attach image"
								size={22}
								className="group/image text-vscode-foreground opacity-70 hover:opacity-100"
							/>
						</div>
					</div>
				</div>

				{/* Send Button */}
				<SendButton
					isProcessing={isProcessing}
					hasContent={!!(inputValue.trim() || attachedFiles.length > 0)}
					onSend={handleSend}
					onStop={handleStop}
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
};
