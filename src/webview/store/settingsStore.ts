/**
 * @file Settings store - Zustand state management for settings
 * @description Centralized state for all extension settings including proxy settings,
 *              access, MCP servers, custom snippets, CLI diagnostics and platform info.
 *              Uses unified types from schemas for consistency with extension backend.
 *              OpenCode-only provider model with unified access handling.
 *
 * Loading State Management:
 * -------------------------
 * Loading states are set when initiating requests and MUST be reset when responses arrive.
 * The following message types reset their corresponding loading states in the webview
 * extension-message dispatcher:
 *
 * - 'cliDiagnostics'    -> cliDiagnostics.isChecking = false
 * - 'openCodeStatus'    -> opencodeStatus.isChecking = false
 * - 'openCodeProviders' -> opencodeConfig.isLoading = false
 * - 'proxyModels'       -> proxyTestStatus.isLoading = false
 *
 * Timeouts are configured in src/webview/constants.ts (TIMEOUTS) and src/constants.ts
 * to ensure loading states are reset even if the backend doesn't respond.
 */

import { create } from 'zustand';
import {
	type Access,
	type CLIProviderType,
	type DiscoveryStatus,
	type ExtensionMessage,
	getProxyEndpointProviderId,
	type LspStatusData,
	type MCPServersMap,
	normalizeProxyBaseUrl,
	type OpenCodeProviderData,
	type PlatformInfo,
	type Rule,
} from '../../common';
import type { PermissionPolicies } from '../../common/permissions';

export type CommandItem = import('../constants').CommandItem;

// Re-export types for convenience
export type {
	Access,
	CLIProviderType,
	DiscoveryStatus,
	MCPServersMap,
	OpenCodeProviderData,
	PermissionPolicies,
	PlatformInfo,
};

import { vscode } from '../utils/vscode';
import { handleSettingsData } from './settingsUtils';

type PersistedSelectionState = {
	modelVariants?: Record<string, string | undefined>;
};

function readPersistedSelectionState(): PersistedSelectionState {
	const raw = vscode.getState();
	if (!raw || typeof raw !== 'object') return {};
	const state = raw as {
		modelVariants?: unknown;
	};
	let modelVariants: Record<string, string | undefined> | undefined;
	if (
		state.modelVariants &&
		typeof state.modelVariants === 'object' &&
		!Array.isArray(state.modelVariants)
	) {
		modelVariants = Object.fromEntries(
			Object.entries(state.modelVariants as Record<string, unknown>).filter(
				([, value]) => typeof value === 'string' || value === undefined,
			),
		) as Record<string, string | undefined>;
	}
	return {
		modelVariants,
	};
}

function writePersistedSelectionState(input: PersistedSelectionState): void {
	const current = vscode.getState();
	const next =
		current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
	delete next.selectedModel;
	if (input.modelVariants !== undefined) next.modelVariants = input.modelVariants;
	vscode.setState(next);
}

const persistedSelection = readPersistedSelectionState();

// Extracted helpers to reduce cognitive complexity of handleExtensionMessage

const handleAuthResult = (
	data: {
		success?: boolean;
		error?: string;
		providerId?: string;
		isLoading?: boolean;
	},
	actions: SettingsActions,
) => {
	actions.setProviderAuthState(
		data.providerId
			? {
					providerId: data.providerId,
					isLoading: data.isLoading ?? false,
					success: data.success ?? false,
					error: data.error ?? undefined,
				}
			: null,
	);
	if (data.success && !data.isLoading && data.providerId) {
		actions.clearSessionDisconnectedProvider(data.providerId);
	}
};

const handleRemoveProvider = (
	data: { providerId?: string; providerName?: string },
	actions: SettingsActions,
	getState: () => SettingsState,
) => {
	const { providerId, providerName } = data;
	if (!providerId) return;

	const provider = getState().opencodeProviders.find(p => p.id === providerId);
	actions.removeOpenCodeProvider(providerId);
	const nextEnabled = getState().enabledOpenCodeModels.filter(id => {
		const slashIndex = id.indexOf('/');
		return slashIndex === -1 || id.slice(0, slashIndex) !== providerId;
	});
	actions.setEnabledOpenCodeModels(nextEnabled);
	if (provider || providerName) {
		actions.addAvailableProvider({
			id: providerId,
			name: provider?.name || providerName || providerId,
			env: [],
		});
	}
};

// Helper for loading meta logic
const handleLoadingMeta = (
	meta: { operation?: string; message?: string } | undefined,
	error: string | undefined,
	setResourceOps: (ops: Partial<SettingsState['resourceOps']>) => void,
) => {
	if (meta?.operation && meta.message) {
		setResourceOps({
			lastAction: meta.operation,
			status: 'success',
			message: meta.message,
		});
		setTimeout(() => setResourceOps({ status: 'idle' }), 3500);
	}
	if (error) {
		setResourceOps({
			lastAction: 'error',
			status: 'error',
			message: error,
		});
		setTimeout(() => setResourceOps({ status: 'idle' }), 6000);
	}
};

// Extension version info
export interface ExtensionVersionInfo {
	current: string;
	latest: string | null;
	updateAvailable: boolean;
	releaseUrl: string | null;
	isChecking: boolean;
	error?: string;
}

// CLI Diagnostics info
export interface CLIDiagnostics {
	installed: boolean;
	version: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	path: string | null;
	error: string | null;
	lastChecked: number | null;
	isChecking: boolean;
}

export interface ProxyEndpointState {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	enabledModels: string[];
	headers?: Record<string, string>;
	modelVariants?: Record<string, string[]>;
	models: Array<{
		id: string;
		name: string;
		contextLength?: number;
		maxCompletionTokens?: number;
		capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
		variants?: string[];
	}>;
	testStatus: {
		isLoading: boolean;
		success: boolean | null;
		error: string | null;
		lastTested: number | null;
	};
}

export interface SettingsActions {
	setSettings: (settings: Partial<SettingsState>) => void;
	setSelectedModel: (model: string) => void;
	setProxyEndpoints: (endpoints: ProxyEndpointState[]) => void;
	addProxyEndpoint: (endpoint: ProxyEndpointState) => void;
	updateProxyEndpoint: (
		endpointId: string,
		updates: Partial<Omit<ProxyEndpointState, 'id'>>,
	) => void;
	removeProxyEndpoint: (endpointId: string) => void;
	syncEnabledProxyModelsFromAvailable: () => void;
	setSubagents: (subagents: Partial<SettingsState['subagents']>) => void;
	setAgents: (agents: Partial<SettingsState['agents']>) => void;
	setCommands: (commands: Partial<SettingsState['commands']>) => void;
	setSkills: (skills: Partial<SettingsState['skills']>) => void;
	setPlugins: (plugins: Partial<SettingsState['plugins']>) => void;
	setMcpServers: (servers: MCPServersMap) => void;
	setMcpStatus: (status: SettingsState['mcpStatus']) => void;
	setMcpInstalledMetadata: (
		metadata: Record<string, import('../../common').InstalledMcpServerMetadata>,
	) => void;
	setLspStatus: (items: LspStatusData[]) => void;
	setAccess: (access: Access[]) => void;
	setCLIDiagnostics: (diagnostics: Partial<CLIDiagnostics>) => void;
	setOpenCodeProviders: (providers: OpenCodeProviderData[]) => void;
	removeOpenCodeProvider: (providerId: string) => void;
	clearSessionDisconnectedProvider: (providerId: string) => void;
	setOpenCodeConfig: (config: Partial<OpenCodeConfigData>) => void;
	setOpenCodeStatus: (status: Partial<OpenCodeStatusData>) => void;
	// Provider management
	setAvailableProviders: (providers: AvailableProviderData[]) => void;
	addAvailableProvider: (provider: AvailableProviderData) => void;
	setProviderAuthState: (state: ProviderAuthState | null) => void;
	// Model selection for OpenCode
	setEnabledOpenCodeModels: (models: string[]) => void;
	setModelVariant: (modelId: string, variant: string | undefined) => void;
	getModelVariant: (modelId: string | undefined) => string | undefined;
	// Unified provider visibility (disabled = hidden from dropdown but keeps model selection)
	// Works for all providers: OpenAI Compatible (__openai_compatible__) and OpenCode providers
	setDisabledProviders: (providers: string[]) => void;
	// Discovery
	setDiscoveryStatus: (status: DiscoveryStatus) => void;
	// Rules
	setRules: (rules: Rule[]) => void;
	updateRule: (rule: Rule) => void;
	// Permissions
	setPolicies: (policies: PermissionPolicies) => void;
	// Agents config
	setMcpConfigStatus: (status: Partial<SettingsState['mcpConfig']>) => void;

	// Import/Sync feedback in Settings (avoids noisy toasts)
	setResourceOps: (ops: Partial<SettingsState['resourceOps']>) => void;

	handleExtensionMessage: (message: ExtensionMessage) => void;
}

// Rule Type
export type { Rule } from '../../common';

// Command Types
export type ParsedCommand = import('../../common').ParsedCommand;
// export type CommandItem = import('../constants').CommandItem;

export interface OpenCodeConfigData {
	isLoading: boolean;
	error?: string;
}

export interface OpenCodeStatusData {
	isChecking: boolean;
	installed: boolean;
	version?: string;
	model?: string;
	serverUrl?: string;
	error?: string;
}

// Available provider (not yet connected) for adding API keys
export interface AvailableProviderData {
	id: string;
	name: string;
	env: string[]; // Environment variable names for API key
	models?: Array<{
		id: string;
		name: string;
		reasoning?: boolean;
		limit?: { context?: number; output?: number };
		variants?: string[];
	}>;
}

// Auth operation state
export interface ProviderAuthState {
	providerId: string;
	isLoading: boolean;
	success?: boolean;
	error?: string;
}

export interface SettingsState {
	workspaceName: string;

	// CLI Provider
	provider: CLIProviderType;
	accessAutoApprove: boolean;

	// Proxy Configuration
	/** When true, only main model is used for all tasks */
	proxyUseSingleModel: boolean;
	/** Model for fast/simple tasks (Explore agent). Empty = use main model */
	proxyHaikuModel: string;
	/** Model for standard tasks. Empty = use main model */
	proxySonnetModel: string;
	/** Model for complex tasks (plan mode). Empty = use main model */
	proxyOpusModel: string;
	/** Model for subagents (Explore, etc.). Empty = use main model */
	proxySubagentModel: string;

	// Prompt Improver
	promptImproveModel: string;
	promptImproveTemplate: string;

	// OpenCode Configuration
	opencodeAgent: string;
	opencodeProviders: OpenCodeProviderData[];
	opencodeConfig: OpenCodeConfigData;
	opencodeStatus: OpenCodeStatusData;
	// Provider management
	availableProviders: AvailableProviderData[];
	providerAuthState: ProviderAuthState | null;
	// Enabled models for chat dropdown (format: "providerId/modelId")
	enabledOpenCodeModels: string[];
	// Unified disabled providers (hidden from dropdown but keeps model selection)
	// Works for all providers: OpenAI Compatible (__openai_compatible__) and OpenCode providers
	disabledProviders: string[];
	// Session-only list of disconnected providers (to filter out stale CLI cache data)
	sessionDisconnectedProviders: string[];

	// Discovery
	discoveryStatus: DiscoveryStatus;

	// Rules
	rules: Rule[];

	// Permissions
	policies: PermissionPolicies;

	// Access
	access: Access[];

	// Platform
	platformInfo: PlatformInfo;

	// Model
	selectedModel: string;
	modelVariants: Record<string, string | undefined>;
	proxyEndpoints: ProxyEndpointState[];

	// MCP servers
	mcpServers: MCPServersMap;
	mcpStatus: Record<
		string,
		{
			status: string;
			error?: string;
			tools?: Array<{ name: string; description?: string }>;
			resources?: Array<{ uri: string; name: string; description?: string }>;
		}
	>;
	mcpInstalledMetadata: Record<string, import('../../common').InstalledMcpServerMetadata>;
	lspStatus: LspStatusData[];

	// Commands
	commands: {
		builtin: CommandItem[];
		custom: ParsedCommand[];
		/** CLI commands fetched dynamically from the OpenCode server */
		cli: Array<{ name: string; description?: string; source?: string }>;
		isLoading: boolean;
		error?: string;
	};

	skills: {
		items: import('../../common').ParsedSkill[];
		isLoading: boolean;
		error?: string;
	};

	// Subagents
	subagents: {
		items: import('../../common').ParsedSubagent[];
		isLoading: boolean;
		error?: string;
	};

	// CLI Agents (primary agents from OpenCode: build, plan, custom)
	agents: {
		items: Array<{
			id: string;
			mode?: string;
			description?: string;
			model?: string;
			variant?: string;
			builtIn?: boolean;
			hidden?: boolean;
		}>;
		isLoading: boolean;
		error?: string;
	};

	// Plugins
	plugins: {
		items: string[];
		isLoading: boolean;
		error?: string;
	};

	// Resource operations feedback in Settings
	resourceOps: {
		lastAction?: string;
		status: 'idle' | 'working' | 'success' | 'error';
		message?: string;
		updatedAt?: number;
	};

	// MCP config status (opencode.json)
	mcpConfig: {
		hasProjectConfig: boolean;
		projectPath?: string;
	};

	// CLI Diagnostics
	cliDiagnostics: CLIDiagnostics;

	// Extension version
	extensionVersion: ExtensionVersionInfo;

	actions: SettingsActions;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	workspaceName: '',

	provider: 'opencode',
	accessAutoApprove: false,

	proxyUseSingleModel: true,
	proxyHaikuModel: '',
	proxySonnetModel: '',
	proxyOpusModel: '',
	proxySubagentModel: '',

	promptImproveModel: '',
	promptImproveTemplate: '',

	opencodeAgent: '',
	opencodeProviders: [],
	opencodeConfig: {
		isLoading: false,
		error: undefined,
	},
	opencodeStatus: {
		isChecking: true,
		installed: false,
		version: undefined,
		model: undefined,
		serverUrl: undefined,
		error: undefined,
	},
	availableProviders: [],
	providerAuthState: null,
	enabledOpenCodeModels: [],
	disabledProviders: [],
	sessionDisconnectedProviders: [],

	discoveryStatus: {
		rules: {
			hasAgentsMd: false,
			ruleFiles: [],
		},
		permissions: {
			openCodeConfig: undefined,
		},
		skills: [],
	},

	rules: [],

	policies: {
		read: 'allow',
		edit: 'ask',
		glob: 'allow',
		grep: 'allow',
		list: 'allow',
		bash: 'ask',
		task: 'ask',
		skill: 'allow',
		lsp: 'allow',
		todoread: 'allow',
		todowrite: 'allow',
		webfetch: 'ask',
		websearch: 'ask',
		codesearch: 'allow',
		external_directory: 'ask',
		doom_loop: 'ask',
	},

	access: [],

	platformInfo: {
		platform: '',
		isWindows: false,
	},

	selectedModel: 'default',
	modelVariants: persistedSelection.modelVariants ?? {},
	proxyEndpoints: [],

	mcpServers: {},
	mcpStatus: {},
	mcpInstalledMetadata: {},
	lspStatus: [],

	commands: {
		builtin: [],
		custom: [],
		cli: [],
		isLoading: false,
		error: undefined,
	},

	skills: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	plugins: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	subagents: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	agents: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	mcpConfig: {
		hasProjectConfig: false,
		projectPath: undefined,
	},

	cliDiagnostics: {
		installed: false,
		version: null,
		latestVersion: null,
		updateAvailable: false,
		path: null,
		error: null,
		lastChecked: null,
		isChecking: false,
	},

	extensionVersion: {
		current: '0.0.0',
		latest: null,
		updateAvailable: false,
		releaseUrl: null,
		isChecking: false,
	},

	resourceOps: {
		lastAction: undefined,
		status: 'idle',
		message: undefined,
		updatedAt: undefined,
	},

	actions: {
		setSettings: settings => set(state => ({ ...state, ...settings })),
		setSelectedModel: selectedModel => {
			writePersistedSelectionState({
				modelVariants: get().modelVariants,
			});
			set({ selectedModel });
		},
		setModelVariant: (modelId, variant) =>
			set(state => {
				const next = { ...state.modelVariants };
				if (variant) next[modelId] = variant;
				else delete next[modelId];
				writePersistedSelectionState({
					modelVariants: next,
				});
				return { modelVariants: next };
			}),
		getModelVariant: modelId => {
			if (!modelId || modelId === 'default') return undefined;
			return get().modelVariants[modelId];
		},
		setProxyEndpoints: proxyEndpoints => set({ proxyEndpoints }),
		addProxyEndpoint: proxyEndpoint =>
			set(state => ({
				proxyEndpoints: [...state.proxyEndpoints, proxyEndpoint],
			})),
		updateProxyEndpoint: (endpointId, updates) =>
			set(state => {
				const exists = state.proxyEndpoints.some(ep => ep.id === endpointId);
				if (exists) {
					return {
						proxyEndpoints: state.proxyEndpoints.map(endpoint =>
							endpoint.id === endpointId ? { ...endpoint, ...updates } : endpoint,
						),
					};
				}
				// If the endpoint doesn't exist yet (proxyModels arrived before settingsData),
				// also check by canonical baseUrl to avoid creating a duplicate when
				// settingsData arrives later with a different ID for the same endpoint.
				// Uses normalizeProxyBaseUrl — the same normalization used when writing
				// to opencode.json and when fetching proxy models.
				const rawUpdateUrl = updates.baseUrl?.trim();
				if (rawUpdateUrl) {
					const canonicalUpdateUrl = normalizeProxyBaseUrl(rawUpdateUrl);
					const existingByUrl = state.proxyEndpoints.find(ep => {
						const rawEpUrl = ep.baseUrl?.trim();
						return rawEpUrl ? normalizeProxyBaseUrl(rawEpUrl) === canonicalUpdateUrl : false;
					});
					if (existingByUrl) {
						return {
							proxyEndpoints: state.proxyEndpoints.map(endpoint =>
								endpoint.id === existingByUrl.id ? { ...endpoint, ...updates } : endpoint,
							),
						};
					}
				}
				// Upsert: create endpoint if proxyModels arrived before settingsData
				return {
					proxyEndpoints: [
						...state.proxyEndpoints,
						{
							id: endpointId,
							name: '',
							baseUrl: '',
							apiKey: '',
							enabledModels: [],
							models: [],
							testStatus: {
								isLoading: false,
								success: null,
								error: null,
								lastTested: null,
							},
							...updates,
						},
					],
				};
			}),
		removeProxyEndpoint: endpointId =>
			set(state => ({
				proxyEndpoints: state.proxyEndpoints.filter(endpoint => endpoint.id !== endpointId),
			})),
		syncEnabledProxyModelsFromAvailable: () =>
			set(state => ({
				proxyEndpoints: state.proxyEndpoints.map(endpoint => ({
					...endpoint,
					enabledModels: endpoint.enabledModels.filter(id =>
						endpoint.models.some(model => model.id === id),
					),
				})),
			})),
		setCommands: commands =>
			set(state => ({
				commands: { ...state.commands, ...commands },
			})),
		setSkills: skills =>
			set(state => ({
				skills: { ...state.skills, ...skills },
			})),
		setPlugins: (plugins: Partial<SettingsState['plugins']>) =>
			set(state => ({
				plugins: { ...state.plugins, ...plugins },
			})),
		setSubagents: subagents =>
			set(state => ({
				subagents: { ...state.subagents, ...subagents },
			})),
		setAgents: agents =>
			set(state => ({
				agents: { ...state.agents, ...agents },
			})),
		setMcpServers: mcpServers => set({ mcpServers }),
		setMcpStatus: mcpStatus => set(state => ({ mcpStatus: { ...state.mcpStatus, ...mcpStatus } })),
		setMcpInstalledMetadata: mcpInstalledMetadata => set({ mcpInstalledMetadata }),
		setLspStatus: lspStatus => set({ lspStatus }),
		setAccess: access => set({ access }),
		setCLIDiagnostics: diagnostics =>
			set(state => ({
				cliDiagnostics: { ...state.cliDiagnostics, ...diagnostics },
			})),
		setOpenCodeProviders: opencodeProviders =>
			set(state => {
				// Deduplicate by provider ID (CLI may return duplicates across reloads
				// or when multiple VS Code windows share the same server)
				const seenIds = new Set<string>();
				const deduped = opencodeProviders.filter(p => {
					if (seenIds.has(p.id)) return false;
					seenIds.add(p.id);
					return true;
				});
				return {
					// Filter out providers that were disconnected in this session (CLI cache may be stale)
					opencodeProviders: deduped.filter(
						p => !state.sessionDisconnectedProviders.includes(p.id),
					),
				};
			}),
		removeOpenCodeProvider: providerId =>
			set(state => ({
				opencodeProviders: state.opencodeProviders.filter(p => p.id !== providerId),
				enabledOpenCodeModels: state.enabledOpenCodeModels.filter(id => {
					const slashIndex = id.indexOf('/');
					return slashIndex === -1 || id.slice(0, slashIndex) !== providerId;
				}),
				// Track disconnected provider to filter out stale CLI cache data
				sessionDisconnectedProviders: state.sessionDisconnectedProviders.includes(providerId)
					? state.sessionDisconnectedProviders
					: [...state.sessionDisconnectedProviders, providerId],
			})),
		clearSessionDisconnectedProvider: providerId =>
			set(state => ({
				sessionDisconnectedProviders: state.sessionDisconnectedProviders.filter(
					id => id !== providerId,
				),
			})),
		setOpenCodeConfig: config =>
			set(state => ({
				opencodeConfig: { ...state.opencodeConfig, ...config },
			})),
		setOpenCodeStatus: status =>
			set(state => ({
				opencodeStatus: { ...state.opencodeStatus, ...status },
			})),
		// Provider management
		setAvailableProviders: availableProviders => set({ availableProviders }),
		addAvailableProvider: provider =>
			set(state => ({
				availableProviders: state.availableProviders.some(p => p.id === provider.id)
					? state.availableProviders
					: [...state.availableProviders, provider],
			})),
		setProviderAuthState: providerAuthState => set({ providerAuthState }),
		// Model selection for OpenCode
		setEnabledOpenCodeModels: enabledOpenCodeModels => set({ enabledOpenCodeModels }),
		// Unified provider visibility (disabled = hidden from dropdown but keeps model selection)
		setDisabledProviders: disabledProviders => set({ disabledProviders }),
		setDiscoveryStatus: discoveryStatus => set({ discoveryStatus }),

		setRules: rules => set({ rules }),
		updateRule: rule =>
			set(state => ({
				rules: state.rules.map(r => (r.path === rule.path ? rule : r)),
			})),

		setPolicies: policies => set({ policies }),

		setMcpConfigStatus: status =>
			set(state => ({
				mcpConfig: { ...state.mcpConfig, ...status },
			})),

		setResourceOps: ops =>
			set(state => ({
				resourceOps: {
					...state.resourceOps,
					...ops,
					updatedAt: Date.now(),
				},
			})),

		handleExtensionMessage: (message: ExtensionMessage) => {
			const actions = get().actions;

			switch (message.type) {
				case 'commandsList':
					if (message.data) {
						const { custom, cli, isLoading, error, meta } = message.data as {
							custom: ParsedCommand[];
							cli?: Array<{ name: string; description?: string; source?: string }>;
							isLoading: boolean;
							error?: string;
							meta?: { operation?: string; message?: string };
						};
						actions.setCommands({ custom, ...(cli !== undefined && { cli }), isLoading, error });
						handleLoadingMeta(meta, error, actions.setResourceOps);
					}
					break;

				case 'skillsList':
					if (message.data) {
						const { skills, isLoading, error, meta } = message.data as {
							skills: import('../../common').ParsedSkill[];
							isLoading: boolean;
							error?: string;
							meta?: { operation?: string; message?: string };
						};
						actions.setSkills({ items: skills, isLoading, error });
						handleLoadingMeta(meta, error, actions.setResourceOps);
					}
					break;

				case 'subagentsList':
					if (message.data) {
						const { subagents, isLoading, error, meta } = message.data as {
							subagents: import('../../common').ParsedSubagent[];
							isLoading: boolean;
							error?: string;
							meta?: { operation?: string; message?: string };
						};
						actions.setSubagents({ items: subagents, isLoading, error });
						handleLoadingMeta(meta, error, actions.setResourceOps);
					}
					break;

				case 'agentsList':
					if (message.data) {
						const { agents, isLoading, error } = message.data as {
							agents: SettingsState['agents']['items'];
							isLoading: boolean;
							error?: string;
						};
						actions.setAgents({ items: agents, isLoading, error });
					}
					break;

				case 'pluginsList':
					if (message.data) {
						const { plugins, isLoading, error } = message.data as {
							plugins: string[];
							isLoading: boolean;
							error?: string;
						};
						actions.setPlugins({ items: plugins, isLoading, error });
					}
					break;

				case 'settingsData':
					if (message.data) {
						handleSettingsData(message.data as Record<string, unknown>, actions, {
							proxyEndpoints: get().proxyEndpoints,
						});
					}
					break;

				case 'workspaceInfo':
					if (message.data?.name) {
						actions.setSettings({ workspaceName: message.data.name });
					}
					break;

				case 'projectUpdated':
					if (message.data?.project?.name) {
						actions.setSettings({ workspaceName: message.data.project.name });
					}
					break;

				case 'platformInfo':
					if (message.data) {
						actions.setSettings({ platformInfo: message.data as PlatformInfo });
					}
					break;

				case 'modelSelected':
					if (message.model) {
						actions.setSelectedModel(message.model);
					}
					break;

				case 'proxyModels':
					if (message.data) {
						const { models, enabledModelIds, error, baseUrl, endpointId } = message.data;
						if (endpointId) {
							actions.updateProxyEndpoint(endpointId, {
								...(baseUrl ? { baseUrl } : {}),
								...(models ? { models } : {}),
								testStatus: {
									isLoading: false,
									success: !error && ((models?.length ?? 0) > 0 || !!enabledModelIds),
									error: error || null,
									lastTested: Date.now(),
								},
							});
						}
					}
					break;

				case 'cliDiagnostics':
					if (message.data) {
						actions.setCLIDiagnostics(message.data);
					}
					break;

				case 'extensionVersion':
					if (message.data) {
						set({ extensionVersion: message.data as ExtensionVersionInfo });
					}
					break;

				case 'discoveryStatus':
					if (message.data) {
						actions.setDiscoveryStatus(message.data);
					}
					break;

				case 'ruleList':
					if (message.data?.rules) {
						actions.setRules(message.data.rules);
						const meta = (message.data as { meta?: { operation?: string; message?: string } })
							?.meta;
						handleLoadingMeta(meta, undefined, actions.setResourceOps);
					}
					break;

				case 'ruleUpdated':
					if (message.data?.rule) {
						actions.updateRule(message.data.rule);
					}
					break;

				case 'permissionsUpdated':
					if (message.data?.policies) {
						actions.setPolicies(message.data.policies);
					}
					break;

				case 'accessData':
					if (message.data) {
						const access = Array.isArray(message.data)
							? (message.data as Access[])
							: [message.data as Access];
						actions.setAccess(access);
					}
					break;

				case 'openCodeStatus':
					if (message.data) {
						const status = message.data;
						actions.setOpenCodeStatus({
							isChecking: false,
							installed: status.installed,
							version: status.version ?? undefined,
							error: status.error,
						});
					}
					break;

				case 'lspStatus':
					if (message.data) {
						actions.setLspStatus((message.data as { items?: LspStatusData[] }).items ?? []);
					}
					break;

				case 'openCodeProviders':
					if (message.data) {
						const { providers, config } = message.data;
						actions.setOpenCodeProviders(providers);
						actions.setOpenCodeConfig({ isLoading: false, error: config?.error });

						const state = get();
						const currentModel = state.selectedModel;
						if (currentModel && currentModel !== 'default' && providers.length > 0) {
							const allAvailable = new Set<string>();
							for (const p of providers) {
								for (const m of p.models) {
									allAvailable.add(`${p.id}/${m.id}`);
								}
							}
							for (const ep of state.proxyEndpoints) {
								for (const m of ep.models) {
									if (ep.enabledModels.includes(m.id)) {
										allAvailable.add(`${getProxyEndpointProviderId(ep.id)}/${m.id}`);
									}
								}
							}
							if (!allAvailable.has(currentModel) && allAvailable.size > 0) {
								const firstAvailable = allAvailable.values().next().value;
								if (firstAvailable) actions.setSelectedModel(firstAvailable);
							}
						}
					}
					break;

				case 'openCodeModelSet':
					if (message.data) {
						actions.setSelectedModel(message.data.model ?? 'default');
					}
					break;

				case 'openCodeAuthResult':
					if (message.data) {
						handleAuthResult(
							message.data as {
								success?: boolean;
								error?: string;
								providerId?: string;
								isLoading?: boolean;
							},
							actions,
						);
					}
					break;

				case 'openCodeDisconnectResult':
					if (message.data) {
						const { success, error, providerId } = message.data as {
							success?: boolean;
							error?: string;
							providerId?: string;
						};
						// Surface disconnect errors via the same auth state mechanism
						if (!success && error && providerId) {
							actions.setProviderAuthState({
								providerId,
								isLoading: false,
								success: false,
								error: `Disconnect failed: ${error}`,
							});
						}
					}
					break;

				case 'removeOpenCodeProvider':
					if (message.data) {
						handleRemoveProvider(
							message.data as { providerId?: string; providerName?: string },
							actions,
							get,
						);
					}
					break;

				case 'availableProviders':
					if (message.data) {
						const { providers } = message.data as {
							providers?: Array<{
								id: string;
								name: string;
								env?: string[];
								models?: Array<{
									id: string;
									name: string;
									reasoning?: boolean;
									limit?: { context?: number; output?: number };
									variants?: string[];
								}>;
							}>;
						};
						if (providers) {
							const normalizedProviders = providers.map(p => ({
								id: p.id,
								name: p.name,
								env: p.env || [],
								models: p.models,
							}));
							actions.setAvailableProviders(normalizedProviders);
						}
					}
					break;

				case 'mcpServers':
					if (message.data) {
						actions.setMcpServers(message.data);
					}
					break;

				case 'mcpInstalledMetadata':
					if (message.data) {
						const data = message.data as {
							metadata?: Record<string, import('../../common').InstalledMcpServerMetadata>;
						};
						actions.setMcpInstalledMetadata(data.metadata ?? {});
					}
					break;

				case 'mcpConfigStatus':
					if (message.data) {
						const data = message.data as {
							hasProjectConfig?: boolean;
							projectPath?: string;
						};
						actions.setMcpConfigStatus({
							hasProjectConfig: data.hasProjectConfig ?? false,
							projectPath: data.projectPath,
						});
					}
					break;

				case 'mcpConfigReloaded':
					// External change to opencode.json detected — re-fetch MCP servers
					vscode.postMessage({ type: 'loadMCPServers' });
					break;

				case 'mcpStatus':
					if (message.data) {
						actions.setMcpStatus(
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
					break;

				case 'opencodeMcpStatus':
					// OpenCode REST API MCP status — authoritative runtime state.
					// Convert to the same format as mcpStatus so the settings panel can display it.
					if (message.data) {
						const openCodeData = message.data as Record<string, { status: string; error?: string }>;
						const converted: Record<string, { status: string; error?: string }> = {};
						for (const [name, entry] of Object.entries(openCodeData)) {
							converted[name] = {
								status: entry.status,
								error: entry.error,
							};
						}
						actions.setMcpStatus(converted);
					}
					break;
			}
		},
	},
}));
