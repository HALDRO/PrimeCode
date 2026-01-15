/**
 * @file useExtensionMessages - hook for handling VS Code extension messages
 * @description Centralizes all message handling logic from the VS Code extension.
 *              Processes incoming messages and dispatches actions to appropriate Zustand stores.
 *              Handlers are organized by category for maintainability and reduced cognitive complexity.
 */

import { useEffect } from 'react';
import type {
	Access,
	ExtensionMessage,
	ParsedCommand,
	SessionEventMessage,
	SessionLifecycleMessage,
	WorkspaceFile,
} from '../../types';
import { type Message, useChatStore } from '../store/chatStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { vscode } from '../utils/vscode';

// =============================================================================
// Types
// =============================================================================

type ChatActions = ReturnType<typeof useChatStore.getState>['actions'];
type UIActions = ReturnType<typeof useUIStore.getState>['actions'];
type SettingsActions = ReturnType<typeof useSettingsStore.getState>['actions'];

interface HandlerContext {
	chatActions: ChatActions;
	uiActions: UIActions;
	settingsActions: SettingsActions;
}

// =============================================================================
// Unified Session Event Handler (new architecture)
// =============================================================================

/**
 * Handle unified session events from the new SessionRouter.
 * Routes events directly to chatStore.dispatch() for simplified processing.
 */
const handleUnifiedSessionEvent = (message: SessionEventMessage, ctx: HandlerContext): boolean => {
	const { chatActions, uiActions } = ctx;

	// Handle sessionInfo as a UI-only event.
	if (message.eventType === 'session_info') {
		const info = (
			message.payload as {
				eventType: 'session_info';
				data: { sessionId: string; tools: string[]; mcpServers: string[] };
			}
		).data;
		uiActions.setSessionInfo({
			sessionId: info.sessionId,
			tools: info.tools || [],
			mcpServers: info.mcpServers || [],
		});
		return true;
	}

	// Dispatch all other session events to the unified store handler.
	chatActions.dispatch(message.targetId, message.eventType, message.payload);
	return true;
};

/**
 * Handle session lifecycle events (created, closed, switched, cleared).
 */
const handleSessionLifecycleEvent = (
	message: SessionLifecycleMessage,
	ctx: HandlerContext,
): boolean => {
	const { chatActions } = ctx;

	switch (message.action) {
		case 'created':
			chatActions.handleSessionCreated(message.sessionId);
			return true;

		case 'closed':
			chatActions.closeSession(message.sessionId);
			return true;

		case 'switched':
			chatActions.switchSession(message.sessionId);
			// If data includes messages, set them
			if (message.data?.messages) {
				chatActions.setSessionMessages(message.sessionId, message.data.messages as Message[]);
			}
			// If data includes processing state, set it
			if (message.data?.isProcessing !== undefined) {
				chatActions.setProcessing(message.data.isProcessing, message.sessionId);
			}
			// If data includes totalStats, set them
			if (message.data?.totalStats) {
				chatActions.setTotalStats(message.data.totalStats, message.sessionId);
			}
			return true;

		case 'cleared':
			chatActions.clearMessages(message.sessionId);
			return true;

		default:
			console.warn(`[useExtensionMessages] Unknown lifecycle action: ${message.action}`);
			return false;
	}
};

// =============================================================================
// Session & Lifecycle Handlers (only non-unified events)
// =============================================================================

const handleSessionMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { uiActions } = ctx;

	switch (message.type) {
		case 'workspaceInfo':
			if (message.data?.name) {
				uiActions.setWorkspaceName(message.data.name);
			}
			return true;

		case 'projectUpdated':
			if (message.data?.project) {
				const { name } = message.data.project;
				if (name) {
					uiActions.setWorkspaceName(name);
				}
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Chat Message Handlers (all handled by session_event now)
// =============================================================================

const handleChatMessages = (_message: ExtensionMessage, _ctx: HandlerContext): boolean => {
	// All chat messages are now handled via session_event
	return false;
};

// =============================================================================
// Tool Handlers (all handled by session_event now)
// =============================================================================

const handleToolMessages = (_message: ExtensionMessage, _ctx: HandlerContext): boolean => {
	// All tool messages are now handled via session_event
	return false;
};

// =============================================================================
// Access Handlers (only global accessData - session-specific handled by session_event)
// =============================================================================

const handleAccessMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions } = ctx;

	switch (message.type) {
		case 'accessData':
			// Global access settings (not session-specific)
			if (message.data) {
				const access = Array.isArray(message.data)
					? (message.data as Access[])
					: [message.data as Access];
				settingsActions.setAccess(access);
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Stats & Tokens Handlers (all handled by session_event now)
// =============================================================================

const handleStatsMessages = (_message: ExtensionMessage, _ctx: HandlerContext): boolean => {
	// All stats messages are now handled via session_event
	return false;
};

// =============================================================================
// Restore & Revert Handlers (all handled by session_event now)
// =============================================================================

const handleRestoreMessages = (_message: ExtensionMessage, _ctx: HandlerContext): boolean => {
	// All restore messages are now handled via session_event
	return false;
};

// =============================================================================
// File Handlers (only global - session-specific handled by session_event)
// =============================================================================

const handleFileMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { uiActions } = ctx;

	switch (message.type) {
		case 'workspaceFiles':
			// Global workspace files list (not session-specific)
			if (Array.isArray(message.data)) {
				uiActions.setWorkspaceFiles(message.data as WorkspaceFile[]);
			}
			return true;

		case 'imagePath':
			if (message.data?.filePath) {
				const path = message.data.filePath;
				window.dispatchEvent(new CustomEvent('image-captured', { detail: path }));
			}
			return true;

		case 'imageData':
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Settings & Configuration Handlers
// =============================================================================

const handleAgentsListUpdate = (
	data: {
		isLoading: boolean;
		error?: string;
		meta?: { operation?: string; message?: string };
	},
	settingsActions: HandlerContext['settingsActions'],
) => {
	if (data.meta?.operation && data.meta.message) {
		settingsActions.setAgentsOps({
			lastAction: data.meta.operation,
			status: 'success',
			message: data.meta.message,
		});
		setTimeout(() => {
			settingsActions.setAgentsOps({ status: 'idle' });
		}, 3500);
	}
	if (data.error) {
		settingsActions.setAgentsOps({
			lastAction: 'error',
			status: 'error',
			message: data.error,
		});
		setTimeout(() => {
			settingsActions.setAgentsOps({ status: 'idle' });
		}, 6000);
	}
};

const handleSettingsMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions, uiActions } = ctx;

	switch (message.type) {
		case 'commandsList':
			if (message.data) {
				const { custom, isLoading, error, meta } = message.data as {
					custom: ParsedCommand[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setCommands({ custom, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'skillsList':
			if (message.data) {
				const { skills, isLoading, error, meta } = message.data as {
					skills: import('../../types').ParsedSkill[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setSkills({ items: skills, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'hooksList':
			if (message.data) {
				const { hooks, isLoading, error, meta } = message.data as {
					hooks: import('../../types').ParsedHook[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setHooks({ items: hooks, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'subagentsList':
			if (message.data) {
				const { subagents, isLoading, error, meta } = message.data as {
					subagents: import('../../types').ParsedSubagent[];
					isLoading: boolean;
					error?: string;
					meta?: { operation?: string; message?: string };
				};
				settingsActions.setSubagents({ items: subagents, isLoading, error });
				handleAgentsListUpdate({ isLoading, error, meta }, settingsActions);
			}
			return true;

		case 'settingsData':
			if (message.data) {
				const settings = message.data;

				// Map backend settings keys to store keys
				const mappedSettings: Record<string, unknown> = {};

				// Direct mappings
				if (settings.provider !== undefined) {
					mappedSettings.provider = settings.provider;
				}

				// Proxy settings
				if (settings['proxy.baseUrl'] !== undefined) {
					mappedSettings.proxyBaseUrl = settings['proxy.baseUrl'];
				}
				if (settings['proxy.apiKey'] !== undefined) {
					mappedSettings.proxyApiKey = settings['proxy.apiKey'];
				}
				if (settings['proxy.enabledModels'] !== undefined) {
					mappedSettings.enabledProxyModels = settings['proxy.enabledModels'];
				}
				if (settings['proxy.useSingleModel'] !== undefined) {
					mappedSettings.proxyUseSingleModel = settings['proxy.useSingleModel'];
				}
				if (settings['proxy.haikuModel'] !== undefined) {
					mappedSettings.proxyHaikuModel = settings['proxy.haikuModel'];
				}
				if (settings['proxy.sonnetModel'] !== undefined) {
					mappedSettings.proxySonnetModel = settings['proxy.sonnetModel'];
				}
				if (settings['proxy.opusModel'] !== undefined) {
					mappedSettings.proxyOpusModel = settings['proxy.opusModel'];
				}
				if (settings['proxy.subagentModel'] !== undefined) {
					mappedSettings.proxySubagentModel = settings['proxy.subagentModel'];
				}

				// Prompt Improver settings
				if (settings['promptImprove.model'] !== undefined) {
					mappedSettings.promptImproveModel = settings['promptImprove.model'];
				}
				if (settings['promptImprove.template'] !== undefined) {
					mappedSettings.promptImproveTemplate = settings['promptImprove.template'];
				}
				if (settings['promptImprove.timeoutMs'] !== undefined) {
					// Stored in ms in extension settings; displayed as seconds in UI.
					const ms = settings['promptImprove.timeoutMs'];
					mappedSettings.promptImproveTimeoutSeconds =
						typeof ms === 'number' && Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) : 30;
				}

				// OpenCode settings
				if (settings['opencode.agent'] !== undefined) {
					mappedSettings.opencodeAgent = settings['opencode.agent'];
				}
				if (settings['opencode.enabledModels'] !== undefined) {
					mappedSettings.enabledOpenCodeModels = settings['opencode.enabledModels'];
				}

				// Unified provider settings
				if (settings['providers.disabled'] !== undefined) {
					mappedSettings.disabledProviders = settings['providers.disabled'];
				}

				settingsActions.setSettings(mappedSettings);
			}
			return true;

		case 'platformInfo':
			if (message.data) {
				uiActions.setPlatformInfo(message.data);
			}
			return true;

		case 'modelSelected':
			if (message.model) {
				settingsActions.setSelectedModel(message.model);
			}
			return true;

		case 'proxyModels':
			if (message.data) {
				const { models, error, baseUrl } = message.data;
				settingsActions.setProxyModels(models || []);
				// Reset loading state and set success/error status
				settingsActions.setProxyTestStatus({
					isLoading: false,
					success: !error && models && models.length > 0,
					error: error || null,
					lastTested: Date.now(),
				});
				if (error) {
				}
				// Store baseUrl for reference (but don't auto-save to avoid restart loops)
				if (baseUrl) {
					settingsActions.setSettings({ proxyBaseUrl: baseUrl });
				}
				// NOTE: Proxy provider is saved to opencode.json only when user
				// explicitly clicks "Fetch Models" button. The save is triggered
				// by SettingsHandler.loadProxyModels which calls saveProxyProviderForOpenCode
				// after successful model fetch. This prevents restart loops on init.
			}
			return true;

		case 'anthropicModels':
			if (message.data) {
				const { models, error } = message.data;
				settingsActions.setAnthropicModels(models || []);
				settingsActions.setAnthropicModelsStatus({
					isLoading: false,
					success: !error && models && models.length > 0,
					error: error || null,
					lastTested: Date.now(),
				});
				if (typeof message.data.keyPresent === 'boolean') {
					settingsActions.setAnthropicKeyStatus({ hasKey: message.data.keyPresent, error: null });
				}
			}
			return true;

		case 'anthropicKeyStatus':
			if (message.data) {
				const { hasKey, error } = message.data as { hasKey?: boolean; error?: string };
				if (typeof hasKey === 'boolean') {
					settingsActions.setAnthropicKeyStatus({ hasKey, error: error || null });
				}
			}
			return true;

		case 'anthropicKeySaved':
			if (message.data) {
				const { success, error } = message.data as { success?: boolean; error?: string };
				if (!success && error) {
					settingsActions.setAnthropicKeyStatus({ error });
				}
			}
			return true;

		case 'anthropicKeyCleared':
			if (message.data) {
				const { success, error } = message.data as { success?: boolean; error?: string };
				if (success) {
					settingsActions.setAnthropicKeyStatus({ hasKey: false, error: null });
				} else if (error) {
					settingsActions.setAnthropicKeyStatus({ error });
				}
			}
			return true;

		case 'proxyProviderSaving':
			// Optional: show loading state while saving proxy provider
			return true;

		case 'proxyProviderSaved':
			if (message.data) {
				const { success, provider: savedProvider } = message.data;
				if (success) {
					if (savedProvider === 'opencode') {
						console.debug('[ExtensionMessages] Proxy provider saved to opencode.json');
					}
				}
			}
			return true;

		case 'reloadOpenCodeProviders':
			// Trigger reload of OpenCode providers after proxy provider is saved
			vscode.postMessage({ type: 'reloadAllProviders' });
			return true;

		case 'configChanged':
			// Silent operation
			return true;

		case 'clipboardText':
			return true;

		case 'clipboardContext':
			return true;

		case 'clipboardContextNotFound':
			return true;

		case 'cliDiagnostics':
			if (message.data) {
				settingsActions.setCLIDiagnostics(message.data);
			}
			return true;

		case 'discoveryStatus':
			if (message.data) {
				settingsActions.setDiscoveryStatus(message.data);
			}
			return true;

		case 'ruleList':
			if (message.data?.rules) {
				settingsActions.setRules(message.data.rules);
				const meta = (message.data as { meta?: { operation?: string; message?: string } })?.meta;
				if (meta?.operation && meta.message) {
					settingsActions.setAgentsOps({
						lastAction: meta.operation,
						status: 'success',
						message: meta.message,
					});
					setTimeout(() => {
						settingsActions.setAgentsOps({ status: 'idle' });
					}, 3500);
				}
			}
			return true;

		case 'ruleUpdated':
			if (message.data?.rule) {
				settingsActions.updateRule(message.data.rule);
				// Silent operation
			}
			return true;

		case 'permissionsUpdated':
			if (message.data?.policies) {
				settingsActions.setPolicies(message.data.policies);
				// Silent operation
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// OpenCode Provider Handlers
// =============================================================================

const handleOpenCodeMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions } = ctx;

	switch (message.type) {
		case 'openCodeStatus':
			if (message.data) {
				const status = message.data;
				settingsActions.setOpenCodeStatus({
					isChecking: false,
					installed: status.installed,
					version: status.version ?? undefined,
					error: status.error,
				});
			}
			return true;

		case 'openCodeProviders':
			if (message.data) {
				const { providers, config } = message.data;
				settingsActions.setOpenCodeProviders(providers);
				// Reset loading state
				settingsActions.setOpenCodeConfig({ isLoading: false, error: config?.error });
			}
			return true;

		case 'openCodeModelSet':
			if (message.data) {
				const { model } = message.data;
				settingsActions.setSelectedModel(model);
				// Silent operation
			}
			return true;

		case 'openCodeAuthResult':
			if (message.data) {
				const { success, error, providerId, isLoading } = message.data as {
					success?: boolean;
					error?: string;
					providerId?: string;
					isLoading?: boolean;
				};

				// Update provider auth state in settings store
				settingsActions.setProviderAuthState(
					providerId
						? {
								providerId,
								isLoading: isLoading ?? false,
								success: success ?? false,
								error: error ?? undefined,
							}
						: null,
				);

				if (success && !isLoading) {
					// Clear from session disconnected list so it can appear again
					if (providerId) {
						settingsActions.clearSessionDisconnectedProvider(providerId);
					}
					// Silent operation
					vscode.postMessage({ type: 'reloadAllProviders' });
				}
			}
			return true;

		case 'openCodeCustomProviderResult':
			// Silent operation
			return true;

		case 'openCodeDisconnectResult':
			// Silent operation
			return true;

		case 'removeOpenCodeProvider':
			if (message.data) {
				const { providerId, providerName } = message.data as {
					providerId?: string;
					providerName?: string;
				};
				if (providerId) {
					// Get provider info before removing
					const provider = useSettingsStore
						.getState()
						.opencodeProviders.find(p => p.id === providerId);
					// Remove provider from connected list (also cleans enabledOpenCodeModels)
					settingsActions.removeOpenCodeProvider(providerId);
					// Persist enabled model cleanup as well
					const nextEnabled = useSettingsStore
						.getState()
						.enabledOpenCodeModels.filter(id => !id.startsWith(`${providerId}/`));
					settingsActions.setEnabledOpenCodeModels(nextEnabled);
					vscode.postMessage({
						type: 'updateSettings',
						settings: { 'opencode.enabledModels': nextEnabled },
					});
					// Add to available providers list (so user can reconnect)
					if (provider || providerName) {
						settingsActions.addAvailableProvider({
							id: providerId,
							name: provider?.name || providerName || providerId,
							env: [], // Will be populated on next full reload
						});
					}
				}
			}
			return true;

		case 'availableProviders':
			if (message.data) {
				const { providers } = message.data as {
					providers?: Array<{ id: string; name: string; env?: string[] }>;
				};
				if (providers) {
					// Ensure env is always an array (required by AvailableProviderData)
					const normalizedProviders = providers.map(p => ({
						id: p.id,
						name: p.name,
						env: p.env || [],
					}));
					settingsActions.setAvailableProviders(normalizedProviders);
				}
			}
			return true;

		default:
			return false;
	}
};

// =============================================================================
// MCP & Other Data Handlers
// =============================================================================

const handleDataMessages = (message: ExtensionMessage, ctx: HandlerContext): boolean => {
	const { settingsActions, uiActions } = ctx;

	switch (message.type) {
		case 'mcpServers':
			if (message.data) {
				const servers = message.data;
				settingsActions.setMcpServers(servers);
			}
			return true;

		case 'mcpInstalledMetadata':
			if (message.data) {
				const data = message.data as {
					metadata?: Record<string, import('../../types').InstalledMcpServerMetadata>;
				};
				settingsActions.setMcpInstalledMetadata(data.metadata ?? {});
			}
			return true;

		case 'mcpMarketplaceCatalog':
			if (message.data) {
				const data = message.data as {
					catalog?: import('../../types').McpMarketplaceCatalog;
					error?: string;
				};
				settingsActions.setMcpMarketplaceState({
					isLoading: false,
					error: data.error ?? null,
					catalog: data.catalog ?? null,
				});
			}
			return true;

		case 'mcpMarketplaceInstallResult':
			if (message.data) {
				const data = message.data as {
					name: string;
					success: boolean;
					error?: string;
					installPrompt?: string;
					githubUrl?: string;
					openedUrl?: string;
				};

				if (data.success && data.installPrompt) {
					// AI-assisted installation: copy prompt to clipboard
					navigator.clipboard.writeText(data.installPrompt).catch(() => {});
				}
				// Silent for other cases (openedUrl, errors, etc.)
			}
			return true;

		case 'mcpServerSaved':
			if (message.data) {
				// Silent operation
				vscode.postMessage({ type: 'loadMCPServers' });
			}
			return true;

		case 'mcpServerDeleted':
			if (message.data) {
				// Silent operation
				vscode.postMessage({ type: 'loadMCPServers' });
			}
			return true;

		case 'mcpServerError':
			// Silent operation
			return true;

		case 'agentsConfigStatus':
			if (message.data) {
				const data = message.data as {
					hasProjectConfig?: boolean;
					projectPath?: string;
				};
				settingsActions.setAgentsConfigStatus({
					hasProjectConfig: data.hasProjectConfig ?? false,
					projectPath: data.projectPath,
				});
			}
			return true;

		case 'opencodeMcpStatus':
			if (message.data) {
				settingsActions.setMcpStatus(
					message.data as Record<string, { status: string; error?: string }>,
				);
			}
			return true;

		case 'mcpStatus':
			if (message.data) {
				settingsActions.setMcpStatus(
					message.data as Record<
						string,
						{
							status: string;
							error?: string;
							tools?: Array<{ name: string; description?: string }>;
							resources?: Array<{ uri: string; name: string; description?: string }>;
						}
					>,
				);
			}
			return true;

		case 'opencodeMcpAuthStarted':
			if (message.data) {
				const { name, authorizationUrl } = message.data as {
					name?: string;
					authorizationUrl?: string;
				};
				if (name && authorizationUrl) {
					// Silent operation (open the URL)
					// Send to extension to open external URL (webview cannot call VS Code API directly)
					vscode.postMessage({ type: 'openExternal', url: authorizationUrl });
					// Refresh MCP status after auth flow
					setTimeout(() => {
						vscode.postMessage({ type: 'loadOpenCodeMcpStatus' });
					}, 2000);
				}
			}
			return true;

		case 'opencodeMcpAuthError':
			// Silent operation
			return true;

		case 'agentsSyncResult':
			if (message.data) {
				const data = message.data as {
					target?: 'claude' | 'opencode' | 'cursor';
					success?: boolean;
					error?: string;
				};

				// Silent operation
				if (!data.success && data.error) {
				}
			}
			return true;

		case 'mcpImportResult':
			if (message.data) {
				const data = message.data as {
					success?: boolean;
					sources?: string[];
					error?: string;
					message?: string;
				};

				// Silent operation
				if (!data.success && data.error) {
				}
			}
			return true;

		case 'conversationList':
			if (Array.isArray(message.data)) {
				uiActions.setConversationList(message.data);
			}
			return true;

		case 'allConversationsCleared':
			useChatStore.setState({
				sessionsById: {},
				sessionOrder: [],
				activeSessionId: undefined,
				editingMessageId: null,
				isImprovingPrompt: false,
				improvingPromptRequestId: null,
			});
			uiActions.setConversationList([]);
			// Silent operation
			return true;

		case 'improvePromptResult':
			if (message.data) {
				const { improvedText, requestId } = message.data as {
					improvedText: string;
					requestId: string;
				};
				// Verify this is the current request before updating
				const currentReqId = useChatStore.getState().improvingPromptRequestId;
				if (currentReqId === requestId) {
					useChatStore
						.getState()
						.actions.appendInput(
							`\n\n---\n✨ Enchanted Query:\n${improvedText}`,
							message.sessionId,
						);
					useChatStore.getState().actions.setImprovingPrompt(false, null);
				}
			}
			return true;

		case 'improvePromptError':
			if (message.data) {
				const { requestId } = message.data as { error: string; requestId: string };
				// Verify this is the current request before updating
				const currentReqId = useChatStore.getState().improvingPromptRequestId;
				if (currentReqId === requestId) {
					useChatStore.getState().actions.setImprovingPrompt(false, null);
				}
			}
			return true;

		case 'improvePromptCancelled':
			// Reset state when cancellation is confirmed by backend
			useChatStore.getState().actions.setImprovingPrompt(false, null);
			return true;

		default:
			return false;
	}
};

// =============================================================================
// Main Message Handler
// =============================================================================

const handleExtensionMessage = (message: ExtensionMessage): void => {
	const chatActions = useChatStore.getState().actions;
	const uiActions = useUIStore.getState().actions;
	const settingsActions = useSettingsStore.getState().actions;

	const ctx: HandlerContext = { chatActions, uiActions, settingsActions };

	// ==========================================================================
	// Handle unified session events first
	// ==========================================================================
	if (message.type === 'session_event') {
		handleUnifiedSessionEvent(message as SessionEventMessage, ctx);
		return;
	}

	if (message.type === 'session_lifecycle') {
		handleSessionLifecycleEvent(message as SessionLifecycleMessage, ctx);
		return;
	}

	// ==========================================================================
	// Global message handling (non-session-specific messages)
	// ==========================================================================

	// Try each handler category in order
	if (handleSessionMessages(message, ctx)) {
		return;
	}
	if (handleChatMessages(message, ctx)) {
		return;
	}
	if (handleToolMessages(message, ctx)) {
		return;
	}
	if (handleAccessMessages(message, ctx)) {
		return;
	}
	if (handleStatsMessages(message, ctx)) {
		return;
	}
	if (handleRestoreMessages(message, ctx)) {
		return;
	}
	if (handleFileMessages(message, ctx)) {
		return;
	}
	if (handleSettingsMessages(message, ctx)) {
		return;
	}
	if (handleOpenCodeMessages(message, ctx)) {
		return;
	}
	if (handleDataMessages(message, ctx)) {
		return;
	}

	// Unknown message type - no action needed
};

// =============================================================================
// Hook Implementation
// =============================================================================

export function useExtensionMessages(): void {
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;
			handleExtensionMessage(message);
		};

		window.addEventListener('message', handleMessage);

		// Request initial data from extension
		vscode.postMessage({ type: 'webviewDidLaunch' });
		vscode.postMessage({ type: 'getSettings' });
		vscode.postMessage({ type: 'getAccess' });
		vscode.postMessage({ type: 'getCommands' });
		vscode.postMessage({ type: 'getSubagents' });
		vscode.postMessage({ type: 'loadMCPServers' });
		vscode.postMessage({ type: 'fetchMcpMarketplaceCatalog', data: { forceRefresh: false } });
		vscode.postMessage({ type: 'loadOpenCodeMcpStatus' });
		vscode.postMessage({ type: 'loadProxyModels' });
		vscode.postMessage({ type: 'getAnthropicKeyStatus' });
		vscode.postMessage({ type: 'loadAnthropicModels' });
		vscode.postMessage({ type: 'checkOpenCodeStatus' });
		vscode.postMessage({ type: 'reloadAllProviders' });
		vscode.postMessage({ type: 'checkDiscoveryStatus' });
		vscode.postMessage({ type: 'getRules' });

		return () => window.removeEventListener('message', handleMessage);
	}, []);
}
