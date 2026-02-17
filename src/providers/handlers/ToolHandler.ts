import {
	DEFAULT_POLICIES,
	migrateLegacyPolicies,
	PERMISSION_CATEGORIES,
	policiesToServerFormat,
	VALID_POLICY_VALUES,
} from '../../common/permissions';
import type { CommandOf, PermissionPolicies, WebviewCommand } from '../../common/protocol';
import { logger } from '../../utils/logger';
import type { HandlerContext, WebviewMessageHandler } from './types';

const POLICIES_KEY = 'primeCode.permissionPolicies';

export class ToolHandler implements WebviewMessageHandler {
	private alwaysAllowByTool: Record<string, boolean> = {};
	private policies: PermissionPolicies;

	constructor(private context: HandlerContext) {
		this.alwaysAllowByTool =
			(this.context.extensionContext.workspaceState.get('primeCode.alwaysAllowByTool') as
				| Record<string, boolean>
				| undefined) ?? {};

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
		return this.alwaysAllowByTool;
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
			const toolName = msg.toolName;
			if (toolName) {
				this.alwaysAllowByTool[toolName] = approved;
				await this.context.extensionContext.workspaceState.update(
					'primeCode.alwaysAllowByTool',
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
			this.context.bridge.session.accessResponse(targetSessionId, {
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
	 * Push current permission policies to the running OpenCode server
	 * via `PATCH /config { permission: { ... } }`.
	 *
	 * The server's Config.Permission Zod schema defines all 16 named fields
	 * plus `.catchall(PermissionRule)`, so every category is accepted.
	 * After writing, the server calls `Instance.dispose()` which forces
	 * a full state rebuild on the next request — agents pick up new rulesets.
	 *
	 * Retries up to 3 times with 1s delay if the SDK client is not yet ready
	 * (server still starting). This closes the timing gap where a policy
	 * change during startup would be silently lost.
	 */
	private async syncPoliciesToServer(retries = 3): Promise<void> {
		const client = this.context.cli.getSdkClient?.();
		if (!client) {
			if (retries > 0) {
				logger.debug(`[ToolHandler] No SDK client — retrying in 1s (${retries} left)`);
				await new Promise(r => setTimeout(r, 1000));
				return this.syncPoliciesToServer(retries - 1);
			}
			logger.warn('[ToolHandler] No SDK client after retries — sync skipped');
			return;
		}

		const serverPermission = policiesToServerFormat(this.policies);

		logger.info('[ToolHandler] Syncing all policies to server', serverPermission);
		const { error } = await client.config.update({
			body: { permission: serverPermission } as import('@opencode-ai/sdk').Config,
		});
		if (error) {
			logger.warn('[ToolHandler] Server config update failed:', error);
		} else {
			logger.info('[ToolHandler] Policies synced to server successfully');
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
			hooks: [],
		});
	}

	private async onGetAccess(): Promise<void> {
		this.context.bridge.data(
			'accessData',
			Object.entries(this.alwaysAllowByTool)
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		);
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

		// Reply to OpenCode's question API with answers array
		await this.context.cli.respondToQuestion({ requestId, answers });

		// Mark the question as resolved in the webview
		// Use 'question-${requestId}' to match the original message ID created in ChatProvider
		if (targetSessionId) {
			this.context.bridge.session.message(targetSessionId, {
				id: `question-${requestId}`,
				type: 'question' as import('../../common/protocol').SessionMessageType,
				resolved: true,
				answers,
				timestamp: new Date().toISOString(),
			});
		}
	}

	private async onQuestionReject(msg: CommandOf<'questionReject'>): Promise<void> {
		const { requestId, sessionId } = msg;
		if (!requestId) {
			throw new Error('Missing questionReject.requestId');
		}

		const targetSessionId = sessionId;

		await this.context.cli.rejectQuestion(requestId);

		// Mark the question as resolved (rejected) in the webview
		if (targetSessionId) {
			this.context.bridge.session.message(targetSessionId, {
				id: `question-${requestId}`,
				type: 'question' as import('../../common/protocol').SessionMessageType,
				resolved: true,
				timestamp: new Date().toISOString(),
			});
		}
	}
}
