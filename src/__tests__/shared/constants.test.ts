/**
 * Unit Tests for shared constants and utilities
 */

import { describe, expect, it } from 'vitest';
import {
	isModelInProxyList,
	isNonDisconnectableProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
	stripProviderPrefix,
} from '../../shared/constants';

describe('OPENAI_COMPATIBLE_PROVIDER_ID', () => {
	it('should be "oai"', () => {
		expect(OPENAI_COMPATIBLE_PROVIDER_ID).toBe('oai');
	});
});

describe('stripProviderPrefix', () => {
	it('should strip oai/ prefix from model', () => {
		expect(stripProviderPrefix('oai/[Kiro] claude-sonnet-4.5')).toBe('[Kiro] claude-sonnet-4.5');
	});

	it('should strip google/ prefix from model', () => {
		expect(stripProviderPrefix('google/gemini-2.5-flash')).toBe('gemini-2.5-flash');
	});

	it('should strip anthropic/ prefix from model', () => {
		expect(stripProviderPrefix('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
	});

	it('should strip any custom provider prefix', () => {
		expect(stripProviderPrefix('myproxy/gpt-4')).toBe('gpt-4');
		expect(stripProviderPrefix('local/llama-3')).toBe('llama-3');
	});

	it('should return model unchanged if no prefix', () => {
		expect(stripProviderPrefix('[Kiro] claude-sonnet-4.5')).toBe('[Kiro] claude-sonnet-4.5');
		expect(stripProviderPrefix('claude-sonnet-4')).toBe('claude-sonnet-4');
	});

	it('should NOT strip if slash is inside brackets (part of model name)', () => {
		// Model names like "[Cline] x-ai/grok" have slash as part of model name
		expect(stripProviderPrefix('[Cline] x-ai/grok-code-fast-1')).toBe(
			'[Cline] x-ai/grok-code-fast-1',
		);
	});

	it('should handle model with provider prefix AND slash in model name', () => {
		expect(stripProviderPrefix('oai/[Cline] x-ai/grok-code-fast-1')).toBe(
			'[Cline] x-ai/grok-code-fast-1',
		);
	});

	it('should handle empty string', () => {
		expect(stripProviderPrefix('')).toBe('');
	});
});

describe('isModelInProxyList', () => {
	const enabledProxyModels = [
		'[Kiro] claude-sonnet-4.5',
		'[Cline] x-ai/grok-code-fast-1',
		'gpt-4o',
	];

	it('should return true for model in list', () => {
		expect(isModelInProxyList('[Kiro] claude-sonnet-4.5', enabledProxyModels)).toBe(true);
	});

	it('should return true for model with oai/ prefix when base model is in list', () => {
		expect(isModelInProxyList('oai/[Kiro] claude-sonnet-4.5', enabledProxyModels)).toBe(true);
	});

	it('should return true for model with any provider prefix when base model is in list', () => {
		expect(isModelInProxyList('myproxy/[Kiro] claude-sonnet-4.5', enabledProxyModels)).toBe(true);
		expect(isModelInProxyList('custom/gpt-4o', enabledProxyModels)).toBe(true);
	});

	it('should return true for model with slash in name', () => {
		expect(isModelInProxyList('[Cline] x-ai/grok-code-fast-1', enabledProxyModels)).toBe(true);
		expect(isModelInProxyList('oai/[Cline] x-ai/grok-code-fast-1', enabledProxyModels)).toBe(true);
	});

	it('should return false for model not in list', () => {
		expect(isModelInProxyList('claude-sonnet-4', enabledProxyModels)).toBe(false);
	});

	it('should return false for undefined model', () => {
		expect(isModelInProxyList(undefined, enabledProxyModels)).toBe(false);
	});

	it('should return false for empty model', () => {
		expect(isModelInProxyList('', enabledProxyModels)).toBe(false);
	});
});

describe('isNonDisconnectableProviderId', () => {
	it('should return true for opencode', () => {
		expect(isNonDisconnectableProviderId('opencode')).toBe(true);
	});

	it('should return true for opencode-zen', () => {
		expect(isNonDisconnectableProviderId('opencode-zen')).toBe(true);
	});

	it('should return true for zen', () => {
		expect(isNonDisconnectableProviderId('zen')).toBe(true);
	});

	it('should be case-insensitive', () => {
		expect(isNonDisconnectableProviderId('OPENCODE')).toBe(true);
		expect(isNonDisconnectableProviderId('OpenCode')).toBe(true);
	});

	it('should return false for other providers', () => {
		expect(isNonDisconnectableProviderId('google')).toBe(false);
		expect(isNonDisconnectableProviderId('oai')).toBe(false);
		expect(isNonDisconnectableProviderId('anthropic')).toBe(false);
	});
});
