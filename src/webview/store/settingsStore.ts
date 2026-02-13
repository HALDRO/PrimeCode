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
 * The following message types reset their corresponding loading states in useExtensionMessages.ts:
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
import type {
	Access,
	CLIProviderType,
	DiscoveryStatus,
	ExtensionMessage,
	MCPServersMap,
	OpenCodeProviderData,
	PlatformInfo,
	Rule,
} from '../../common';

export type CommandItem = import('../constants').CommandItem;

// Re-export types for convenience
export type {
	Access,
	CLIProviderType,
	MCPServersMap,
	OpenCodeProviderData,
	PlatformInfo,
	DiscoveryStatus,
};

import { handleSettingsData } from './settingsUtils';

// Helper for loading meta logic
const handleLoadingMeta = (
	meta: { operation?: string; message?: string } | undefined,
	error: string | undefined,
	setAgentsOps: (ops: Partial<SettingsState['agentsOps']>) => void,
) => {
	if (meta?.operation && meta.message) {
		setAgentsOps({
			lastAction: meta.operation,
			status: 'success',
			message: meta.message,
		});
		setTimeout(() => setAgentsOps({ status: 'idle' }), 3500);
	}
	if (error) {
		setAgentsOps({
			lastAction: 'error',
			status: 'error',
			message: error,
		});
		setTimeout(() => setAgentsOps({ status: 'idle' }), 6000);
	}
};

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

// Permission Policies
export interface PermissionPolicies {
	edit: 'ask' | 'allow' | 'deny';
	terminal: 'ask' | 'allow' | 'deny';
	network: 'ask' | 'allow' | 'deny';
}

export interface SettingsActions {
	setSettings: (settings: Partial<SettingsState>) => void;
	setSelectedModel: (model: string) => void;
	setProxyModels: (
		models: Array<{
			id: string;
			name: string;
			capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
		}>,
	) => void;
	setEnabledProxyModels: (models: string[]) => void;
	setProxyTestStatus: (status: Partial<SettingsState['proxyTestStatus']>) => void;
	setSubagents: (subagents: Partial<SettingsState['subagents']>) => void;
	setCommands: (commands: Partial<SettingsState['commands']>) => void;
	setSkills: (skills: Partial<SettingsState['skills']>) => void;
	setHooks: (hooks: Partial<SettingsState['hooks']>) => void;
	setMcpServers: (servers: MCPServersMap) => void;
	setMcpStatus: (status: SettingsState['mcpStatus']) => void;
	setMcpInstalledMetadata: (
		metadata: Record<string, import('../../common').InstalledMcpServerMetadata>,
	) => void;
	setMcpMarketplaceState: (state: Partial<SettingsState['mcpMarketplace']>) => void;
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
	setAgentsConfigStatus: (status: Partial<SettingsState['agentsConfig']>) => void;

	// Import/Sync feedback in Settings (avoids noisy toasts)
	setAgentsOps: (ops: Partial<SettingsState['agentsOps']>) => void;

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

	// Proxy Configuration
	proxyBaseUrl: string;
	proxyApiKey: string;
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
	/** Timeout in seconds for UI display (persisted as ms in extension settings). */
	promptImproveTimeoutSeconds: number;

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
	proxyModels: Array<{
		id: string;
		name: string;
		contextLength?: number;
		maxCompletionTokens?: number;
		capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
	}>;
	enabledProxyModels: string[]; // IDs of models enabled for selection in chat
	proxyTestStatus: {
		isLoading: boolean;
		success: boolean | null;
		error: string | null;
		lastTested: number | null;
	};

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
	mcpMarketplace: {
		isLoading: boolean;
		error: string | null;
		catalog: import('../../common').McpMarketplaceCatalog | null;
	};

	// Commands
	commands: {
		builtin: CommandItem[];
		custom: ParsedCommand[];
		isLoading: boolean;
		error?: string;
	};

	skills: {
		items: import('../../common').ParsedSkill[];
		isLoading: boolean;
		error?: string;
	};

	// Hooks
	hooks: {
		items: import('../../common').ParsedHook[];
		isLoading: boolean;
		error?: string;
	};

	// Subagents
	subagents: {
		items: import('../../common').ParsedSubagent[];
		isLoading: boolean;
		error?: string;
	};

	// Import/Sync feedback in Settings (avoids noisy toasts)
	agentsOps: {
		lastAction?: string;
		status: 'idle' | 'working' | 'success' | 'error';
		message?: string;
		updatedAt?: number;
	};

	// Agents config status (.agents/mcp.json)
	agentsConfig: {
		hasProjectConfig: boolean;
		projectPath?: string;
	};

	// CLI Diagnostics
	cliDiagnostics: CLIDiagnostics;

	actions: SettingsActions;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
	workspaceName: '',

	provider: 'opencode',

	proxyBaseUrl: 'http://localhost:11434',
	proxyApiKey: '',
	proxyUseSingleModel: true,
	proxyHaikuModel: '',
	proxySonnetModel: '',
	proxyOpusModel: '',
	proxySubagentModel: '',

	promptImproveModel: '',
	promptImproveTemplate: '',
	promptImproveTimeoutSeconds: 30,

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
		hooks: [],
	},

	rules: [],

	policies: {
		edit: 'allow',
		terminal: 'allow',
		network: 'allow',
	},

	access: [],

	platformInfo: {
		platform: '',
		isWindows: false,
	},

	selectedModel: 'default',
	proxyModels: [],
	enabledProxyModels: [],
	proxyTestStatus: {
		isLoading: false,
		success: null,
		error: null,
		lastTested: null,
	},

	mcpServers: {},
	mcpStatus: {},
	mcpInstalledMetadata: {},
	mcpMarketplace: { isLoading: false, error: null, catalog: null },

	commands: {
		builtin: [],
		custom: [],
		isLoading: false,
		error: undefined,
	},

	skills: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	hooks: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	subagents: {
		items: [],
		isLoading: false,
		error: undefined,
	},

	agentsConfig: {
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

	agentsOps: {
		lastAction: undefined,
		status: 'idle',
		message: undefined,
		updatedAt: undefined,
	},

	actions: {
		setSettings: settings => set(state => ({ ...state, ...settings })),
		setSelectedModel: selectedModel => set({ selectedModel }),
		setProxyModels: proxyModels => set({ proxyModels }),
		setEnabledProxyModels: enabledProxyModels => set({ enabledProxyModels }),
		setProxyTestStatus: (status: Partial<SettingsState['proxyTestStatus']>) =>
			set(state => ({
				proxyTestStatus: { ...state.proxyTestStatus, ...status },
			})),
		setCommands: commands =>
			set(state => ({
				commands: { ...state.commands, ...commands },
			})),
		setSkills: skills =>
			set(state => ({
				skills: { ...state.skills, ...skills },
			})),
		setHooks: hooks =>
			set(state => ({
				hooks: { ...state.hooks, ...hooks },
			})),
		setSubagents: subagents =>
			set(state => ({
				subagents: { ...state.subagents, ...subagents },
			})),
		setMcpServers: mcpServers => set({ mcpServers }),
		setMcpStatus: mcpStatus => set(state => ({ mcpStatus: { ...state.mcpStatus, ...mcpStatus } })),
		setMcpInstalledMetadata: mcpInstalledMetadata => set({ mcpInstalledMetadata }),
		setMcpMarketplaceState: mcpMarketplace =>
			set(state => ({ mcpMarketplace: { ...state.mcpMarketplace, ...mcpMarketplace } })),
		setAccess: access => set({ access }),
		setCLIDiagnostics: diagnostics =>
			set(state => ({
				cliDiagnostics: { ...state.cliDiagnostics, ...diagnostics },
			})),
		setOpenCodeProviders: opencodeProviders =>
			set(state => ({
				// Filter out providers that were disconnected in this session (CLI cache may be stale)
				opencodeProviders: opencodeProviders.filter(
					p => !state.sessionDisconnectedProviders.includes(p.id),
				),
			})),
		removeOpenCodeProvider: providerId =>
			set(state => ({
				opencodeProviders: state.opencodeProviders.filter(p => p.id !== providerId),
				enabledOpenCodeModels: state.enabledOpenCodeModels.filter(
					id => !id.startsWith(`${providerId}/`),
				),
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

		setAgentsConfigStatus: status =>
			set(state => ({
				agentsConfig: { ...state.agentsConfig, ...status },
			})),

		setAgentsOps: ops =>
			set(state => ({
				agentsOps: {
					...state.agentsOps,
					...ops,
					updatedAt: Date.now(),
				},
			})),

		handleExtensionMessage: (message: ExtensionMessage) => {
			const actions = get().actions;

			switch (message.type) {
				case 'commandsList':
					if (message.data) {
						const { custom, isLoading, error, meta } = message.data as {
							custom: ParsedCommand[];
							isLoading: boolean;
							error?: string;
							meta?: { operation?: string; message?: string };
						};
						actions.setCommands({ custom, isLoading, error });
						handleLoadingMeta(meta, error, actions.setAgentsOps);
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
						handleLoadingMeta(meta, error, actions.setAgentsOps);
					}
					break;

				case 'hooksList':
					if (message.data) {
						const { hooks, isLoading, error, meta } = message.data as {
							hooks: import('../../common').ParsedHook[];
							isLoading: boolean;
							error?: string;
							meta?: { operation?: string; message?: string };
						};
						actions.setHooks({ items: hooks, isLoading, error });
						handleLoadingMeta(meta, error, actions.setAgentsOps);
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
						handleLoadingMeta(meta, error, actions.setAgentsOps);
					}
					break;

				case 'settingsData':
					if (message.data) {
						handleSettingsData(message.data as Record<string, unknown>, actions);
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
						const { models, error, baseUrl } = message.data;
						actions.setProxyModels(models || []);
						actions.setProxyTestStatus({
							isLoading: false,
							success: !error && models && models.length > 0,
							error: error || null,
							lastTested: Date.now(),
						});
						if (baseUrl) {
							actions.setSettings({ proxyBaseUrl: baseUrl });
						}
					}
					break;

				case 'cliDiagnostics':
					if (message.data) {
						actions.setCLIDiagnostics(message.data);
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
						handleLoadingMeta(meta, undefined, actions.setAgentsOps);
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

				case 'openCodeProviders':
					if (message.data) {
						const { providers, config } = message.data;
						actions.setOpenCodeProviders(providers);
						actions.setOpenCodeConfig({ isLoading: false, error: config?.error });
					}
					break;

				case 'openCodeModelSet':
					if (message.data) {
						actions.setSelectedModel(message.data.model);
					}
					break;

				case 'openCodeAuthResult':
					if (message.data) {
						const { success, error, providerId, isLoading } = message.data as {
							success?: boolean;
							error?: string;
							providerId?: string;
							isLoading?: boolean;
						};
						actions.setProviderAuthState(
							providerId
								? {
										providerId,
										isLoading: isLoading ?? false,
										success: success ?? false,
										error: error ?? undefined,
									}
								: null,
						);
						if (success && !isLoading && providerId) {
							actions.clearSessionDisconnectedProvider(providerId);
						}
					}
					break;

				case 'removeOpenCodeProvider':
					if (message.data) {
						const { providerId, providerName } = message.data as {
							providerId?: string;
							providerName?: string;
						};
						if (providerId) {
							const provider = get().opencodeProviders.find(p => p.id === providerId);
							actions.removeOpenCodeProvider(providerId);
							const nextEnabled = get().enabledOpenCodeModels.filter(
								id => !id.startsWith(`${providerId}/`),
							);
							actions.setEnabledOpenCodeModels(nextEnabled);
							if (provider || providerName) {
								actions.addAvailableProvider({
									id: providerId,
									name: provider?.name || providerName || providerId,
									env: [],
								});
							}
						}
					}
					break;

				case 'availableProviders':
					if (message.data) {
						const { providers } = message.data as {
							providers?: Array<{ id: string; name: string; env?: string[] }>;
						};
						if (providers) {
							const normalizedProviders = providers.map(p => ({
								id: p.id,
								name: p.name,
								env: p.env || [],
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

				case 'mcpMarketplaceCatalog':
					if (message.data) {
						const data = message.data as {
							catalog?: import('../../common').McpMarketplaceCatalog;
							error?: string;
						};
						actions.setMcpMarketplaceState({
							isLoading: false,
							error: data.error ?? null,
							catalog: data.catalog ?? null,
						});
					}
					break;

				case 'mcpMarketplaceInstallResult':
					if (message.data) {
						const data = message.data as {
							success: boolean;
							installPrompt?: string;
						};
						if (data.success && data.installPrompt) {
							navigator.clipboard.writeText(data.installPrompt).catch(() => {});
						}
					}
					break;

				case 'agentsConfigStatus':
					if (message.data) {
						const data = message.data as {
							hasProjectConfig?: boolean;
							projectPath?: string;
						};
						actions.setAgentsConfigStatus({
							hasProjectConfig: data.hasProjectConfig ?? false,
							projectPath: data.projectPath,
						});
					}
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
			}
		},
	},
}));

export const useSettingsActions = () => useSettingsStore(state => state.actions);
