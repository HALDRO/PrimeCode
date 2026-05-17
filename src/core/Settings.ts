/**
 * @file Settings
 * @description Unified settings manager for PrimeCode.
 * Manages VS Code workspace/user settings.
 */

import * as vscode from 'vscode';
import { normalizeDriveLetter } from '../utils/path';

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
	'proxy.useSingleModel'?: boolean;
	'proxy.haikuModel'?: string;
	'proxy.sonnetModel'?: string;
	'proxy.opusModel'?: string;
	'proxy.subagentModel'?: string;

	'opencode.autoStart'?: boolean;
	'opencode.serverTimeout'?: number;
	'opencode.serverUrl'?: string;
	'opencode.agent'?: string;
	'opencode.enabledModels': string[];
	'opencode.providerModelVisibility'?: Record<string, boolean | undefined>;

	'providers.disabled': string[];

	'promptImprove.model'?: string;
	'promptImprove.template'?: string;
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
		return this.config.get<T>(key);
	}

	async update<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		// Always write to Global settings to avoid polluting project-specific .vscode/settings.json
		await this.config.update(key, value, vscode.ConfigurationTarget.Global);
		// Refresh cached config to reflect the update immediately
		this.config = vscode.workspace.getConfiguration('primeCode');
	}

	async set<T>(key: keyof PrimeCodeSettings, value: T): Promise<void> {
		await this.update(key, value);
	}

	getAll(): PrimeCodeSettings {
		return {
			provider: 'opencode',
			model: this.get('model'),
			'access.autoApprove': this.get('access.autoApprove') || false,
			mcpServers: this.get('mcpServers') ?? {},

			'proxy.endpoints': this.get('proxy.endpoints') ?? [],
			'proxy.useSingleModel': this.get('proxy.useSingleModel'),
			'proxy.haikuModel': this.get('proxy.haikuModel'),
			'proxy.sonnetModel': this.get('proxy.sonnetModel'),
			'proxy.opusModel': this.get('proxy.opusModel'),
			'proxy.subagentModel': this.get('proxy.subagentModel'),

			'opencode.autoStart': this.get('opencode.autoStart'),
			'opencode.serverTimeout': this.get('opencode.serverTimeout'),
			'opencode.serverUrl': this.get('opencode.serverUrl'),
			'opencode.agent': this.get('opencode.agent'),
			'opencode.enabledModels': this.get('opencode.enabledModels') ?? [],
			'opencode.providerModelVisibility': this.get('opencode.providerModelVisibility'),

			'providers.disabled': this.get('providers.disabled') ?? [],

			'promptImprove.model': this.get('promptImprove.model'),
			'promptImprove.template': this.get('promptImprove.template'),
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
