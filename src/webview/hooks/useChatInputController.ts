/**
 * @file useChatInputController — Value routing, send, stop, improve prompt
 * @description Absorbs controlled/uncontrolled branching, send logic, prompt improver,
 *              and agent/model selection from the old ChatInput monolith.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { resolveModelDisplayName } from '../../common';
import { extractInlineAttachmentPayload } from '../../common/inlineAttachments';
import {
	getAvailableModelVariants,
	getConfiguredAgentVariant,
	resolveEffectiveVariant,
} from '../lib/modelVariants';
import { openCodeRuntime } from '../services/opencodeRuntime';
import {
	useActiveSessionId,
	useChatActions,
	useChatStore,
	useDraftAgent,
	useDraftAttachments,
	useImprovingPromptRequestId,
	useIsImprovingPrompt,
	useModelSelection,
	usePromptVersions,
	useSessionAgent,
	useSessionModel,
	useSessionVariant,
	useStoreInput,
} from '../store';
import { getSessionRuntimeStatus } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';

function mapInlineCodeSnippets(
	codeSnippets: Array<{
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>,
) {
	return codeSnippets.map(codeSnippet => ({
		filePath: codeSnippet.filePath,
		startLine: codeSnippet.startLine,
		endLine: codeSnippet.endLine,
		content: codeSnippet.content,
	}));
}

function mapAttachmentImages(
	images: Array<{ id: string; name: string; dataUrl: string; path?: string }>,
) {
	return images.map(image => ({
		id: image.id,
		name: image.name,
		dataUrl: image.dataUrl,
		path: image.path,
	}));
}

interface AttachmentState {
	images: Array<{ id: string; name: string; dataUrl: string; path?: string }>;
	clearAll: () => void;
	addFile: (path: string) => void;
	addImage: (image: { id: string; name: string; dataUrl: string; path?: string }) => void;
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
	getSessionAgent: () => string | undefined;
	getSessionModel: () => string | undefined;
}

export function useChatInputController(
	options: UseChatInputControllerOptions,
): ChatInputController {
	const { controlledValue, controlledOnChange, controlledOnSend, attachments } = options;

	const storeInput = useStoreInput();
	const {
		updateSessionInput,
		setImprovingPrompt,
		clearPromptVersions,
		togglePromptVersion,
		clearDraftState,
	} = useChatActions();
	const activeSessionId = useActiveSessionId();
	const isProcessing = useChatStore(state => {
		if (!activeSessionId) return false;
		const status = getSessionRuntimeStatus(state, activeSessionId);
		return status?.type === 'busy' || status?.type === 'retry';
	});
	const { proxyEndpoints, opencodeProviders, getSessionModel, getSessionAgent, setSessionAgent } =
		useModelSelection();
	const isImproving = useIsImprovingPrompt();
	const currentImproveRequestId = useImprovingPromptRequestId();
	const promptVersions = usePromptVersions();
	const agentResources = useSettingsStore(s => s.resources.agent.items);
	const lastSelectedModel = useSettingsStore(s => s.lastSelectedModel);
	const pushNotification = useUIStore(s => s.actions.pushNotification);
	// Use reactive selector so the button re-renders immediately when agent changes.
	// getSessionAgent() is an imperative getter that doesn't subscribe to store updates.
	const selectedAgent = useSessionAgent();
	const sessionModel = useSessionModel();
	const reactiveSessionVariant = useSessionVariant();
	const validSessionVariant = useMemo(() => {
		const sessionModelId = sessionModel;
		if (!sessionModelId) return undefined;
		const variants = getAvailableModelVariants(opencodeProviders, sessionModelId, proxyEndpoints);
		const agentId = selectedAgent ?? 'build';
		const selectedResource = agentResources.find(agent => agent.name === agentId);
		const configured = getConfiguredAgentVariant({
			agent: selectedResource
				? {
						name: selectedResource.name,
						model: selectedResource.model,
						variant: selectedResource.variant,
					}
				: undefined,
			effectiveModel: sessionModelId,
			variants,
		});
		return resolveEffectiveVariant({
			variants,
			selected: reactiveSessionVariant,
			configured,
		});
	}, [
		agentResources,
		opencodeProviders,
		proxyEndpoints,
		reactiveSessionVariant,
		selectedAgent,
		sessionModel,
	]);

	const availableAgentNames = useMemo(
		() =>
			agentResources
				.filter(agent => !agent.disabled && !agent.hidden)
				.map(agent => agent.name)
				.sort((a, b) => b.length - a.length),
		[agentResources],
	);

	useEffect(() => {
		if (!selectedAgent) return;
		const resource = agentResources.find(agent => agent.name === selectedAgent);
		if (!resource || (!resource.disabled && !resource.hidden)) return;
		setSessionAgent(undefined);
		pushNotification({
			type: 'system_notice',
			content: `Agent ${selectedAgent} is no longer available. Switched back to Build.`,
			timestamp: new Date().toISOString(),
			autoDismissMs: 6000,
		});
	}, [agentResources, pushNotification, selectedAgent, setSessionAgent]);

	const isControlled = controlledValue !== undefined;
	const inputValue = isControlled ? controlledValue : storeInput;

	const setInputValue = useCallback(
		(v: string) => {
			if (isControlled && controlledOnChange) {
				controlledOnChange(v);
			} else {
				updateSessionInput(v);
			}
		},
		[isControlled, controlledOnChange, updateSessionInput],
	);

	const setSelectedAgent = useCallback(
		(a: string | undefined) => {
			setSessionAgent(a);
		},
		[setSessionAgent],
	);

	// Restore draft state from cancelled queued messages
	const draftAttachments = useDraftAttachments();
	const draftAgent = useDraftAgent();
	const shouldRestoreQueuedDraft = !isControlled;

	useEffect(() => {
		if (!shouldRestoreQueuedDraft) return;
		if (!draftAttachments && draftAgent === undefined) return;
		if (draftAttachments?.images) {
			for (const image of draftAttachments.images) attachments.addImage(image);
		}
		if (draftAgent !== undefined) {
			setSelectedAgent(draftAgent);
		}
		clearDraftState();
	}, [
		draftAttachments,
		draftAgent,
		attachments,
		clearDraftState,
		setSelectedAgent,
		shouldRestoreQueuedDraft,
	]);

	const ensureSessionForSend = useCallback(async (): Promise<string | undefined> => {
		const existing = useChatStore.getState().activeSessionId;
		if (existing) return existing;
		return await openCodeRuntime.createSession();
	}, []);

	// Send message
	const handleSend = useCallback(async () => {
		const inlinePayload = extractInlineAttachmentPayload(inputValue);

		const hasContent =
			inputValue.trim() ||
			inlinePayload.codeSnippets.length > 0 ||
			inlinePayload.files.length > 0 ||
			attachments.images.length > 0;

		if (!hasContent) return;

		if (isControlled && controlledOnSend) {
			controlledOnSend(inputValue.trim(), {
				files: inlinePayload.files,
				codeSnippets: mapInlineCodeSnippets(inlinePayload.codeSnippets),
				images: mapAttachmentImages(attachments.images),
			});
			return;
		}

		const originalInputValue = inputValue;
		const mappedCodeSnippets = mapInlineCodeSnippets(inlinePayload.codeSnippets);
		const mappedImages = mapAttachmentImages(attachments.images);

		const builtAttachments = {
			files: inlinePayload.files.length > 0 ? inlinePayload.files : undefined,
			codeSnippets: mappedCodeSnippets.length > 0 ? mappedCodeSnippets : undefined,
			images: mappedImages.length > 0 ? mappedImages : undefined,
		};

		const hasAttachments =
			builtAttachments.files || builtAttachments.codeSnippets || builtAttachments.images;

		// Parse @agent from text as fallback when selectedAgent is not set via InputToolbar.
		// Only match known agent names from resources to avoid false positives with @filenames.
		let agent = selectedAgent;
		if (!agent) {
			const normalizedInput = inputValue.toLowerCase();
			for (let index = 0; index < inputValue.length; index++) {
				if (inputValue[index] !== '@') continue;
				const prevChar = inputValue[index - 1];
				if (prevChar && !/\s/.test(prevChar)) continue;

				for (const candidate of availableAgentNames) {
					const mention = `@${candidate}`;
					if (!normalizedInput.startsWith(mention.toLowerCase(), index)) continue;
					const nextChar = inputValue[index + mention.length];
					if (nextChar && !/\s/.test(nextChar)) continue;
					agent = candidate;
					break;
				}
				if (agent) break;
			}
		}

		const targetSessionId = await ensureSessionForSend();

		if (!targetSessionId) return;
		const sessionModelId =
			useChatStore.getState().sessionModel[targetSessionId] ??
			(sessionModel && sessionModel !== 'default' ? sessionModel : undefined) ??
			(lastSelectedModel && lastSelectedModel !== 'default' ? lastSelectedModel : undefined);
		updateSessionInput('');
		attachments.clearAll();
		clearPromptVersions();
		try {
			await openCodeRuntime.sendMessage({
				sessionId: targetSessionId,
				text: inputValue.trim(),
				agent,
				model: sessionModelId,
				variant: validSessionVariant,
				attachments: hasAttachments ? builtAttachments : undefined,
			});
		} catch (error) {
			updateSessionInput(originalInputValue);
			throw error;
		}
	}, [
		inputValue,
		attachments,
		isControlled,
		controlledOnSend,
		selectedAgent,
		validSessionVariant,
		updateSessionInput,
		clearPromptVersions,
		lastSelectedModel,
		sessionModel,
		availableAgentNames,
		ensureSessionForSend,
	]);

	const handleStop = useCallback(() => {
		if (!activeSessionId) return;
		openCodeRuntime.abortSession(activeSessionId);
	}, [activeSessionId]);

	// Prompt improver
	const handleImprovePrompt = useCallback(() => {
		if (isImproving) {
			if (currentImproveRequestId) {
				openCodeRuntime.cancelImprovePrompt(currentImproveRequestId);
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
		void openCodeRuntime
			.improvePrompt(inputValue, requestId)
			.catch(openCodeRuntime.showRuntimeError);
	}, [inputValue, isImproving, currentImproveRequestId, setImprovingPrompt]);

	// Model display name
	const modelDisplayName = useMemo(() => {
		const sessionModelId = sessionModel;
		if (!sessionModelId) return 'No model';
		if (sessionModelId === 'default') return 'Default';
		const allProxyModels = proxyEndpoints.flatMap(ep => ep.models);
		return resolveModelDisplayName(sessionModelId, opencodeProviders, allProxyModels);
	}, [sessionModel, proxyEndpoints, opencodeProviders]);

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
		getSessionAgent,
		getSessionModel,
	};
}
