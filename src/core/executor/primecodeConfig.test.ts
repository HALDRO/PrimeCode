import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	addRuntime,
	CONFIG_PATH,
	flushWrites,
	getAppSettings,
	getModelSettings,
	getRuntimesForWorkspace,
	invalidateConfigCache,
	isProcessAlive,
	removeRuntime,
	resetConfigForTesting,
	updateAppSettings,
	updateConfig,
	updateModelSettings,
} from './primecodeConfig';

// Use a temp directory to avoid polluting real config
const TEST_DIR = path.dirname(CONFIG_PATH);

function cleanConfig(): void {
	if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
	if (existsSync(`${CONFIG_PATH}.tmp`)) rmSync(`${CONFIG_PATH}.tmp`);
	resetConfigForTesting();
}

describe('primecodeConfig', () => {
	beforeEach(() => {
		cleanConfig();
	});

	afterEach(() => {
		cleanConfig();
	});

	describe('readConfig / defaults', () => {
		it('returns defaults when file does not exist', () => {
			const models = getModelSettings();
			expect(models.enabledModels).toEqual([]);
			expect(models.providerModelVisibility).toEqual({});
			expect(models.modelVariants).toEqual({});

			const app = getAppSettings();
			expect(app.proxyEndpoints).toEqual([]);
			expect(app.providersDisabled).toEqual([]);
			expect(app.promptImproveModel).toBe('');
			expect(app.promptImproveTemplate).toBe('');
			expect(app.opencodeAgent).toBe('');
		});

		it('parses existing file correctly', () => {
			const config = {
				runtimes: [],
				models: {
					enabledModels: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
					providerModelVisibility: { anthropic: true },
					modelVariants: { 'anthropic/claude-sonnet-4': 'extended-thinking' },
				},
				app: {
					proxyEndpoints: [
						{
							id: 'ep1',
							name: 'Test',
							baseUrl: 'http://localhost:8080',
							apiKey: 'key',
							enabledModels: ['m1'],
						},
					],
					providersDisabled: ['openai'],
					promptImproveModel: 'gpt-4o',
					promptImproveTemplate: 'Improve this',
					opencodeAgent: 'coder',
				},
			};
			if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(CONFIG_PATH, JSON.stringify(config), 'utf-8');
			invalidateConfigCache();

			const models = getModelSettings();
			expect(models.enabledModels).toEqual(['anthropic/claude-sonnet-4', 'openai/gpt-4o']);
			expect(models.modelVariants['anthropic/claude-sonnet-4']).toBe('extended-thinking');

			const app = getAppSettings();
			expect(app.proxyEndpoints).toHaveLength(1);
			expect(app.proxyEndpoints[0].id).toBe('ep1');
			expect(app.providersDisabled).toEqual(['openai']);
			expect(app.opencodeAgent).toBe('coder');
		});

		it('handles corrupted JSON gracefully', () => {
			if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
			writeFileSync(CONFIG_PATH, '{invalid json!!!', 'utf-8');
			invalidateConfigCache();

			// Should return cached/default state, not crash
			const models = getModelSettings();
			expect(models).toBeDefined();
			expect(Array.isArray(models.enabledModels)).toBe(true);
		});
	});

	describe('stat-based cache', () => {
		it('returns cached data without re-reading file', () => {
			updateModelSettings({ enabledModels: ['test/model'] });
			const models = getModelSettings();
			expect(models.enabledModels).toEqual(['test/model']);
		});

		it('invalidateConfigCache forces re-read from disk', async () => {
			updateModelSettings({ enabledModels: ['original'] });
			await flushWrites();

			// Write directly to disk bypassing cache
			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			raw.models.enabledModels = ['modified-externally'];
			writeFileSync(CONFIG_PATH, JSON.stringify(raw), 'utf-8');

			// After invalidation, reads fresh from disk
			invalidateConfigCache();
			expect(getModelSettings().enabledModels).toEqual(['modified-externally']);
		});
	});

	describe('updateModelSettings', () => {
		it('updates enabledModels', () => {
			updateModelSettings({ enabledModels: ['a', 'b', 'c'] });
			expect(getModelSettings().enabledModels).toEqual(['a', 'b', 'c']);
		});

		it('merges providerModelVisibility', () => {
			updateModelSettings({ providerModelVisibility: { anthropic: true } });
			updateModelSettings({ providerModelVisibility: { openai: false } });
			const vis = getModelSettings().providerModelVisibility;
			expect(vis.anthropic).toBe(true);
			expect(vis.openai).toBe(false);
		});

		it('merges modelVariants', () => {
			updateModelSettings({ modelVariants: { 'model-a': 'high' } });
			updateModelSettings({ modelVariants: { 'model-b': 'low' } });
			const variants = getModelSettings().modelVariants;
			expect(variants['model-a']).toBe('high');
			expect(variants['model-b']).toBe('low');
		});
	});

	describe('updateAppSettings', () => {
		it('updates proxyEndpoints', () => {
			const endpoint = {
				id: 'ep1',
				name: 'Local',
				baseUrl: 'http://localhost:11434',
				apiKey: '',
				enabledModels: ['llama3'],
			};
			updateAppSettings({ proxyEndpoints: [endpoint] });
			expect(getAppSettings().proxyEndpoints).toHaveLength(1);
			expect(getAppSettings().proxyEndpoints[0].id).toBe('ep1');
		});

		it('updates providersDisabled', () => {
			updateAppSettings({ providersDisabled: ['openai', 'google'] });
			expect(getAppSettings().providersDisabled).toEqual(['openai', 'google']);
		});

		it('updates opencodeAgent', () => {
			updateAppSettings({ opencodeAgent: 'architect' });
			expect(getAppSettings().opencodeAgent).toBe('architect');
		});

		it('updates promptImprove fields', () => {
			updateAppSettings({ promptImproveModel: 'gpt-4o', promptImproveTemplate: 'Be concise' });
			expect(getAppSettings().promptImproveModel).toBe('gpt-4o');
			expect(getAppSettings().promptImproveTemplate).toBe('Be concise');
		});
	});

	describe('updateConfig (batched)', () => {
		it('updates models and app in a single call', () => {
			updateConfig({
				models: { enabledModels: ['x'], providerModelVisibility: { test: true } },
				app: { opencodeAgent: 'batch-agent', providersDisabled: ['p1'] },
			});

			expect(getModelSettings().enabledModels).toEqual(['x']);
			expect(getModelSettings().providerModelVisibility.test).toBe(true);
			expect(getAppSettings().opencodeAgent).toBe('batch-agent');
			expect(getAppSettings().providersDisabled).toEqual(['p1']);
		});

		it('only updates models when app is not provided', () => {
			updateAppSettings({ opencodeAgent: 'original' });
			updateConfig({ models: { enabledModels: ['new'] } });

			expect(getModelSettings().enabledModels).toEqual(['new']);
			expect(getAppSettings().opencodeAgent).toBe('original');
		});
	});

	describe('runtime registry', () => {
		const entry = {
			runtimeId: 'rt-1',
			serverUrl: 'http://127.0.0.1:4096',
			authorization: 'Basic abc',
			workspaceRoot: 'D:\\Projects\\Test',
			createdAt: Date.now(),
			pid: 12345,
			ownerPid: process.pid,
		};

		it('addRuntime stores entry', () => {
			addRuntime(entry);
			const entries = getRuntimesForWorkspace('D:\\Projects\\Test');
			expect(entries).toHaveLength(1);
			expect(entries[0].runtimeId).toBe('rt-1');
			expect(entries[0].pid).toBe(12345);
		});

		it('addRuntime deduplicates by runtimeId', () => {
			addRuntime(entry);
			addRuntime({ ...entry, pid: 99999 });
			const entries = getRuntimesForWorkspace('D:\\Projects\\Test');
			expect(entries).toHaveLength(1);
			expect(entries[0].pid).toBe(99999);
		});

		it('removeRuntime removes by runtimeId', () => {
			addRuntime(entry);
			removeRuntime('rt-1');
			expect(getRuntimesForWorkspace('D:\\Projects\\Test')).toHaveLength(0);
		});

		it('removeRuntime is no-op for unknown id', () => {
			addRuntime(entry);
			removeRuntime('unknown');
			expect(getRuntimesForWorkspace('D:\\Projects\\Test')).toHaveLength(1);
		});

		it('getRuntimesForWorkspace filters by workspace', () => {
			addRuntime(entry);
			addRuntime({ ...entry, runtimeId: 'rt-2', workspaceRoot: 'D:\\Other' });
			expect(getRuntimesForWorkspace('D:\\Projects\\Test')).toHaveLength(1);
			expect(getRuntimesForWorkspace('D:\\Other')).toHaveLength(1);
			expect(getRuntimesForWorkspace('D:\\Unknown')).toHaveLength(0);
		});
	});

	describe('isProcessAlive', () => {
		it('returns true for current process', () => {
			expect(isProcessAlive(process.pid)).toBe(true);
		});

		it('returns false for non-existent PID', () => {
			expect(isProcessAlive(999999)).toBe(false);
		});
	});

	describe('atomic write safety', () => {
		it('does not leave .tmp file after successful write', async () => {
			updateModelSettings({ enabledModels: ['test'] });
			await flushWrites();
			expect(existsSync(`${CONFIG_PATH}.tmp`)).toBe(false);
			expect(existsSync(CONFIG_PATH)).toBe(true);
		});

		it('file contains valid JSON after write', async () => {
			updateConfig({
				models: { enabledModels: ['a', 'b'] },
				app: { opencodeAgent: 'y' },
			});
			await flushWrites();
			const raw = readFileSync(CONFIG_PATH, 'utf-8');
			const parsed = JSON.parse(raw);
			expect(parsed.models.enabledModels).toEqual(['a', 'b']);
			expect(parsed.app.opencodeAgent).toBe('y');
		});
	});

	describe('runtime and settings independence', () => {
		it('addRuntime does not overwrite settings', async () => {
			// Write settings first
			updateConfig({
				models: { enabledModels: ['model-a', 'model-b'] },
				app: { providersDisabled: ['openai'], opencodeAgent: 'coder' },
			});
			await flushWrites();

			// Add runtime — should only touch runtimes section
			addRuntime({
				runtimeId: 'rt-1',
				serverUrl: 'http://127.0.0.1:5000',
				authorization: 'Bearer x',
				workspaceRoot: 'D:\\Test',
				createdAt: Date.now(),
				pid: 1234,
				ownerPid: process.pid,
			});

			// Verify settings are intact
			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.models.enabledModels).toEqual(['model-a', 'model-b']);
			expect(raw.app.providersDisabled).toEqual(['openai']);
			expect(raw.app.opencodeAgent).toBe('coder');
			expect(raw.runtimes).toHaveLength(1);
		});

		it('removeRuntime does not overwrite settings', async () => {
			// Setup: settings + runtime
			updateConfig({
				models: { enabledModels: ['keep-me'] },
				app: {
					proxyEndpoints: [
						{ id: 'ep1', name: 'Test', baseUrl: 'http://x', apiKey: 'k', enabledModels: ['m1'] },
					],
				},
			});
			await flushWrites();
			addRuntime({
				runtimeId: 'rt-1',
				serverUrl: 'http://127.0.0.1:5000',
				authorization: 'Bearer x',
				workspaceRoot: 'D:\\Test',
				createdAt: Date.now(),
				pid: 1234,
				ownerPid: process.pid,
			});

			// Remove runtime
			removeRuntime('rt-1');

			// Verify settings are intact
			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.models.enabledModels).toEqual(['keep-me']);
			expect(raw.app.proxyEndpoints).toHaveLength(1);
			expect(raw.runtimes).toHaveLength(0);
		});

		it('settings write does not overwrite runtimes', async () => {
			// Add runtime first
			addRuntime({
				runtimeId: 'rt-1',
				serverUrl: 'http://127.0.0.1:5000',
				authorization: 'Bearer x',
				workspaceRoot: 'D:\\Test',
				createdAt: Date.now(),
				pid: 1234,
				ownerPid: process.pid,
			});

			// Write settings — should not touch runtimes
			updateConfig({
				models: { enabledModels: ['new-model'] },
				app: { opencodeAgent: 'new-agent' },
			});
			await flushWrites();

			// Verify runtimes are intact
			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.runtimes).toHaveLength(1);
			expect(raw.runtimes[0].runtimeId).toBe('rt-1');
			expect(raw.models.enabledModels).toEqual(['new-model']);
		});

		it('multiple rapid runtime writes preserve settings', async () => {
			updateConfig({
				models: { enabledModels: ['preserved'] },
				app: { providersDisabled: ['keep'] },
			});
			await flushWrites();

			// Rapid add/remove cycle
			addRuntime({
				runtimeId: 'rt-1',
				serverUrl: 'http://a',
				authorization: 'x',
				workspaceRoot: 'D:\\A',
				createdAt: 1,
				pid: 1,
				ownerPid: process.pid,
			});
			addRuntime({
				runtimeId: 'rt-2',
				serverUrl: 'http://b',
				authorization: 'y',
				workspaceRoot: 'D:\\B',
				createdAt: 2,
				pid: 2,
				ownerPid: process.pid,
			});
			removeRuntime('rt-1');
			addRuntime({
				runtimeId: 'rt-3',
				serverUrl: 'http://c',
				authorization: 'z',
				workspaceRoot: 'D:\\C',
				createdAt: 3,
				pid: 3,
				ownerPid: process.pid,
			});

			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.models.enabledModels).toEqual(['preserved']);
			expect(raw.app.providersDisabled).toEqual(['keep']);
			expect(raw.runtimes).toHaveLength(2);
			expect(raw.runtimes.map((r: { runtimeId: string }) => r.runtimeId).sort()).toEqual([
				'rt-2',
				'rt-3',
			]);
		});
	});

	describe('parse resilience', () => {
		it('partial models section preserves existing cache values', async () => {
			// First, set real values in cache and disk
			updateConfig({
				models: { enabledModels: ['cached-model'], providerModelVisibility: { prov: true } },
				app: { providersDisabled: ['cached-provider'] },
			});
			await flushWrites();

			// Now write a file with partial models (missing providerModelVisibility)
			const partial = {
				models: { enabledModels: ['from-disk'] },
				app: { providersDisabled: ['from-disk-provider'] },
			};
			writeFileSync(CONFIG_PATH, JSON.stringify(partial), 'utf-8');
			invalidateConfigCache();

			// providerModelVisibility should fall back to cached value { prov: true }
			const models = getModelSettings();
			expect(models.enabledModels).toEqual(['from-disk']);
			expect(models.providerModelVisibility.prov).toBe(true);
		});

		it('missing app section preserves cached app settings', async () => {
			updateAppSettings({ providersDisabled: ['important-provider'], opencodeAgent: 'my-agent' });
			await flushWrites();

			// Write file without app section
			writeFileSync(CONFIG_PATH, JSON.stringify({ models: { enabledModels: ['x'] } }), 'utf-8');
			invalidateConfigCache();

			const app = getAppSettings();
			expect(app.providersDisabled).toEqual(['important-provider']);
			expect(app.opencodeAgent).toBe('my-agent');
		});

		it('empty file does not reset settings', async () => {
			updateConfig({
				models: { enabledModels: ['should-survive'] },
				app: { providersDisabled: ['should-survive-too'] },
			});
			await flushWrites();

			// Simulate truncated/empty file
			writeFileSync(CONFIG_PATH, '', 'utf-8');
			invalidateConfigCache();

			// Should return cached values, not defaults
			expect(getModelSettings().enabledModels).toEqual(['should-survive']);
			expect(getAppSettings().providersDisabled).toEqual(['should-survive-too']);
		});

		it('corrupted JSON does not reset settings', async () => {
			updateConfig({
				models: { enabledModels: ['protected'] },
				app: { opencodeAgent: 'protected-agent' },
			});
			await flushWrites();

			// Corrupt the file
			writeFileSync(CONFIG_PATH, '{"models": {broken', 'utf-8');
			invalidateConfigCache();

			expect(getModelSettings().enabledModels).toEqual(['protected']);
			expect(getAppSettings().opencodeAgent).toBe('protected-agent');
		});

		it('settings write skipped when file is corrupted on disk', async () => {
			updateConfig({ models: { enabledModels: ['original'] } });
			await flushWrites();

			// Corrupt file on disk
			writeFileSync(CONFIG_PATH, 'not json at all', 'utf-8');

			// Try to write settings — should skip disk write, keep cache
			updateModelSettings({ enabledModels: ['new-value'] });
			await flushWrites();

			// Cache should have new value
			expect(getModelSettings().enabledModels).toEqual(['new-value']);

			// Disk should still be corrupted (write was skipped)
			const diskContent = readFileSync(CONFIG_PATH, 'utf-8');
			expect(diskContent).toBe('not json at all');
		});
	});

	describe('concurrent settings writes', () => {
		it('sequential updateConfig calls produce correct final state', async () => {
			updateConfig({ models: { enabledModels: ['first'] } });
			updateConfig({ models: { enabledModels: ['second'] } });
			updateConfig({ app: { opencodeAgent: 'final-agent' } });
			await flushWrites();

			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.models.enabledModels).toEqual(['second']);
			expect(raw.app.opencodeAgent).toBe('final-agent');
		});

		it('interleaved runtime and settings writes are consistent', async () => {
			updateConfig({ models: { enabledModels: ['settings-1'] } });
			addRuntime({
				runtimeId: 'rt-1',
				serverUrl: 'http://a',
				authorization: 'x',
				workspaceRoot: 'D:\\A',
				createdAt: 1,
				pid: 1,
				ownerPid: process.pid,
			});
			updateConfig({ app: { opencodeAgent: 'settings-2' } });
			addRuntime({
				runtimeId: 'rt-2',
				serverUrl: 'http://b',
				authorization: 'y',
				workspaceRoot: 'D:\\B',
				createdAt: 2,
				pid: 2,
				ownerPid: process.pid,
			});
			await flushWrites();

			const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
			expect(raw.models.enabledModels).toEqual(['settings-1']);
			expect(raw.app.opencodeAgent).toBe('settings-2');
			expect(raw.runtimes).toHaveLength(2);
		});
	});
});
