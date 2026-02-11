import type { SessionEventMessage } from '../../common';
import type { HandlerContext, WebviewMessage, WebviewMessageHandler } from './types';

export class ToolHandler implements WebviewMessageHandler {
	private alwaysAllowByTool: Record<string, boolean> = {};

	constructor(private context: HandlerContext) {
		this.alwaysAllowByTool =
			(this.context.extensionContext.workspaceState.get('primeCode.alwaysAllowByTool') as
				| Record<string, boolean>
				| undefined) ?? {};
	}

	async handleMessage(msg: WebviewMessage): Promise<void> {
		switch (msg.type) {
			case 'accessResponse':
				await this.onAccessResponse(msg);
				break;
			case 'getPermissions':
				await this.onGetPermissions();
				break;
			case 'setPermissions':
				await this.onSetPermissions();
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

	private async onAccessResponse(msg: WebviewMessage): Promise<void> {
		const requestId = typeof msg.id === 'string' ? (msg.id as string) : undefined;
		const approved = Boolean(msg.approved);
		const alwaysAllow = Boolean(msg.alwaysAllow);
		const response =
			msg.response === 'once' || msg.response === 'always' || msg.response === 'reject'
				? msg.response
				: undefined;
		const targetSessionId =
			typeof msg.sessionId === 'string' ? msg.sessionId : this.context.sessionState.activeSessionId;

		if (!requestId) {
			throw new Error('Missing accessResponse.id');
		}

		if (alwaysAllow) {
			const toolName = typeof msg.toolName === 'string' ? (msg.toolName as string) : undefined;
			if (toolName) {
				this.alwaysAllowByTool[toolName] = approved;
				await this.context.extensionContext.workspaceState.update(
					'primeCode.alwaysAllowByTool',
					this.alwaysAllowByTool,
				);
				this.context.view.postMessage({
					type: 'accessData',
					data: Object.entries(this.alwaysAllowByTool)
						.filter(([, allow]) => allow)
						.map(([t]) => ({ toolName: t, allowAll: true })),
				});
			}
		}

		await this.context.cli.respondToPermission({
			requestId,
			approved,
			alwaysAllow,
			response,
		});

		if (targetSessionId) {
			this.context.view.postMessage({
				type: 'session_event',
				targetId: targetSessionId,
				eventType: 'access',
				payload: {
					eventType: 'access',
					action: 'response',
					requestId,
					approved,
					alwaysAllow,
				},
				timestamp: Date.now(),
				sessionId: targetSessionId,
			} satisfies SessionEventMessage);
		}
	}

	private async onGetPermissions(): Promise<void> {
		this.context.view.postMessage({
			type: 'permissionsUpdated',
			data: { policies: { edit: 'ask', terminal: 'ask', network: 'ask' } },
		});
	}

	private async onSetPermissions(): Promise<void> {
		this.context.view.postMessage({
			type: 'permissionsUpdated',
			data: { policies: { edit: 'ask', terminal: 'ask', network: 'ask' } },
		});
	}

	private async onCheckDiscoveryStatus(): Promise<void> {
		// Best-effort discovery based on existing files/services.
		this.context.view.postMessage({
			type: 'discoveryStatus',
			data: {
				rules: {
					hasAgentsMd: true,
					hasClaudeMd: false,
					hasClaudeShim: false,
					ruleFiles: [],
				},
				permissions: {},
				skills: [],
				hooks: [],
			},
		});
	}

	private async onGetAccess(): Promise<void> {
		this.context.view.postMessage({
			type: 'accessData',
			data: Object.entries(this.alwaysAllowByTool)
				.filter(([, allow]) => allow)
				.map(([toolName]) => ({ toolName, allowAll: true })),
		});
	}

	private async onCheckCliDiagnostics(): Promise<void> {
		this.context.view.postMessage({ type: 'cliDiagnostics', data: null });
	}
}
