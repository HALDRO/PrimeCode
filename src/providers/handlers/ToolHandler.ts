import * as vscode from 'vscode';
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
	 * Persist current permission policies into the project's `opencode.json`.
	 *
	 * OpenCode loads project config from `opencode.json` / `opencode.jsonc`
	 * (via `findUp`), NOT from `config.json`. The old approach of using
	 * `PATCH /config` wrote to `config.json` in the project root, which
	 * OpenCode never reads back — making it effectively a no-op.
	 *
	 * This method writes directly to `opencode.json` so that:
	 * 1. Permissions survive server restarts (read by `Config.state()`)
	 * 2. No stale `config.json` is created in the project root
	 * 3. The file matches the documented OpenCode config format
	 */
	private async syncPoliciesToServer(): Promise<void> {
		const workspaceRoot = this.context.settings.getWorkspaceRoot?.();
		if (!workspaceRoot) {
			logger.warn('[ToolHandler] No workspace root — sync skipped');
			return;
		}

		const configUri = vscode.Uri.file(`${workspaceRoot}/opencode.json`);
		const serverPermission = policiesToServerFormat(this.policies);

		try {
			// Read existing opencode.json (or start fresh)
			let existing: Record<string, unknown> = {};
			try {
				const raw = await vscode.workspace.fs.readFile(configUri);
				existing = JSON.parse(Buffer.from(raw).toString('utf-8')) as Record<string, unknown>;
			} catch {
				// File doesn't exist or is invalid — start with schema
				existing = { $schema: 'https://opencode.ai/config.json' };
			}

			// Merge permission field
			existing.permission = serverPermission;

			const content = Buffer.from(`${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
			await vscode.workspace.fs.writeFile(configUri, content);
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
				type: 'question' as const,
				resolved: true,
				answers,
				timestamp: new Date().toISOString(),
			} satisfies import('../../common').SessionMessageUpdate);
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
				type: 'question' as const,
				resolved: true,
				timestamp: new Date().toISOString(),
			} satisfies import('../../common').SessionMessageUpdate);
		}
	}
}
