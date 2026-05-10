/**
 * @file useModelOptions.ts
 * @description Shared hook for building model select options from enabled providers.
 *              Used by SubagentsTab and potentially ModelDropdown to avoid duplicating
 *              provider filtering logic across components.
 */

import { useMemo } from 'react';
import {
	getProxyEndpointProviderIdFromName,
	isProxyEndpointProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
	type OpenCodeProviderData,
} from '../../common';
import { useSettingsStore } from '../store/settingsStore';

export interface ModelOption {
	value: string;
	label: string;
	modelLabel?: string;
	providerLabel?: string;
	reasoning?: boolean;
}

interface BuildModelOptionsInput {
	opencodeProviders: OpenCodeProviderData[];
	enabledOpenCodeModels: string[];
	proxyEndpoints: ReturnType<typeof useSettingsStore.getState>['proxyEndpoints'];
	includeDefault?: boolean;
}

export function buildModelOptions({
	opencodeProviders,
	enabledOpenCodeModels,
	proxyEndpoints,
	includeDefault = true,
}: BuildModelOptionsInput): ModelOption[] {
	const opts: ModelOption[] = [];
	if (includeDefault) opts.push({ value: '', label: 'Default (inherit)' });

	const enabledSet = new Set(enabledOpenCodeModels);

	for (const provider of opencodeProviders) {
		if (provider.id === OPENAI_COMPATIBLE_PROVIDER_ID || isProxyEndpointProviderId(provider.id)) {
			continue;
		}
		for (const model of provider.models) {
			const compositeId = `${provider.id}/${model.id}`;
			if (!enabledSet.has(compositeId)) continue;
			const modelLabel = model.name || model.id;
			opts.push({
				value: compositeId,
				label: `${modelLabel} (${provider.name})`,
				modelLabel,
				providerLabel: provider.name,
				reasoning: model.reasoning === true,
			});
		}
	}

	for (const endpoint of proxyEndpoints) {
		if (endpoint.enabledModels.length === 0 || endpoint.models.length === 0) continue;
		const providerId = getProxyEndpointProviderIdFromName(endpoint.name, endpoint.id);
		const enabled = new Set(endpoint.enabledModels);
		for (const model of endpoint.models) {
			if (!enabled.has(model.id)) continue;
			const modelLabel = model.name || model.id;
			const providerLabel = endpoint.name || 'Custom';
			opts.push({
				value: `${providerId}/${model.id}`,
				label: `${modelLabel} (${providerLabel})`,
				modelLabel,
				providerLabel,
				reasoning: model.capabilities?.reasoning === true,
			});
		}
	}
	return opts;
}

export function useModelOptions(includeDefault = true): ModelOption[] {
	const opencodeProviders = useSettingsStore(s => s.opencodeProviders);
	const enabledOpenCodeModels = useSettingsStore(s => s.enabledOpenCodeModels);
	const proxyEndpoints = useSettingsStore(s => s.proxyEndpoints);
	const providerModelVisibility = useSettingsStore(s => s.providerModelVisibility);

	return useMemo(() => {
		return buildModelOptions({
			opencodeProviders: opencodeProviders.filter(
				provider => providerModelVisibility[provider.id] !== false,
			),
			enabledOpenCodeModels,
			proxyEndpoints,
			includeDefault,
		});
	}, [
		opencodeProviders,
		enabledOpenCodeModels,
		proxyEndpoints,
		providerModelVisibility,
		includeDefault,
	]);
}
