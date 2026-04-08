import type { ProxyEndpointState, SettingsActions, SettingsState } from './settingsStore';

// Helper for settings data mapping
export const handleSettingsData = (
	settings: Record<string, unknown>,
	actions: SettingsActions,
	currentState?: Pick<SettingsState, 'proxyEndpoints'>,
) => {
	const mappedSettings: Record<string, unknown> = {};

	if (settings.provider !== undefined) mappedSettings.provider = settings.provider;
	if (settings['proxy.baseUrl'] !== undefined)
		mappedSettings.proxyBaseUrl = settings['proxy.baseUrl'];
	if (settings['proxy.apiKey'] !== undefined) mappedSettings.proxyApiKey = settings['proxy.apiKey'];
	if (settings['proxy.enabledModels'] !== undefined)
		mappedSettings.enabledProxyModels = settings['proxy.enabledModels'];
	if (settings['proxy.endpoints'] !== undefined && Array.isArray(settings['proxy.endpoints'])) {
		const currentById = new Map(
			(currentState?.proxyEndpoints ?? []).map(endpoint => [endpoint.id, endpoint]),
		);
		mappedSettings.proxyEndpoints = (settings['proxy.endpoints'] as Record<string, unknown>[])
			.filter(endpoint => typeof endpoint.id === 'string')
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
