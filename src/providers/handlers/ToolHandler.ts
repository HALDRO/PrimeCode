import {
	DEFAULT_POLICIES,
	migrateLegacyPolicies,
	PERMISSION_CATEGORIES,
	policiesToServerFormat,
	VALID_POLICY_VALUES,
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
			// Migrate legacy policies (terminal → bash, network → webfetch)
			const migrated = migrateLegacyPolicies(stored);
			// Merge migrated policies into defaults
			this.policies = { ...this.policies, ...migrated };
		}

		logger.info('[ToolHandler] Initialized policies', {
			hasStored: !!stored,
			task: this.policies.task,
			external_directory: this.policies.external_directory,
			bash: this.policies.bash,
			edit: this.policies.edit,
		});
	}

	async handleMessage(msg: WebviewCommand): Promise<void> {
		switch (msg.type) {
			case 'accessResponse':
				await this.onAccessResponse(msg);
				break;
			case 'questionResponse':
				await this.onQuestionResponse(msg);
				break;
			case 'questionReject':
				await this.onQuestionReject(msg);
				break;
			case 'getPermissions':
				await this.onGetPermissions();
				break;
			case 'setPermissions':
				await this.onSetPermissions(msg);
				break;
			case 'setAutoAccept':
				this.onSetAutoAccept(msg);
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

	getSessionAutoAcceptState(sessionId?: string): PermissionAutoAcceptState {
		if (!sessionId) return { mode: 'default', effective: false };
		const visited = new Set<string>();
		let current: string | undefined = sessionId;
		let isOwnSession = true;
		while (current && !visited.has(current)) {
			visited.add(current);
			const own = this.autoAcceptBySession.get(current);
			if (own === 'on') {
				return { mode: isOwnSession ? 'on' : 'default', effective: true };
			}
			if (own === 'off') {
				return { mode: isOwnSession ? 'off' : 'default', effective: false };
			}
			current = this.context.sessionGraph.getParent(current);
			isOwnSession = false;
		}
		return { mode: 'default', effective: false };
	}

	getPermissionPolicies(): PermissionPolicies {
		return { ...this.policies };
	}

	private async onAccessResponse(msg: CommandOf<'accessResponse'>): Promise<void> {
		const { id: requestId, approved, response } = msg;
		const alwaysAllow = msg.alwaysAllow ?? false;
		const targetSessionId = msg.sessionId;

		if (!requestId) {
			throw new Error('Missing accessResponse.id');
		}

		if (!targetSessionId) {
			logger.warn('[ToolHandler] accessResponse dropped: no sessionId', { requestId });
		}

		if (alwaysAllow) {
			const toolName = this.normalizePermissionToolName(msg.toolName);
			if (toolName) {
				if (approved) {
					this.alwaysAllowByTool[toolName] = true;
				} else {
					delete this.alwaysAllowByTool[toolName];
				}
				await this.context.extensionContext.workspaceState.update(
					ALWAYS_ALLOW_KEY,
					this.alwaysAllowByTool,
				);
				this.context.bridge.data(
					'accessData',
					Object.entries(this.alwaysAllowByTool)
						.filter(([, allow]) => allow)
						.map(([t]) => ({ toolName: t, allowAll: true })),
				);
			}
		}

		await this.context.cli.respondToPermission({
			requestId,
			approved,
			alwaysAllow,
			response,
		});

		if (targetSessionId) {
			this.context.bridge.emit(targetSessionId, 'permission', {
				action: 'remove',
				requestId,
				response,
			});
			this.context.bridge.emit(targetSessionId, 'access', {
				action: 'response',
				requestId,
				approved,
				alwaysAllow,
			});
		}
	}

	private async onGetPermissions(): Promise<void> {
		this.context.bridge.permissionsUpdated({ ...this.policies });
	}

	private async onSetPermissions(msg: CommandOf<'setPermissions'>): Promise<void> {
		const incoming = msg.policies;
		logger.info('[ToolHandler] onSetPermissions called', {
			hasIncoming: !!incoming,
			incomingTask: incoming?.task,
			incomingExtDir: incoming?.external_directory,
		});
		if (incoming) {
			// Merge incoming policies with current policies
			for (const key of PERMISSION_CATEGORIES) {
				const val = incoming[key];
				if (val && VALID_POLICY_VALUES.has(val)) {
					this.policies[key] = val;
				}
			}
		}
		logger.info('[ToolHandler] Policies after update', {
			task: this.policies.task,
			external_directory: this.policies.external_directory,
			bash: this.policies.bash,
			edit: this.policies.edit,
		});
		await this.context.extensionContext.workspaceState.update(POLICIES_KEY, this.policies);
		this.context.bridge.permissionsUpdated({ ...this.policies });

		// Sync all categories to running OpenCode server via PATCH /config.
		void this.syncPoliciesToServer().catch(e =>
			logger.warn('[ToolHandler] Failed to sync policies to server:', e),
		);
	}

	/**
	 * Persist current permission policies into the project's `opencode.json`.
	 *
	 * Uses McpConfigService.updateProjectField to ensure atomic writes and
	 * proper event emission, avoiding race conditions with MCP config saves.
	 */
	private async syncPoliciesToServer(): Promise<void> {
		const serverPermission = policiesToServerFormat(this.policies);
		try {
			await this.context.services.mcpConfig.updateProjectField('permission', serverPermission);
			logger.info('[ToolHandler] Policies written to opencode.json', serverPermission);
		} catch (e) {
			logger.warn('[ToolHandler] Failed to write opencode.json:', e);
		}
	}

	private async onCheckDiscoveryStatus(): Promise<void> {
		// Best-effort discovery based on existing files/services.
		this.context.bridge.data('discoveryStatus', {
			rules: {
				hasAgentsMd: true,
				ruleFiles: [],
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

	/** Check if auto-accept mode is currently active for a session. */
	isAutoAccept(sessionId?: string): boolean {
		return this.getSessionAutoAcceptState(sessionId).effective;
	}

	clearSessionAutoAccept(sessionId: string): void {
		this.autoAcceptBySession.delete(sessionId);
		void this.persistAutoAcceptModes().catch(error =>
			logger.warn('[ToolHandler] Failed to persist auto-accept clear', { sessionId, error }),
		);
	}

	private async autoRespondPendingPermissions(sessionId: string): Promise<void> {
		if (!this.isAutoAccept(sessionId)) return;
		const serverInfo = this.context.cli.getOpenCodeServerInfo();
		if (!serverInfo?.baseUrl || !serverInfo.directory) return;
		const openCodeClient = this.context.services.openCodeClient;
		if (!openCodeClient?.getSessionPermissions) return;
		const pending = await openCodeClient.getSessionPermissions(
			serverInfo.baseUrl,
			serverInfo.directory,
			sessionId,
		);
		for (const request of pending) {
			try {
				await this.context.cli.respondToPermission({
					requestId: request.id,
					approved: true,
					alwaysAllow: false,
					response: 'once',
				});
				this.context.bridge.emit(sessionId, 'permission', {
					action: 'remove',
					requestId: request.id,
					response: 'once',
				});
			} catch (error) {
				logger.warn('[ToolHandler] Failed to auto-respond pending permission', {
					sessionId,
					requestId: request.id,
					error,
				});
			}
		}
	}

	private onSetAutoAccept(msg: CommandOf<'setAutoAccept'>): void {
		const sessionId = msg.sessionId || this.context.sessionState.activeSessionId;
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
		const autoAcceptState = this.getSessionAutoAcceptState(sessionId);

		this.context.bridge.emit(sessionId, 'session_info', {
			data: { sessionId, autoAccept: autoAcceptState.effective },
			permissionAutoAccept: autoAcceptState,
		});
		if (autoAcceptState.effective) {
			void this.autoRespondPendingPermissions(sessionId);
		}
	}

	private async onCheckCliDiagnostics(): Promise<void> {
		this.context.bridge.data('cliDiagnostics', null);
	}

	private async onQuestionResponse(msg: CommandOf<'questionResponse'>): Promise<void> {
		const { requestId, answers, sessionId } = msg;
		if (!requestId) {
			throw new Error('Missing questionResponse.requestId');
		}

		const targetSessionId = sessionId;

		// Remove from pending immediately so the card disappears on submit.
		if (targetSessionId) {
			this.context.bridge.emit(targetSessionId, 'question', {
				action: 'remove',
				requestId,
				answers,
			});
		}

		// Reply to OpenCode's question API with answers array
		await this.context.cli.respondToQuestion({ requestId, answers });
	}

	private async onQuestionReject(msg: CommandOf<'questionReject'>): Promise<void> {
		const { requestId, sessionId } = msg;
		if (!requestId) {
			throw new Error('Missing questionReject.requestId');
		}

		const targetSessionId = sessionId;

		// Remove from pending immediately.
		if (targetSessionId) {
			this.context.bridge.emit(targetSessionId, 'question', {
				action: 'remove',
				requestId,
				rejected: true,
			});
		}

		await this.context.cli.rejectQuestion(requestId);
	}
}
