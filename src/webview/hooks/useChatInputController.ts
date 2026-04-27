/**
 * @file useChatInputController — Value routing, send, stop, improve prompt
 * @description Absorbs controlled/uncontrolled branching, send logic, prompt improver,
 *              and agent/model selection from the old ChatInput monolith.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { generateId, resolveModelDisplayName } from '../../common';
import { extractInlineAttachmentPayload } from '../../common/inlineAttachments';
import {
	getAvailableModelVariants,
	getConfiguredAgentVariant,
	resolveEffectiveVariant,
} from '../lib/modelVariants';
import {
	useChatActions,
	useChatStore,
	useDraftAgent,
	useDraftAttachments,
	useImprovingPromptRequestId,
	useIsImprovingPrompt,
	useIsProcessing,
	useModelSelection,
	usePromptVersions,
	useSessionAgent,
	useSessionModel,
	useSessionVariant,
	useStoreInput,
} from '../store';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { useSessionMessage, useVSCode } from '../utils/vscode';

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
	const { postMessage } = useVSCode();
	const { postSessionMessage } = useSessionMessage();

	const storeInput = useStoreInput();
	const {
		updateSessionInput,
		setImprovingPrompt,
		clearPromptVersions,
		togglePromptVersion,
		clearDraftState,
	} = useChatActions();
	const isProcessing = useIsProcessing();
	const { proxyEndpoints, opencodeProviders, getSessionModel, getSessionAgent, setSessionAgent } =
		useModelSelection();
	const isImproving = useIsImprovingPrompt();
	const currentImproveRequestId = useImprovingPromptRequestId();
	const promptVersions = usePromptVersions();
	const subagentItems = useSettingsStore(s => s.subagents.items);
	const agentItems = useSettingsStore(s => s.agents.items);
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
		const configured = getConfiguredAgentVariant({
			agent:
				agentItems.find(agent => agent.id === agentId) ??
				subagentItems.find(agent => agent.name === agentId),
			effectiveModel: sessionModelId,
			variants,
		});
		return resolveEffectiveVariant({
			variants,
			selected: reactiveSessionVariant,
			configured,
		});
	}, [
		agentItems,
		opencodeProviders,
		proxyEndpoints,
		reactiveSessionVariant,
		selectedAgent,
		sessionModel,
		subagentItems,
	]);

	// Build a set of valid agent names for @mention parsing
	const validAgentNames = useMemo(() => {
		const names = new Set<string>();
		for (const sa of subagentItems) names.add(sa.name.toLowerCase());
		for (const a of agentItems) names.add(a.id.toLowerCase());
		return names;
	}, [subagentItems, agentItems]);

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

		postMessage({ type: 'createSession' });

		return await new Promise<string | undefined>(resolve => {
			const timeoutId = window.setTimeout(() => {
				unsubscribe();
				resolve(useChatStore.getState().activeSessionId);
			}, 3000);

			const unsubscribe = useChatStore.subscribe(state => {
				if (!state.activeSessionId) return;
				window.clearTimeout(timeoutId);
				unsubscribe();
				resolve(state.activeSessionId);
			});
		});
	}, [postMessage]);

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
		const sessionModelId = sessionModel;
		if (!sessionModelId) return;

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

		// Generate a stable message ID on the client so the extension
		// can reuse the same ID — messages come from SDK events now.
		const clientMessageID = generateId('msg');
		const targetSessionId = await ensureSessionForSend();

		postSessionMessage({
			type: 'sendMessage',
			text: inputValue.trim(),
			...(targetSessionId ? { sessionId: targetSessionId } : {}),
			clientMessageID,
			agent,
			model: sessionModelId,
			...(validSessionVariant ? { variant: validSessionVariant } : {}),
			attachments: hasAttachments ? builtAttachments : undefined,
		});

		updateSessionInput('');
		attachments.clearAll();
		clearPromptVersions();
	}, [
		inputValue,
		attachments,
		isControlled,
		controlledOnSend,
		selectedAgent,
		validSessionVariant,
		postSessionMessage,
		updateSessionInput,
		clearPromptVersions,
		sessionModel,
		validAgentNames.has,
		ensureSessionForSend,
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
