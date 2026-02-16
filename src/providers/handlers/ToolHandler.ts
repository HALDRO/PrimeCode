import type { CommandOf, PermissionPolicies, WebviewCommand } from '../../common/protocol';
import type { HandlerContext, WebviewMessageHandler } from './types';

const VALID_POLICY_VALUES = new Set(['ask', 'allow', 'deny']);
const DEFAULT_POLICIES: PermissionPolicies = { edit: 'ask', terminal: 'ask', network: 'ask' };
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
			| PermissionPolicies
			| undefined;
		this.policies = stored ? { ...DEFAULT_POLICIES, ...stored } : { ...DEFAULT_POLICIES };
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
		const targetSessionId = msg.sessionId ?? this.context.sessionState.activeSessionId;

		if (!requestId) {
			throw new Error('Missing accessResponse.id');
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
		if (incoming) {
			for (const key of ['edit', 'terminal', 'network'] as const) {
				const val = incoming[key];
				if (val && VALID_POLICY_VALUES.has(val)) {
					this.policies[key] = val;
				}
			}
		}
		await this.context.extensionContext.workspaceState.update(POLICIES_KEY, this.policies);
		this.context.bridge.permissionsUpdated({ ...this.policies });
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

		const targetSessionId = sessionId ?? this.context.sessionState.activeSessionId;

		// Reply to OpenCode's question API with answers array
		await this.context.cli.respondToQuestion({ requestId, answers });

		// Mark the question as resolved in the webview
		if (targetSessionId) {
			this.context.bridge.session.message(targetSessionId, {
				id: requestId,
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

		const targetSessionId = sessionId ?? this.context.sessionState.activeSessionId;

		await this.context.cli.rejectQuestion(requestId);

		// Mark the question as resolved (rejected) in the webview
		if (targetSessionId) {
			this.context.bridge.session.message(targetSessionId, {
				id: requestId,
				type: 'question' as import('../../common/protocol').SessionMessageType,
				resolved: true,
				timestamp: new Date().toISOString(),
			});
		}
	}
}
