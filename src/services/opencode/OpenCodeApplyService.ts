import * as vscode from 'vscode';
import type { AgentResource, ResourceActionResult } from '../../common/protocol';
import type { OpenCodeExecutor } from '../../core/executor/OpenCode';
import { parseFrontmatter, stringifyFrontmatter } from '../../utils/frontmatter';
import type { McpConfigWatcherService } from '../McpConfigWatcherService';
import type { AgentResourceService } from './AgentResourceService';
import type { OpenCodeConfigService } from './OpenCodeConfigService';

export class OpenCodeApplyService {
	constructor(
		private readonly config: OpenCodeConfigService,
		private readonly resources: AgentResourceService,
		private readonly configWatcher: McpConfigWatcherService,
	) {}

	public async setAgentDisabled(
		cli: OpenCodeExecutor,
		resource: AgentResource,
		disabled: boolean,
		reloadRuntime?: (source: string) => Promise<void>,
	): Promise<{
		result: ResourceActionResult;
		message?: string;
		resources: AgentResource[];
		revision: number;
	}> {
		const target = resource.action?.type === 'setDisabled' ? resource.action.target : undefined;
		if (!target) {
			return this.result(
				cli,
				'error',
				'No project-safe action target is available for this agent.',
			);
		}

		try {
			if (target.type === 'project-config') {
				const result = await this.config.setAgentDisabled(resource.name, disabled);
				this.configWatcher.notifyUiSave(result.contentHash);
			} else if (target.type === 'project-file') {
				await setAgentFileDisabled(target.path, disabled);
			}
			cli.clearAgentsCache();
			const applied = await this.applyAgentChange(cli, reloadRuntime);
			if (!applied.ok) {
				return this.result(cli, applied.result, applied.message);
			}
			return this.verifyAgentDisabled(cli, resource.name, disabled);
		} catch (error) {
			return this.result(cli, 'error', error instanceof Error ? error.message : String(error));
		}
	}

	private async applyAgentChange(
		cli: OpenCodeExecutor,
		reloadRuntime?: (source: string) => Promise<void>,
	): Promise<{ ok: true } | { ok: false; result: ResourceActionResult; message: string }> {
		const connection = cli.getConnectionDetails();
		if (!connection.serverUrl) {
			return {
				ok: false,
				result: 'config-written-unverified',
				message: 'Project override was written, but OpenCode is not running to verify it.',
			};
		}

		await reloadRuntime?.('settings:agent:setDisabled');
		cli.clearAgentsCache();

		return { ok: true };
	}

	private async verifyAgentDisabled(
		cli: OpenCodeExecutor,
		name: string,
		expectedDisabled: boolean,
	): Promise<{
		result: ResourceActionResult;
		message?: string;
		resources: AgentResource[];
		revision: number;
	}> {
		const resources = await this.resources.buildAgentResources(cli);
		const resource = resources.find(item => item.name === name);
		const result: ResourceActionResult =
			resource?.disabled === expectedDisabled ? 'verified' : 'stale';
		const message =
			result === 'verified'
				? undefined
				: 'Project override was written, but refreshed OpenCode agent state did not match it.';
		return { result, message, resources, revision: this.resources.nextRevision() };
	}

	private async result(
		cli: OpenCodeExecutor,
		result: ResourceActionResult,
		message: string,
	): Promise<{
		result: ResourceActionResult;
		message?: string;
		resources: AgentResource[];
		revision: number;
	}> {
		return {
			result,
			message,
			resources: await this.resources.buildAgentResources(cli),
			revision: this.resources.nextRevision(),
		};
	}
}

async function setAgentFileDisabled(filePath: string, disabled: boolean): Promise<void> {
	const uri = vscode.Uri.file(filePath);
	const raw = await vscode.workspace.fs.readFile(uri);
	const text = new TextDecoder().decode(raw);
	const parsed = parseFrontmatter(text);
	const attributes = { ...parsed.attributes, disable: disabled };
	await vscode.workspace.fs.writeFile(
		uri,
		new TextEncoder().encode(stringifyFrontmatter(attributes, parsed.body)),
	);
}
