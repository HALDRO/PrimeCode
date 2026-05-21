/**
 * @file OpenCodeExecutor
 * @description Managed OpenCode runtime bridge with dynamic port, auth, and reattach support.
 */

import { type ChildProcess, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2/client';
import launch from 'cross-spawn';
import type * as vscode from 'vscode';

import { logger } from '../../utils/logger';
import { normalizeDriveLetter } from '../../utils/path';
import type { CLIConfig, CLIExecutor } from './types';

class TtlCache<T> {
	private data: T | null = null;
	private timestamp = 0;
	constructor(private readonly ttlMs: number) {}

	get(): T | null {
		if (this.data !== null && Date.now() - this.timestamp < this.ttlMs) return this.data;
		return null;
	}

	set(value: T): T {
		this.data = value;
		this.timestamp = Date.now();
		return value;
	}

	clear(): void {
		this.data = null;
	}
}

type RuntimeRecord = {
	runtimeId: string;
	serverUrl: string;
	authorization: string;
	workspaceRoot: string;
	createdAt: number;
	ownerSessionId: string;
	pid: number | null;
	provider: 'opencode';
	kind: 'managed-local';
};

const RUNTIME_RECORD_KEY = 'primecode.managedOpenCodeRuntime';

export class OpenCodeExecutor extends EventEmitter implements CLIExecutor {
	private serverUrl: string | null = null;
	private directory: string | null = null;
	private sdkClient: OpencodeClient | null = null;
	private ensureServerPromise: Promise<void> | null = null;

	private readonly caches = {
		commands: new TtlCache<Array<{ name: string; description?: string }>>(5 * 60 * 1000),
		agents: new TtlCache<unknown>(5 * 60 * 1000),
		skills: new TtlCache<
			Array<{ name: string; description: string; location?: string; content?: string }>
		>(5 * 60 * 1000),
		mcp: new TtlCache<unknown>(30 * 1000),
	};

	private serverInstance: { close(): void } | null = null;
	private isServerOwner = false;
	private serverStartedAt: number | null = null;
	private runtimeId: string | null = null;
	private authorizationHeader: string | null = null;

	private static readonly LOCAL_SERVER_HOST = '127.0.0.1';

	constructor(private readonly extensionContext?: vscode.ExtensionContext) {
		super();
	}

	private static normalizeDriveLetter(dir: string): string {
		return normalizeDriveLetter(dir);
	}

	private readRuntimeRecord(): RuntimeRecord | null {
		const value = this.extensionContext?.workspaceState.get<RuntimeRecord>(RUNTIME_RECORD_KEY);
		if (!value) return null;
		if (value.provider !== 'opencode' || value.kind !== 'managed-local') return null;
		return value;
	}

	private async writeRuntimeRecord(record: RuntimeRecord | null): Promise<void> {
		if (!this.extensionContext) return;
		await this.extensionContext.workspaceState.update(RUNTIME_RECORD_KEY, record);
	}

	private createAuthorizationHeader(password: string): string {
		return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
	}

	private buildFetchHeaders(directory?: string, authorization?: string | null): Headers {
		const headers = new Headers();
		if (directory) {
			headers.set('x-opencode-directory', encodeURIComponent(directory));
		}
		if (authorization) {
			headers.set('authorization', authorization);
		}
		return headers;
	}

	public async request(path: string, init?: RequestInit): Promise<Response> {
		if (!this.serverUrl) throw new Error('OpenCode server is not initialized');
		const url = path.startsWith('http') ? path : new URL(path, this.serverUrl).toString();
		const headers = this.buildFetchHeaders(this.directory ?? undefined, this.authorizationHeader);
		new Headers(init?.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		return fetch(url, { ...init, headers });
	}

	private createRuntimeFetch(directory?: string, authorization?: string | null) {
		return (input: Request | URL | string, init?: RequestInit) => {
			if (input instanceof Request) {
				const headers = this.buildFetchHeaders(directory, authorization);
				input.headers.forEach((value, key) => {
					if (!headers.has(key)) headers.set(key, value);
				});
				headers.forEach((value, key) => {
					if (!input.headers.has(key)) input.headers.set(key, value);
				});
				return fetch(input);
			}

			const initCopy = { ...init };
			const headers = new Headers(initCopy.headers);
			const runtimeHeaders = this.buildFetchHeaders(directory, authorization);
			runtimeHeaders.forEach((value, key) => {
				if (!headers.has(key)) headers.set(key, value);
			});
			initCopy.headers = headers;
			return fetch(input, initCopy);
		};
	}

	private async isOpenCodeServer(
		baseUrl: string,
		authorization = this.authorizationHeader,
	): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5_000);
		try {
			const res = await fetch(`${baseUrl}/global/health`, {
				method: 'GET',
				headers: this.buildFetchHeaders(undefined, authorization),
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!res.ok) return false;
			const data = (await res.json()) as { healthy?: boolean };
			return data.healthy === true;
		} catch {
			clearTimeout(timeout);
			return false;
		}
	}

	private async tryReattach(config: CLIConfig): Promise<boolean> {
		const record = this.readRuntimeRecord();
		if (!record) return false;
		const workspaceRoot = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
		const isMatchingWorkspace = record.workspaceRoot === workspaceRoot;
		if (!isMatchingWorkspace) return false;
		if (!(await this.isOpenCodeServer(record.serverUrl, record.authorization))) {
			await this.writeRuntimeRecord(null);
			return false;
		}

		this.serverUrl = record.serverUrl;
		this.authorizationHeader = record.authorization;
		this.runtimeId = record.runtimeId;
		this.directory = workspaceRoot;
		this.isServerOwner = false;
		this.serverStartedAt = record.createdAt;
		this.serverInstance = null;
		this.initSdkClient();
		logger.info('[OpenCode] Reattached to managed local runtime', {
			serverUrl: this.serverUrl,
			runtimeId: this.runtimeId,
		});
		void this.preloadMetadata();
		return true;
	}

	private async cleanupRecordedRuntime(config: CLIConfig): Promise<void> {
		const record = this.readRuntimeRecord();
		if (!record) return;
		const workspaceRoot = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
		if (record.workspaceRoot !== workspaceRoot) return;

		const isAlive = await this.isOpenCodeServer(record.serverUrl, record.authorization);
		if (isAlive) return;

		logger.info('[OpenCode] Cleaning up stale managed runtime record', {
			serverUrl: record.serverUrl,
			runtimeId: record.runtimeId,
			pid: record.pid,
		});

		if (record.pid) {
			await this.killProcess(record.pid);
		}
		await this.writeRuntimeRecord(null);
	}

	async ensureServer(config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;
		if (this.ensureServerPromise) {
			await this.ensureServerPromise;
			return;
		}

		this.ensureServerPromise = this.doEnsureServer(config);
		try {
			await this.ensureServerPromise;
		} finally {
			this.ensureServerPromise = null;
		}
	}

	private async doEnsureServer(config: CLIConfig): Promise<void> {
		if (config.serverUrl) {
			this.serverUrl = config.serverUrl;
			this.authorizationHeader = null;
			this.runtimeId = null;
			this.isServerOwner = false;
			this.serverStartedAt = null;
			this.directory = OpenCodeExecutor.normalizeDriveLetter(config.workspaceRoot);
			this.serverInstance = null;
			this.initSdkClient();
			logger.info(`[OpenCode] Connected to configured server at ${this.serverUrl}`);
			return;
		}

		await this.cleanupRecordedRuntime(config);
		if (await this.tryReattach(config)) return;
		await this.spawnServer(config.workspaceRoot, config);
	}

	private async spawnServer(workspaceRoot: string, config: CLIConfig): Promise<void> {
		if (this.serverUrl) return;

		// Ensure no stale OPENCODE_PERMISSION env var overrides opencode.json policies.
		// Permissions are managed exclusively via the project config file.
		delete process.env.OPENCODE_PERMISSION;

		const password = randomUUID();
		const processEnv: Record<string, string | undefined> = {
			...process.env,
			...config.env,
			NODE_NO_WARNINGS: '1',
			NO_COLOR: '1',
			NPM_CONFIG_LOGLEVEL: 'error',
			OPENCODE_SERVER_USERNAME: 'opencode',
			OPENCODE_SERVER_PASSWORD: password,
			OPENCODE_CONFIG_CONTENT:
				!process.env.OPENCODE_CONFIG_CONTENT && config.autoCompact !== false
					? JSON.stringify({ compaction: { auto: true } })
					: process.env.OPENCODE_CONFIG_CONTENT,
		};

		logger.info('[OpenCodeExecutor] Starting managed OpenCode runtime...');

		try {
			const { serverUrl, close, pid } = await this.launchManagedServer(
				OpenCodeExecutor.LOCAL_SERVER_HOST,
				config.serverTimeoutMs ?? 15_000,
				workspaceRoot,
				processEnv,
			);
			const runtimeId = randomUUID();
			const authorization = this.createAuthorizationHeader(password);
			const normalizedWorkspaceRoot = OpenCodeExecutor.normalizeDriveLetter(workspaceRoot);

			this.serverInstance = { close };
			this.serverUrl = serverUrl;
			this.authorizationHeader = authorization;
			this.directory = normalizedWorkspaceRoot;
			this.runtimeId = runtimeId;
			this.isServerOwner = true;
			this.serverStartedAt = Date.now();

			await this.writeRuntimeRecord({
				runtimeId,
				serverUrl,
				authorization,
				workspaceRoot: normalizedWorkspaceRoot,
				createdAt: this.serverStartedAt,
				ownerSessionId: `${process.pid}`,
				pid,
				provider: 'opencode',
				kind: 'managed-local',
			});

			this.initSdkClient();
			logger.info('[OpenCode] Managed runtime started', {
				serverUrl: this.serverUrl,
				runtimeId: this.runtimeId,
			});
			void this.preloadMetadata();
		} catch (error) {
			logger.error('[OpenCodeExecutor] Failed to start server:', error);
			throw error;
		}
	}

	private async launchManagedServer(
		hostname: string,
		timeoutMs: number,
		cwd: string,
		env: Record<string, string | undefined>,
	) {
		const proc = launch('opencode', ['serve', `--hostname=${hostname}`, '--port=0'], {
			cwd: cwd || undefined,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});

		const pid = typeof proc.pid === 'number' ? proc.pid : null;
		let output = '';
		const serverUrl = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				void this.killProcess(pid);
				reject(new Error(`Timeout waiting for server to start after ${timeoutMs}ms`));
			}, timeoutMs);
			let resolved = false;

			const onData = (chunk: unknown) => {
				if (resolved) return;
				output += String(chunk);
				const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s\r\n]+)/);
				if (!match?.[1]) return;
				resolved = true;
				clearTimeout(timer);
				resolve(match[1]);
			};

			proc.stdout?.on('data', onData);
			proc.stderr?.on('data', onData);
			proc.on('error', (error: Error) => {
				clearTimeout(timer);
				reject(error);
			});
			proc.on('exit', (code: number | null) => {
				if (resolved) return;
				clearTimeout(timer);
				let message = `Server exited with code ${code}`;
				if (output.trim()) {
					message += `\nServer output: ${output}`;
				}
				reject(new Error(message));
			});
		});

		return {
			serverUrl,
			pid,
			close: () => {
				void this.killProcess(pid, proc);
			},
		};
	}

	private async killProcess(pid: number | null, proc?: ChildProcess): Promise<void> {
		let terminated = false;
		if (proc && !proc.killed) {
			try {
				terminated = proc.kill('SIGTERM');
			} catch {}
		}
		if (!pid) return;
		if (!terminated) {
			try {
				process.kill(pid, 'SIGTERM');
				terminated = true;
			} catch {}
		}
		if (terminated || process.platform !== 'win32') return;
		await new Promise<void>(resolve => {
			execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () =>
				resolve(),
			);
		});
	}

	private initSdkClient(): void {
		if (!this.serverUrl) return;
		try {
			this.sdkClient = createOpencodeClient({
				baseUrl: this.serverUrl,
				headers: this.authorizationHeader ? { authorization: this.authorizationHeader } : undefined,
				...(this.directory ? { directory: this.directory } : {}),
				fetch: this.createRuntimeFetch(this.directory ?? undefined, this.authorizationHeader),
			});
			logger.info('[OpenCode] SDK client initialized');
		} catch (e) {
			logger.warn('[OpenCode] Failed to init SDK client, falling back to fetch:', e);
			this.sdkClient = null;
		}
	}

	private requireSdk(): OpencodeClient {
		if (!this.sdkClient) throw new Error('OpenCode SDK client not initialized');
		return this.sdkClient;
	}

	private async preloadMetadata(): Promise<void> {
		if (!this.directory) return;
		logger.info('[OpenCode] Preloading metadata cache...');
		await Promise.allSettled([
			this.listCommands(this.directory),
			this.listAgents(this.directory),
			this.listSkills(this.directory),
			this.getMcpStatus(this.directory),
		]);
		logger.info('[OpenCode] Metadata cache preloaded');
	}

	public async listCommands(
		directory: string,
	): Promise<Array<{ name: string; description?: string }>> {
		const cached = this.caches.commands.get();
		if (cached) return cached;
		try {
			if (!this.serverUrl) return [];
			const url = new URL('/command', this.serverUrl);
			url.searchParams.set('directory', directory);
			const response = await fetch(url, {
				headers: this.buildFetchHeaders(undefined, this.authorizationHeader),
			});
			if (!response.ok) return [];
			const data = (await response.json()) as Array<{ name?: string; description?: string }>;
			const commands = Array.isArray(data)
				? data
						.filter(
							(command): command is { name: string; description?: string } =>
								typeof command?.name === 'string' && command.name.trim().length > 0,
						)
						.map(command => ({
							name: command.name.trim(),
							...(typeof command.description === 'string'
								? { description: command.description }
								: {}),
						}))
				: [];
			return this.caches.commands.set(commands);
		} catch {
			return [];
		}
	}

	public async listAgents(directory: string): Promise<unknown> {
		const cached = this.caches.agents.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.agents({ directory });
			return this.caches.agents.set(data);
		} catch {
			return [];
		}
	}

	public async listSkills(
		directory: string,
	): Promise<Array<{ name: string; description: string; location?: string; content?: string }>> {
		const cached = this.caches.skills.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.app.skills({ directory });
			const skills = (data ?? []) as Array<{
				name: string;
				description: string;
				location?: string;
				content?: string;
			}>;
			return this.caches.skills.set(Array.isArray(skills) ? skills : []);
		} catch {
			return [];
		}
	}

	public async getMcpStatus(directory: string): Promise<unknown> {
		const cached = this.caches.mcp.get();
		if (cached) return cached;
		try {
			const client = this.requireSdk();
			const { data } = await client.mcp.status({ directory });
			return this.caches.mcp.set(data);
		} catch {
			return {};
		}
	}

	async tryReconnect(workspaceRoot?: string): Promise<boolean> {
		const directory = workspaceRoot
			? OpenCodeExecutor.normalizeDriveLetter(workspaceRoot)
			: this.directory;
		if (!directory) return false;

		if (this.serverUrl && (await this.isOpenCodeServer(this.serverUrl, this.authorizationHeader))) {
			return true;
		}

		const record = this.readRuntimeRecord();
		if (!record) return false;
		if (record.workspaceRoot !== directory) return false;
		if (!(await this.isOpenCodeServer(record.serverUrl, record.authorization))) return false;

		this.serverUrl = record.serverUrl;
		this.authorizationHeader = record.authorization;
		this.runtimeId = record.runtimeId;
		this.directory = directory;
		this.isServerOwner = false;
		this.serverStartedAt = record.createdAt;
		this.serverInstance = null;
		this.initSdkClient();
		logger.info('[OpenCode] Reconnected to managed runtime', { url: record.serverUrl });
		return true;
	}

	getAuthorizationHeader(): string | null {
		return this.authorizationHeader;
	}

	async restartServer(config: CLIConfig): Promise<void> {
		await this.stopManagedRuntime();
		await this.ensureServer(config);
	}

	async isServerHealthy(): Promise<boolean> {
		if (!this.serverUrl) return false;
		return this.isOpenCodeServer(this.serverUrl, this.authorizationHeader);
	}

	private async stopManagedRuntime(): Promise<void> {
		if (this.serverUrl) {
			try {
				await this.request('/global/dispose', {
					method: 'POST',
					signal: AbortSignal.timeout(3_000),
				});
			} catch (error) {
				logger.debug('[OpenCode] REST dispose failed, falling back to process kill', { error });
			}
		}
		if (this.serverInstance) {
			try {
				this.serverInstance.close();
			} catch {}
		}
		const record = this.readRuntimeRecord();
		if (!this.serverInstance && record?.pid) {
			await this.killProcess(record.pid);
		}
		this.serverInstance = null;
		await this.writeRuntimeRecord(null);
		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
		this.isServerOwner = false;
		this.serverStartedAt = null;
		this.runtimeId = null;
		this.authorizationHeader = null;
	}

	async dispose(): Promise<void> {
		this.serverInstance = null;
		this.serverUrl = null;
		this.directory = null;
		this.sdkClient = null;
		this.isServerOwner = false;
		this.serverStartedAt = null;
		this.runtimeId = null;
		this.authorizationHeader = null;
	}

	getAdminInfo(): { baseUrl: string; directory: string } | null {
		return this.serverUrl && this.directory
			? { baseUrl: this.serverUrl, directory: this.directory }
			: null;
	}

	getSdkClient(): OpencodeClient | null {
		return this.sdkClient;
	}

	clearSkillsCache(): void {
		this.caches.skills.clear();
	}

	clearCommandsCache(): void {
		this.caches.commands.clear();
	}

	clearAgentsCache(): void {
		this.caches.agents.clear();
	}

	clearMcpCache(): void {
		this.caches.mcp.clear();
	}

	getProvider(): 'opencode' {
		return 'opencode';
	}

	getConnectionDetails(): {
		serverUrl: string | null;
		isServerOwner: boolean;
		port: number | null;
		uptime: number | null;
		runtimeId: string | null;
	} {
		let port: number | null = null;
		if (this.serverUrl) {
			try {
				port = parseInt(new URL(this.serverUrl).port, 10) || null;
			} catch {}
		}
		return {
			serverUrl: this.serverUrl,
			isServerOwner: this.isServerOwner,
			port,
			uptime: this.serverStartedAt ? Math.max(0, Date.now() - this.serverStartedAt) : null,
			runtimeId: this.runtimeId,
		};
	}
}
