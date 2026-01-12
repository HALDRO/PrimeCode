/**
 * @file Permissions Handler
 * @description Handles unified permission policies for Claude Code and OpenCode.
 *              Translates abstract UI policies (edit/terminal/network) into the native
 *              configuration formats of each CLI. For OpenCode, writes directly to
 *              opencode.json (not config.json) because SDK's Config.update() writes to
 *              config.json which is NOT read by OpenCode's config loader.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { OpenCodeFullConfig } from '../../services/ICLIService';
import { getOpenCodeServiceForRead, ProviderResolver } from '../../services/ProviderResolver';
import { logger } from '../../utils/logger';

// OpenCode config file structure
interface OpenCodeConfigFile {
	$schema?: string;
	permission?: {
		edit?: 'ask' | 'allow' | 'deny';
		bash?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
		skill?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>;
		webfetch?: 'ask' | 'allow' | 'deny';
		doom_loop?: 'ask' | 'allow' | 'deny';
		external_directory?: 'ask' | 'allow' | 'deny';
	};
	experimental?: {
		continue_loop_on_deny?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export type PermissionPolicyValue = 'ask' | 'allow' | 'deny';

// Defined locally to match SettingsStore policies
export interface PermissionPolicies {
	edit: PermissionPolicyValue;
	terminal: PermissionPolicyValue;
	network: PermissionPolicyValue;
}

export interface PermissionsHandlerDeps {
	postMessage: (msg: unknown) => void;
}

type ClaudePermissionTool = 'Edit' | 'Bash' | 'WebFetch';

type ClaudePermissionsBlock = {
	allow?: string[];
	ask?: string[];
	deny?: string[];
};

type ClaudeSettingsFile = {
	permissions?: ClaudePermissionsBlock;
	[key: string]: unknown;
};

export class PermissionsHandler {
	constructor(private readonly _deps: PermissionsHandlerDeps) {}

	public async getPermissions(): Promise<void> {
		const provider = ProviderResolver.getGlobalProvider();
		const workspaceRoot = ProviderResolver.getWorkspaceRoot();
		if (!workspaceRoot) return;

		let policies: PermissionPolicies = {
			edit: 'ask',
			terminal: 'ask',
			network: 'ask',
		};

		try {
			if (provider === 'opencode') {
				// Read directly from opencode.json/opencode.jsonc for consistency with OpenCode config loader
				// (OpenCode loads opencode.jsonc first, then opencode.json overrides it).
				// Also try SDK as fallback.
				const configPathJson = path.join(workspaceRoot, 'opencode.json');
				const configPathJsonc = path.join(workspaceRoot, 'opencode.jsonc');
				const localConfig =
					(await this._readJsonFile<OpenCodeConfigFile>(configPathJson)) ??
					(await this._readJsonFile<OpenCodeConfigFile>(configPathJsonc));

				// Use local config or fallback to SDK
				let permissionConfig: OpenCodeConfigFile['permission'] | undefined;

				if (localConfig?.permission) {
					permissionConfig = localConfig.permission;
				} else {
					// Fallback to SDK if local file doesn't exist
					const openCodeService = await getOpenCodeServiceForRead();
					if (openCodeService) {
						const sdkConfig = (await openCodeService.getConfig()) as OpenCodeFullConfig | undefined;
						permissionConfig = sdkConfig?.permission;
					}
				}

				if (permissionConfig) {
					policies = {
						edit: permissionConfig.edit || 'ask',
						terminal: typeof permissionConfig.bash === 'string' ? permissionConfig.bash : 'ask',
						network: permissionConfig.webfetch || 'ask',
					};
				}
			} else {
				const configPath = path.join(workspaceRoot, '.claude', 'settings.json');
				const config = await this._readJsonFile<ClaudeSettingsFile>(configPath);
				const permissions = config?.permissions;

				policies = {
					edit: this._inferClaudePolicy(permissions, 'Edit'),
					terminal: this._inferClaudePolicy(permissions, 'Bash'),
					network: this._inferClaudePolicy(permissions, 'WebFetch'),
				};
			}

			this._deps.postMessage({
				type: 'permissionsUpdated',
				data: { policies },
			});
		} catch (error) {
			logger.error('[PermissionsHandler] Error fetching permissions:', error);
		}
	}

	public async setPermissions(
		policies: PermissionPolicies,
		provider: 'claude' | 'opencode',
	): Promise<void> {
		const workspaceRoot = ProviderResolver.getWorkspaceRoot();
		if (!workspaceRoot) return;

		try {
			if (provider === 'opencode') {
				// Write directly to opencode.json in workspace root
				// IMPORTANT: SDK's Config.update() writes to config.json which is NOT read
				// by OpenCode's config loader. Only opencode.json and opencode.jsonc are loaded.
				const configPath = path.join(workspaceRoot, 'opencode.json');
				const existing = await this._readJsonFile<OpenCodeConfigFile>(configPath);
				const config: OpenCodeConfigFile = existing ?? {
					$schema: 'https://opencode.ai/config.json',
				};

				// Merge permission settings
				config.permission = {
					...(config.permission ?? {}),
					edit: policies.edit,
					bash: policies.terminal,
					webfetch: policies.network,
				};

				// Ensure model continues after permission denial (like Cursor/Claude Code behavior)
				// Without this, denying a permission stops the entire session
				config.experimental = {
					...(config.experimental ?? {}),
					continue_loop_on_deny: true,
				};

				await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
				logger.info('[PermissionsHandler] Wrote OpenCode permissions to opencode.json');

				// Restart OpenCode server to reload config.
				// Use the read service helper so we can restart even if global provider is Claude.
				const openCodeService = await getOpenCodeServiceForRead();
				if (openCodeService) {
					await openCodeService.restart();
					logger.info('[PermissionsHandler] OpenCode server restarted to apply permissions');
				} else {
					logger.info(
						'[PermissionsHandler] OpenCode service not available; permissions written to opencode.json but server was not restarted',
					);
				}
			} else {
				const configDir = path.join(workspaceRoot, '.claude');
				await fs.mkdir(configDir, { recursive: true });
				const configPath = path.join(configDir, 'settings.json');

				const config = (await this._readJsonFile<ClaudeSettingsFile>(configPath)) ?? {};
				const permissions = config.permissions;
				const existing: ClaudePermissionsBlock = {
					allow: Array.isArray(permissions?.allow) ? [...(permissions?.allow ?? [])] : [],
					ask: Array.isArray(permissions?.ask) ? [...(permissions?.ask ?? [])] : [],
					deny: Array.isArray(permissions?.deny) ? [...(permissions?.deny ?? [])] : [],
				};

				const updated = this._applyClaudePolicies(existing, policies);
				config.permissions = updated;

				await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
			}

			this._deps.postMessage({
				type: 'permissionsUpdated',
				data: { policies },
			});
		} catch (error) {
			logger.error('[PermissionsHandler] Error setting permissions:', error);
		}
	}

	// Helpers
	private async _readJsonFile<T>(filePath: string): Promise<T | undefined> {
		try {
			const content = await fs.readFile(filePath, 'utf8');
			return JSON.parse(content) as T;
		} catch {
			return undefined;
		}
	}

	private _inferClaudePolicy(
		permissions: ClaudePermissionsBlock | undefined,
		tool: ClaudePermissionTool,
	): PermissionPolicyValue {
		const allow = permissions?.allow ?? [];
		const ask = permissions?.ask ?? [];
		const deny = permissions?.deny ?? [];

		if (deny.includes(tool)) return 'deny';
		if (allow.includes(tool)) return 'allow';
		if (ask.includes(tool)) return 'ask';

		return 'ask';
	}

	private _applyClaudePolicies(
		permissions: ClaudePermissionsBlock,
		policies: PermissionPolicies,
	): ClaudePermissionsBlock {
		const normalized: ClaudePermissionsBlock = {
			allow: this._removeTools(permissions.allow ?? [], ['Edit', 'Bash', 'WebFetch']),
			ask: this._removeTools(permissions.ask ?? [], ['Edit', 'Bash', 'WebFetch']),
			deny: this._removeTools(permissions.deny ?? [], ['Edit', 'Bash', 'WebFetch']),
		};

		this._pushPolicy(normalized, 'Edit', policies.edit);
		this._pushPolicy(normalized, 'Bash', policies.terminal);
		this._pushPolicy(normalized, 'WebFetch', policies.network);

		return {
			allow: this._uniq(normalized.allow ?? []),
			ask: this._uniq(normalized.ask ?? []),
			deny: this._uniq(normalized.deny ?? []),
		};
	}

	private _pushPolicy(
		permissions: ClaudePermissionsBlock,
		tool: ClaudePermissionTool,
		policy: PermissionPolicyValue,
	): void {
		switch (policy) {
			case 'allow':
				permissions.allow = [...(permissions.allow ?? []), tool];
				break;
			case 'deny':
				permissions.deny = [...(permissions.deny ?? []), tool];
				break;
			default:
				permissions.ask = [...(permissions.ask ?? []), tool];
				break;
		}
	}

	private _removeTools(list: string[], tools: ClaudePermissionTool[]): string[] {
		return list.filter(item => !tools.includes(item as ClaudePermissionTool));
	}

	private _uniq(list: string[]): string[] {
		return Array.from(new Set(list));
	}
}
