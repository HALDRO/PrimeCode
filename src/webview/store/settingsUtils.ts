import { normalizeProxyBaseUrl } from '../../common';
import type { ProxyEndpointState, SettingsActions, SettingsState } from './settingsStore';

// Helper for settings data mapping
export const handleSettingsData = (
	settings: Record<string, unknown>,
	actions: SettingsActions,
	currentState?: Pick<SettingsState, 'proxyEndpoints'>,
) => {
	const mappedSettings: Record<string, unknown> = {};

	if (settings.provider !== undefined) mappedSettings.provider = settings.provider;
	if (settings['proxy.endpoints'] !== undefined && Array.isArray(settings['proxy.endpoints'])) {
		const currentById = new Map(
			(currentState?.proxyEndpoints ?? []).map(endpoint => [endpoint.id, endpoint]),
		);
		// Deduplicate endpoints: first by ID, then by canonical baseUrl
		// (normalizeProxyBaseUrl). This is the same normalization used when
		// writing to opencode.json and when fetching proxy models, so
		// "http://host:8080", "http://host:8080/", "http://host:8080/v1"
		// all resolve to the same canonical form.
		const seenIds = new Set<string>();
		const seenBaseUrls = new Set<string>();
		mappedSettings.proxyEndpoints = (settings['proxy.endpoints'] as Record<string, unknown>[])
			.filter(endpoint => {
				if (typeof endpoint.id !== 'string') return false;
				const id = String(endpoint.id);
				if (seenIds.has(id)) return false;
				seenIds.add(id);
				const rawUrl = String(endpoint.baseUrl ?? '').trim();
				if (rawUrl) {
					const canonical = normalizeProxyBaseUrl(rawUrl);
					if (seenBaseUrls.has(canonical)) return false;
					seenBaseUrls.add(canonical);
				}
				return true;
			})
			.map(endpoint => {
				const id = String(endpoint.id);
				const current = currentById.get(id);
				return {
					id,
					name: String(endpoint.name ?? ''),
					baseUrl: String(endpoint.baseUrl ?? ''),
					apiKey: String(endpoint.apiKey ?? ''),
					enabledModels: Array.isArray(endpoint.enabledModels)
						? endpoint.enabledModels.filter((value): value is string => typeof value === 'string')
						: [],
					headers:
						endpoint.headers &&
						typeof endpoint.headers === 'object' &&
						!Array.isArray(endpoint.headers)
							? (endpoint.headers as Record<string, string>)
							: undefined,
					models: current?.models ?? [],
					testStatus: current?.testStatus ?? {
						isLoading: false,
						success: null,
						error: null,
						lastTested: null,
					},
				} satisfies ProxyEndpointState;
			});
	}
	if (settings['proxy.useSingleModel'] !== undefined)
		mappedSettings.proxyUseSingleModel = settings['proxy.useSingleModel'];
	if (settings['proxy.haikuModel'] !== undefined)
		mappedSettings.proxyHaikuModel = settings['proxy.haikuModel'];
	if (settings['proxy.sonnetModel'] !== undefined)
		mappedSettings.proxySonnetModel = settings['proxy.sonnetModel'];
	if (settings['proxy.opusModel'] !== undefined)
		mappedSettings.proxyOpusModel = settings['proxy.opusModel'];
	if (settings['proxy.subagentModel'] !== undefined)
		mappedSettings.proxySubagentModel = settings['proxy.subagentModel'];

	if (settings['promptImprove.model'] !== undefined)
		mappedSettings.promptImproveModel = settings['promptImprove.model'];
	if (settings['promptImprove.template'] !== undefined)
		mappedSettings.promptImproveTemplate = settings['promptImprove.template'];

	if (settings['opencode.agent'] !== undefined)
		mappedSettings.opencodeAgent = settings['opencode.agent'];
	if (settings['opencode.enabledModels'] !== undefined)
		mappedSettings.enabledOpenCodeModels = settings['opencode.enabledModels'];
	if (settings['providers.disabled'] !== undefined)
		mappedSettings.disabledProviders = settings['providers.disabled'];

	actions.setSettings(mappedSettings);
};
