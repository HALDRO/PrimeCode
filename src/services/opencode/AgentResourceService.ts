import type { ParsedSubagent } from '../../common';
import type { AgentResource } from '../../common/protocol';
import type { OpenCodeExecutor } from '../../core/executor/OpenCode';
import type { ResourceService } from '../ResourceService';
import type { OpenCodeConfigService } from './OpenCodeConfigService';

type RuntimeAgent = {
	name: string;
	path?: string;
	description?: string;
	mode?: 'primary' | 'subagent' | 'all';
	model?: string;
	variant?: string;
	builtIn?: boolean;
	native?: boolean;
	hidden?: boolean;
	disable?: boolean;
};

export class AgentResourceService {
	private agentRevision = 0;

	constructor(
		private readonly resources: ResourceService,
		private readonly config: OpenCodeConfigService,
	) {}

	public nextRevision(): number {
		this.agentRevision += 1;
		return this.agentRevision;
	}

	public async listAgents(
		cli: OpenCodeExecutor,
	): Promise<{ resources: AgentResource[]; revision: number }> {
		const resources = await this.buildAgentResources(cli);
		return { resources, revision: this.nextRevision() };
	}

	public async buildAgentResources(cli: OpenCodeExecutor): Promise<AgentResource[]> {
		const serverInfo = cli.getOpenCodeServerInfo();
		const [runtimeAgents, projectAgents, globalAgents, disabledOverrides] = await Promise.all([
			serverInfo?.directory ? fetchRuntimeAgents(cli, serverInfo.directory) : Promise.resolve([]),
			this.resources.getAll('subagents') as Promise<ParsedSubagent[]>,
			this.resources.getGlobalSubagents(),
			this.config.getAgentDisabledOverrides(),
		]);

		const runtimeByName = new Map(runtimeAgents.map(agent => [agent.name, agent]));
		const projectByName = new Map(projectAgents.map(agent => [agent.name, agent]));
		const globalByName = new Map(globalAgents.map(agent => [agent.name, agent]));
		const names = new Set([
			...runtimeByName.keys(),
			...projectByName.keys(),
			...globalByName.keys(),
			...Object.keys(disabledOverrides),
		]);

		return [...names]
			.sort((a, b) => a.localeCompare(b))
			.map(name =>
				toAgentResource(
					name,
					runtimeByName.get(name),
					projectByName.get(name),
					globalByName.get(name),
					disabledOverrides,
				),
			);
	}
}

async function fetchRuntimeAgents(
	cli: OpenCodeExecutor,
	directory: string,
): Promise<RuntimeAgent[]> {
	const data = await cli.listAgents(directory);
	if (!Array.isArray(data)) return [];
	return data.flatMap(item => {
		if (!item || typeof item !== 'object') return [];
		const record = item as Record<string, unknown>;
		const name = typeof record.name === 'string' ? record.name : undefined;
		if (!name) return [];
		return [
			{
				name,
				path: typeof record.path === 'string' ? record.path : undefined,
				description: typeof record.description === 'string' ? record.description : undefined,
				mode: normalizeMode(record.mode),
				model: typeof record.model === 'string' ? record.model : undefined,
				variant: typeof record.variant === 'string' ? record.variant : undefined,
				builtIn: typeof record.builtIn === 'boolean' ? record.builtIn : undefined,
				native: typeof record.native === 'boolean' ? record.native : undefined,
				hidden: typeof record.hidden === 'boolean' ? record.hidden : undefined,
				disable: typeof record.disable === 'boolean' ? record.disable : undefined,
			},
		];
	});
}

function toAgentResource(
	name: string,
	runtimeAgent: RuntimeAgent | undefined,
	projectAgent: ParsedSubagent | undefined,
	globalAgent: ParsedSubagent | undefined,
	disabledOverrides: Record<string, boolean>,
): AgentResource {
	const hasConfigOverride = Object.hasOwn(disabledOverrides, name);
	const disabled = hasConfigOverride
		? disabledOverrides[name] === true
		: projectAgent?.disable === true ||
			globalAgent?.disable === true ||
			runtimeAgent?.disable === true;
	const hidden = runtimeAgent?.hidden ?? projectAgent?.hidden ?? globalAgent?.hidden;
	const mode = normalizeMode(runtimeAgent?.mode ?? projectAgent?.mode ?? globalAgent?.mode);
	const source = resolveSource(runtimeAgent, projectAgent, globalAgent);
	const sourceKind = isBuiltinAgent(runtimeAgent) ? 'builtin' : 'custom';
	const sourcePath = projectAgent?.path ?? globalAgent?.path ?? runtimeAgent?.path;
	const target =
		hasConfigOverride || !projectAgent
			? {
					type: 'project-config' as const,
					jsonPointer: `/agent/${escapeJsonPointer(name)}/disable`,
				}
			: { type: 'project-file' as const, path: projectAgent.path, frontmatterKey: 'disable' };

	return {
		id: projectAgent
			? `agent:file:${projectAgent.path}`
			: globalAgent
				? `agent:global:${globalAgent.path}`
				: `agent:runtime:${name}`,
		kind: 'agent',
		name,
		description: runtimeAgent?.description ?? projectAgent?.description ?? globalAgent?.description,
		source,
		sourceKind,
		hasProjectOverride: Boolean(projectAgent || hasConfigOverride),
		sourcePath,
		disabled,
		hidden,
		mode,
		model: runtimeAgent?.model ?? projectAgent?.model ?? globalAgent?.model,
		variant: runtimeAgent?.variant ?? projectAgent?.variant ?? globalAgent?.variant,
		action: { type: 'setDisabled', target },
	};
}

function resolveSource(
	runtimeAgent: RuntimeAgent | undefined,
	projectAgent: ParsedSubagent | undefined,
	globalAgent: ParsedSubagent | undefined,
): AgentResource['source'] {
	if (projectAgent) return 'project';
	if (globalAgent || isGlobalOpenCodePath(runtimeAgent?.path)) return 'global';
	if (isBuiltinAgent(runtimeAgent)) return 'builtin';
	return 'runtime';
}

function isBuiltinAgent(runtimeAgent: RuntimeAgent | undefined): boolean {
	return runtimeAgent?.builtIn === true || runtimeAgent?.native === true;
}

function normalizeMode(input: unknown): RuntimeAgent['mode'] {
	return input === 'primary' || input === 'subagent' || input === 'all' ? input : undefined;
}

function isGlobalOpenCodePath(value: string | undefined): boolean {
	if (!value) return false;
	return value.replace(/\\/g, '/').includes('/.config/opencode/');
}

function escapeJsonPointer(input: string): string {
	return input.replaceAll('~', '~0').replaceAll('/', '~1');
}
