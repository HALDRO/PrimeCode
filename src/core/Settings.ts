/**
 * @file Settings
 * @description Unified settings manager for PrimeCode.
 * Manages VS Code workspace/user settings for non-model preferences.
 * Model-related preferences (lastSelected, enabledModels, taskModels, variants,
 * visibility) are stored in ~/.config/primecode.json via primecodeConfig module
 * and injected into getAll() for seamless webview consumption.
 */

import * as vscode from 'vscode';
import { normalizeDriveLetter } from '../utils/path';
import {
	type AppSettings,
	getAppSettings,
	getModelSettings,
	updateAppSettings,
	updateModelSettings,
} from './executor/primecodeConfig';

// =============================================================================
// Types
// =============================================================================

export interface PrimeCodeSettings {
	provider: 'opencode';
	model?: string;
	'access.autoApprove': boolean;
	mcpServers: Record<string, unknown>;

	'proxy.endpoints'?: Array<{
		id: string;
		name: string;
		baseUrl: string;
		apiKey: string;
		protocol?: 'openai-compatible' | 'openai-responses' | 'anthropic';
		enabledModels: string[];
		headers?: Record<string, string>;
		modelVariants?: Record<string, string[]>;
	}>;

	'opencode.autoStart'?: boolean;
	'opencode.serverTimeout'?: number;
	'opencode.serverUrl'?: string;
	'opencode.agent'?: string;
	'opencode.enabledModels': string[];
	'opencode.providerModelVisibility'?: Record<string, boolean | undefined>;

	'providers.disabled': string[];

	'promptImprove.model'?: string;
	'promptImprove.template'?: string;

	modelVariants?: Record<string, string | undefined>;
}

// =============================================================================
// Settings Manager Interface
// =============================================================================

export interface ISettings {
	get<T>(key: keyof PrimeCodeSettings): T | undefined;
	set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void>;
	update<T>(key: keyof PrimeCodeSettings, value: T): Promise<void>;
	getAll(): PrimeCodeSettings;
	refresh(): void;
	getWorkspaceRoot(): string | undefined;
}

// =============================================================================
// Settings Manager Implementation
// =============================================================================

export class Settings implements ISettings {
	private config: vscode.WorkspaceConfiguration;
	private workspaceRoot: string | undefined;

	constructor() {
		this.config = vscode.workspace.getConfiguration('primeCode');
		const raw = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.workspaceRoot = raw ? normalizeDriveLetter(raw) : undefined;
	}

	// =============================================================================
	// VS Code Settings
	// =============================================================================

	get<T>(key: keyof PrimeCodeSettings): T | undefined {
		// Migrated model keys — read from primecodeConfig
		const models = getModelSettings();
		switch (key) {
			case 'opencode.enabledModels':
				return models.enabledModels as T;
			case 'opencode.providerModelVisibility':
				return models.providerModelVisibility as T;
			case 'modelVariants':
				return models.modelVariants as T;
			default:
				break;
		}

		// Migrated app keys — read from primecodeConfig
		const app = getAppSettings();
		switch (key) {
			case 'proxy.endpoints':
				return app.proxyEndpoints as T;
			case 'providers.disabled':
				return app.providersDisabled as T;
			case 'promptImprove.model':
				return (app.promptImproveModel || undefined) as T | undefined;
			case 'promptImprove.template':
				return (app.promptImproveTemplate || undefined) as T | undefined;
			case 'opencode.agent':
				return (app.opencodeAgent || undefined) as T | undefined;
			default:
				return this.config.get<T>(key);
		}
	}

	async update<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		// Model keys → primecodeConfig
		switch (key) {
			case 'opencode.enabledModels':
				updateModelSettings({ enabledModels: value as string[] });
				return;
			case 'opencode.providerModelVisibility':
				updateModelSettings({
					providerModelVisibility: value as Record<string, boolean | undefined>,
				});
				return;
			case 'modelVariants':
				updateModelSettings({ modelVariants: value as Record<string, string | undefined> });
				return;
			default:
				break;
		}

		// App keys → primecodeConfig
		switch (key) {
			case 'proxy.endpoints':
				updateAppSettings({ proxyEndpoints: value as AppSettings['proxyEndpoints'] });
				return;
			case 'providers.disabled':
				updateAppSettings({ providersDisabled: value as string[] });
				return;
			case 'promptImprove.model':
				updateAppSettings({ promptImproveModel: (value as string) || '' });
				return;
			case 'promptImprove.template':
				updateAppSettings({ promptImproveTemplate: (value as string) || '' });
				return;
			case 'opencode.agent':
				updateAppSettings({ opencodeAgent: (value as string) || '' });
				return;
			default:
				break;
		}

		// VS Code settings (autoStart, serverTimeout, serverUrl, access.autoApprove, mcpServers)
		await this.config.update(key, value, vscode.ConfigurationTarget.Global);
		this.config = vscode.workspace.getConfiguration('primeCode');
	}

	async set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		await this.update(key, value);
	}

	getAll(): PrimeCodeSettings {
		const models = getModelSettings();
		const app = getAppSettings();
		return {
			provider: 'opencode',
			model: this.config.get('model'),
			'access.autoApprove': this.config.get('access.autoApprove') || false,
			mcpServers: this.config.get('mcpServers') ?? {},

			'proxy.endpoints': app.proxyEndpoints,

			'opencode.autoStart': this.config.get('opencode.autoStart'),
			'opencode.serverTimeout': this.config.get('opencode.serverTimeout'),
			'opencode.serverUrl': this.config.get('opencode.serverUrl'),
			'opencode.agent': app.opencodeAgent || undefined,
			'opencode.enabledModels': models.enabledModels,
			'opencode.providerModelVisibility': models.providerModelVisibility,

			'providers.disabled': app.providersDisabled,

			'promptImprove.model': app.promptImproveModel || undefined,
			'promptImprove.template': app.promptImproveTemplate || undefined,

			modelVariants: models.modelVariants,
		};
	}

	// =============================================================================
	// Watch for Changes
	// =============================================================================

	watch(callback: () => void): vscode.Disposable {
		return vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('primeCode')) {
				callback();
			}
		});
	}

	// =============================================================================
	// Helpers
	// =============================================================================

	getWorkspaceRoot(): string | undefined {
		return this.workspaceRoot;
	}

	refresh(): void {
		this.config = vscode.workspace.getConfiguration('primeCode');
		const raw = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.workspaceRoot = raw ? normalizeDriveLetter(raw) : undefined;
	}
}
