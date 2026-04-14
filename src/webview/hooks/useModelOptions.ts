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
	const availableProviders = useSettingsStore(s => s.availableProviders);
	const enabledOpenCodeModels = useSettingsStore(s => s.enabledOpenCodeModels);
	const disabledProviders = useSettingsStore(s => s.disabledProviders);
	const proxyEndpoints = useSettingsStore(s => s.proxyEndpoints);

	return useMemo(() => {
		const opts: ModelOption[] = [];
		if (includeDefault) opts.push({ value: '', label: 'Default (inherit)' });

		const disabledSet = new Set(disabledProviders);
		const enabledSet = new Set(enabledOpenCodeModels);

		for (const provider of opencodeProviders) {
			if (
				disabledSet.has(provider.id) ||
				provider.id === OPENAI_COMPATIBLE_PROVIDER_ID ||
				isProxyEndpointProviderId(provider.id)
			)
				continue;
			for (const model of provider.models) {
				const compositeId = `${provider.id}/${model.id}`;
				if (!enabledSet.has(compositeId)) continue;
				opts.push({ value: compositeId, label: `${model.name || model.id} (${provider.name})` });
			}
		}

		for (const provider of availableProviders) {
			if (
				disabledSet.has(provider.id) ||
				provider.id === OPENAI_COMPATIBLE_PROVIDER_ID ||
				isProxyEndpointProviderId(provider.id) ||
				opencodeProviders.some(connected => connected.id === provider.id)
			)
				continue;
			for (const model of provider.models ?? []) {
				const compositeId = `${provider.id}/${model.id}`;
				if (!enabledSet.has(compositeId)) continue;
				opts.push({ value: compositeId, label: `${model.name || model.id} (${provider.name})` });
			}
		}

		for (const endpoint of proxyEndpoints) {
			const providerId = getProxyEndpointProviderId(endpoint.id);
			if (disabledSet.has(providerId)) continue;
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
	}, [
		opencodeProviders,
		availableProviders,
		enabledOpenCodeModels,
		disabledProviders,
		proxyEndpoints,
		includeDefault,
	]);
}
