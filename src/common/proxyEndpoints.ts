export type ProxyEndpointProtocol = 'openai-compatible' | 'openai-responses' | 'anthropic';

const CUSTOM_ENDPOINT_NPM_BY_PROTOCOL: Record<ProxyEndpointProtocol, string> = {
	'openai-compatible': '@ai-sdk/openai-compatible',
	'openai-responses': '@ai-sdk/openai',
	anthropic: '@ai-sdk/anthropic',
};

const CUSTOM_ENDPOINT_DEFAULT_NAME_BY_PROTOCOL: Record<ProxyEndpointProtocol, string> = {
	'openai-compatible': 'OpenAI Compatible',
	'openai-responses': 'OpenAI Responses',
	anthropic: 'Anthropic',
};

/**
 * Normalize a user-provided proxy base URL to the canonical form expected by
 * `@ai-sdk/openai-compatible`, which appends `/chat/completions` directly.
 *
 * Handles common user mistakes:
 *   http://host:port            -> http://host:port/v1
 *   http://host:port/           -> http://host:port/v1
 *   http://host:port///         -> http://host:port/v1
 *   http://host:port/v1         -> http://host:port/v1
 *   http://host:port/v1/        -> http://host:port/v1
 *   http://host:port/v1/models  -> http://host:port/v1
 *   http://host:port/v1/chat/completions -> http://host:port/v1
 */
export function normalizeProxyBaseUrl(raw: string): string {
	return `${raw
		.trim()
		.replace(/\/+$/, '')
		.replace(/\/v1(?:\/.*)?$/, '')}/v1`;
}

export function getProxyEndpointProtocol(value: unknown): ProxyEndpointProtocol {
	if (value === 'anthropic') return 'anthropic';
	if (value === 'openai-responses') return 'openai-responses';
	return 'openai-compatible';
}

export function normalizeCustomEndpointBaseUrl(
	protocol: ProxyEndpointProtocol,
	raw: string,
): string {
	if (protocol === 'anthropic') return raw.trim().replace(/\/+$/, '');
	if (protocol === 'openai-responses') return raw.trim().replace(/\/+$/, '');
	return normalizeProxyBaseUrl(raw);
}

export function getCustomEndpointDedupeKey(
	protocol: ProxyEndpointProtocol,
	baseUrl: string,
): string {
	const normalized = normalizeCustomEndpointBaseUrl(protocol, baseUrl);
	return normalized ? `${protocol}::${normalized}` : '';
}

export function isCustomEndpointNpm(npm: string | undefined): boolean {
	return npm !== undefined && Object.values(CUSTOM_ENDPOINT_NPM_BY_PROTOCOL).includes(npm);
}

export function getCustomEndpointNpm(protocol: ProxyEndpointProtocol): string {
	return CUSTOM_ENDPOINT_NPM_BY_PROTOCOL[protocol];
}

export function getCustomEndpointProtocolFromNpm(npm: string | undefined): ProxyEndpointProtocol {
	if (npm === CUSTOM_ENDPOINT_NPM_BY_PROTOCOL.anthropic) return 'anthropic';
	if (npm === CUSTOM_ENDPOINT_NPM_BY_PROTOCOL['openai-responses']) return 'openai-responses';
	return 'openai-compatible';
}

export function getCustomEndpointDefaultName(protocol: ProxyEndpointProtocol): string {
	return CUSTOM_ENDPOINT_DEFAULT_NAME_BY_PROTOCOL[protocol];
}

export function getCustomEndpointModelsUrl(
	protocol: ProxyEndpointProtocol,
	baseUrl: string,
): string {
	return protocol === 'anthropic' ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
}

export function buildCustomEndpointAuthHeaders(
	protocol: ProxyEndpointProtocol,
	apiKey: string,
): Record<string, string> {
	if (protocol === 'anthropic') {
		return {
			...(apiKey ? { 'x-api-key': apiKey } : {}),
			'anthropic-version': '2023-06-01',
		};
	}

	return {
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};
}
