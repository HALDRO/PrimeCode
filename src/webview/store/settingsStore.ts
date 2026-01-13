/**
 * @file Settings store - Zustand state management for settings
 * @description Centralized state for all extension settings including proxy settings,
 *              access, MCP servers, custom snippets, CLI diagnostics and platform info.
 *              Uses unified types from schemas for consistency with extension backend.
 *              Supports both Claude and OpenCode CLI providers with unified access handling.
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
	MCPServersMap,
	OpenCodeProviderData,
	PlatformInfo,
	Rule,
} from '../../types';

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
	setAnthropicModels: (models: Array<{ id: string; name: string }>) => void;
	setAnthropicModelsStatus: (status: Partial<SettingsState['anthropicModelsStatus']>) => void;
	setAnthropicKeyStatus: (status: Partial<SettingsState['anthropicKeyStatus']>) => void;
	setEnabledProxyModels: (models: string[]) => void;
	setProxyTestStatus: (status: Partial<SettingsState['proxyTestStatus']>) => void;
	setCommands: (commands: Partial<SettingsState['commands']>) => void;
	setSkills: (skills: Partial<SettingsState['skills']>) => void;
	setHooks: (hooks: Partial<SettingsState['hooks']>) => void;
	setMcpServers: (servers: MCPServersMap) => void;
	setMcpStatus: (status: SettingsState['mcpStatus']) => void;
	setMcpInstalledMetadata: (
		metadata: Record<string, import('../../types').InstalledMcpServerMetadata>,
	) => void;
	setMcpMarketplaceState: (state: Partial<SettingsState['mcpMarketplace']>) => void;
	setAccess: (access: Access[]) => void;
	setCLIDiagnostics: (diagnostics: Partial<CLIDiagnostics>) => void;
	setProvider: (provider: CLIProviderType) => void;
	setOpenCodeProviders: (providers: OpenCodeProviderData[]) => void;
	removeOpenCodeProvider: (providerId: string) => void;
	clearSessionDisconnectedProvider: (providerId: string) => void;
	setOpenCodeConfig: (config: Partial<OpenCodeConfigData>) => void;
	setOpenCodeStatus: (status: Partial<OpenCodeStatusData>) => void;
	// Provider management
	setAvailableProviders: (providers: AvailableProviderData[]) => void;
	addAvailableProvider: (provider: AvailableProviderData) => void;
	setProviderAuthState: (state: ProviderAuthState | null) => void;
	setCustomProviderForm: (form: Partial<CustomProviderFormData>) => void;
	resetCustomProviderForm: () => void;
	// Model selection for OpenCode
	setEnabledOpenCodeModels: (models: string[]) => void;
	toggleOpenCodeModel: (modelId: string) => void;
	// Unified provider visibility (disabled = hidden from dropdown but keeps model selection)
	// Works for all providers: OpenAI Compatible (__openai_compatible__) and OpenCode providers
	setDisabledProviders: (providers: string[]) => void;
	toggleProviderDisabled: (providerId: string) => void;
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
}

// Rule Type
export type { Rule } from '../../types';

// Command Types
export type ParsedCommand = import('../../types').ParsedCommand;
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

// Custom provider form state
export interface CustomProviderFormData {
	id: string;
	name: string;
	baseURL: string;
	apiKey: string;
	models: string; // Comma-separated model IDs
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
	customProviderForm: CustomProviderFormData;
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
	anthropicModels: Array<{ id: string; name: string }>;
	anthropicModelsStatus: {
		isLoading: boolean;
		success: boolean | null;
		error: string | null;
		lastTested: number | null;
	};
	anthropicKeyStatus: {
		hasKey: boolean;
		lastChecked: number | null;
		error: string | null;
	};
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
	mcpInstalledMetadata: Record<string, import('../../types').InstalledMcpServerMetadata>;
	mcpMarketplace: {
		isLoading: boolean;
		error: string | null;
		catalog: import('../../types').McpMarketplaceCatalog | null;
	};

	// Commands
	commands: {
		builtin: CommandItem[];
		custom: ParsedCommand[];
		isLoading: boolean;
		error?: string;
	};

	// Skills
	skills: {
		items: import('../../types').ParsedSkill[];
		isLoading: boolean;
		error?: string;
	};

	// Hooks
	hooks: {
		items: import('../../types').ParsedHook[];
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

export const useSettingsStore = create<SettingsState>(set => ({
	workspaceName: '',

	provider: 'claude',

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
	customProviderForm: {
		id: '',
		name: '',
		baseURL: '',
		apiKey: '',
		models: '',
	},
	enabledOpenCodeModels: [],
	disabledProviders: [],
	sessionDisconnectedProviders: [],

	discoveryStatus: {
		rules: {
			hasAgentsMd: false,
			hasClaudeMd: false,
			hasClaudeShim: false,
			ruleFiles: [],
		},
		permissions: {
			claudeConfig: undefined,
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
	anthropicModels: [],
	anthropicModelsStatus: {
		isLoading: false,
		success: null,
		error: null,
		lastTested: null,
	},
	anthropicKeyStatus: {
		hasKey: false,
		lastChecked: null,
		error: null,
	},
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
		setAnthropicModels: anthropicModels => set({ anthropicModels }),
		setAnthropicModelsStatus: status =>
			set(state => ({
				anthropicModelsStatus: { ...state.anthropicModelsStatus, ...status },
			})),
		setAnthropicKeyStatus: status =>
			set(state => ({
				anthropicKeyStatus: {
					...state.anthropicKeyStatus,
					...status,
					lastChecked: Date.now(),
				},
			})),
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
		setProvider: provider => set({ provider }),
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
		setCustomProviderForm: form =>
			set(state => ({
				customProviderForm: { ...state.customProviderForm, ...form },
			})),
		resetCustomProviderForm: () =>
			set({
				customProviderForm: {
					id: '',
					name: '',
					baseURL: '',
					apiKey: '',
					models: '',
				},
			}),
		// Model selection for OpenCode
		setEnabledOpenCodeModels: enabledOpenCodeModels => set({ enabledOpenCodeModels }),
		toggleOpenCodeModel: modelId =>
			set(state => ({
				enabledOpenCodeModels: state.enabledOpenCodeModels.includes(modelId)
					? state.enabledOpenCodeModels.filter(id => id !== modelId)
					: [...state.enabledOpenCodeModels, modelId],
			})),
		// Unified provider visibility (disabled = hidden from dropdown but keeps model selection)
		setDisabledProviders: disabledProviders => set({ disabledProviders }),
		toggleProviderDisabled: providerId =>
			set(state => ({
				disabledProviders: state.disabledProviders.includes(providerId)
					? state.disabledProviders.filter(id => id !== providerId)
					: [...state.disabledProviders, providerId],
			})),
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
	},
}));

export const useSettingsActions = () => useSettingsStore(state => state.actions);
