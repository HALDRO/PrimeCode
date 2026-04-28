/**
 * @file useModelOptions.ts
 * @description Shared hook for building model select options from enabled providers.
 *              Used by SubagentsTab and potentially ModelDropdown to avoid duplicating
 *              provider filtering logic across components.
 */

import { useMemo } from 'react';
import {
	getProxyEndpointProviderId,
	isProxyEndpointProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from '../../common';
import { useSettingsStore } from '../store/settingsStore';

export interface ModelOption {
	value: string;
	label: string;
}

export function useModelOptions(includeDefault = true): ModelOption[] {
	const opencodeProviders = useSettingsStore(s => s.opencodeProviders);
	const enabledOpenCodeModels = useSettingsStore(s => s.enabledOpenCodeModels);
	const proxyEndpoints = useSettingsStore(s => s.proxyEndpoints);

	return useMemo(() => {
		const opts: ModelOption[] = [];
		if (includeDefault) opts.push({ value: '', label: 'Default (inherit)' });

		const enabledSet = new Set(enabledOpenCodeModels);

		for (const provider of opencodeProviders) {
			if (provider.id === OPENAI_COMPATIBLE_PROVIDER_ID || isProxyEndpointProviderId(provider.id))
				continue;
			for (const model of provider.models) {
				const compositeId = `${provider.id}/${model.id}`;
				if (!enabledSet.has(compositeId)) continue;
				opts.push({ value: compositeId, label: `${model.name || model.id} (${provider.name})` });
			}
		}

		for (const endpoint of proxyEndpoints) {
			const providerId = getProxyEndpointProviderId(endpoint.id);
			const enabled = new Set(endpoint.enabledModels);
			for (const model of endpoint.models) {
				if (!enabled.has(model.id)) continue;
				opts.push({
					value: `${providerId}/${model.id}`,
					label: `${model.name || model.id} (${endpoint.name || 'Custom'})`,
				});
			}
		}

		return opts;
	}, [opencodeProviders, enabledOpenCodeModels, proxyEndpoints, includeDefault]);
}
