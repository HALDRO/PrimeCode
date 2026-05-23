/**
 * @file useModelOptions.ts
 * @description Shared hook for building model select options from enabled providers.
 *              Used by SubagentsTab and potentially ModelDropdown to avoid duplicating
 *              provider filtering logic across components.
 */

import { useMemo } from 'react';
import {
	getProxyEndpointProviderIdFromName,
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
	providerModelVisibility?: Record<string, boolean | undefined>;
	includeDefault?: boolean;
}

export function buildModelOptions({
	opencodeProviders,
	enabledOpenCodeModels,
	proxyEndpoints,
	providerModelVisibility,
	includeDefault = true,
}: BuildModelOptionsInput): ModelOption[] {
	const opts: ModelOption[] = [];
	if (includeDefault) opts.push({ value: '', label: 'Default (inherit)' });

	const enabledSet = new Set(enabledOpenCodeModels);
	const proxyProviderIds = new Set(
		proxyEndpoints.map(ep => getProxyEndpointProviderIdFromName(ep.name, ep.id)),
	);

	for (const provider of opencodeProviders) {
		if (provider.id === OPENAI_COMPATIBLE_PROVIDER_ID || proxyProviderIds.has(provider.id)) {
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
		// Check visibility by endpoint.id first (canonical key), then fall back to derived providerId
		// for backward compatibility with previously saved preferences.
		const visibilityById = providerModelVisibility?.[endpoint.id];
		const visibilityByProviderId = providerModelVisibility?.[providerId];
		if (
			visibilityById === false ||
			(visibilityById === undefined && visibilityByProviderId === false)
		)
			continue;
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
			providerModelVisibility,
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
