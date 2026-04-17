import type { OpenCodeProviderData } from '../../common';
import type { ProxyEndpointState } from '../store/settingsStore';

type AgentLike = {
	id?: string;
	name?: string;
	model?: string;
	variant?: string;
};

const OPENAI_COMPATIBLE_DEFAULT_VARIANTS = ['low', 'medium', 'high'];

function isOpenAICompatibleProvider(providerId: string): boolean {
	return providerId === 'proxy' || providerId === 'oai' || providerId.startsWith('oai-');
}

function getMatchingProxyEndpoints(
	providerId: string,
	proxyEndpoints: ProxyEndpointState[],
): ProxyEndpointState[] {
	if (providerId.startsWith('oai-')) {
		const endpointId = providerId.slice(4);
		return proxyEndpoints.filter(endpoint => endpoint.id === endpointId);
	}
	return proxyEndpoints;
}

export function getAvailableModelVariants(
	providers: OpenCodeProviderData[],
	effectiveModel: string | undefined,
	proxyEndpoints: ProxyEndpointState[] = [],
): string[] {
	if (!effectiveModel || effectiveModel === 'default') return [];
	const parts = effectiveModel.split('/');
	if (parts.length < 2) return [];
	const [providerId, ...rest] = parts;
	const modelId = rest.join('/');
	if (isOpenAICompatibleProvider(providerId)) {
		for (const endpoint of getMatchingProxyEndpoints(providerId, proxyEndpoints)) {
			const endpointModel = endpoint.models.find(item => item.id === modelId);
			if (endpointModel?.variants && endpointModel.variants.length > 0)
				return endpointModel.variants;
			const configuredVariants = endpoint.modelVariants?.[modelId];
			if (configuredVariants && configuredVariants.length > 0) return configuredVariants;
		}
		return OPENAI_COMPATIBLE_DEFAULT_VARIANTS;
	}
	const provider = providers.find(item => item.id === providerId);
	const model = provider?.models?.find(item => item.id === modelId);
	return model?.variants && model.variants.length > 0 ? model.variants : [];
}

export function resolveValidVariant(
	variants: string[],
	variant: string | undefined,
): string | undefined {
	if (!variant) return undefined;
	return variants.includes(variant) ? variant : undefined;
}

export function getConfiguredAgentVariant(input: {
	agent: AgentLike | undefined;
	effectiveModel: string | undefined;
	variants: string[];
}): string | undefined {
	if (!input.agent?.variant) return undefined;
	if (!input.agent.model) return undefined;
	if (!input.effectiveModel || input.agent.model !== input.effectiveModel) return undefined;
	return resolveValidVariant(input.variants, input.agent.variant);
}

export function resolveEffectiveVariant(input: {
	variants: string[];
	selected: string | undefined;
	configured: string | undefined;
}): string | undefined {
	return (
		resolveValidVariant(input.variants, input.selected) ??
		resolveValidVariant(input.variants, input.configured)
	);
}
