/**
 * @file ModelsDevService tests
 * @description Tests for models.dev metadata lookup, caching, and batch operations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsDevService } from '../ModelsDevService';

// ---------------------------------------------------------------------------
// Mock data — mimics models.dev/api.json structure
// ---------------------------------------------------------------------------

const MOCK_MODELS_DEV_DATA = {
	anthropic: {
		name: 'Anthropic',
		models: {
			'claude-sonnet-4-5': {
				id: 'claude-sonnet-4-5',
				name: 'Claude Sonnet 4.5',
				reasoning: true,
				tool_call: true,
				attachment: true,
				temperature: true,
				limit: { context: 200000, output: 16384 },
				modalities: { input: ['text', 'image'], output: ['text'] },
			},
			'claude-haiku-4-5': {
				id: 'claude-haiku-4-5',
				name: 'Claude Haiku 4.5',
				reasoning: false,
				tool_call: true,
				limit: { context: 200000, output: 8192 },
				modalities: { input: ['text', 'image'], output: ['text'] },
			},
		},
	},
	openai: {
		name: 'OpenAI',
		models: {
			'gpt-4o': {
				id: 'gpt-4o',
				name: 'GPT-4o',
				reasoning: false,
				tool_call: true,
				limit: { context: 128000, output: 16384 },
				modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
			},
			'o3-mini': {
				id: 'o3-mini',
				name: 'o3-mini',
				reasoning: true,
				tool_call: true,
				limit: { context: 200000, output: 100000 },
				modalities: { input: ['text'], output: ['text'] },
			},
		},
	},
	deepseek: {
		name: 'DeepSeek',
		models: {
			'deepseek-chat': {
				name: 'DeepSeek V3',
				reasoning: false,
				tool_call: true,
				limit: { context: 65536, output: 8192 },
				modalities: { input: ['text'], output: ['text'] },
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let service: ModelsDevService;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	service = new ModelsDevService();
	fetchSpy = vi.fn().mockResolvedValue({
		ok: true,
		json: () => Promise.resolve(MOCK_MODELS_DEV_DATA),
	});
	vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
	service.dispose();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelsDevService', () => {
	describe('getData', () => {
		it('should fetch models.dev data on first call', async () => {
			const data = await service.getData();
			expect(data).toBeTruthy();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(fetchSpy).toHaveBeenCalledWith(
				'https://models.dev/api.json',
				expect.objectContaining({ headers: { Accept: 'application/json' } }),
			);
		});

		it('should cache data and not re-fetch within TTL', async () => {
			await service.getData();
			await service.getData();
			await service.getData();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it('should return null on fetch error without cache', async () => {
			fetchSpy.mockRejectedValueOnce(new Error('Network error'));
			const data = await service.getData();
			expect(data).toBeNull();
		});

		it('should return stale cache on fetch error', async () => {
			// First call succeeds
			await service.getData();
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			// Force cache expiry by manipulating internal state
			(service as any).lastFetchTime = 0;

			// Second call fails
			fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
			const data = await service.getData();
			expect(data).toBeTruthy();
			expect(data).toEqual(MOCK_MODELS_DEV_DATA);
		});

		it('should return stale cache on non-ok response', async () => {
			await service.getData();
			(service as any).lastFetchTime = 0;

			fetchSpy.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' });
			const data = await service.getData();
			expect(data).toEqual(MOCK_MODELS_DEV_DATA);
		});

		it('should deduplicate concurrent fetches', async () => {
			const [r1, r2, r3] = await Promise.all([
				service.getData(),
				service.getData(),
				service.getData(),
			]);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(r1).toBe(r2);
			expect(r2).toBe(r3);
		});
	});

	describe('lookupModel', () => {
		it('should find a model by ID across providers', async () => {
			const result = await service.lookupModel('gpt-4o');
			expect(result).toBeDefined();
			expect(result?.id).toBe('gpt-4o');
			expect(result?.name).toBe('GPT-4o');
			expect(result?.context).toBe(128000);
			expect(result?.output).toBe(16384);
			expect(result?.reasoning).toBe(false);
			expect(result?.tool_call).toBe(true);
			expect(result?.modalities?.input).toContain('image');
		});

		it('should find a model by key when id differs', async () => {
			// deepseek-chat has no explicit id field, uses key
			const result = await service.lookupModel('deepseek-chat');
			expect(result).toBeDefined();
			expect(result?.name).toBe('DeepSeek V3');
			expect(result?.context).toBe(65536);
		});

		it('should return undefined for unknown model', async () => {
			const result = await service.lookupModel('nonexistent-model-xyz');
			expect(result).toBeUndefined();
		});

		it('should return undefined when fetch fails', async () => {
			fetchSpy.mockRejectedValueOnce(new Error('Network error'));
			const result = await service.lookupModel('gpt-4o');
			expect(result).toBeUndefined();
		});

		it('should return correct capabilities for reasoning model', async () => {
			const result = await service.lookupModel('claude-sonnet-4-5');
			expect(result).toBeDefined();
			expect(result?.reasoning).toBe(true);
			expect(result?.context).toBe(200000);
			expect(result?.output).toBe(16384);
		});

		it('should return correct capabilities for non-reasoning model', async () => {
			const result = await service.lookupModel('claude-haiku-4-5');
			expect(result).toBeDefined();
			expect(result?.reasoning).toBe(false);
		});
	});

	describe('lookupModels (batch)', () => {
		it('should resolve multiple models in one call', async () => {
			const results = await service.lookupModels(['gpt-4o', 'claude-sonnet-4-5', 'o3-mini']);
			expect(results.size).toBe(3);
			expect(results.get('gpt-4o')?.context).toBe(128000);
			expect(results.get('claude-sonnet-4-5')?.context).toBe(200000);
			expect(results.get('o3-mini')?.context).toBe(200000);
			// Only one fetch call for the batch
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it('should skip unknown models in batch', async () => {
			const results = await service.lookupModels(['gpt-4o', 'unknown-model']);
			expect(results.size).toBe(1);
			expect(results.has('gpt-4o')).toBe(true);
			expect(results.has('unknown-model')).toBe(false);
		});

		it('should return empty map when fetch fails', async () => {
			fetchSpy.mockRejectedValueOnce(new Error('Network error'));
			const results = await service.lookupModels(['gpt-4o']);
			expect(results.size).toBe(0);
		});

		it('should return empty map for empty input', async () => {
			const results = await service.lookupModels([]);
			expect(results.size).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// Real-world model IDs from opencode.json (bracket prefixes, slashes, etc.)
	// -----------------------------------------------------------------------

	describe('lookupModel with bracket-prefixed IDs', () => {
		it('should match "[Kiro] claude-sonnet-4-5" to "claude-sonnet-4-5"', async () => {
			const result = await service.lookupModel('[Kiro] claude-sonnet-4-5');
			expect(result).toBeDefined();
			expect(result?.context).toBe(200000);
			expect(result?.name).toBe('Claude Sonnet 4.5');
		});

		it('should match "[Kiro] claude-haiku-4-5" to "claude-haiku-4-5"', async () => {
			const result = await service.lookupModel('[Kiro] claude-haiku-4-5');
			expect(result).toBeDefined();
			expect(result?.context).toBe(200000);
			expect(result?.reasoning).toBe(false);
		});

		it('should match "[Codex] gpt-4o" to "gpt-4o"', async () => {
			const result = await service.lookupModel('[Codex] gpt-4o');
			expect(result).toBeDefined();
			expect(result?.context).toBe(128000);
		});

		it('should return undefined for prefixed model not in models.dev', async () => {
			const result = await service.lookupModel('[Codex] gpt-5.4');
			expect(result).toBeUndefined();
		});

		it('should match wrapper around known model via substring', async () => {
			// "kiro-claude-sonnet-4-5" contains "claude-sonnet-4-5" as substring.
			// This is correct: the wrapper model inherits the base model's metadata.
			const result = await service.lookupModel('[Kiro] kiro-claude-sonnet-4-5');
			expect(result).toBeDefined();
			expect(result?.id).toBe('claude-sonnet-4-5');
			expect(result?.context).toBe(200000);
		});

		it('should return undefined for truly unknown model', async () => {
			const result = await service.lookupModel('[Kiro] kiro-custom-xyz');
			expect(result).toBeUndefined();
		});
	});

	describe('lookupModels (batch) with bracket-prefixed IDs', () => {
		it('should resolve prefixed IDs and return results keyed by original ID', async () => {
			const results = await service.lookupModels([
				'[Kiro] claude-sonnet-4-5',
				'[Codex] gpt-4o',
				'[Kiro] kiro-custom-model', // not in models.dev
			]);
			expect(results.size).toBe(2);
			expect(results.get('[Kiro] claude-sonnet-4-5')?.context).toBe(200000);
			expect(results.get('[Codex] gpt-4o')?.context).toBe(128000);
			expect(results.has('[Kiro] kiro-custom-model')).toBe(false);
		});

		it('should handle mix of prefixed and non-prefixed IDs', async () => {
			const results = await service.lookupModels([
				'gpt-4o',
				'[Kiro] claude-sonnet-4-5',
				'deepseek-chat',
			]);
			expect(results.size).toBe(3);
			expect(results.get('gpt-4o')?.context).toBe(128000);
			expect(results.get('[Kiro] claude-sonnet-4-5')?.context).toBe(200000);
			expect(results.get('deepseek-chat')?.context).toBe(65536);
		});
	});

	describe('dispose', () => {
		it('should clear cache on dispose', async () => {
			await service.getData();
			service.dispose();
			expect((service as any).cache).toBeNull();
			expect((service as any).fetchPromise).toBeNull();
		});
	});
});
