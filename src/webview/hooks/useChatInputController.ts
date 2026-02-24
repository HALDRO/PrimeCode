/**
 * @file useChatInputController — Value routing, send, stop, improve prompt
 * @description Absorbs controlled/uncontrolled branching, send logic, prompt improver,
 *              and agent/model selection from the old ChatInput monolith.
 */

import { useCallback, useEffect, useState } from 'react';
import { resolveModelDisplayName } from '../../common';
import {
	useChatActions,
	useDraftAgent,
	useDraftAttachments,
	useImprovingPromptRequestId,
	useIsImprovingPrompt,
	useIsProcessing,
	useModelSelection,
	usePromptVersions,
	useStoreInput,
} from '../store';
import { useUIStore } from '../store/uiStore';
import { useSessionMessage, useVSCode } from '../utils/vscode';

interface AttachmentState {
	files: string[];
	images: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
	codeSnippets: Array<{
		id: string;
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>;
	clearAll: () => void;
	addFile: (path: string) => void;
}

interface UseChatInputControllerOptions {
	controlledValue?: string;
	controlledOnChange?: (value: string) => void;
	controlledOnSend?: (
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
	attachments: AttachmentState;
}

export interface ChatInputController {
	inputValue: string;
	setInputValue: (v: string) => void;
	isControlled: boolean;
	isProcessing: boolean;
	handleSend: () => void;
	handleStop: () => void;
	isImproving: boolean;
	handleImprovePrompt: () => void;
	promptVersions: { showingImproved: boolean; original: string; improved: string } | null;
	togglePromptVersion: () => void;
	clearPromptVersions: () => void;
	selectedAgent: string | undefined;
	setSelectedAgent: (a: string | undefined) => void;
	modelDisplayName: string;
	getSessionModel: () => string | undefined;
}

export function useChatInputController(
	options: UseChatInputControllerOptions,
): ChatInputController {
	const { controlledValue, controlledOnChange, controlledOnSend, attachments } = options;
	const { postMessage } = useVSCode();
	const { postSessionMessage } = useSessionMessage();

	const storeInput = useStoreInput();
	const {
		setInput: setStoreInput,
		clearRevertedMessages,
		setImprovingPrompt,
		clearPromptVersions,
		togglePromptVersion,
		clearDraftState,
	} = useChatActions();
	const isProcessing = useIsProcessing();
	const { selectedModel, proxyModels, opencodeProviders, getSessionModel } = useModelSelection();
	const isImproving = useIsImprovingPrompt();
	const currentImproveRequestId = useImprovingPromptRequestId();
	const promptVersions = usePromptVersions();

	const isControlled = controlledValue !== undefined;
	const inputValue = isControlled ? controlledValue : storeInput;

	const setInputValue = useCallback(
		(v: string) => {
			if (isControlled && controlledOnChange) {
				controlledOnChange(v);
			} else {
				setStoreInput(v);
			}
		},
		[isControlled, controlledOnChange, setStoreInput],
	);

	// Agent selection
	const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);

	// Restore draft state from cancelled queued messages
	const draftAttachments = useDraftAttachments();
	const draftAgent = useDraftAgent();

	useEffect(() => {
		if (!draftAttachments && draftAgent === undefined) return;
		if (draftAttachments?.files) {
			for (const f of draftAttachments.files) attachments.addFile(f);
		}
		if (draftAgent !== undefined) {
			setSelectedAgent(draftAgent);
		}
		clearDraftState();
	}, [draftAttachments, draftAgent, attachments, clearDraftState]);

	// Send message
	const handleSend = useCallback(() => {
		const hasContent =
			inputValue.trim() ||
			attachments.codeSnippets.length > 0 ||
			attachments.files.length > 0 ||
			attachments.images.length > 0;

		if (!hasContent) return;

		if (isControlled && controlledOnSend) {
			controlledOnSend(inputValue, {
				files: attachments.files,
				codeSnippets: attachments.codeSnippets.map(s => ({
					filePath: s.filePath,
					startLine: s.startLine,
					endLine: s.endLine,
					content: s.content,
				})),
				images: attachments.images.map(img => ({
					id: img.id,
					name: img.name,
					dataUrl: img.dataUrl,
					path: img.path,
				})),
			});
			return;
		}

		const builtAttachments = {
			files: attachments.files.length > 0 ? attachments.files : undefined,
			codeSnippets:
				attachments.codeSnippets.length > 0
					? attachments.codeSnippets.map(s => ({
							filePath: s.filePath,
							startLine: s.startLine,
							endLine: s.endLine,
							content: s.content,
						}))
					: undefined,
			images:
				attachments.images.length > 0
					? attachments.images.map(img => ({
							id: img.id,
							name: img.name,
							dataUrl: img.dataUrl,
							path: img.path,
						}))
					: undefined,
		};

		const hasAttachments =
			builtAttachments.files || builtAttachments.codeSnippets || builtAttachments.images;
		const sessionModel = getSessionModel();

		postSessionMessage({
			type: 'sendMessage',
			text: inputValue.trim(),
			agent: selectedAgent,
			model: sessionModel,
			attachments: hasAttachments ? builtAttachments : undefined,
		});

		clearRevertedMessages();
		setStoreInput('');
		attachments.clearAll();
		clearPromptVersions();
		setSelectedAgent(undefined);
	}, [
		inputValue,
		attachments,
		isControlled,
		controlledOnSend,
		selectedAgent,
		postSessionMessage,
		clearRevertedMessages,
		setStoreInput,
		clearPromptVersions,
		getSessionModel,
	]);

	const handleStop = useCallback(
		() => postSessionMessage({ type: 'stopRequest' }),
		[postSessionMessage],
	);

	// Prompt improver
	const handleImprovePrompt = useCallback(() => {
		if (isImproving) {
			if (currentImproveRequestId) {
				postMessage({
					type: 'cancelImprovePrompt',
					requestId: currentImproveRequestId,
				});
			}
			setImprovingPrompt(false, null);
			return;
		}

		if (!inputValue.trim()) {
			useUIStore.getState().actions.pushNotification({
				type: 'error',
				content: 'Cannot improve an empty prompt',
				timestamp: new Date().toISOString(),
				autoDismissMs: 4000,
			});
			return;
		}

		const requestId = crypto.randomUUID();
		setImprovingPrompt(true, requestId);
		postMessage({
			type: 'improvePromptRequest',
			text: inputValue,
			requestId,
		});
	}, [inputValue, isImproving, currentImproveRequestId, postMessage, setImprovingPrompt]);

	// Model display name
	const modelDisplayName = (() => {
		const effectiveModel = getSessionModel() ?? selectedModel;
		if (effectiveModel === 'default') return 'Default';
		return resolveModelDisplayName(effectiveModel, opencodeProviders, proxyModels);
	})();

	return {
		inputValue,
		setInputValue,
		isControlled,
		isProcessing,
		handleSend,
		handleStop,
		isImproving,
		handleImprovePrompt,
		promptVersions,
		togglePromptVersion,
		clearPromptVersions,
		selectedAgent,
		setSelectedAgent,
		modelDisplayName,
		getSessionModel,
	};
}
