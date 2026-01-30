import type { SettingsActions } from './settingsStore';

// Helper for settings data mapping
export const handleSettingsData = (settings: Record<string, unknown>, actions: SettingsActions) => {
	const mappedSettings: Record<string, unknown> = {};

	if (settings.provider !== undefined) mappedSettings.provider = settings.provider;
	if (settings['proxy.baseUrl'] !== undefined)
		mappedSettings.proxyBaseUrl = settings['proxy.baseUrl'];
	if (settings['proxy.apiKey'] !== undefined) mappedSettings.proxyApiKey = settings['proxy.apiKey'];
	if (settings['proxy.enabledModels'] !== undefined)
		mappedSettings.enabledProxyModels = settings['proxy.enabledModels'];
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
	if (settings['promptImprove.timeoutMs'] !== undefined) {
		const ms = settings['promptImprove.timeoutMs'];
		mappedSettings.promptImproveTimeoutSeconds =
			typeof ms === 'number' && Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) : 30;
	}

	if (settings['opencode.agent'] !== undefined)
		mappedSettings.opencodeAgent = settings['opencode.agent'];
	if (settings['opencode.enabledModels'] !== undefined)
		mappedSettings.enabledOpenCodeModels = settings['opencode.enabledModels'];
	if (settings['providers.disabled'] !== undefined)
		mappedSettings.disabledProviders = settings['providers.disabled'];

	actions.setSettings(mappedSettings);
};
