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
	useSessionProcessing,
	useSessionVariant,
	useStoreInput,
} from '../store';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { webviewLogger } from '../utils/logger';

const log = webviewLogger.forComponent('Send');

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
	const activeSessionId = useChatStore(state => state.activeSessionId);
	const isProcessing = useSessionProcessing(activeSessionId);
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

	// Build a set of valid agent names for @mention parsing
	const validAgentNames = useMemo(() => {
		const names = new Set<string>();
		for (const agent of agentResources) {
			if (!agent.disabled && !agent.hidden) names.add(agent.name.toLowerCase());
		}
		return names;
	}, [agentResources]);

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
				codeSnippets: inlinePayload.codeSnippets.map(s => ({
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

		const originalInputValue = inputValue;

		const builtAttachments = {
			files: inlinePayload.files.length > 0 ? inlinePayload.files : undefined,
			codeSnippets:
				inlinePayload.codeSnippets.length > 0
					? inlinePayload.codeSnippets.map(s => ({
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

		// Parse @agent from text as fallback when selectedAgent is not set via InputToolbar.
		// Only match known subagent/CLI agent names to avoid false positives with @filenames.
		let agent = selectedAgent;
		if (!agent) {
			const mentions = inputValue.match(/(?<=^|\s)@([a-zA-Z0-9_-]+)(?=\s|$)/g);
			if (mentions) {
				for (const mention of mentions) {
					const name = mention.trim().slice(1); // remove @ prefix
					if (validAgentNames.has(name.toLowerCase())) {
						agent = name;
						break;
					}
				}
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
			log.error('Request failed', error);
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
		validAgentNames.has,
		ensureSessionForSend,
	]);

	const handleStop = useCallback(() => {
		if (!activeSessionId) return;
		void openCodeRuntime.abortSession(activeSessionId).catch(openCodeRuntime.showRuntimeError);
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
