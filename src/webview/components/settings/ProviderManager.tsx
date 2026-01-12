/**
 * @file Provider Manager Component
 * @description Unified interface for managing AI providers. Shows connected providers with
 *              ability to enable/disable individual models and disconnect providers. Includes
 *              OpenAI-compatible provider configuration. Uses shared SettingsUI primitives.
 *              For OpenCode CLI, proxy settings are saved to opencode.json via SDK.
 *              For Claude CLI, proxy settings are passed via environment variables.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { isNonDisconnectableProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from '../../../shared';
import { useSettingsActions, useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { BrainSideIcon, RefreshIcon } from '../icons';
import { Button, Select, Switch, TextInput } from '../ui';
import {
	EmptyState,
	ErrorBox,
	ExpandableRow,
	GroupTitle,
	ModelItem,
	ModelList,
	SettingRow,
	SettingsBadge,
	SettingsStatusIndicator,
	StatusMessage,
} from './SettingsUI';

interface ProviderItemData {
	id: string;
	name: string;
	connected: boolean;
	isCustom?: boolean;
	isOpenAICompatible?: boolean;
	isAnthropic?: boolean;
	env?: string[];
	models?: Array<{
		id: string;
		name: string;
		capabilities?: { reasoning?: boolean; vision?: boolean; tools?: boolean };
		contextLimit?: number;
	}>;
}

// OpenAI-compatible provider ID used by settings/UI
const OPENAI_COMPATIBLE_ID = OPENAI_COMPATIBLE_PROVIDER_ID;

// Providers that cannot be disconnected (built-in)
// Centralized in @shared to avoid drift.

export const ProviderManager: React.FC = () => {
	const {
		provider: cliProvider,
		opencodeProviders,
		availableProviders,
		providerAuthState,
		anthropicModels,
		anthropicModelsStatus,
		anthropicKeyStatus,
		proxyBaseUrl,
		proxyApiKey,
		proxyModels,
		enabledProxyModels,
		proxyTestStatus,
		enabledOpenCodeModels,
		disabledProviders,
	} = useSettingsStore();
	const {
		setProviderAuthState,
		setSettings,
		setEnabledProxyModels,
		setProxyTestStatus,
		setEnabledOpenCodeModels,
	} = useSettingsActions();
	const { postMessage } = useVSCode();

	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [apiKeyInput, setApiKeyInput] = useState('');
	const [selectedNewProvider, setSelectedNewProvider] = useState('');
	const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
	const [editApiKeyInput, setEditApiKeyInput] = useState('');
	const [anthropicApiKeyInput, setAnthropicApiKeyInput] = useState('');

	const isOpenCodeCLI = cliProvider === 'opencode';

	// Load providers on mount (only for OpenCode CLI)
	useEffect(() => {
		if (isOpenCodeCLI) {
			postMessage('reloadAllProviders');
		}
	}, [postMessage, isOpenCodeCLI]);

	// Reset form on success
	useEffect(() => {
		if (providerAuthState?.success && !providerAuthState.isLoading) {
			const timer = setTimeout(() => {
				setExpandedProvider(null);
				setApiKeyInput('');
				setSelectedNewProvider('');
				setEditingApiKey(null);
				setEditApiKeyInput('');
				setProviderAuthState(null);
				postMessage('reloadAllProviders');
			}, 1000);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [providerAuthState, setProviderAuthState, postMessage]);

	// Clear Anthropic API key input when key is successfully saved
	useEffect(() => {
		if (anthropicKeyStatus.hasKey && anthropicKeyStatus.lastChecked) {
			setAnthropicApiKeyInput('');
		}
	}, [anthropicKeyStatus.hasKey, anthropicKeyStatus.lastChecked]);

	// Merge connected and available providers into unified list
	// For Claude CLI: OpenAI Compatible + Anthropic (API key)
	// For OpenCode CLI: OpenAI Compatible + all connected OpenCode providers (excluding OpenAI-compatible to avoid duplication)
	// Note: Anthropic provider with API key is hidden for OpenCode CLI because OpenCode has built-in Anthropic support
	const connectedProviders: ProviderItemData[] = useMemo(() => {
		const list: ProviderItemData[] = [
			// OpenAI Compatible provider always shown for both CLI providers
			{
				id: OPENAI_COMPATIBLE_ID,
				name: 'OpenAI Compatible API',
				connected: true, // Always "connected" - visibility controlled by disabledProviders
				isOpenAICompatible: true,
				models: proxyModels.map(m => ({
					id: m.id,
					name: m.name,
					contextLimit: m.contextLength,
					capabilities: m.capabilities,
				})),
			},
		];

		// Anthropic (API key) provider only shown for Claude CLI
		// OpenCode CLI has built-in Anthropic support, so showing this would cause duplication
		if (!isOpenCodeCLI) {
			list.push({
				id: 'anthropic',
				name: 'Anthropic (Claude API)',
				connected: true,
				isAnthropic: true,
				models: anthropicModels,
			});
		}

		// Add OpenCode providers only when using OpenCode CLI
		// Filter out OpenAI-compatible provider to avoid duplication
		if (isOpenCodeCLI) {
			list.push(
				...opencodeProviders
					.filter(p => p.id !== OPENAI_COMPATIBLE_PROVIDER_ID)
					.map(p => ({
						id: p.id,
						name: p.name,
						connected: true,
						isCustom: p.isCustom,
						models: p.models,
					})),
			);
		}

		return list;
	}, [opencodeProviders, proxyModels, anthropicModels, isOpenCodeCLI]);

	// Available providers for Quick Add (not yet connected) - only for OpenCode CLI
	// Sorted by popularity/importance, not alphabetically
	const availableForConnection = useMemo(() => {
		if (!isOpenCodeCLI) {
			return [];
		}

		// Priority order for popular providers (lower = higher priority)
		const providerPriority: Record<string, number> = {
			anthropic: 1,
			openai: 2,
			google: 3,
			openrouter: 4,
			groq: 5,
			mistral: 6,
			deepseek: 7,
			xai: 8,
			cohere: 9,
			together: 10,
			fireworks: 11,
			perplexity: 12,
			azure: 20,
			bedrock: 21,
			vertex: 22,
		};

		return availableProviders
			.filter(ap => !opencodeProviders.some(cp => cp.id === ap.id))
			.sort((a, b) => {
				const priorityA = providerPriority[a.id] ?? 100;
				const priorityB = providerPriority[b.id] ?? 100;
				if (priorityA !== priorityB) {
					return priorityA - priorityB;
				}
				// Fallback to alphabetical for same priority
				return a.name.localeCompare(b.name);
			});
	}, [availableProviders, opencodeProviders, isOpenCodeCLI]);

	const handleToggleProvider = (providerId: string) => {
		if (expandedProvider === providerId) {
			setExpandedProvider(null);
			setApiKeyInput('');
			setSelectedNewProvider('');
		} else {
			setExpandedProvider(providerId);
			setApiKeyInput('');
			setSelectedNewProvider('');
		}
	};

	const handleConnectProvider = (providerId: string) => {
		if (apiKeyInput.trim()) {
			postMessage('setOpenCodeProviderAuth', {
				providerId,
				apiKey: apiKeyInput.trim(),
			});
		}
	};

	const handleUpdateApiKey = (providerId: string) => {
		if (editApiKeyInput.trim()) {
			postMessage('setOpenCodeProviderAuth', {
				providerId,
				apiKey: editApiKeyInput.trim(),
			});
			setEditingApiKey(null);
			setEditApiKeyInput('');
		}
	};

	const handleDisconnectProvider = (providerId: string) => {
		postMessage('disconnectOpenCodeProvider', { providerId });
	};

	// Check if provider can be disconnected
	const canDisconnect = (providerId: string) => {
		return !isNonDisconnectableProviderId(providerId);
	};

	const handleRefresh = () => {
		postMessage('reloadAllProviders');
	};

	// OpenAI Compatible provider handlers
	const saveProxySettings = () => {
		postMessage('updateSettings', {
			settings: {
				'proxy.baseUrl': proxyBaseUrl,
				'proxy.apiKey': proxyApiKey,
			},
		});
	};

	const saveAnthropicKey = (apiKey: string) => {
		postMessage('setAnthropicApiKey', { anthropicApiKey: apiKey });
	};

	const clearAnthropicKey = () => {
		postMessage('clearAnthropicApiKey', {});
	};

	const fetchAnthropicModels = (apiKey?: string) => {
		postMessage('loadAnthropicModels', { anthropicApiKey: apiKey });
	};

	// Unified toggle for any provider visibility (hide from dropdown without disconnecting)
	const handleToggleProviderEnabled = (providerId: string) => {
		// Persist to settings (avoid stale-closure race by computing next state once)
		const nextDisabled = disabledProviders.includes(providerId)
			? disabledProviders.filter(id => id !== providerId)
			: [...disabledProviders, providerId];
		setSettings({ disabledProviders: nextDisabled });
		postMessage('updateSettings', { settings: { 'providers.disabled': nextDisabled } });
	};

	const handleFetchProxyModels = () => {
		setProxyTestStatus({ isLoading: true, error: null });
		postMessage('loadProxyModels', {
			baseUrl: proxyBaseUrl,
			apiKey: proxyApiKey,
		});
	};

	const handleToggleProxyModel = (modelId: string) => {
		const newEnabled = enabledProxyModels.includes(modelId)
			? enabledProxyModels.filter(id => id !== modelId)
			: [...enabledProxyModels, modelId];
		setEnabledProxyModels(newEnabled);
		postMessage('updateSettings', { settings: { 'proxy.enabledModels': newEnabled } });
	};

	// OpenCode provider model handlers
	const handleToggleOpenCodeModel = (providerId: string, modelId: string) => {
		const fullId = `${providerId}/${modelId}`;
		const newEnabled = enabledOpenCodeModels.includes(fullId)
			? enabledOpenCodeModels.filter(id => id !== fullId)
			: [...enabledOpenCodeModels, fullId];
		setEnabledOpenCodeModels(newEnabled);
		postMessage('updateSettings', { settings: { 'opencode.enabledModels': newEnabled } });
	};

	// Get enabled count for a provider
	const getEnabledCountForProvider = (providerId: string) => {
		return enabledOpenCodeModels.filter(id => id.startsWith(`${providerId}/`)).length;
	};

	// Check if model is enabled (if no models selected, all are enabled)
	const isOpenCodeModelEnabled = (providerId: string, modelId: string) => {
		return enabledOpenCodeModels.includes(`${providerId}/${modelId}`);
	};

	return (
		<div className="animate-fade-in">
			{/* Connected Providers List Header */}
			<div className="flex items-center justify-between mb-(--gap-2)">
				<GroupTitle className="mb-0">
					{isOpenCodeCLI ? 'Providers' : 'OpenAI Compatible'}
				</GroupTitle>
				{isOpenCodeCLI && (
					<button
						type="button"
						onClick={handleRefresh}
						className="text-2xs text-white/40 hover:text-white/60 pr-1"
					>
						<RefreshIcon size={10} />
					</button>
				)}
			</div>

			{/* Connected Providers List */}
			<div className="border border-white/10 rounded overflow-hidden mb-(--gap-6) mx-(--gap-1)">
				{/* Add Provider Row - pinned at the top */}
				{availableForConnection.length > 0 && (
					<ExpandableRow
						title="Add Provider"
						subtitle={`${availableForConnection.length} available`}
						statusDot="disconnected"
						expanded={expandedProvider === '__add_provider__'}
						onToggle={() => handleToggleProvider('__add_provider__')}
						last={connectedProviders.length === 0}
					>
						<SettingRow title="Provider">
							<Select
								value={selectedNewProvider}
								onChange={e => setSelectedNewProvider(e.target.value)}
								options={[
									{ value: '', label: 'Select provider...' },
									...availableForConnection.map(p => ({
										value: p.id,
										label: p.name,
									})),
								]}
								className="min-w-(--input-width-sm)"
							/>
						</SettingRow>

						{selectedNewProvider &&
							(() => {
								const provider = availableForConnection.find(p => p.id === selectedNewProvider);
								if (!provider) {
									return null;
								}
								const isAuthLoading =
									providerAuthState?.providerId === provider.id && providerAuthState?.isLoading;

								return (
									<>
										{provider.env && provider.env.length > 0 && (
											<SettingRow title="Environment">
												<span className="text-xs font-mono text-white/50">{provider.env[0]}</span>
											</SettingRow>
										)}

										<SettingRow title="API Key">
											<TextInput
												type="password"
												value={apiKeyInput}
												onChange={e => setApiKeyInput(e.target.value)}
												placeholder="Enter API key"
												className="flex-1 max-w-(--input-width-md)"
											/>
										</SettingRow>

										{providerAuthState && providerAuthState.providerId === provider.id && (
											<div className="px-2.5 py-1.5">
												<StatusMessage
													isLoading={providerAuthState.isLoading}
													success={providerAuthState.success}
													error={providerAuthState.error}
												/>
											</div>
										)}

										<SettingRow title="" last>
											<Button
												size="sm"
												variant="primary"
												onClick={() => handleConnectProvider(provider.id)}
												disabled={!apiKeyInput.trim() || isAuthLoading}
												className="text-xs px-3"
											>
												{isAuthLoading ? 'Connecting...' : 'Connect'}
											</Button>
										</SettingRow>
									</>
								);
							})()}
					</ExpandableRow>
				)}

				{/* Connected Providers */}
				{connectedProviders.map((provider, idx) => {
					const isExpanded = expandedProvider === provider.id;
					const isOpenAICompatible = provider.isOpenAICompatible;
					const isAnthropic = provider.isAnthropic;
					const modelCount = provider.models?.length ?? 0;
					const enabledCount = isOpenAICompatible
						? enabledProxyModels.length
						: isAnthropic
							? (provider.models?.length ?? 0)
							: getEnabledCountForProvider(provider.id);

					const badge = (
						<>{provider.isCustom && <SettingsBadge variant="blue">custom</SettingsBadge>}</>
					);

					return (
						<ExpandableRow
							key={provider.id}
							title={provider.name}
							subtitle={
								provider.connected && modelCount > 0
									? `${enabledCount}/${modelCount} models`
									: undefined
							}
							badge={badge}
							statusDot={provider.connected ? 'connected' : 'disconnected'}
							expanded={isExpanded}
							onToggle={() => handleToggleProvider(provider.id)}
							last={idx === connectedProviders.length - 1}
						>
							{isOpenAICompatible ? (
								<OpenAICompatibleConfig
									enabled={!disabledProviders.includes(OPENAI_COMPATIBLE_ID)}
									baseUrl={proxyBaseUrl}
									apiKey={proxyApiKey}
									models={proxyModels}
									enabledModels={enabledProxyModels}
									testStatus={proxyTestStatus}
									onToggle={() => handleToggleProviderEnabled(OPENAI_COMPATIBLE_ID)}
									onBaseUrlChange={v => setSettings({ proxyBaseUrl: v })}
									onApiKeyChange={v => setSettings({ proxyApiKey: v })}
									onBlur={() => saveProxySettings()}
									onFetchModels={handleFetchProxyModels}
									onToggleModel={handleToggleProxyModel}
								/>
							) : isAnthropic ? (
								<AnthropicConfig
									enabled={!disabledProviders.includes('anthropic')}
									apiKeyInput={anthropicApiKeyInput}
									models={anthropicModels}
									modelsStatus={anthropicModelsStatus}
									keyStatus={anthropicKeyStatus}
									onToggle={() => handleToggleProviderEnabled('anthropic')}
									onApiKeyInputChange={setAnthropicApiKeyInput}
									onSaveKey={saveAnthropicKey}
									onClearKey={clearAnthropicKey}
									onFetchModels={fetchAnthropicModels}
								/>
							) : (
								<>
									<SettingRow title="Enable Provider">
										<div className="flex items-center gap-2">
											{canDisconnect(provider.id) && (
												<button
													type="button"
													onClick={() => handleDisconnectProvider(provider.id)}
													className="text-2xs text-red-400/70 hover:text-red-400 transition-colors"
												>
													Disconnect
												</button>
											)}
											<Switch
												checked={!disabledProviders.includes(provider.id)}
												onChange={() => handleToggleProviderEnabled(provider.id)}
											/>
										</div>
									</SettingRow>

									{/* API Key editing for connected providers */}
									{canDisconnect(provider.id) && (
										<SettingRow title="API Key" last={!provider.models?.length}>
											{editingApiKey === provider.id ? (
												<div className="flex items-center gap-1.5">
													<TextInput
														type="password"
														value={editApiKeyInput}
														onChange={e => setEditApiKeyInput(e.target.value)}
														placeholder="Enter new API key"
														className="flex-1 max-w-(--input-width-md)"
													/>
													<Button
														size="sm"
														variant="primary"
														onClick={() => handleUpdateApiKey(provider.id)}
														disabled={!editApiKeyInput.trim() || providerAuthState?.isLoading}
														className="text-xs px-2"
													>
														{providerAuthState?.isLoading ? '...' : 'Save'}
													</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => {
															setEditingApiKey(null);
															setEditApiKeyInput('');
														}}
														className="text-xs px-2"
													>
														Cancel
													</Button>
												</div>
											) : (
												<Button
													size="sm"
													variant="secondary"
													onClick={() => {
														setEditingApiKey(provider.id);
														setEditApiKeyInput('');
													}}
													className="text-xs px-2"
												>
													Change
												</Button>
											)}
										</SettingRow>
									)}

									{provider.models && provider.models.length > 0 ? (
										<ModelList>
											{provider.models.map((model, _modelIdx) => {
												const isEnabled = isOpenCodeModelEnabled(provider.id, model.id);
												return (
													<ModelItem key={model.id} name={model.name} id={model.id}>
														{model.capabilities?.reasoning && (
															<BrainSideIcon
																size={14}
																style={{ color: 'rgba(168, 85, 247, 0.8)' }}
															/>
														)}
														<Switch
															checked={isEnabled}
															onChange={() => handleToggleOpenCodeModel(provider.id, model.id)}
														/>
													</ModelItem>
												);
											})}
										</ModelList>
									) : (
										<EmptyState>No models available</EmptyState>
									)}
								</>
							)}
						</ExpandableRow>
					);
				})}
			</div>
		</div>
	);
};

// =============================================================================
// Anthropic (Claude API) Provider Configuration
// =============================================================================

interface AnthropicConfigProps {
	enabled: boolean;
	apiKeyInput: string;
	models: Array<{ id: string; name: string }>;
	modelsStatus: {
		isLoading: boolean;
		success: boolean | null;
		error: string | null;
		lastTested: number | null;
	};
	keyStatus: {
		hasKey: boolean;
		lastChecked: number | null;
		error: string | null;
	};
	onToggle: () => void;
	onApiKeyInputChange: (value: string) => void;
	onSaveKey: (apiKey: string) => void;
	onClearKey: () => void;
	onFetchModels: (apiKey?: string) => void;
}

const AnthropicConfig: React.FC<AnthropicConfigProps> = ({
	enabled,
	apiKeyInput,
	models,
	modelsStatus,
	keyStatus,
	onToggle,
	onApiKeyInputChange,
	onSaveKey,
	onClearKey,
	onFetchModels,
}) => {
	const hasKey = keyStatus.hasKey;
	const isLoading = modelsStatus.isLoading;
	const hasError = modelsStatus.error || keyStatus.error;
	const status = isLoading
		? 'loading'
		: modelsStatus.success
			? 'success'
			: hasError
				? 'error'
				: 'idle';

	return (
		<>
			<SettingRow title="Enable Provider" last={!enabled}>
				<Switch checked={enabled} onChange={onToggle} />
			</SettingRow>

			{enabled && (
				<>
					<SettingRow title="API Key">
						<div className="flex items-center gap-1.5 flex-1">
							<TextInput
								type="password"
								value={apiKeyInput}
								onChange={e => onApiKeyInputChange(e.target.value)}
								placeholder={hasKey && !apiKeyInput ? 'API key is set' : 'Enter Anthropic API key'}
								className="flex-1 max-w-(--input-width-lg)"
							/>
							{hasKey && !apiKeyInput ? (
								<>
									<Button
										size="sm"
										variant="secondary"
										onClick={() => onApiKeyInputChange('')}
										className="text-xs px-2"
									>
										Change
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={onClearKey}
										className="text-xs px-2 text-red-400/70 hover:text-red-400"
									>
										Clear
									</Button>
								</>
							) : (
								<>
									<Button
										size="sm"
										variant="primary"
										onClick={() => {
											if (apiKeyInput.trim()) {
												onSaveKey(apiKeyInput.trim());
												onApiKeyInputChange('');
											}
										}}
										disabled={!apiKeyInput.trim() || isLoading}
										className="text-xs px-2"
									>
										{hasKey ? 'Save' : 'Connect'}
									</Button>
									{hasKey && apiKeyInput && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => onApiKeyInputChange('')}
											className="text-xs px-2"
										>
											Cancel
										</Button>
									)}
								</>
							)}
						</div>
					</SettingRow>

					{(keyStatus.error || modelsStatus.error) && (
						<div className="px-2.5 py-1.5">
							<StatusMessage
								isLoading={false}
								success={false}
								error={keyStatus.error || modelsStatus.error || undefined}
							/>
						</div>
					)}

					{hasKey && (
						<>
							<div className="flex items-center justify-between px-2.5 py-1.5">
								<div className="flex items-center gap-1.5">
									<span className="text-sm text-white/90">Models</span>
									{models.length > 0 && <SettingsBadge>{models.length} found</SettingsBadge>}
									{modelsStatus.success !== null && <SettingsStatusIndicator status={status} />}
								</div>
								<Button
									size="sm"
									variant="secondary"
									onClick={() => onFetchModels()}
									disabled={isLoading}
									className="text-xs px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
								>
									{isLoading ? 'Loading...' : models.length > 0 ? 'Refresh' : 'Fetch'}
								</Button>
							</div>

							{models.length > 0 && (
								<ModelList>
									{models.map((model, _idx) => (
										<ModelItem key={model.id} name={model.name} id={model.id}>
											<SettingsBadge variant="blue">enabled</SettingsBadge>
										</ModelItem>
									))}
								</ModelList>
							)}

							{models.length === 0 && !isLoading && !modelsStatus.error && (
								<EmptyState>Click "Fetch" to load available models</EmptyState>
							)}
						</>
					)}

					{!hasKey && (
						<EmptyState>
							Enter your Anthropic API key and click "Connect" to load available models
						</EmptyState>
					)}
				</>
			)}
		</>
	);
};

// =============================================================================
// OpenAI Compatible Provider Configuration
// =============================================================================

interface OpenAICompatibleConfigProps {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	models: Array<{ id: string; name: string }>;
	enabledModels: string[];
	testStatus: {
		isLoading: boolean;
		success: boolean | null;
		error: string | null;
	};
	onToggle: () => void;
	onBaseUrlChange: (value: string) => void;
	onApiKeyChange: (value: string) => void;
	onBlur: () => void;
	onFetchModels: () => void;
	onToggleModel: (modelId: string) => void;
}

const OpenAICompatibleConfig: React.FC<OpenAICompatibleConfigProps> = ({
	enabled,
	baseUrl,
	apiKey,
	models,
	enabledModels,
	testStatus,
	onToggle,
	onBaseUrlChange,
	onApiKeyChange,
	onBlur,
	onFetchModels,
	onToggleModel,
}) => {
	const status = testStatus.isLoading
		? 'loading'
		: testStatus.success
			? 'success'
			: testStatus.error
				? 'error'
				: 'idle';

	return (
		<>
			<SettingRow title="Enable Provider" last={!enabled}>
				<Switch checked={enabled} onChange={onToggle} />
			</SettingRow>

			{enabled && (
				<>
					<SettingRow title="Base URL">
						<TextInput
							value={baseUrl}
							onChange={e => onBaseUrlChange(e.target.value)}
							onBlur={onBlur}
							placeholder="http://localhost:11434"
							className="flex-1 max-w-(--input-width-lg)"
						/>
					</SettingRow>

					<SettingRow title="API Key">
						<TextInput
							value={apiKey}
							onChange={e => onApiKeyChange(e.target.value)}
							onBlur={onBlur}
							placeholder="optional"
							type="password"
							className="flex-1 max-w-(--input-width-lg)"
						/>
					</SettingRow>

					<div className="flex items-center justify-between px-2.5 py-1.5">
						<div className="flex items-center gap-1.5">
							<span className="text-sm text-white/90">Models</span>
							{models.length > 0 && <SettingsBadge>{models.length} found</SettingsBadge>}
							{testStatus.success !== null && <SettingsStatusIndicator status={status} />}
						</div>
						<Button
							size="sm"
							variant="secondary"
							onClick={onFetchModels}
							disabled={testStatus.isLoading}
							className="text-xs px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
						>
							{testStatus.isLoading ? 'Loading...' : models.length > 0 ? 'Refresh' : 'Fetch'}
						</Button>
					</div>

					{testStatus.error && <ErrorBox>{testStatus.error}</ErrorBox>}

					{models.length > 0 && (
						<ModelList>
							{models.map((model, _idx) => (
								<ModelItem key={model.id} name={model.name} id={model.id}>
									<Switch
										checked={enabledModels.includes(model.id)}
										onChange={() => onToggleModel(model.id)}
									/>
								</ModelItem>
							))}
						</ModelList>
					)}

					{models.length === 0 && !testStatus.isLoading && !testStatus.error && (
						<EmptyState>Click "Fetch" to load available models</EmptyState>
					)}
				</>
			)}
		</>
	);
};

export default ProviderManager;

// Alias for backward compatibility
export { ProviderManager as OpenCodeProviderManager };
