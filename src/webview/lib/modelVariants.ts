import type { OpenCodeProviderData } from '../../common';

export function getAvailableModelVariants(
	providers: OpenCodeProviderData[],
	effectiveModel: string | undefined,
): string[] {
	if (!effectiveModel || effectiveModel === 'default') return [];
	const parts = effectiveModel.split('/');
	if (parts.length < 2) return [];
	const [providerId, ...rest] = parts;
	const modelId = rest.join('/');
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
