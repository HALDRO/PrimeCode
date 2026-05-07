/**
 * @file useModelOptions.test.ts
 * @description Regression tests for canonical provider/model option construction shared by model UI.
 */

import { describe, expect, it } from 'vitest';
import { buildModelOptions } from './useModelOptions';

describe('buildModelOptions', () => {
	it('builds official provider/model values for enabled OpenCode and proxy models', () => {
		const options = buildModelOptions({
			opencodeProviders: [
				{
					id: 'opencode',
					name: 'OpenCode',
					models: [
						{ id: 'gpt-5', name: 'GPT-5', reasoning: true },
						{ id: 'disabled-model', name: 'Disabled' },
					],
				},
				{
					id: 'oai',
					name: 'OpenAI Compatible',
					models: [{ id: 'shadow', name: 'Shadow' }],
				},
			],
			enabledOpenCodeModels: ['opencode/gpt-5'],
			proxyEndpoints: [
				{
					id: 'local',
					name: 'Local Proxy',
					protocol: 'openai-compatible',
					baseUrl: 'http://localhost:1234/v1',
					apiKey: '',
					models: [
						{ id: 'qwen3', name: 'Qwen 3', capabilities: { reasoning: true } },
						{ id: 'disabled-local', name: 'Disabled Local' },
					],
					enabledModels: ['qwen3'],
					testStatus: { isLoading: false, success: null, error: null, lastTested: null },
				},
			],
		});

		expect(options).toEqual([
			{ value: '', label: 'Default (inherit)' },
			{
				value: 'opencode/gpt-5',
				label: 'GPT-5 (OpenCode)',
				modelLabel: 'GPT-5',
				providerLabel: 'OpenCode',
				reasoning: true,
			},
			{
				value: 'oai-local/qwen3',
				label: 'Qwen 3 (Local Proxy)',
				modelLabel: 'Qwen 3',
				providerLabel: 'Local Proxy',
				reasoning: true,
			},
		]);
	});

	it('keeps duplicate model names distinguishable in simple selects', () => {
		const options = buildModelOptions({
			opencodeProviders: [
				{
					id: 'anthropic',
					name: 'Anthropic',
					models: [{ id: 'sonnet', name: 'Sonnet' }],
				},
				{
					id: 'openrouter',
					name: 'OpenRouter',
					models: [{ id: 'sonnet', name: 'Sonnet' }],
				},
			],
			enabledOpenCodeModels: ['anthropic/sonnet', 'openrouter/sonnet'],
			proxyEndpoints: [],
		});

		expect(options.map(option => option.label)).toEqual([
			'Default (inherit)',
			'Sonnet (Anthropic)',
			'Sonnet (OpenRouter)',
		]);
		expect(options[1].modelLabel).toBe('Sonnet');
	});

	it('skips empty proxy endpoints without affecting enabled proxy models', () => {
		const options = buildModelOptions({
			opencodeProviders: [],
			enabledOpenCodeModels: [],
			proxyEndpoints: [
				{
					id: 'empty',
					name: 'Empty Proxy',
					protocol: 'openai-compatible',
					baseUrl: 'http://localhost:1111/v1',
					apiKey: '',
					models: [{ id: 'ignored', name: 'Ignored' }],
					enabledModels: [],
					testStatus: { isLoading: false, success: null, error: null, lastTested: null },
				},
				{
					id: 'enabled',
					name: 'Enabled Proxy',
					protocol: 'openai-compatible',
					baseUrl: 'http://localhost:2222/v1',
					apiKey: '',
					models: [{ id: 'qwen3', name: 'Qwen 3' }],
					enabledModels: ['qwen3'],
					testStatus: { isLoading: false, success: null, error: null, lastTested: null },
				},
			],
			includeDefault: false,
		});

		expect(options).toEqual([
			{
				value: 'oai-enabled/qwen3',
				label: 'Qwen 3 (Enabled Proxy)',
				modelLabel: 'Qwen 3',
				providerLabel: 'Enabled Proxy',
				reasoning: false,
			},
		]);
	});

	it('omits default inherit option for concrete model dropdowns', () => {
		const options = buildModelOptions({
			opencodeProviders: [],
			enabledOpenCodeModels: [],
			proxyEndpoints: [],
			includeDefault: false,
		});

		expect(options).toEqual([]);
	});
});
