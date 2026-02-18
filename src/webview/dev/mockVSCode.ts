/**
 * @file Mock VS Code API for browser development
 * @description Replays real OpenCode session dumps from docs/debug/*.json.
 *              Uses unified session_event / session_lifecycle protocol.
 */

import type { VSCodeApi } from '../../common';
import {
	createDumpPlayer,
	type DumpPlayer,
	getAvailableDumps,
	loadDumpFromUrl,
	type PlaybackConfig,
} from './sessionDumpPlayer';

declare global {
	interface Window {
		vscode?: VSCodeApi;
		acquireVsCodeApi?: () => VSCodeApi;
	}
}

interface MockMessage {
	type: 'session_event' | 'session_lifecycle';
	delay?: number;
	targetId?: string;
	eventType?: string;
	payload?: unknown;
	timestamp?: number;
	action?: 'created' | 'closed' | 'switched' | 'cleared';
	sessionId?: string;
	data?: Record<string, unknown>;
}

let mockState: Record<string, unknown> = {};
let activeTimers: NodeJS.Timeout[] = [];
const mockActiveSessionId = 'premium-dev-session';
let isScenarioRunning = false;
let isLaunched = false;
let activeDumpPlayer: DumpPlayer | null = null;

function createId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Dispatch helpers ─────────────────────────────────────────────────────────

function dispatchSessionEvent(
	targetId: string,
	eventType: string,
	payload: Record<string, unknown>,
): void {
	window.postMessage(
		{
			type: 'session_event',
			targetId,
			eventType,
			payload: { eventType, ...payload },
			timestamp: Date.now(),
		},
		'*',
	);
}

function dispatchSessionLifecycle(
	action: 'created' | 'closed' | 'switched' | 'cleared',
	sessionId: string,
	data?: Record<string, unknown>,
): void {
	window.postMessage({ type: 'session_lifecycle', action, sessionId, data }, '*');
}

function dispatchMessage(targetId: string, message: Record<string, unknown>): void {
	dispatchSessionEvent(targetId, 'message', { message });
}

function dispatchStatus(
	targetId: string,
	status: 'idle' | 'busy' | 'error' | 'retrying',
	statusText?: string,
): void {
	dispatchSessionEvent(targetId, 'status', { status, statusText });
}

function dispatchRestore(targetId: string, action: string, data?: Record<string, unknown>): void {
	dispatchSessionEvent(targetId, 'restore', { action, ...data });
}

function dispatchGlobalMessage(type: string, data?: unknown): void {
	window.postMessage({ type, data }, '*');
}

function clearAllMockTimers(): void {
	for (const timer of activeTimers) clearTimeout(timer);
	activeTimers = [];
}

async function runScenario(messages: MockMessage[], clearSession = false): Promise<void> {
	clearAllMockTimers();
	isScenarioRunning = true;
	if (clearSession) {
		dispatchSessionLifecycle('cleared', mockActiveSessionId);
		await new Promise(r => setTimeout(r, 100));
	}
	dispatchStatus(mockActiveSessionId, 'busy', 'Processing...');
	await new Promise(r => setTimeout(r, 100));
	for (const msg of messages) {
		if (!isScenarioRunning) break;
		await new Promise(resolve => {
			const timer = setTimeout(() => {
				if (msg.type === 'session_event' && msg.targetId && msg.eventType && msg.payload) {
					window.postMessage(
						{
							type: 'session_event',
							targetId: msg.targetId,
							eventType: msg.eventType,
							payload: msg.payload,
							timestamp: msg.timestamp || Date.now(),
						},
						'*',
					);
				} else if (msg.type === 'session_lifecycle' && msg.action && msg.sessionId) {
					window.postMessage(
						{
							type: 'session_lifecycle',
							action: msg.action,
							sessionId: msg.sessionId,
							data: msg.data,
						},
						'*',
					);
				}
				resolve(null);
			}, msg.delay || 600);
			activeTimers.push(timer);
		});
	}
	dispatchStatus(mockActiveSessionId, 'idle', 'Ready');
	isScenarioRunning = false;
}

// ── Session Dump Loader ──────────────────────────────────────────────────────

async function loadAndPlayDump(config?: Partial<PlaybackConfig>): Promise<void> {
	const dumps = getAvailableDumps();
	if (dumps.length === 0) {
		console.log('[Mock] No dumps available');
		return;
	}
	const urlParams = new URLSearchParams(window.location.search);
	const dumpParam = urlParams.get('dump');
	const selectedDump = dumpParam
		? dumps.find(d => d.path.includes(dumpParam)) || dumps[0]
		: dumps[0];
	try {
		console.log(`[Mock] Loading dump: ${selectedDump.name}`);
		const dump = await loadDumpFromUrl(selectedDump.path);
		activeDumpPlayer = createDumpPlayer(dump, mockActiveSessionId, {
			speed: Number(urlParams.get('speed')) || 2,
			...config,
		});
		console.log(
			`[Mock] "${activeDumpPlayer.title}" — ${activeDumpPlayer.messageCount} msgs, ${activeDumpPlayer.childCount} children`,
		);
		const timeline = activeDumpPlayer.getMergedTimeline();
		console.log(`[Mock] Playing ${timeline.length} events...`);
		await runScenario(timeline, true);
	} catch (err) {
		console.error('[Mock] Failed to load dump:', err);
	}
}

// ── API Mock Implementation ──────────────────────────────────────────────────

const mockVSCodeApi: VSCodeApi = {
	postMessage: (message: unknown) => {
		const msg = message as { type: string; text?: string; data?: Record<string, unknown> };
		console.log('[Mock] Received:', msg.type);

		if (msg.type === 'sendMessage') {
			const userContent =
				msg.text || (msg.data?.text as string) || (msg.data?.message as string) || 'Follow-up';
			const uid = createId('user');
			runScenario(
				[
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: uid,
								type: 'user',
								content: userContent,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 100,
					},
					{
						type: 'session_event',
						targetId: mockActiveSessionId,
						eventType: 'message',
						payload: {
							eventType: 'message',
							message: {
								id: createId('a'),
								type: 'assistant',
								content: `Echo: "${userContent.slice(0, 80)}"`,
								timestamp: new Date().toISOString(),
							},
						},
						timestamp: Date.now(),
						delay: 400,
					},
				],
				false,
			);
		} else if (msg.type === 'stopRequest') {
			isScenarioRunning = false;
			clearAllMockTimers();
			dispatchStatus(mockActiveSessionId, 'idle', 'Stopped');
			dispatchMessage(mockActiveSessionId, {
				type: 'interrupted',
				content: 'Stopped by user',
				id: createId('int'),
				timestamp: new Date().toISOString(),
			});
		} else if (msg.type === 'resumeAfterError') {
			console.log('[Mock] Resume — no-op in dump mode');
		} else if (msg.type === 'dismissError') {
			const { messageId, sessionId } = msg as unknown as { messageId?: string; sessionId?: string };
			if (messageId)
				dispatchSessionEvent(sessionId || mockActiveSessionId, 'complete', {
					partId: messageId,
					removed: true,
					messageId,
				});
		} else if (msg.type === 'accessResponse') {
			const { id, approved, alwaysAllow } = msg as unknown as {
				id?: string;
				approved?: boolean;
				alwaysAllow?: boolean;
			};
			if (id && approved !== undefined)
				dispatchSessionEvent(mockActiveSessionId, 'access', {
					action: 'response',
					requestId: id,
					approved,
					alwaysAllow,
				});
		} else if (msg.type === 'createSession') {
			setTimeout(() => dispatchSessionLifecycle('created', createId('session')), 100);
		} else if (msg.type === 'switchSession') {
			dispatchSessionLifecycle('switched', (msg as unknown as { sessionId: string }).sessionId);
		} else if (msg.type === 'closeSession') {
			dispatchSessionLifecycle('closed', (msg as unknown as { sessionId: string }).sessionId);
		} else if (msg.type === 'webviewDidLaunch') {
			if (isLaunched) return;
			isLaunched = true;
			setTimeout(() => {
				dispatchSessionLifecycle('created', mockActiveSessionId);
				dispatchSessionLifecycle('switched', mockActiveSessionId, {
					isProcessing: false,
					totalStats: {
						contextTokens: 0,
						outputTokens: 0,
						totalTokens: 0,
						cacheReadTokens: 0,
						reasoningTokens: 0,
						requestCount: 0,
						totalDuration: 0,
					},
				});
				dispatchStatus(mockActiveSessionId, 'idle', 'Ready');
				dispatchSessionEvent(mockActiveSessionId, 'session_info', {
					data: {
						sessionId: mockActiveSessionId,
						tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'LS', 'TodoWrite'],
						mcpServers: [],
					},
				});
				dispatchGlobalMessage('openCodeModelSet', { model: 'anthropic/claude-opus-4-5' });
				dispatchGlobalMessage('workspaceInfo', { name: 'primecode' });
				dispatchGlobalMessage('workspaceFiles', [
					{ path: 'src/App.tsx', name: 'App.tsx', fsPath: 'C:\\src\\App.tsx' },
					{ path: 'package.json', name: 'package.json', fsPath: 'C:\\package.json' },
				]);
				loadAndPlayDump();
			}, 300);
		} else if (msg.type === 'getSettings') {
			dispatchGlobalMessage('settingsData', {
				provider: 'opencode',
				'primeCode.baseUrl': 'http://localhost:11434',
				'primeCode.apiKey': '',
				'primeCode.enabledModels': [],
				'opencode.agent': '',
				'opencode.enabledModels': ['anthropic/claude-opus-4-5', 'google/gemini-2.0-flash'],
				'providers.disabled': [],
			});
			dispatchGlobalMessage('platformInfo', { platform: 'win32', isWindows: true });
		} else if (msg.type === 'checkDiscoveryStatus') {
			dispatchGlobalMessage('discoveryStatus', {
				rules: { hasAgentsMd: true, ruleFiles: ['.opencode/rules/base.md'] },
				permissions: { openCodeConfig: 'opencode.json' },
				skills: [],
				hooks: [],
			});
		} else if (msg.type === 'getRules') {
			dispatchGlobalMessage('ruleList', {
				rules: [
					{ name: 'base.md', path: '.opencode/rules/base.md', isEnabled: true, source: 'opencode' },
				],
			});
		} else if (msg.type === 'toggleRule') {
			const { path: rp, enabled } = msg as unknown as { path: string; enabled: boolean };
			if (rp) {
				dispatchGlobalMessage('ruleUpdated', {
					rule: { name: rp.split('/').pop(), path: rp, isEnabled: enabled, source: 'opencode' },
				});
				mockVSCodeApi.postMessage({ type: 'getRules' });
			}
		} else if (msg.type === 'createRule') {
			const { name } = msg as unknown as { name: string };
			dispatchGlobalMessage('ruleUpdated', {
				rule: {
					name: name ?? 'new-rule.md',
					path: `.opencode/rules/${name ?? 'new-rule.md'}`,
					isEnabled: true,
					source: 'opencode',
				},
			});
		} else if (msg.type === 'getPermissions') {
			dispatchGlobalMessage('permissionsUpdated', {
				policies: { edit: 'allow', terminal: 'allow', network: 'allow' },
			});
		} else if (msg.type === 'setPermissions') {
			const { policies } = msg as unknown as { policies: Record<string, string> };
			if (policies) dispatchGlobalMessage('permissionsUpdated', { policies });
		} else if (msg.type === 'reloadAllProviders') {
			mockVSCodeApi.postMessage({ type: 'loadOpenCodeProviders' });
			mockVSCodeApi.postMessage({ type: 'loadAvailableProviders' });
		} else if (msg.type === 'loadOpenCodeProviders') {
			dispatchGlobalMessage('openCodeProviders', {
				providers: [
					{
						id: 'anthropic',
						name: 'Anthropic',
						isCustom: false,
						models: [
							{
								id: 'claude-opus-4-5',
								name: 'Claude Opus 4.5',
								reasoning: true,
								limit: { context: 200000 },
							},
							{
								id: 'claude-sonnet-4-5',
								name: 'Claude Sonnet 4.5',
								reasoning: true,
								limit: { context: 200000 },
							},
						],
					},
					{
						id: 'google',
						name: 'Google AI',
						isCustom: false,
						models: [
							{
								id: 'gemini-2.0-flash',
								name: 'Gemini 2.0 Flash',
								reasoning: true,
								limit: { context: 200000 },
							},
						],
					},
				],
				config: { isLoading: false },
			});
		} else if (msg.type === 'loadAvailableProviders') {
			dispatchGlobalMessage('availableProviders', {
				providers: [
					{ id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] },
					{ id: 'openrouter', name: 'OpenRouter', env: ['OPENROUTER_API_KEY'] },
					{ id: 'mistral', name: 'Mistral AI', env: ['MISTRAL_API_KEY'] },
					{ id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'] },
				],
			});
		} else if (msg.type === 'loadProxyModels') {
			setTimeout(
				() =>
					dispatchGlobalMessage('proxyModels', {
						models: [{ id: 'gpt-4o', name: 'GPT-4o', contextLength: 228000 }],
						baseUrl: 'http://localhost:11434',
					}),
				500,
			);
		} else if (msg.type === 'checkOpenCodeStatus') {
			dispatchGlobalMessage('openCodeStatus', { installed: true, version: '0.1.0' });
		} else if (msg.type === 'getAccess') {
			dispatchGlobalMessage('accessData', []);
		} else if (msg.type === 'getCommands') {
			dispatchGlobalMessage('commandsList', { custom: [], isLoading: false });
		} else if (msg.type === 'setOpenCodeProviderAuth') {
			const { providerId } = msg as unknown as { providerId: string };
			setTimeout(() => {
				dispatchGlobalMessage('openCodeAuthResult', {
					providerId,
					isLoading: false,
					success: true,
				});
				setTimeout(() => mockVSCodeApi.postMessage({ type: 'reloadAllProviders' }), 500);
			}, 1000);
		} else if (msg.type === 'updateSettings') {
			const settings = (msg as unknown as { settings: Record<string, unknown> }).settings || {};
			if (settings.provider) {
				dispatchGlobalMessage('settingsData', { provider: settings.provider });
				if (settings.provider === 'opencode')
					setTimeout(() => mockVSCodeApi.postMessage({ type: 'reloadAllProviders' }), 100);
			}
		} else if (msg.type === 'restoreCommit') {
			const data = msg.data as
				| { messageId: string; sessionId: string; associatedMessageId?: string }
				| string
				| undefined;
			setTimeout(() => {
				const sid = typeof data === 'object' && data ? data.sessionId : mockActiveSessionId;
				if (typeof data === 'object' && data && 'associatedMessageId' in data) {
					dispatchSessionEvent(sid, 'delete_messages_after', {
						messageId: data.associatedMessageId,
					});
					dispatchRestore(sid, 'success', { message: 'Files restored.', canUnrevert: true });
					dispatchRestore(sid, 'unrevert_available', { available: true });
					dispatchRestore(sid, 'set_commits', { commits: [] });
				}
			}, 300);
		} else if (msg.type === 'unrevert') {
			const data = msg.data as { sessionId: string } | undefined;
			setTimeout(() => {
				if (data?.sessionId) {
					dispatchSessionEvent(data.sessionId, 'messages_reload', {
						messages: [
							{
								type: 'assistant',
								content: 'Previous response restored',
								id: createId('a'),
								timestamp: new Date().toISOString(),
							},
						],
					});
					dispatchRestore(data.sessionId, 'success', { message: 'Restored', canUnrevert: false });
					dispatchRestore(data.sessionId, 'unrevert_available', { available: false });
				}
			}, 300);
		}
	},
	getState: () => mockState,
	setState: (state: unknown) => {
		mockState = state as Record<string, unknown>;
	},
};

// ── Init & CSS Theme ─────────────────────────────────────────────────────────

export function initMockVSCode(): void {
	window.vscode = mockVSCodeApi;
	window.acquireVsCodeApi = () => mockVSCodeApi;
	const s = document.documentElement.style;
	const t: Record<string, string> = {
		'--vscode-font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
		'--vscode-editor-font-family': '"SF Mono", Monaco, Menlo, Consolas, monospace',
		'--vscode-font-size': '13px',
		'--vscode-editor-font-size': '13px',
		'--vscode-foreground': '#CCCCCC',
		'--vscode-descriptionForeground': '#9D9D9D',
		'--vscode-disabledForeground': '#6E7681',
		'--vscode-errorForeground': '#F85149',
		'--vscode-icon-foreground': '#CCCCCC',
		'--vscode-editor-background': '#1F1F1F',
		'--vscode-editor-foreground': '#CCCCCC',
		'--vscode-sideBar-background': '#181818',
		'--vscode-sideBar-foreground': '#CCCCCC',
		'--vscode-sideBar-border': '#2B2B2B',
		'--vscode-sideBarTitle-foreground': '#CCCCCC',
		'--vscode-sideBarSectionHeader-background': '#181818',
		'--vscode-sideBarSectionHeader-foreground': '#CCCCCC',
		'--vscode-sideBarSectionHeader-border': '#2B2B2B',
		'--vscode-panel-background': '#181818',
		'--vscode-panel-border': '#2B2B2B',
		'--vscode-input-background': '#313131',
		'--vscode-input-foreground': '#CCCCCC',
		'--vscode-input-border': '#3C3C3C',
		'--vscode-input-placeholderForeground': '#989898',
		'--vscode-inputOption-activeBackground': '#2489DB82',
		'--vscode-inputOption-activeBorder': '#2488DB',
		'--vscode-button-background': '#0078D4',
		'--vscode-button-foreground': '#FFFFFF',
		'--vscode-button-hoverBackground': '#026EC1',
		'--vscode-button-border': '#FFFFFF12',
		'--vscode-button-secondaryBackground': '#313131',
		'--vscode-button-secondaryForeground': '#CCCCCC',
		'--vscode-button-secondaryHoverBackground': '#3C3C3C',
		'--vscode-dropdown-background': '#313131',
		'--vscode-dropdown-foreground': '#CCCCCC',
		'--vscode-dropdown-border': '#3C3C3C',
		'--vscode-dropdown-listBackground': '#1F1F1F',
		'--vscode-list-hoverBackground': '#2A2D2E',
		'--vscode-list-activeSelectionBackground': '#04395E',
		'--vscode-list-activeSelectionForeground': '#FFFFFF',
		'--vscode-list-inactiveSelectionBackground': '#37373D',
		'--vscode-list-focusBackground': '#04395E',
		'--vscode-focusBorder': '#0078D4',
		'--vscode-widget-border': '#313131',
		'--vscode-contrastBorder': '#2B2B2B',
		'--vscode-textLink-foreground': '#4DAAFC',
		'--vscode-textLink-activeForeground': '#4DAAFC',
		'--vscode-toolbar-hoverBackground': '#5A5D5E50',
		'--vscode-badge-background': '#616161',
		'--vscode-badge-foreground': '#F8F8F8',
		'--vscode-activityBar-background': '#181818',
		'--vscode-activityBar-foreground': '#D7D7D7',
		'--vscode-activityBar-inactiveForeground': '#868686',
		'--vscode-activityBar-border': '#2B2B2B',
		'--vscode-activityBar-activeBorder': '#0078D4',
		'--vscode-activityBarBadge-background': '#0078D4',
		'--vscode-activityBarBadge-foreground': '#FFFFFF',
		'--vscode-checkbox-background': '#313131',
		'--vscode-checkbox-border': '#3C3C3C',
		'--vscode-tab-activeBackground': '#1F1F1F',
		'--vscode-tab-activeForeground': '#FFFFFF',
		'--vscode-tab-inactiveBackground': '#181818',
		'--vscode-tab-inactiveForeground': '#9D9D9D',
		'--vscode-tab-border': '#2B2B2B',
		'--vscode-tab-activeBorderTop': '#0078D4',
		'--vscode-tab-hoverBackground': '#1F1F1F',
		'--vscode-titleBar-activeBackground': '#181818',
		'--vscode-titleBar-activeForeground': '#CCCCCC',
		'--vscode-titleBar-inactiveBackground': '#1F1F1F',
		'--vscode-titleBar-inactiveForeground': '#9D9D9D',
		'--vscode-titleBar-border': '#2B2B2B',
		'--vscode-statusBar-background': '#181818',
		'--vscode-statusBar-foreground': '#CCCCCC',
		'--vscode-statusBar-border': '#2B2B2B',
		'--vscode-statusBarItem-hoverBackground': '#F1F1F133',
		'--vscode-statusBarItem-hoverForeground': '#FFFFFF',
		'--vscode-editorWidget-background': '#202020',
		'--vscode-editorWidget-foreground': '#CCCCCC',
		'--vscode-editorWidget-border': '#313131',
		'--vscode-notifications-background': '#1F1F1F',
		'--vscode-notifications-foreground': '#CCCCCC',
		'--vscode-notifications-border': '#2B2B2B',
		'--vscode-notificationCenterHeader-background': '#1F1F1F',
		'--vscode-notificationCenterHeader-foreground': '#CCCCCC',
		'--vscode-quickInput-background': '#222222',
		'--vscode-quickInput-foreground': '#CCCCCC',
		'--vscode-menu-background': '#1F1F1F',
		'--vscode-menu-foreground': '#CCCCCC',
		'--vscode-menu-selectionBackground': '#0078D4',
		'--vscode-menu-selectionForeground': '#FFFFFF',
		'--vscode-scrollbarSlider-background': '#79797966',
		'--vscode-scrollbarSlider-hoverBackground': '#646464B3',
		'--vscode-scrollbarSlider-activeBackground': '#BFBFBF66',
		'--vscode-terminal-foreground': '#CCCCCC',
		'--vscode-terminal-background': '#181818',
		'--vscode-textBlockQuote-background': '#2B2B2B',
		'--vscode-textBlockQuote-border': '#616161',
		'--vscode-textCodeBlock-background': '#2B2B2B',
		'--vscode-textPreformat-foreground': '#D0D0D0',
		'--vscode-textPreformat-background': '#3C3C3C',
		'--vscode-progressBar-background': '#0078D4',
		'--vscode-settings-dropdownBackground': '#313131',
		'--vscode-settings-dropdownBorder': '#3C3C3C',
		'--vscode-settings-headerForeground': '#FFFFFF',
		'--vscode-welcomePage-tileBackground': '#2B2B2B',
		'--vscode-editorGutter-addedBackground': '#2EA043',
		'--vscode-editorGutter-deletedBackground': '#F85149',
		'--vscode-editorGutter-modifiedBackground': '#0078D4',
		'--vscode-editorLineNumber-foreground': '#6E7681',
		'--vscode-editorLineNumber-activeForeground': '#CCCCCC',
		'--changed-files-added': '#089981',
		'--changed-files-removed': '#f23645',
	};
	for (const [k, v] of Object.entries(t)) s.setProperty(k, v);
	console.log('[Mock] Initialized with Dark Modern theme');
}

export function addSampleMessages(): void {}
