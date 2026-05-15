import * as path from 'node:path';
import * as vscode from 'vscode';
import { PATHS } from '../../common/constants';

export type ProjectConfig = Record<string, unknown>;

export class ProjectConfigParseError extends Error {
	constructor(
		message: string,
		public readonly filePath: string,
	) {
		super(message);
		this.name = 'ProjectConfigParseError';
	}
}

export class OpenCodeConfigService {
	private workspaceRoot: string | undefined;

	public setWorkspaceRoot(root: string): void {
		this.workspaceRoot = root;
	}

	public getProjectConfigPath(): string | undefined {
		return this.workspaceRoot ? path.join(this.workspaceRoot, PATHS.OPENCODE_CONFIG) : undefined;
	}

	public async resolveProjectConfigPath(): Promise<string | undefined> {
		return this.workspaceRoot ? resolveProjectConfigPath(this.workspaceRoot) : undefined;
	}

	public getGlobalConfigDir(): string | undefined {
		return getGlobalOpenCodeDir();
	}

	public getGlobalConfigPath(): string | undefined {
		const configDir = this.getGlobalConfigDir();
		return configDir ? path.join(configDir, PATHS.OPENCODE_CONFIG) : undefined;
	}

	public async resolveGlobalConfigPath(): Promise<string | undefined> {
		const configDir = this.getGlobalConfigDir();
		if (!configDir) return undefined;
		const jsonPath = path.join(configDir, PATHS.OPENCODE_CONFIG);
		const jsoncPath = path.join(configDir, `${PATHS.OPENCODE_CONFIG}c`);
		if (await fileExists(vscode.Uri.file(jsonPath))) return jsonPath;
		if (await fileExists(vscode.Uri.file(jsoncPath))) return jsoncPath;
		return jsonPath;
	}

	public async ensureProjectConfig(): Promise<string | undefined> {
		const configPath = await this.resolveProjectConfigPath();
		if (!configPath) return undefined;
		if (await fileExists(vscode.Uri.file(configPath))) return configPath;
		await this.patchProjectConfig(config => config);
		return configPath;
	}

	public async ensureGlobalConfig(): Promise<string | undefined> {
		const configPath = await this.resolveGlobalConfigPath();
		if (!configPath) return undefined;
		const uri = vscode.Uri.file(configPath);
		if (await fileExists(uri)) return configPath;
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(configPath)));
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('{}\n'));
		return configPath;
	}

	public async patchProjectConfig(
		mutator: (config: ProjectConfig) => undefined | ProjectConfig,
	): Promise<{ path: string; config: ProjectConfig; contentHash: string }> {
		const configPath = await this.requireConfigPath();
		const uri = vscode.Uri.file(configPath);
		const document = await this.readProjectConfigDocument(uri, configPath);
		const current = document.config;
		const result = mutator(current);
		const next = result ?? current;
		const content = formatProjectConfig(next, document.text);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
		return { path: configPath, config: next, contentHash: simpleHash(content) };
	}

	public async setAgentDisabled(
		name: string,
		disabled: boolean,
	): Promise<{ path: string; contentHash: string }> {
		const result = await this.patchProjectConfig(config => {
			if (!disabled) {
				deleteNested(config, ['agent', name, 'disable']);
				pruneEmptyParents(config, ['agent', name]);
				return config;
			}
			const agent = ensureRecord(config, 'agent');
			const entry = ensureRecord(agent, name);
			entry.disable = true;
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async setMcpServer(
		name: string,
		server: unknown,
	): Promise<{ path: string; contentHash: string }> {
		const result = await this.patchProjectConfig(config => {
			const mcp = ensureRecord(config, 'mcp');
			mcp[name] = server;
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async deleteMcpServer(name: string): Promise<{ path: string; contentHash: string }> {
		const result = await this.patchProjectConfig(config => {
			const mcp = ensureRecord(config, 'mcp');
			delete mcp[name];
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async setProjectField(
		key: string,
		value: unknown,
	): Promise<{ path: string; contentHash: string }> {
		const result = await this.patchProjectConfig(config => {
			config[key] = value;
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async getProjectPlugins(): Promise<string[]> {
		const configPath = await this.resolveProjectConfigPath();
		if (!configPath) return [];
		return readStringArray(
			(await this.readProjectConfig(vscode.Uri.file(configPath), configPath)).plugin,
		);
	}

	public async getGlobalPlugins(): Promise<string[]> {
		const { config } = await this.readGlobalConfigForInspection();
		return readStringArray(config.plugin);
	}

	public async addProjectPlugin(name: string): Promise<{ path: string; contentHash: string }> {
		const normalized = name.trim();
		if (!normalized) throw new Error('Plugin name is required');
		const result = await this.patchProjectConfig(config => {
			const plugins = readStringArray(config.plugin);
			if (!plugins.includes(normalized)) {
				config.plugin = [...plugins, normalized];
			}
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async removeProjectPlugin(name: string): Promise<{ path: string; contentHash: string }> {
		const result = await this.patchProjectConfig(config => {
			const next = readStringArray(config.plugin).filter(plugin => plugin !== name);
			if (next.length > 0) {
				config.plugin = next;
			} else {
				delete config.plugin;
			}
			return config;
		});
		return { path: result.path, contentHash: result.contentHash };
	}

	public async getAgentDisabledOverrides(): Promise<Record<string, boolean>> {
		const configPath = await this.resolveProjectConfigPath();
		if (!configPath) return {};
		const config = await this.readProjectConfig(vscode.Uri.file(configPath), configPath);
		const agent = config.agent;
		if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return {};
		const overrides: Record<string, boolean> = {};
		for (const [name, value] of Object.entries(agent as Record<string, unknown>)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
			const disabled = (value as Record<string, unknown>).disable;
			if (typeof disabled === 'boolean') overrides[name] = disabled;
		}
		return overrides;
	}

	public async readProjectConfigForInspection(): Promise<ProjectConfig> {
		const configPath = await this.resolveProjectConfigPath();
		if (!configPath) return {};
		return this.readProjectConfig(vscode.Uri.file(configPath), configPath);
	}

	public async readGlobalConfigForInspection(): Promise<{ config: ProjectConfig; path?: string }> {
		const configDir = this.getGlobalConfigDir();
		if (!configDir) return { config: {} };

		const jsonPath = path.join(configDir, PATHS.OPENCODE_CONFIG);
		const jsoncPath = path.join(configDir, `${PATHS.OPENCODE_CONFIG}c`);
		if (await fileExists(vscode.Uri.file(jsonPath))) {
			return { config: await this.readConfig(vscode.Uri.file(jsonPath), jsonPath), path: jsonPath };
		}
		if (await fileExists(vscode.Uri.file(jsoncPath))) {
			return {
				config: await this.readConfig(vscode.Uri.file(jsoncPath), jsoncPath),
				path: jsoncPath,
			};
		}
		return { config: {} };
	}

	private async requireConfigPath(): Promise<string> {
		const configPath = await this.resolveProjectConfigPath();
		if (!configPath) throw new Error('No workspace root is available for opencode.json');
		return configPath;
	}

	private async readProjectConfig(uri: vscode.Uri, filePath: string): Promise<ProjectConfig> {
		return (await this.readProjectConfigDocument(uri, filePath)).config;
	}

	private async readProjectConfigDocument(
		uri: vscode.Uri,
		filePath: string,
	): Promise<{ config: ProjectConfig; text?: string }> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			const text = new TextDecoder().decode(raw);
			return { config: parseConfigText(text, filePath), text };
		} catch (error) {
			if (error instanceof ProjectConfigParseError) throw error;
			if (isFileNotFound(error)) return { config: {} };
			throw error;
		}
	}

	private async readConfig(uri: vscode.Uri, filePath: string): Promise<ProjectConfig> {
		try {
			const raw = await vscode.workspace.fs.readFile(uri);
			return parseConfigText(new TextDecoder().decode(raw), filePath);
		} catch (error) {
			if (error instanceof ProjectConfigParseError) throw error;
			if (isFileNotFound(error)) return {};
			throw error;
		}
	}
}

export function getGlobalOpenCodeDir(): string | undefined {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME;
	if (xdgConfigHome) return path.join(xdgConfigHome, 'opencode');
	const home = process.env.HOME || process.env.USERPROFILE;
	return home ? path.join(home, '.config', 'opencode') : undefined;
}

export async function resolveProjectConfigPath(workspaceRoot: string): Promise<string> {
	const jsonPath = path.join(workspaceRoot, PATHS.OPENCODE_CONFIG);
	const jsoncPath = path.join(workspaceRoot, `${PATHS.OPENCODE_CONFIG}c`);
	if (await fileExists(vscode.Uri.file(jsonPath))) return jsonPath;
	if (await fileExists(vscode.Uri.file(jsoncPath))) return jsoncPath;
	return jsonPath;
}

export function getGlobalAgentsDir(): string | undefined {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home ? path.join(home, '.agents') : undefined;
}

export function getGlobalClaudeDir(): string | undefined {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home ? path.join(home, '.claude') : undefined;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
	const current = parent[key];
	if (current && typeof current === 'object' && !Array.isArray(current)) {
		return current as Record<string, unknown>;
	}
	const next: Record<string, unknown> = {};
	parent[key] = next;
	return next;
}

function deleteNested(parent: Record<string, unknown>, pathParts: string[]): void {
	let current: Record<string, unknown> = parent;
	for (const part of pathParts.slice(0, -1)) {
		const next = current[part];
		if (!next || typeof next !== 'object' || Array.isArray(next)) return;
		current = next as Record<string, unknown>;
	}
	delete current[pathParts[pathParts.length - 1]];
}

function pruneEmptyParents(parent: Record<string, unknown>, pathParts: string[]): void {
	for (let length = pathParts.length; length > 0; length--) {
		const parentPath = pathParts.slice(0, length - 1);
		const key = pathParts[length - 1];
		const container = getNestedRecord(parent, parentPath);
		const value = container?.[key];
		if (
			value &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0
		) {
			delete container[key];
		}
	}
}

function getNestedRecord(
	parent: Record<string, unknown>,
	pathParts: string[],
): Record<string, unknown> | undefined {
	let current: Record<string, unknown> = parent;
	for (const part of pathParts) {
		const next = current[part];
		if (!next || typeof next !== 'object' || Array.isArray(next)) return undefined;
		current = next as Record<string, unknown>;
	}
	return current;
}

function isFileNotFound(error: unknown): boolean {
	const candidate = error as { code?: unknown; name?: unknown };
	return candidate.code === 'FileNotFound' || candidate.name === 'EntryNotFound';
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function stripJsonComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function parseConfigText(text: string, filePath: string): ProjectConfig {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(stripJsonComments(trimmed)) as unknown;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new ProjectConfigParseError('opencode config must contain a JSON object', filePath);
		}
		return parsed as ProjectConfig;
	} catch (error) {
		if (error instanceof ProjectConfigParseError) throw error;
		if (error instanceof SyntaxError) {
			throw new ProjectConfigParseError(
				`Invalid JSON in opencode config: ${error.message}`,
				filePath,
			);
		}
		throw error;
	}
}

export function parseProjectConfigText(text: string, filePath: string): ProjectConfig {
	return parseConfigText(text, filePath);
}

function formatProjectConfig(config: ProjectConfig, previousText: string | undefined): string {
	const newline = previousText?.endsWith('\n') ? '\n' : '';
	const indentUnit = detectIndentUnit(previousText);
	return `${formatJsonValue(config, 0, indentUnit)}${newline}`;
}

function formatJsonValue(value: unknown, level: number, indentUnit: string): string {
	if (Array.isArray(value)) return formatJsonArray(value, level, indentUnit);
	if (isPlainObject(value)) return formatJsonObject(value, level, indentUnit);
	return JSON.stringify(value);
}

function formatJsonArray(value: unknown[], level: number, indentUnit: string): string {
	if (value.length === 0) return '[]';
	if (canInlineArray(value)) return `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
	const childIndent = indent(level + 1, indentUnit);
	const currentIndent = indent(level, indentUnit);
	return [
		'[',
		value.map(item => `${childIndent}${formatJsonValue(item, level + 1, indentUnit)}`).join(',\n'),
		`${currentIndent}]`,
	].join('\n');
}

function formatJsonObject(
	value: Record<string, unknown>,
	level: number,
	indentUnit: string,
): string {
	const entries = Object.entries(value).filter(([, item]) => item !== undefined);
	if (entries.length === 0) return '{}';
	const childIndent = indent(level + 1, indentUnit);
	const currentIndent = indent(level, indentUnit);
	return [
		'{',
		entries
			.map(
				([key, item]) =>
					`${childIndent}${JSON.stringify(key)}: ${formatJsonValue(item, level + 1, indentUnit)}`,
			)
			.join(',\n'),
		`${currentIndent}}`,
	].join('\n');
}

function canInlineArray(value: unknown[]): boolean {
	return value.every(
		item => item === null || ['string', 'number', 'boolean'].includes(typeof item),
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detectIndentUnit(text: string | undefined): string {
	if (!text) return '  ';
	const match = text.match(/^([\t ]+)"/m);
	return match?.[1] ?? '  ';
}

function indent(level: number, indentUnit: string): string {
	return indentUnit.repeat(level);
}

function simpleHash(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return hash.toString(36);
}
