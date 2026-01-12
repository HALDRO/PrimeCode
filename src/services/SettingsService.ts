/**
 * @file Settings management service for extension configuration
 * @description Handles reading and writing VS Code configuration settings,
 * custom snippets, model selection, and terminal command execution.
 * Supports both Claude Code and OpenCode CLI providers.
 * Integrates with ErrorService for centralized error handling.
 *
 * NOTE: Provider resolution is delegated to ProviderResolver for consistency.
 */

import * as vscode from 'vscode';
import type { ClaudeSettings, PlatformInfo } from '../types';
import { ErrorCode, ExtensionError, errorService } from './ErrorService';
import { type CLIProviderType, getGlobalProvider, isOpenCode } from './ProviderResolver';

export class SettingsService {
	private _selectedModel: string;

	constructor(private readonly _context: vscode.ExtensionContext) {
		const savedModel = this._context.workspaceState.get<string>('chat.selectedModel', 'default');

		// Validate saved model format against current provider
		// OpenCode requires "providerId/modelId" format, Claude uses plain model IDs
		const provider = getGlobalProvider();
		if (provider === 'opencode' && savedModel !== 'default') {
			// For OpenCode, model must contain "/" (e.g., "anthropic/claude-sonnet-4" or "oai/[Kiro] model")
			// Models without "/" are from Claude provider and are incompatible
			if (!savedModel.includes('/')) {
				// Reset to default - user will need to select a model from OpenCode provider list
				this._selectedModel = 'default';
				this._context.workspaceState.update('chat.selectedModel', 'default');
			} else {
				this._selectedModel = savedModel;
			}
		} else {
			this._selectedModel = savedModel;
		}
	}

	public get selectedModel(): string {
		return this._selectedModel;
	}

	/**
	 * Get the current CLI provider.
	 * Delegates to ProviderResolver for consistency.
	 */
	public getProvider(): CLIProviderType {
		return getGlobalProvider();
	}

	/**
	 * Check if the current provider is OpenCode.
	 * Delegates to ProviderResolver for consistency.
	 */
	public isOpenCodeProvider(): boolean {
		return isOpenCode();
	}

	public getCurrentSettings(): ClaudeSettings {
		const config = vscode.workspace.getConfiguration('primeCode');
		return {
			provider: getGlobalProvider(),
			'proxy.baseUrl': config.get<string>('proxy.baseUrl', 'http://localhost:11434'),
			'proxy.apiKey': config.get<string>('proxy.apiKey', ''),
			'proxy.enabledModels': config.get<string[]>('proxy.enabledModels', []),
			'proxy.useSingleModel': config.get<boolean>('proxy.useSingleModel', true),
			'proxy.haikuModel': config.get<string>('proxy.haikuModel', ''),
			'proxy.sonnetModel': config.get<string>('proxy.sonnetModel', ''),
			'proxy.opusModel': config.get<string>('proxy.opusModel', ''),
			'proxy.subagentModel': config.get<string>('proxy.subagentModel', ''),
			'opencode.autoStart': config.get<boolean>('opencode.autoStart', true),
			'opencode.serverTimeout': config.get<number>('opencode.serverTimeout', 15000),
			'opencode.agent': config.get<string>('opencode.agent', ''),
			'opencode.enabledModels': config.get<string[]>('opencode.enabledModels', []),
			'providers.disabled': config.get<string[]>('providers.disabled', []),
			'promptImprove.model': config.get<string>('promptImprove.model', ''),
			'promptImprove.template': config.get<string>('promptImprove.template', ''),
			'promptImprove.timeoutMs': config.get<number>('promptImprove.timeoutMs', 60000),
		};
	}

	public async updateSettings(settings: Partial<ClaudeSettings>): Promise<void> {
		const config = vscode.workspace.getConfiguration('primeCode');

		try {
			for (const [key, value] of Object.entries(settings)) {
				await config.update(key, value, vscode.ConfigurationTarget.Global);
			}
		} catch (error) {
			const settingsError = new ExtensionError(
				error instanceof Error ? error.message : String(error),
				ErrorCode.VALIDATION_INVALID_INPUT,
				'Failed to update settings. Please check your configuration.',
				{ settings },
			);
			errorService.handle(settingsError, 'SettingsService.updateSettings');
			errorService.showError(settingsError);
		}
	}

	public async setProvider(provider: CLIProviderType): Promise<void> {
		await this.updateSettings({ provider: provider });
	}

	public setSelectedModel(model: string): void {
		this._selectedModel = model;
		this._context.workspaceState.update('chat.selectedModel', model);
	}

	public getPlatformInfo(): PlatformInfo {
		return {
			platform: process.platform,
			isWindows: process.platform === 'win32',
		};
	}

	public openModelTerminal(currentSessionId?: string): void {
		if (this.isOpenCodeProvider()) {
			// Model selection for OpenCode is configured in opencode.json - no action needed
			return;
		}
		this._runInTerminal(['/model', ...(currentSessionId ? ['--resume', currentSessionId] : [])]);
	}

	public executeSlashCommand(command: string, currentSessionId?: string): void {
		if (this.isOpenCodeProvider()) {
			this._runOpenCodeCommand(command);
			return;
		}
		this._runInTerminal([
			`/${command}`,
			...(currentSessionId ? ['--resume', currentSessionId] : []),
		]);
	}

	private _runInTerminal(args: string[]): void {
		const terminal = vscode.window.createTerminal('PrimeCode Claude');
		terminal.sendText(`claude ${args.join(' ')}`);
		terminal.show();
	}

	private _runOpenCodeCommand(command: string): void {
		const terminal = vscode.window.createTerminal('PrimeCode OpenCode');
		terminal.sendText(`opencode ${command}`);
		terminal.show();
	}
}
