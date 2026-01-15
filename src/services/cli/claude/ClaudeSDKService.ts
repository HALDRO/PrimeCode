/**
 * @file ClaudeSDKService
 * @description Claude provider implementation backed by the Anthropic Claude Agent SDK.
 * Streams SDK messages through SDKEventAdapter to preserve the existing StreamHandler/UI contract.
 */

import { logger } from '../../../utils/logger';
import { buildClaudeMcpServersJson } from '../../../utils/mcpAdapters';
import type { AccessService } from '../../AccessService';
import { AgentsConfigService, agentsConfigToUnifiedRegistry } from '../../AgentsConfigService';
import type { CLIProcessOptions, CLIStreamData, ICLIService } from '../../ICLIService';
import { getProxyServer } from '../../proxy';
import { transformSDKMessage } from './SDKEventAdapter';
import { SDKPermissionsBroker } from './SDKPermissionsBroker';

// =========================================================================
// Proxy Configuration Helpers
// =========================================================================

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1\/messages\/?$/, '')
		.replace(/\/v1\/?$/, '');
}

/**
 * Start the local proxy server that converts Anthropic API requests to OpenAI format.
 * Returns the local proxy URL that Claude SDK should use as ANTHROPIC_BASE_URL.
 */
async function ensureProxyServerRunning(
	targetBaseUrl: string,
	apiKey: string,
	modelMapping?: Record<string, string>,
): Promise<string> {
	const proxyServer = getProxyServer();

	// If already running, return existing URL
	const existingInfo = proxyServer.getInfo();
	if (existingInfo) {
		logger.debug(`[ClaudeSDKService] Proxy server already running at ${existingInfo.baseUrl}`);
		return existingInfo.baseUrl;
	}

	// Start the proxy server
	const info = await proxyServer.start({
		targetBaseUrl: normalizeBaseUrl(targetBaseUrl),
		apiKey,
		modelMapping,
	});

	logger.info(
		`[ClaudeSDKService] Started local proxy server at ${info.baseUrl} -> ${targetBaseUrl}`,
	);
	return info.baseUrl;
}

async function buildProxyEnvironment(
	options: CLIProcessOptions,
): Promise<Record<string, string | undefined> | undefined> {
	if (!options.proxyConfig?.enabled || !options.proxyConfig.baseUrl) {
		if (options.proxyConfig) {
			logger.warn(
				`[ClaudeSDKService] Proxy config provided but incomplete: enabled=${options.proxyConfig.enabled}, baseUrl="${options.proxyConfig.baseUrl}"`,
			);
		}
		return undefined;
	}

	const env: Record<string, string | undefined> = { ...process.env };

	// Start local proxy server that converts Anthropic -> OpenAI format
	// Claude SDK will send requests to this local proxy, which forwards to the actual OpenAI-compatible backend
	const localProxyUrl = await ensureProxyServerRunning(
		options.proxyConfig.baseUrl,
		options.proxyConfig.apiKey || '',
	);

	// Point Claude SDK to our local proxy (which accepts Anthropic format)
	env.ANTHROPIC_BASE_URL = localProxyUrl;

	// Use a dummy API key for the local proxy (actual key is used by proxy -> backend)
	env.ANTHROPIC_API_KEY = 'proxy-key';
	env.ANTHROPIC_AUTH_TOKEN = 'proxy-key';

	// Configure main model
	const mainModel = options.selectedModel || 'default';
	if (mainModel && mainModel !== 'default') {
		env.ANTHROPIC_MODEL = mainModel;
	}

	// Configure model routing
	const useSingleModel = options.proxyConfig.useSingleModel !== false;

	if (useSingleModel) {
		// Force all task types to use the main model
		if (mainModel && mainModel !== 'default') {
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL = mainModel;
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = mainModel;
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = mainModel;
			env.CLAUDE_CODE_SUBAGENT_MODEL = mainModel;
		}
		logger.info(
			`[ClaudeSDKService] Proxy env set (single model): LOCAL_PROXY="${localProxyUrl}", TARGET="${options.proxyConfig.baseUrl}", MODEL="${mainModel}" (all tasks use this model)`,
		);
	} else {
		// Set different models for different task types
		const haikuModel = options.proxyConfig.haikuModel || mainModel;
		const sonnetModel = options.proxyConfig.sonnetModel || mainModel;
		const opusModel = options.proxyConfig.opusModel || mainModel;
		const subagentModel = options.proxyConfig.subagentModel || sonnetModel;

		if (haikuModel && haikuModel !== 'default') {
			env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuModel;
		}
		if (sonnetModel && sonnetModel !== 'default') {
			env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnetModel;
		}
		if (opusModel && opusModel !== 'default') {
			env.ANTHROPIC_DEFAULT_OPUS_MODEL = opusModel;
		}
		env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;

		logger.info(
			`[ClaudeSDKService] Proxy env set: LOCAL_PROXY="${localProxyUrl}", TARGET="${options.proxyConfig.baseUrl}", MODEL="${mainModel}", HAIKU="${haikuModel}", SONNET="${sonnetModel}", OPUS="${opusModel}", SUBAGENT="${subagentModel}"`,
		);
	}

	return env;
}

export class ClaudeSDKService implements ICLIService {
	private _workspaceRoot: string | undefined;
	private _currentQuery: unknown;
	private _abortController: AbortController | undefined;
	private _permissionsBroker: SDKPermissionsBroker;
	private _agentsConfigService: AgentsConfigService;
	private _sessionMap = new Map<string, string>();

	constructor(readonly _accessService: AccessService) {
		this._permissionsBroker = new SDKPermissionsBroker(_accessService);
		this._agentsConfigService = new AgentsConfigService();
	}

	public async initialize(workspaceRoot?: string): Promise<void> {
		this._workspaceRoot = workspaceRoot;
		// Pass workspace root to permissions broker for reading .claude/settings.json
		if (workspaceRoot) {
			this._permissionsBroker.setWorkspaceRoot(workspaceRoot);
		}
		logger.info('[ClaudeSDKService] Initialized with workspace root:', workspaceRoot);
	}

	public isReady(): boolean {
		return true;
	}

	public getProviderType() {
		return 'claude' as const;
	}

	public getWorkspaceRoot(): string | undefined {
		return this._workspaceRoot;
	}

	public async startProcess(
		options: CLIProcessOptions,
		onData: (data: CLIStreamData) => void,
		onClose: (code: number | null, errorOutput: string) => void,
		onError: (error: Error) => void,
	): Promise<void> {
		this._abortController = new AbortController();

		try {
			// Load MCP servers
			const mcpServers = await this._loadMcpServers();

			// Build environment with proxy config if needed (starts local proxy server if needed)
			const proxyEnv = await buildProxyEnvironment(options);
			const env = proxyEnv || process.env;

			// Build SDK options
			const workingDir = this._workspaceRoot || process.cwd();
			logger.info(`[ClaudeSDKService] Using cwd for SDK: "${workingDir}"`);

			const sdkOptions = {
				mcpServers,
				canUseTool: this._permissionsBroker.getToolCallback(options.sessionId || 'default'),
				abortController: this._abortController,
				includePartialMessages: true,
				cwd: workingDir,
				// Default to true for persistence unless overridden
				persistSession: true,
				// Pass environment variables (with proxy config if enabled)
				env,
				// Use Claude Code's system prompt which includes context about working directory
				// This is required for the model to know where to create/edit files
				systemPrompt: { type: 'preset', preset: 'claude_code' },
				// Load project-level settings (CLAUDE.md, etc.) but not user settings
				// to prevent conflicts with proxy models while keeping workspace context
				settingSources: ['project'],
				// Permission mode options:
				// - 'default': Use canUseTool callback for all tools (our custom UI flow)
				// - 'acceptEdits': Auto-accept Write/Edit, still ask for Bash
				// - 'bypassPermissions': Skip ALL permission checks (dangerous!)
				// Using 'default' to enable our custom permission UI
				permissionMode: 'default',
			} as Record<string, unknown>;

			// Set model if specified (for proxy or direct use)
			if (options.selectedModel && options.selectedModel !== 'default') {
				sdkOptions.model = options.selectedModel;
			}

			// Handle session resumption
			if (options.sessionId) {
				const cliSessionId = this._sessionMap.get(options.sessionId);
				if (cliSessionId) {
					(sdkOptions as Record<string, unknown>).resume = cliSessionId;
					logger.debug(
						`[ClaudeSDKService] Resuming session: ${cliSessionId} (UI: ${options.sessionId})`,
					);
				} else {
					logger.debug(
						`[ClaudeSDKService] No CLI session mapping found for UI session: ${options.sessionId}. Starting new session.`,
					);
				}
			}

			const sdk = await import('@anthropic-ai/claude-agent-sdk');
			this._currentQuery = sdk.query({
				prompt: options.message,
				options: sdkOptions,
			});

			for await (const rawMessage of this._currentQuery as AsyncIterable<unknown>) {
				const message = rawMessage as { session_id?: string } & Record<string, unknown>;
				// Capture CLI Session ID mapping
				if (message.session_id && options.sessionId) {
					if (!this._sessionMap.has(options.sessionId)) {
						this._sessionMap.set(options.sessionId, message.session_id);
						logger.debug(
							`[ClaudeSDKService] Mapped session: ${options.sessionId} -> ${message.session_id}`,
						);
					}
				}

				const data = transformSDKMessage(
					message as unknown as Parameters<typeof transformSDKMessage>[0],
				);
				if (data) {
					onData(data);
				}
			}

			onClose(0, '');
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			onError(err);
			// Ensure we close if error happens
			onClose(1, err.message);
		}
	}

	public async stopProcess(_sessionId?: string): Promise<boolean> {
		if (this._abortController) {
			this._abortController.abort();
			this._abortController = undefined;
			return true;
		}
		return false;
	}

	public isProcessRunning(_sessionId?: string): boolean {
		// Approximate check
		return !!this._abortController && !this._abortController.signal.aborted;
	}

	public async dispose(): Promise<void> {
		if (this._abortController) {
			this._abortController.abort();
		}
		// Stop the proxy server if running
		const proxyServer = getProxyServer();
		if (proxyServer.isRunning()) {
			await proxyServer.stop();
			logger.info('[ClaudeSDKService] Proxy server stopped on dispose');
		}
	}

	/**
	 * Reload MCP configuration for the Claude SDK.
	 * If a query is currently streaming, updates servers via Query.setMcpServers().
	 */
	public async reloadMcpConfig(): Promise<void> {
		const mcpServers = await this._loadMcpServers();
		const activeQuery = this._currentQuery as unknown as {
			setMcpServers?: (servers: Record<string, unknown>) => Promise<unknown>;
		};
		if (activeQuery?.setMcpServers) {
			try {
				await activeQuery.setMcpServers(mcpServers);
				logger.info('[ClaudeSDKService] MCP servers updated on active query');
			} catch (e) {
				logger.warn('[ClaudeSDKService] Failed to update MCP servers on active query:', e);
			}
		}
	}

	// Required by ICLIService
	public getCurrentSessionId(): string | null {
		return null;
	}
	public getCurrentSessionTitle(): string {
		return 'Claude';
	}
	public async createSession(): Promise<string> {
		return 'new-session';
	} // Dummy
	// biome-ignore lint/suspicious/noExplicitAny: interface implementation requires strict match or compatible return
	public async listSessions(): Promise<any[]> {
		return [];
	}
	// biome-ignore lint/suspicious/noExplicitAny: interface implementation
	public async switchSession(_sessionId: string): Promise<any> {
		return {};
	}
	// biome-ignore lint/suspicious/noExplicitAny: interface implementation
	public async getMessages(_sessionId: string): Promise<any[]> {
		return [];
	}
	public async abortSession(sessionId?: string): Promise<void> {
		this.stopProcess(sessionId);
	}
	// biome-ignore lint/suspicious/noExplicitAny: interface implementation
	public async getAgents(): Promise<any[]> {
		return [];
	}
	// biome-ignore lint/suspicious/noExplicitAny: interface implementation
	public async respondToPermission(_id: string, _response: any, _message?: string): Promise<void> {
		// SDK permissions handled via callback
	}

	private async _loadMcpServers(): Promise<Record<string, unknown>> {
		try {
			const agentsConfig = await this._agentsConfigService.loadProjectConfig();
			if (!agentsConfig) return {};
			const registry = agentsConfigToUnifiedRegistry(agentsConfig);
			return buildClaudeMcpServersJson(registry).mcpServers as unknown as Record<string, unknown>;
		} catch (e) {
			logger.error('[ClaudeSDKService] Failed to load MCP config:', e);
			return {};
		}
	}

	/**
	 * Run a simple prompt and get a text response (no streaming, no session).
	 * Used for utility tasks like Prompt Improver.
	 */
	public async runSimplePrompt(
		prompt: string,
		options?: {
			model?: string;
			timeoutMs?: number;
			proxyConfig?: {
				enabled: boolean;
				baseUrl: string;
				apiKey?: string;
				useSingleModel?: boolean;
				haikuModel?: string;
				sonnetModel?: string;
				opusModel?: string;
				subagentModel?: string;
			};
		},
	): Promise<string> {
		const timeout = options?.timeoutMs || 60000;

		// Build environment with proxy config if needed
		const proxyEnv = options?.proxyConfig
			? await buildProxyEnvironment({
					message: prompt,
					selectedModel: options.model,
					proxyConfig: options.proxyConfig,
				})
			: null;
		const env = proxyEnv || process.env;

		const abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController.abort(), timeout);

		try {
			const sdk = await import('@anthropic-ai/claude-agent-sdk');

			const sdkOptions: Record<string, unknown> = {
				abortController,
				cwd: this._workspaceRoot || process.cwd(),
				env,
				// Disable tools for simple prompts - we just want text output
				tools: [],
				// Don't persist these utility sessions
				persistSession: false,
				// Use minimal system prompt
				systemPrompt: { type: 'preset', preset: 'claude_code' },
				settingSources: ['project'],
			};

			// When proxy is enabled, model is passed via ANTHROPIC_MODEL env var (set in buildProxyEnvironment)
			// Only set sdkOptions.model for non-proxy scenarios with valid Anthropic models
			const hasProxy = !!options?.proxyConfig?.enabled;
			if (!hasProxy && options?.model && options.model !== 'default') {
				sdkOptions.model = options.model;
			}

			logger.debug(
				`[ClaudeSDKService] runSimplePrompt: proxy=${hasProxy}, model=${options?.model}, env.ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL}`,
			);

			let resultText = '';

			// Use query with print mode behavior - collect all text
			const query = sdk.query({
				prompt,
				options: sdkOptions,
			});

			for await (const message of query) {
				if (message.type === 'assistant' && message.message?.content) {
					for (const block of message.message.content) {
						if (block.type === 'text' && block.text) {
							resultText += block.text;
						}
					}
				}
			}

			return resultText.trim();
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`[ClaudeSDKService] runSimplePrompt failed: ${errorMsg}`);
			throw new Error(`Claude Code process exited with code 1: ${errorMsg}`);
		} finally {
			clearTimeout(timeoutId);
		}
	}
}
