import {
	DEFAULT_POLICIES,
	isPermissionCategory,
	isValidPolicyValue,
	mergePolicies,
	type PermissionCategory,
	type PermissionPolicyValue,
	policiesToServerFormat,
} from '../../common/permissions';
import type { CommandOf, PermissionPolicies, WebviewCommand } from '../../common/protocol';
import { resolveToolName } from '../../common/toolRegistry';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

const POLICIES_KEY = 'primeCode.permissionPolicies';
const ALWAYS_ALLOW_KEY = 'primeCode.permissionAlwaysAllowByTool';
const AUTO_ACCEPT_KEY = 'primeCode.permissionAutoAcceptBySession';

type PermissionAutoAcceptMode = 'default' | 'on' | 'off';
type PermissionAutoAcceptState = { mode: PermissionAutoAcceptMode; effective: boolean };

export class ToolHandler implements WebviewMessageHandler {
	private alwaysAllowByTool: Record<string, true> = {};
	private policies: PermissionPolicies;
	private readonly autoAcceptBySession = new Map<string, PermissionAutoAcceptMode>();
	private hydratePoliciesPromise: Promise<void> | null = null;

	constructor(private context: HandlerContext) {
		this.alwaysAllowByTool =
			(this.context.extensionContext.workspaceState.get(ALWAYS_ALLOW_KEY) as
				| Record<string, true>
				| undefined) ?? {};

		const storedAutoAccept = this.context.extensionContext.workspaceState.get(AUTO_ACCEPT_KEY) as
			| Record<string, PermissionAutoAcceptMode>
			| undefined;
		if (storedAutoAccept) {
			for (const [sessionId, mode] of Object.entries(storedAutoAccept)) {
				if (mode === 'default' || mode === 'on' || mode === 'off') {
					this.autoAcceptBySession.set(sessionId, mode);
				}
			}
		}

		const stored = this.context.extensionContext.workspaceState.get(POLICIES_KEY) as
			| Record<string, unknown>
			| undefined;

		// Start with defaults
		this.policies = { ...DEFAULT_POLICIES };

		if (stored) {
			for (const [key, value] of Object.entries(stored)) {
				if (isPermissionCategory(key) && isValidPolicyValue(value)) {
					this.policies[key] = value;
				}
			}
		}
	}

	private async ensurePoliciesHydrated(): Promise<void> {
		if (this.hydratePoliciesPromise) {
			await this.hydratePoliciesPromise;
			return;
		}

		this.hydratePoliciesPromise = (async () => {
			try {
				const globalEntry = this.context.services.openCodeConfig.readGlobalConfigForInspection
					? await this.context.services.openCodeConfig.readGlobalConfigForInspection()
					: undefined;
				const projectConfig = this.context.services.openCodeConfig.readProjectConfigForInspection
					? await this.context.services.openCodeConfig.readProjectConfigForInspection()
					: undefined;
				const permissionValue = mergePermissionConfig(
					globalEntry?.config.permission,
					projectConfig?.permission,
				);
				if (
					!permissionValue ||
					typeof permissionValue !== 'object' ||
					Array.isArray(permissionValue)
				) {
					return;
				}

				const partial: Partial<PermissionPolicies> = {};
				for (const [key, value] of Object.entries(permissionValue as Record<string, unknown>)) {
					if (isPermissionCategory(key) && isValidPolicyValue(value)) {
						partial[key] = value;
					}
				}
				if (Object.keys(partial).length === 0) {
					return;
				}
				this.policies = mergePolicies(partial);
			} catch (error) {
				logger.warn('[ToolHandler] Failed to hydrate policies from project config', error);
			}
		})();

		await this.hydratePoliciesPromise;
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'getPermissions':
				await this.onGetPermissions();
				break;
			case 'setPermissionPolicy':
				logger.info(`[ToolHandler] User set permission policy`, {
					category: msg.category,
					policy: msg.policy,
				});
				await this.setPermissionPolicy(msg.category, msg.policy);
				break;
			case 'setAutoAccept':
				logger.info(`[ToolHandler] User set auto-accept`, {
					mode: msg.mode,
					sessionId: msg.sessionId,
				});
				this.onSetAutoAccept(msg);
				break;
			case 'setAlwaysAllowTool':
				logger.info(`[ToolHandler] User set always-allow tool`, {
					toolName: msg.toolName,
					allow: msg.allow,
				});
				await this.onSetAlwaysAllowTool(msg.toolName, msg.allow);
				break;
			case 'checkDiscoveryStatus':
				await this.onCheckDiscoveryStatus();
				break;
			case 'getAccess':
				await this.onGetAccess();
				break;
			case 'checkCLIDiagnostics':
				await this.onCheckCliDiagnostics();
				break;
		}
	}

	getAlwaysAllowByTool(): Record<string, boolean> {
		return { ...this.alwaysAllowByTool };
	}

	private normalizePermissionToolName(toolName: string | undefined): string | undefined {
		if (!toolName) return undefined;
		return resolveToolName(toolName) ?? toolName.toLowerCase();
	}

	private async persistAutoAcceptModes(): Promise<void> {
		const payload = Object.fromEntries(this.autoAcceptBySession.entries());
		await this.context.extensionContext.workspaceState.update(AUTO_ACCEPT_KEY, payload);
	}

	private async resolveInheritedAutoAcceptMode(
		sessionId: string,
		visited = new Set<string>(),
	): Promise<PermissionAutoAcceptMode | undefined> {
		if (visited.has(sessionId)) return undefined;
		visited.add(sessionId);

		const own = this.autoAcceptBySession.get(sessionId);
		if (own === 'on' || own === 'off') return own;

		const parentId = await this.context.getParentSessionId?.(sessionId);
		if (!parentId) return undefined;
		return this.resolveInheritedAutoAcceptMode(parentId, visited);
	}

	getSessionAutoAcceptState(sessionId?: string): PermissionAutoAcceptState {
		if (!sessionId) return { mode: 'default', effective: false };
		const own = this.autoAcceptBySession.get(sessionId);
		if (own === 'on') return { mode: 'on', effective: true };
		if (own === 'off') return { mode: 'off', effective: false };
		return { mode: 'default', effective: false };
	}

	getPermissionPolicies(): PermissionPolicies {
		return { ...this.policies };
	}

	async getPermissionPoliciesAsync(): Promise<PermissionPolicies> {
		await this.ensurePoliciesHydrated();
		return { ...this.policies };
	}

	async setPermissionPolicy(
		category: PermissionCategory,
		policy: PermissionPolicyValue,
	): Promise<void> {
		this.policies[category] = policy;
		await this.persistPolicies();
	}

	private async onGetPermissions(): Promise<void> {
		await this.ensurePoliciesHydrated();
		this.context.bridge.data('permissionsUpdated', { policies: { ...this.policies } });
		const entries = await Promise.all(
			[...this.autoAcceptBySession.keys()].map(async sessionId => {
				const inherited = await this.resolveInheritedAutoAcceptMode(sessionId);
				return [sessionId, inherited === 'on'] as const;
			}),
		);
		this.context.bridge.data('sessionAutoAccept', {
			states: Object.fromEntries(entries),
		});
	}

	private async persistPolicies(): Promise<void> {
		await this.context.extensionContext.workspaceState.update(POLICIES_KEY, this.policies);
		this.context.bridge.data('permissionsUpdated', { policies: { ...this.policies } });

		// Sync all categories to project opencode.json through the canonical writer.
		void this.syncPoliciesToServer().catch(e =>
			logger.warn('[ToolHandler] Failed to sync policies to server:', e),
		);
	}

	/**
	 * Persist current permission policies into the project's `opencode.json`.
	 *
	 * Uses OpenCodeConfigService so project opencode.json writes stay centralized.
	 * After writing, disposes the OpenCode instance so the server re-reads permissions.
	 */
	private async syncPoliciesToServer(): Promise<void> {
		const serverPermission = policiesToServerFormat(this.policies);
		try {
			const result = await this.context.services.openCodeConfig.setProjectField(
				'permission',
				serverPermission,
			);
			this.context.services.mcpConfigWatcher.notifyUiSave(result.contentHash);
			await this.context.reloadOpenCodeRuntime?.('permissions:sync');
			logger.info('[ToolHandler] Policies written to opencode.json', serverPermission);
		} catch (e) {
			logger.warn('[ToolHandler] Failed to write opencode.json:', e);
		}
	}

	private async onCheckDiscoveryStatus(): Promise<void> {
		const instructionSources =
			(await this.context.services.rules?.getInstructionSources().catch(error => {
				logger.warn('[ToolHandler] Failed to inspect AGENTS.md sources', error);
				return [];
			})) ?? [];

		this.context.bridge.data('discoveryStatus', {
			rules: {
				hasAgentsMd: instructionSources.length > 0,
				ruleFiles: instructionSources.map(source => `${source.label}: ${source.path}`),
			},
			permissions: {},
			skills: [],
		});
	}

	private async onGetAccess(): Promise<void> {
		this.context.bridge.data(
			'accessData',
			Object.entries(this.alwaysAllowByTool).map(([toolName]) => ({ toolName, allowAll: true })),
		);
	}

	private async onSetAlwaysAllowTool(toolName: string, allow: boolean): Promise<void> {
		const normalized = this.normalizePermissionToolName(toolName);
		if (!normalized) return;
		if (allow) {
			this.alwaysAllowByTool[normalized] = true;
		} else {
			delete this.alwaysAllowByTool[normalized];
		}
		await this.context.extensionContext.workspaceState.update(
			ALWAYS_ALLOW_KEY,
			this.alwaysAllowByTool,
		);
		this.context.bridge.data(
			'accessData',
			Object.entries(this.alwaysAllowByTool)
				.filter(([, enabled]) => enabled)
				.map(([name]) => ({ toolName: name, allowAll: true })),
		);
	}

	/** Check if auto-accept mode is currently active for a session. */
	isAutoAccept(sessionId?: string): boolean {
		return this.getSessionAutoAcceptState(sessionId).effective;
	}

	async isAutoAcceptAsync(sessionId?: string): Promise<boolean> {
		if (!sessionId) return false;
		const inherited = await this.resolveInheritedAutoAcceptMode(sessionId);
		return inherited === 'on';
	}

	clearSessionAutoAccept(sessionId: string): void {
		this.autoAcceptBySession.delete(sessionId);
		void this.persistAutoAcceptModes().catch(error =>
			logger.warn('[ToolHandler] Failed to persist auto-accept clear', { sessionId, error }),
		);
	}

	private onSetAutoAccept(msg: CommandOf<'setAutoAccept'>): void {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			logger.warn('[ToolHandler] setAutoAccept ignored: no target session', {
				mode: msg.mode,
			});
			return;
		}

		logger.info('[ToolHandler] setAutoAccept', { mode: msg.mode, sessionId });
		if (msg.mode === 'default') {
			this.autoAcceptBySession.delete(sessionId);
		} else {
			this.autoAcceptBySession.set(sessionId, msg.mode);
		}
		void this.persistAutoAcceptModes().catch(error =>
			logger.warn('[ToolHandler] Failed to persist auto-accept state', { sessionId, error }),
		);
		void this.resolveInheritedAutoAcceptMode(sessionId)
			.then(inherited => {
				this.context.bridge.data('sessionAutoAccept', {
					sessionId,
					autoAccept: inherited === 'on',
				});
			})
			.catch(error =>
				logger.warn('[ToolHandler] Failed to resolve inherited auto-accept state', {
					sessionId,
					error,
				}),
			);
	}

	private async onCheckCliDiagnostics(): Promise<void> {
		this.context.bridge.data('cliDiagnostics', null);
	}
}

function mergePermissionConfig(globalValue: unknown, projectValue: unknown): unknown {
	if (!globalValue || typeof globalValue !== 'object' || Array.isArray(globalValue)) {
		return projectValue;
	}
	if (!projectValue || typeof projectValue !== 'object' || Array.isArray(projectValue)) {
		return globalValue;
	}
	return {
		...(globalValue as Record<string, unknown>),
		...(projectValue as Record<string, unknown>),
	};
}
