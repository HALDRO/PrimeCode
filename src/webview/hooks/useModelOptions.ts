/**
 * @file useModelOptions.ts
 * @description Shared hook for building model select options from enabled providers.
 *              Used by SubagentsTab and potentially ModelDropdown to avoid duplicating
 *              provider filtering logic across components.
 */

import { useMemo } from 'react';
import { useSettingsStore } from '../store/settingsStore';

export interface ModelOption {
	value: string;
	label: string;
}

export function useModelOptions(includeDefault = true): ModelOption[] {
	const opencodeProviders = useSettingsStore(s => s.opencodeProviders);
	const enabledOpenCodeModels = useSettingsStore(s => s.enabledOpenCodeModels);
	const disabledProviders = useSettingsStore(s => s.disabledProviders);
	const proxyModels = useSettingsStore(s => s.proxyModels);
	const enabledProxyModels = useSettingsStore(s => s.enabledProxyModels);

	return useMemo(() => {
		const opts: ModelOption[] = [];
		if (includeDefault) opts.push({ value: '', label: 'Default (inherit)' });

		const disabledSet = new Set(disabledProviders);
		const enabledSet = new Set(enabledOpenCodeModels);

		for (const provider of opencodeProviders) {
			if (disabledSet.has(provider.id) || provider.id === 'oai') continue;
			for (const model of provider.models) {
				const compositeId = `${provider.id}/${model.id}`;
				if (!enabledSet.has(compositeId)) continue;
				opts.push({ value: compositeId, label: `${model.name || model.id} (${provider.name})` });
			}
		}

		// Proxy models (OpenAI-compatible)
		if (!disabledSet.has('oai')) {
			const enabledProxy = new Set(enabledProxyModels);
			for (const model of proxyModels) {
				if (!enabledProxy.has(model.id)) continue;
				opts.push({ value: `oai/${model.id}`, label: `${model.name || model.id} (OAI)` });
			}
		}

		return opts;
	}, [
		opencodeProviders,
		enabledOpenCodeModels,
		disabledProviders,
		proxyModels,
		enabledProxyModels,
		includeDefault,
	]);
}
