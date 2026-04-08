/**
 * @file Provider Manager Component
 * @description Unified interface for managing AI providers. Shows connected providers with
 *              ability to enable/disable individual models and disconnect providers. Includes
 *              OpenAI-compatible provider configuration. Uses shared SettingsUI primitives.
 *              For OpenCode CLI, provider auth is handled via OpenCode server endpoints.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
	getProxyEndpointProviderId,
	isNonDisconnectableProviderId,
	isProxyEndpointProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
} from '../../../common';
import { useSettingsActions, useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { BrainSideIcon, RefreshIcon } from '../icons';
import { Button, Select, Switch, TextInput } from '../ui';
import {
	EmptyState,
	ExpandableRow,
	GroupTitle,
	ModelItem,
	ModelList,
	SettingRow,
	SettingsBadge,
	StatusMessage,
} from './SettingsUI';

interface ProviderItemData {
	id: string;
	name: string;
	connected: boolean;
	isCustom?: boolean;
	isOpenAICompatible?: boolean;
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

export const ProviderManager: React.FC = () => {
	const {
		provider: cliProvider,
		opencodeProviders,
		availableProviders,
		providerAuthState,
		proxyBaseUrl,
		proxyApiKey,
		proxyModels,
		enabledProxyModels,
		proxyTestStatus,
		proxyEndpoints,
		enabledOpenCodeModels,
		disabledProviders,
	} = useSettingsStore();

	const {
		setProviderAuthState,
		setSettings,
		setEnabledProxyModels,
		setProxyTestStatus,
		addProxyEndpoint,
		updateProxyEndpoint,
		removeProxyEndpoint,
		setEnabledOpenCodeModels,
	} = useSettingsActions();
	const { postMessage } = useVSCode();

	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [apiKeyInput, setApiKeyInput] = useState('');
	const [selectedNewProvider, setSelectedNewProvider] = useState('');
	const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
	const [editApiKeyInput, setEditApiKeyInput] = useState('');
	const [modelSearch, setModelSearch] = useState('');

	const isOpenCodeCLI = cliProvider === 'opencode';

	useEffect(() => {
		if (isOpenCodeCLI) {
			postMessage({ type: 'syncAll' });
		}
	}, [postMessage, isOpenCodeCLI]);

	useEffect(() => {
		if (providerAuthState?.success && !providerAuthState.isLoading) {
			const timer = setTimeout(() => {
				setExpandedProvider(null);
				setApiKeyInput('');
				setSelectedNewProvider('');
				setEditingApiKey(null);
				setEditApiKeyInput('');
				setProviderAuthState(null);
				postMessage({ type: 'syncAll' });
			}, 1000);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [providerAuthState, setProviderAuthState, postMessage]);

	// Connected providers list:
	// - Always show OpenAI Compatible provider
	// - If OpenCode CLI: add OpenCode connected providers (excluding OpenAI-compatible)
	const connectedProviders: ProviderItemData[] = useMemo(() => {
		const list: ProviderItemData[] = [
			{
				id: OPENAI_COMPATIBLE_ID,
				name: 'OpenAI Compatible API',
				connected: true,
				isOpenAICompatible: true,
				models: proxyModels.map(m => ({
					id: m.id,
					name: m.name,
					contextLimit: m.contextLength,
					capabilities: m.capabilities,
				})),
			},
		];

		if (isOpenCodeCLI) {
			list.push(
				...opencodeProviders
					.filter(p => p.id !== OPENAI_COMPATIBLE_PROVIDER_ID && !isProxyEndpointProviderId(p.id))
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
	}, [opencodeProviders, proxyModels, isOpenCodeCLI]);

	const availableForConnection = useMemo(() => {
		if (!isOpenCodeCLI) return [];

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
				if (priorityA !== priorityB) return priorityA - priorityB;
				return a.name.localeCompare(b.name);
			});
	}, [availableProviders, opencodeProviders, isOpenCodeCLI]);

	const handleToggleProvider = (providerId: string) => {
		if (expandedProvider === providerId) {
			setExpandedProvider(null);
			setApiKeyInput('');
			setSelectedNewProvider('');
			setModelSearch('');
			return;
		}
		setExpandedProvider(providerId);
		setApiKeyInput('');
		setSelectedNewProvider('');
		setModelSearch('');
	};

	const canDisconnect = (providerId: string) => !isNonDisconnectableProviderId(providerId);

	const handleRefresh = () => {
		postMessage({ type: 'syncAll' });
	};

	const saveProxySettings = () => {
		postMessage({
			type: 'updateSettings',
			settings: {
				'proxy.baseUrl': proxyBaseUrl,
				'proxy.apiKey': proxyApiKey,
			},
		});
	};

	const handleFetchProxyModels = () => {
		setProxyTestStatus({ isLoading: true, error: null });
		postMessage({
			type: 'loadProxyModels',
			baseUrl: proxyBaseUrl,
			apiKey: proxyApiKey,
		});
	};

	const handleToggleProxyModel = (modelId: string) => {
		const newEnabled = enabledProxyModels.includes(modelId)
			? enabledProxyModels.filter(id => id !== modelId)
			: [...enabledProxyModels, modelId];
		setEnabledProxyModels(newEnabled);
		postMessage({ type: 'updateSettings', settings: { 'proxy.enabledModels': newEnabled } });
		// Sync only enabled models to opencode.json
		postMessage({
			type: 'syncProxyModels',
			baseUrl: proxyBaseUrl,
			apiKey: proxyApiKey,
			enabledModelIds: newEnabled,
		});
	};

	const handleToggleProviderEnabled = (providerId: string) => {
		const nextDisabled = disabledProviders.includes(providerId)
			? disabledProviders.filter(id => id !== providerId)
			: [...disabledProviders, providerId];
		setSettings({ disabledProviders: nextDisabled });
		postMessage({ type: 'updateSettings', settings: { 'providers.disabled': nextDisabled } });
	};

	const persistProxyEndpoints = (
		endpoints: import('../../store/settingsStore').ProxyEndpointState[],
	) => {
		const persistedEndpoints = endpoints.map(endpoint => ({
			id: endpoint.id,
			name: endpoint.name,
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			enabledModels: endpoint.enabledModels,
			...(endpoint.headers && Object.keys(endpoint.headers).length > 0
				? { headers: endpoint.headers }
				: {}),
		}));
		postMessage({ type: 'updateSettings', settings: { 'proxy.endpoints': persistedEndpoints } });
	};

	const handleAddProxyEndpoint = () => {
		const endpointId = crypto.randomUUID();
		const nextEndpoint = {
			id: endpointId,
			name: '',
			baseUrl: '',
			apiKey: '',
			enabledModels: [],
			models: [],
			testStatus: { isLoading: false, success: null, error: null, lastTested: null },
		};
		const nextEndpoints = [...useSettingsStore.getState().proxyEndpoints, nextEndpoint];
		addProxyEndpoint(nextEndpoint);
		setExpandedProvider(`endpoint:${endpointId}`);
		persistProxyEndpoints(nextEndpoints);
	};

	const handleUpdateEndpointField = (
		endpointId: string,
		field: 'name' | 'baseUrl' | 'apiKey',
		value: string,
	) => {
		updateProxyEndpoint(endpointId, { [field]: value });
		const nextEndpoints = useSettingsStore
			.getState()
			.proxyEndpoints.map(endpoint =>
				endpoint.id === endpointId ? { ...endpoint, [field]: value } : endpoint,
			);
		persistProxyEndpoints(nextEndpoints);
	};

	const handleUpdateEndpointHeaders = (endpointId: string, headers: Record<string, string>) => {
		updateProxyEndpoint(endpointId, { headers });
		const nextEndpoints = useSettingsStore
			.getState()
			.proxyEndpoints.map(endpoint =>
				endpoint.id === endpointId ? { ...endpoint, headers } : endpoint,
			);
		persistProxyEndpoints(nextEndpoints);
	};

	const handleEndpointBlur = () => undefined;

	const handleFetchEndpointModels = (endpointId: string) => {
		const endpoint = useSettingsStore
			.getState()
			.proxyEndpoints.find(item => item.id === endpointId);
		if (!endpoint) return;
		updateProxyEndpoint(endpointId, {
			testStatus: { ...endpoint.testStatus, isLoading: true, error: null },
		});
		postMessage({
			type: 'loadProxyModels',
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			endpointId,
			headers: endpoint.headers,
		});
	};

	const handleToggleEndpointModel = (endpointId: string, modelId: string) => {
		const endpoint = useSettingsStore
			.getState()
			.proxyEndpoints.find(item => item.id === endpointId);
		if (!endpoint) return;
		const enabledModels = endpoint.enabledModels.includes(modelId)
			? endpoint.enabledModels.filter(id => id !== modelId)
			: [...endpoint.enabledModels, modelId];
		updateProxyEndpoint(endpointId, { enabledModels });
		const nextEndpoints = useSettingsStore
			.getState()
			.proxyEndpoints.map(item => (item.id === endpointId ? { ...item, enabledModels } : item));
		persistProxyEndpoints(nextEndpoints);
		postMessage({
			type: 'syncProxyModels',
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			enabledModelIds: enabledModels,
			endpointId,
			providerId: getProxyEndpointProviderId(endpointId),
			providerName: endpoint.name || undefined,
			headers: endpoint.headers,
		});
	};

	const handleRemoveEndpoint = (endpointId: string) => {
		postMessage({
			type: 'removeProxyEndpoint',
			providerId: getProxyEndpointProviderId(endpointId),
		});
		const nextEndpoints = useSettingsStore
			.getState()
			.proxyEndpoints.filter(endpoint => endpoint.id !== endpointId);
		removeProxyEndpoint(endpointId);
		persistProxyEndpoints(nextEndpoints);
	};

	const handleConnectProvider = (providerId: string) => {
		if (!apiKeyInput.trim()) return;
		postMessage({
			type: 'setOpenCodeProviderAuth',
			providerId,
			apiKey: apiKeyInput.trim(),
		});
	};

	const handleUpdateApiKey = (providerId: string) => {
		if (!editApiKeyInput.trim()) return;
		postMessage({
			type: 'setOpenCodeProviderAuth',
			providerId,
			apiKey: editApiKeyInput.trim(),
		});
		setEditingApiKey(null);
		setEditApiKeyInput('');
	};

	const handleDisconnectProvider = (providerId: string) => {
		postMessage({ type: 'disconnectOpenCodeProvider', providerId });
	};

	const handleToggleOpenCodeModel = (providerId: string, modelId: string) => {
		const fullId = `${providerId}/${modelId}`;
		const newEnabled = enabledOpenCodeModels.includes(fullId)
			? enabledOpenCodeModels.filter(id => id !== fullId)
			: [...enabledOpenCodeModels, fullId];
		setEnabledOpenCodeModels(newEnabled);
		postMessage({ type: 'updateSettings', settings: { 'opencode.enabledModels': newEnabled } });
	};

	const getEnabledCountForProvider = (providerId: string) =>
		enabledOpenCodeModels.filter(id => id.startsWith(`${providerId}/`)).length;

	const isOpenCodeModelEnabled = (providerId: string, modelId: string) =>
		enabledOpenCodeModels.includes(`${providerId}/${modelId}`);

	return (
		<div className="animate-fade-in">
			<div className="flex items-center justify-between mb-(--gap-2)">
				<GroupTitle className="mb-0">
					{isOpenCodeCLI ? 'Providers' : 'OpenAI Compatible'}
				</GroupTitle>
				{isOpenCodeCLI && (
					<button
						type="button"
						onClick={handleRefresh}
						className="text-xs text-vscode-descriptionForeground hover:text-vscode-foreground pr-1"
					>
						<RefreshIcon size={10} />
					</button>
				)}
			</div>

			<div className="border border-vscode-panel-border rounded overflow-hidden mb-(--gap-6) mx-(--gap-1)">
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
									...availableForConnection.map(p => ({ value: p.id, label: p.name })),
								]}
								className="min-w-(--input-width-sm)"
							/>
						</SettingRow>

						{selectedNewProvider &&
							(() => {
								const provider = availableForConnection.find(p => p.id === selectedNewProvider);
								if (!provider) return null;
								const isAuthLoading =
									providerAuthState?.providerId === provider.id && providerAuthState?.isLoading;

								return (
									<>
										{provider.env && provider.env.length > 0 && (
											<SettingRow title="Environment">
												<span className="text-xs font-mono text-vscode-descriptionForeground">
													{provider.env[0]}
												</span>
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

				{connectedProviders.map((provider, idx) => {
					const isExpanded = expandedProvider === provider.id;
					const isOpenAICompatible = provider.isOpenAICompatible;
					const modelCount = provider.models?.length ?? 0;
					const enabledCount = isOpenAICompatible
						? enabledProxyModels.length
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
							) : (
								<>
									<SettingRow title="Enable Provider">
										<div className="flex items-center gap-2">
											{canDisconnect(provider.id) && (
												<button
													type="button"
													onClick={() => handleDisconnectProvider(provider.id)}
													className="text-xs text-vscode-errorForeground/70 hover:text-vscode-errorForeground transition-colors"
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
										<ModelList searchValue={modelSearch} onSearchChange={setModelSearch}>
											{provider.models
												.filter(
													model =>
														!modelSearch ||
														model.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
														model.id.toLowerCase().includes(modelSearch.toLowerCase()),
												)
												.map(model => {
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

			<div className="flex items-center justify-between mb-(--gap-2)">
				<GroupTitle className="mb-0">Custom Endpoints</GroupTitle>
				<Button
					size="sm"
					variant="secondary"
					onClick={handleAddProxyEndpoint}
					className="text-xs px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
				>
					+ Add Endpoint
				</Button>
			</div>

			{proxyEndpoints.length > 0 ? (
				<div className="border border-vscode-panel-border rounded overflow-hidden mb-(--gap-6) mx-(--gap-1)">
					{proxyEndpoints.map((endpoint, idx) => {
						const providerKey = `endpoint:${endpoint.id}`;
						const enabledCount = endpoint.enabledModels.length;
						const modelCount = endpoint.models.length;
						return (
							<ExpandableRow
								key={endpoint.id}
								title={endpoint.name || 'New Endpoint'}
								subtitle={
									modelCount > 0
										? `${enabledCount}/${modelCount} models`
										: endpoint.baseUrl || 'Not configured'
								}
								badge={<SettingsBadge variant="blue">custom</SettingsBadge>}
								statusDot={endpoint.baseUrl ? 'connected' : 'disconnected'}
								expanded={expandedProvider === providerKey}
								onToggle={() => handleToggleProvider(providerKey)}
								last={idx === proxyEndpoints.length - 1}
							>
								<CustomEndpointConfig
									enabled={!disabledProviders.includes(getProxyEndpointProviderId(endpoint.id))}
									endpoint={endpoint}
									onToggle={() =>
										handleToggleProviderEnabled(getProxyEndpointProviderId(endpoint.id))
									}
									onFieldChange={(field, value) =>
										handleUpdateEndpointField(endpoint.id, field, value)
									}
									onHeadersChange={headers => handleUpdateEndpointHeaders(endpoint.id, headers)}
									onBlur={handleEndpointBlur}
									onFetchModels={() => handleFetchEndpointModels(endpoint.id)}
									onToggleModel={modelId => handleToggleEndpointModel(endpoint.id, modelId)}
									onRemove={() => handleRemoveEndpoint(endpoint.id)}
								/>
							</ExpandableRow>
						);
					})}
				</div>
			) : (
				<div className="mx-(--gap-1) mb-(--gap-6)">
					<EmptyState>Add an extra OpenAI-compatible endpoint</EmptyState>
				</div>
			)}
		</div>
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

interface CustomEndpointConfigProps {
	enabled: boolean;
	endpoint: import('../../store/settingsStore').ProxyEndpointState;
	onToggle: () => void;
	onFieldChange: (field: 'name' | 'baseUrl' | 'apiKey', value: string) => void;
	onHeadersChange: (headers: Record<string, string>) => void;
	onBlur: () => void;
	onFetchModels: () => void;
	onToggleModel: (modelId: string) => void;
	onRemove: () => void;
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
	const [modelSearch, setModelSearch] = useState('');

	const status = testStatus.isLoading
		? 'loading'
		: testStatus.success
			? 'success'
			: testStatus.error
				? 'error'
				: 'idle';

	const filteredModels = modelSearch
		? models.filter(
				m =>
					m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
					m.id.toLowerCase().includes(modelSearch.toLowerCase()),
			)
		: models;

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
							type="password"
							value={apiKey}
							onChange={e => onApiKeyChange(e.target.value)}
							onBlur={onBlur}
							placeholder="Optional"
							className="flex-1 max-w-(--input-width-lg)"
						/>
					</SettingRow>

					<div className="flex items-center justify-between px-2.5 py-1.5">
						<div className="flex items-center gap-1.5">
							<span className="text-sm text-vscode-foreground">Models</span>
							{models.length > 0 && <SettingsBadge>{models.length} found</SettingsBadge>}
							{status !== 'idle' && <SettingsBadge variant="blue">{status}</SettingsBadge>}
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

					{testStatus.error && (
						<div className="px-2.5 py-1.5">
							<StatusMessage error={testStatus.error} />
						</div>
					)}

					{models.length > 0 ? (
						<ModelList searchValue={modelSearch} onSearchChange={setModelSearch}>
							{filteredModels.map(model => (
								<ModelItem key={model.id} name={model.name} id={model.id}>
									<Switch
										checked={enabledModels.includes(model.id)}
										onChange={() => onToggleModel(model.id)}
									/>
								</ModelItem>
							))}
						</ModelList>
					) : (
						<EmptyState>Click "Fetch" to load available models</EmptyState>
					)}
				</>
			)}
		</>
	);
};

const CustomEndpointConfig: React.FC<CustomEndpointConfigProps> = ({
	enabled,
	endpoint,
	onToggle,
	onFieldChange,
	onHeadersChange,
	onBlur,
	onFetchModels,
	onToggleModel,
	onRemove,
}) => {
	const [modelSearch, setModelSearch] = useState('');
	const [headerKey, setHeaderKey] = useState('');
	const [headerValue, setHeaderValue] = useState('');
	const baseUrlError =
		endpoint.baseUrl.trim() && !/^https?:\/\//i.test(endpoint.baseUrl.trim())
			? 'URL must start with http:// or https://'
			: undefined;
	const status = endpoint.testStatus.isLoading
		? 'loading'
		: endpoint.testStatus.success
			? 'success'
			: endpoint.testStatus.error
				? 'error'
				: 'idle';
	const filteredModels = modelSearch
		? endpoint.models.filter(
				m =>
					m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
					m.id.toLowerCase().includes(modelSearch.toLowerCase()),
			)
		: endpoint.models;

	const headers = endpoint.headers ?? {};
	const headerEntries = Object.entries(headers);

	const handleAddHeader = () => {
		const key = headerKey.trim();
		const value = headerValue.trim();
		if (!key) return;
		onHeadersChange({ ...headers, [key]: value });
		setHeaderKey('');
		setHeaderValue('');
	};

	const handleRemoveHeader = (key: string) => {
		const next = { ...headers };
		delete next[key];
		onHeadersChange(next);
	};

	return (
		<>
			<SettingRow title="Enable Provider">
				<Switch checked={enabled} onChange={onToggle} />
			</SettingRow>
			<SettingRow title="Name">
				<TextInput
					value={endpoint.name}
					onChange={e => onFieldChange('name', e.target.value)}
					onBlur={onBlur}
					placeholder="e.g. Ollama"
					className="flex-1 max-w-(--input-width-lg)"
				/>
			</SettingRow>
			<SettingRow title="Base URL">
				<div className="flex flex-col flex-1 max-w-(--input-width-lg)">
					<TextInput
						value={endpoint.baseUrl}
						onChange={e => onFieldChange('baseUrl', e.target.value)}
						onBlur={onBlur}
						placeholder="http://localhost:11434"
						className="flex-1"
					/>
					{baseUrlError && (
						<span className="text-xs text-vscode-errorForeground mt-0.5">{baseUrlError}</span>
					)}
				</div>
			</SettingRow>
			<SettingRow title="API Key">
				<TextInput
					type="password"
					value={endpoint.apiKey}
					onChange={e => onFieldChange('apiKey', e.target.value)}
					onBlur={onBlur}
					placeholder="Optional"
					className="flex-1 max-w-(--input-width-lg)"
				/>
			</SettingRow>
			<div className="px-2.5 py-1.5">
				<div className="flex items-center justify-between mb-1">
					<span className="text-sm text-vscode-foreground">Headers</span>
					{headerEntries.length > 0 && <SettingsBadge>{headerEntries.length}</SettingsBadge>}
				</div>
				{headerEntries.map(([key, value]) => (
					<div key={key} className="flex items-center gap-1 mb-1">
						<span className="text-xs text-vscode-descriptionForeground truncate min-w-0 flex-1">
							{key}: {value}
						</span>
						<button
							type="button"
							onClick={() => handleRemoveHeader(key)}
							className="text-xs text-vscode-errorForeground/70 hover:text-vscode-errorForeground shrink-0"
						>
							×
						</button>
					</div>
				))}
				<div className="flex items-center gap-1">
					<TextInput
						value={headerKey}
						onChange={e => setHeaderKey(e.target.value)}
						placeholder="Header name"
						className="flex-1 text-xs"
					/>
					<TextInput
						value={headerValue}
						onChange={e => setHeaderValue(e.target.value)}
						placeholder="Value"
						className="flex-1 text-xs"
					/>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleAddHeader}
						disabled={!headerKey.trim()}
						className="text-xs px-2 py-0.5 h-(--btn-height-sm) min-h-[unset] shrink-0"
					>
						Add
					</Button>
				</div>
			</div>
			<div className="flex items-center justify-between px-2.5 py-1.5">
				<div className="flex items-center gap-1.5">
					<span className="text-sm text-vscode-foreground">Models</span>
					{endpoint.models.length > 0 && (
						<SettingsBadge>{endpoint.models.length} found</SettingsBadge>
					)}
					{status !== 'idle' && <SettingsBadge variant="blue">{status}</SettingsBadge>}
				</div>
				<Button
					size="sm"
					variant="secondary"
					onClick={onFetchModels}
					disabled={endpoint.testStatus.isLoading || !endpoint.baseUrl.trim() || !!baseUrlError}
					className="text-xs px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
				>
					{endpoint.testStatus.isLoading
						? 'Loading...'
						: endpoint.models.length > 0
							? 'Refresh'
							: 'Fetch'}
				</Button>
			</div>
			{endpoint.testStatus.error && (
				<div className="px-2.5 py-1.5">
					<StatusMessage error={endpoint.testStatus.error} />
				</div>
			)}
			{endpoint.models.length > 0 ? (
				<ModelList searchValue={modelSearch} onSearchChange={setModelSearch}>
					{filteredModels.map(model => (
						<ModelItem key={model.id} name={model.name} id={model.id}>
							<Switch
								checked={endpoint.enabledModels.includes(model.id)}
								onChange={() => onToggleModel(model.id)}
							/>
						</ModelItem>
					))}
				</ModelList>
			) : (
				<EmptyState>
					{endpoint.baseUrl.trim()
						? baseUrlError
							? 'Fix the Base URL format first'
							: 'Click "Fetch" to load available models'
						: 'Enter a Base URL first'}
				</EmptyState>
			)}
			<SettingRow title="" last>
				<button
					type="button"
					onClick={onRemove}
					className="text-xs text-vscode-errorForeground/70 hover:text-vscode-errorForeground transition-colors"
				>
					Remove Endpoint
				</button>
			</SettingRow>
		</>
	);
};
