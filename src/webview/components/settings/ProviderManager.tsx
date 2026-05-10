/**
 * @file Provider Manager Component
 * @description Unified interface for managing AI providers. Shows connected providers with
 *              ability to enable/disable individual models and disconnect providers.
 *              Uses shared SettingsUI primitives with provider-level model visibility controls.
 *              For OpenCode CLI, provider auth is handled via OpenCode server endpoints.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
	getProxyEndpointProtocol,
	getProxyEndpointProviderId,
	getProxyEndpointProviderIdFromName,
	isNonDisconnectableProviderId,
	isProxyEndpointProviderId,
	OPENAI_COMPATIBLE_PROVIDER_ID,
	type OpenCodeProviderData,
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
	npm?: string;
	baseUrl?: string;
	source?: OpenCodeProviderData['source'];
	env?: string[];
	models?: Array<{
		id: string;
		name: string;
		reasoning?: boolean;
		limit?: { context?: number; output?: number };
	}>;
}

interface AddProviderSectionProps {
	availableForConnection: Array<{ id: string; name: string; env: string[] }>;
	selectedNewProvider: string;
	setSelectedNewProvider: (value: string) => void;
	apiKeyInput: string;
	setApiKeyInput: (value: string) => void;
	providerAuthState: ReturnType<typeof useSettingsStore.getState>['providerAuthState'];
	onConnect: (providerId: string) => void;
	last?: boolean;
}

export const AddProviderSection: React.FC<AddProviderSectionProps> = ({
	availableForConnection,
	selectedNewProvider,
	setSelectedNewProvider,
	apiKeyInput,
	setApiKeyInput,
	providerAuthState,
	onConnect,
	last = false,
}) => {
	if (availableForConnection.length === 0) return null;

	const selectedProvider = availableForConnection.find(p => p.id === selectedNewProvider);
	const isAuthLoading =
		selectedProvider &&
		providerAuthState?.providerId === selectedProvider.id &&
		providerAuthState?.isLoading;

	return (
		<>
			<SettingRow title="Add Provider" last={!selectedProvider && last}>
				<div className="flex items-center gap-2">
					<span className="text-sm text-vscode-descriptionForeground shrink-0">
						{availableForConnection.length} available
					</span>
					<Select
						value={selectedNewProvider}
						onChange={e => setSelectedNewProvider(e.target.value)}
						options={[
							{ value: '', label: 'Select provider...' },
							...availableForConnection.map(p => ({ value: p.id, label: p.name })),
						]}
						className="min-w-(--input-width-sm)"
					/>
				</div>
			</SettingRow>

			{selectedProvider && (
				<>
					<SettingRow
						title="API Key"
						last={!providerAuthState || providerAuthState.providerId !== selectedProvider.id}
					>
						<TextInput
							type="password"
							value={apiKeyInput}
							onChange={e => setApiKeyInput(e.target.value)}
							placeholder="Enter API key"
							className="flex-1 max-w-(--input-width-md)"
						/>
					</SettingRow>

					{providerAuthState && providerAuthState.providerId === selectedProvider.id && (
						<div className="px-2.5 py-1.5 border-t border-(--border-subtle)">
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
							onClick={() => onConnect(selectedProvider.id)}
							disabled={!apiKeyInput.trim() || Boolean(isAuthLoading)}
							className="px-3"
						>
							{isAuthLoading ? 'Connecting...' : 'Connect'}
						</Button>
					</SettingRow>
				</>
			)}
		</>
	);
};

export const ProviderManager: React.FC = () => {
	const {
		provider: cliProvider,
		opencodeProviders,
		providerModelVisibility,
		availableProviders,
		providerAuthState,
		proxyEndpoints,
		enabledOpenCodeModels,
	} = useSettingsStore();

	const {
		setProviderAuthState,
		addProxyEndpoint,
		updateProxyEndpoint,
		removeProxyEndpoint,
		setEnabledOpenCodeModels,
		setProviderModelVisibility,
	} = useSettingsActions();
	const { postMessage } = useVSCode();

	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [editingApiKey, setEditingApiKey] = useState<string | null>(null);
	const [editApiKeyInput, setEditApiKeyInput] = useState('');
	const [modelSearchByProvider, setModelSearchByProvider] = useState<Record<string, string>>({});

	const isOpenCodeCLI = cliProvider === 'opencode';

	useEffect(() => {
		if (providerAuthState?.success && !providerAuthState.isLoading) {
			const timer = setTimeout(() => {
				setExpandedProvider(null);
				setEditingApiKey(null);
				setEditApiKeyInput('');
				setProviderAuthState(null);
				postMessage({ type: 'reloadAllProviders' });
			}, 1000);
			return () => clearTimeout(timer);
		}
		return undefined;
	}, [providerAuthState, setProviderAuthState, postMessage]);

	// Unified provider list: connected system providers + popular disconnected providers.
	// Custom endpoint-backed providers are handled separately in Custom Endpoints.
	const POPULAR_PROVIDER_IDS = useMemo(
		() =>
			new Set([
				'opencode',
				'anthropic',
				'github-copilot',
				'openai',
				'google',
				'openrouter',
				'vercel',
			]),
		[],
	);

	const allProviders: ProviderItemData[] = useMemo(() => {
		if (!isOpenCodeCLI) return [];

		const proxyProviderIds = new Set(
			proxyEndpoints.flatMap(endpoint => [
				endpoint.id,
				getProxyEndpointProviderId(endpoint.id),
				getProxyEndpointProviderIdFromName(endpoint.name, endpoint.id),
			]),
		);

		// Connected system providers (exclude custom endpoint providers)
		const connected: ProviderItemData[] = opencodeProviders
			.filter(
				p =>
					p.id !== OPENAI_COMPATIBLE_PROVIDER_ID &&
					!proxyProviderIds.has(p.id) &&
					!isProxyEndpointProviderId(p.id),
			)
			.map(p => ({
				id: p.id,
				name: p.name,
				connected: true,
				npm: p.npm,
				baseUrl: p.baseUrl,
				source: p.source,
				env: p.env,
				models: p.models,
			}));

		// Disconnected popular providers (not yet connected)
		const connectedIds = new Set(connected.map(p => p.id));
		const disconnected: ProviderItemData[] = availableProviders
			.filter(ap => POPULAR_PROVIDER_IDS.has(ap.id) && !connectedIds.has(ap.id))
			.map(ap => ({
				id: ap.id,
				name: ap.name,
				connected: false,
				env: ap.env,
				models: ap.models,
			}));

		// Sort: connected first, then disconnected in popular order
		const popularOrder = [...POPULAR_PROVIDER_IDS];
		disconnected.sort((a, b) => popularOrder.indexOf(a.id) - popularOrder.indexOf(b.id));

		return [...connected, ...disconnected];
	}, [opencodeProviders, availableProviders, isOpenCodeCLI, proxyEndpoints, POPULAR_PROVIDER_IDS]);

	const handleToggleProvider = (providerId: string) => {
		if (expandedProvider === providerId) {
			setExpandedProvider(null);
			return;
		}
		setExpandedProvider(providerId);
	};

	const canDisconnect = (provider: ProviderItemData) => {
		if (provider.source === 'env') return false;
		return !isNonDisconnectableProviderId(provider.id);
	};

	const resolveEndpointProviderId = (endpoint: { id: string; name?: string }): string => {
		const trimmedName = endpoint.name?.trim();
		const hasDuplicateName = Boolean(
			trimmedName &&
				proxyEndpoints.some(other => other.id !== endpoint.id && other.name.trim() === trimmedName),
		);
		return getProxyEndpointProviderIdFromName(
			hasDuplicateName ? undefined : endpoint.name,
			endpoint.id,
		);
	};

	const updateProviderModelSearch = (providerId: string, value: string) => {
		setModelSearchByProvider(prev => ({ ...prev, [providerId]: value }));
	};

	const handleRefresh = () => {
		postMessage({ type: 'reloadAllProviders' });
	};

	const persistProxyEndpoints = (
		endpoints: import('../../store/settingsStore').ProxyEndpointState[],
	) => {
		const persistedEndpoints = endpoints.map(endpoint => ({
			id: endpoint.id,
			name: endpoint.name,
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			protocol: getProxyEndpointProtocol(endpoint.protocol),
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
			protocol: 'openai-compatible' as const,
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
		field: 'name' | 'baseUrl' | 'apiKey' | 'protocol',
		value: string,
	) => {
		updateProxyEndpoint(endpointId, { [field]: value });
		persistProxyEndpoints(useSettingsStore.getState().proxyEndpoints);
	};

	const handleUpdateEndpointHeaders = (endpointId: string, headers: Record<string, string>) => {
		updateProxyEndpoint(endpointId, { headers });
		persistProxyEndpoints(useSettingsStore.getState().proxyEndpoints);
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
			protocol: getProxyEndpointProtocol(endpoint.protocol),
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
		persistProxyEndpoints(useSettingsStore.getState().proxyEndpoints);
		const providerId = resolveEndpointProviderId(endpoint);
		postMessage({
			type: 'syncProxyModels',
			baseUrl: endpoint.baseUrl,
			apiKey: endpoint.apiKey,
			enabledModelIds: enabledModels,
			endpointId,
			providerId,
			providerName: providerId,
			headers: endpoint.headers,
			protocol: getProxyEndpointProtocol(endpoint.protocol),
		});
	};

	const handleRemoveEndpoint = (endpointId: string) => {
		const endpoint = useSettingsStore
			.getState()
			.proxyEndpoints.find(item => item.id === endpointId);
		postMessage({
			type: 'removeProxyEndpoint',
			providerId: endpoint
				? resolveEndpointProviderId(endpoint)
				: getProxyEndpointProviderId(endpointId),
			baseUrl: endpoint?.baseUrl,
		});
		const nextEndpoints = useSettingsStore
			.getState()
			.proxyEndpoints.filter(endpoint => endpoint.id !== endpointId);
		removeProxyEndpoint(endpointId);
		persistProxyEndpoints(nextEndpoints);
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

	const handleToggleOpenCodeProviderModels = (provider: ProviderItemData) => {
		setProviderModelVisibility(provider.id, providerModelVisibility[provider.id] === false);
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
						className="text-sm text-vscode-descriptionForeground hover:text-vscode-foreground pr-1"
					>
						<RefreshIcon size={10} />
					</button>
				)}
			</div>

			<div className="border border-vscode-panel-border rounded overflow-hidden mb-(--gap-6) mx-(--gap-1)">
				{allProviders.map((provider, idx) => {
					const isExpanded = expandedProvider === provider.id;
					const modelCount = provider.models?.length ?? 0;
					const enabledCount = getEnabledCountForProvider(provider.id);
					const modelSearch = modelSearchByProvider[provider.id] ?? '';
					const isThisProvider = providerAuthState?.providerId === provider.id;
					const isAuthLoading = isThisProvider && providerAuthState?.isLoading;
					const authSuccess = isThisProvider ? providerAuthState?.success : undefined;
					const authError = isThisProvider ? providerAuthState?.error : undefined;

					return (
						<ExpandableRow
							key={provider.id}
							title={provider.name}
							subtitle={modelCount > 0 ? `${enabledCount}/${modelCount} models` : undefined}
							statusDot={provider.connected ? 'connected' : 'disconnected'}
							expanded={isExpanded}
							onToggle={() => handleToggleProvider(provider.id)}
							last={idx === allProviders.length - 1}
						>
							<SettingRow title="API Key" last={!provider.models?.length}>
								{editingApiKey === provider.id ? (
									<div className="flex items-center gap-1.5">
										<TextInput
											type="password"
											value={editApiKeyInput}
											onChange={e => setEditApiKeyInput(e.target.value)}
											placeholder={provider.connected ? 'Enter new API key' : 'Enter API key'}
											className="flex-1 max-w-(--input-width-md)"
										/>
										<Button
											size="sm"
											variant="primary"
											onClick={() => handleUpdateApiKey(provider.id)}
											disabled={!editApiKeyInput.trim() || Boolean(isAuthLoading)}
											className="px-2"
										>
											{isAuthLoading ? '...' : provider.connected ? 'Save' : 'Connect'}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => {
												setEditingApiKey(null);
												setEditApiKeyInput('');
											}}
											className="px-2"
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
										className="px-2"
									>
										{provider.connected ? 'Change' : 'Configure'}
									</Button>
								)}
							</SettingRow>

							{(authSuccess || authError) && (
								<div className="px-2.5 py-1.5 border-t border-(--border-subtle)">
									<StatusMessage
										isLoading={false}
										success={authSuccess || undefined}
										error={authError || undefined}
									/>
								</div>
							)}

							{provider.models && provider.models.length > 0 ? (
								<>
									<SettingRow title="Show Models" last>
										<div className="flex items-center gap-2">
											{provider.connected && canDisconnect(provider) && (
												<button
													type="button"
													onClick={() => handleDisconnectProvider(provider.id)}
													className="text-sm text-vscode-errorForeground/70 hover:text-vscode-errorForeground transition-colors"
												>
													Disconnect
												</button>
											)}
											<Switch
												checked={providerModelVisibility[provider.id] !== false}
												indeterminate={
													providerModelVisibility[provider.id] !== false &&
													enabledCount > 0 &&
													enabledCount < modelCount
												}
												onChange={() => handleToggleOpenCodeProviderModels(provider)}
											/>
										</div>
									</SettingRow>
									<ModelList
										searchValue={modelSearch}
										onSearchChange={value => updateProviderModelSearch(provider.id, value)}
										maxHeight={320}
									>
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
														{model.reasoning && (
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
								</>
							) : (
								<EmptyState>No models available</EmptyState>
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
					className="px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
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
						const endpointProviderId = resolveEndpointProviderId(endpoint);
						return (
							<ExpandableRow
								key={endpoint.id}
								title={endpoint.name || 'New Endpoint'}
								subtitle={
									modelCount > 0
										? `${enabledCount}/${modelCount} models`
										: endpoint.baseUrl || 'Not configured'
								}
								statusDot={endpoint.baseUrl ? 'connected' : 'disconnected'}
								expanded={expandedProvider === providerKey}
								onToggle={() => handleToggleProvider(providerKey)}
								last={idx === proxyEndpoints.length - 1}
							>
								<CustomEndpointConfig
									enabled={providerModelVisibility[endpointProviderId] !== false}
									endpoint={endpoint}
									onToggle={() =>
										setProviderModelVisibility(
											endpointProviderId,
											providerModelVisibility[endpointProviderId] === false,
										)
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
					<EmptyState>Add a custom API endpoint</EmptyState>
				</div>
			)}
		</div>
	);
};

interface CustomEndpointConfigProps {
	enabled: boolean;
	endpoint: import('../../store/settingsStore').ProxyEndpointState;
	onToggle: () => void;
	onFieldChange: (field: 'name' | 'baseUrl' | 'apiKey' | 'protocol', value: string) => void;
	onHeadersChange: (headers: Record<string, string>) => void;
	onBlur: () => void;
	onFetchModels: () => void;
	onToggleModel: (modelId: string) => void;
	onRemove: () => void;
}

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
			<SettingRow
				title="Show Models"
				tooltip="Controls PrimeCode UI visibility only. Does not disable the provider in OpenCode runtime config."
			>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onRemove}
						className="text-sm text-vscode-errorForeground/70 hover:text-vscode-errorForeground transition-colors"
					>
						Disconnect
					</button>
					<Switch checked={enabled} onChange={onToggle} />
				</div>
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
			<SettingRow title="Protocol">
				<Select
					value={endpoint.protocol ?? 'openai-compatible'}
					onChange={e =>
						onFieldChange('protocol', e.target.value as 'openai-compatible' | 'anthropic')
					}
					options={[
						{ value: 'openai-compatible', label: 'OpenAI Compatible' },
						{ value: 'anthropic', label: 'Anthropic' },
					]}
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
						<span className="text-sm text-vscode-errorForeground mt-0.5">{baseUrlError}</span>
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
			<div className="px-2.5 py-0.5">
				<div className="flex items-center justify-between mb-1">
					<span className="text-sm text-vscode-foreground">Headers</span>
					{headerEntries.length > 0 && <SettingsBadge>{headerEntries.length}</SettingsBadge>}
				</div>
				{headerEntries.map(([key, value]) => (
					<div key={key} className="flex items-center gap-1 mb-0.5">
						<span className="text-sm text-vscode-descriptionForeground truncate min-w-0 flex-1">
							{key}: {value}
						</span>
						<button
							type="button"
							onClick={() => handleRemoveHeader(key)}
							className="text-sm text-vscode-errorForeground/70 hover:text-vscode-errorForeground shrink-0"
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
						className="flex-1 text-sm"
					/>
					<TextInput
						value={headerValue}
						onChange={e => setHeaderValue(e.target.value)}
						placeholder="Value"
						className="flex-1 text-sm"
					/>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleAddHeader}
						disabled={!headerKey.trim()}
						className="px-2 py-0.5 h-(--btn-height-sm) min-h-[unset] shrink-0"
					>
						Add
					</Button>
				</div>
			</div>
			<div className="flex items-center justify-between px-2.5 py-0.5">
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
					className="px-2 py-0.5 h-(--btn-height-sm) min-h-[unset]"
				>
					{endpoint.testStatus.isLoading
						? 'Loading...'
						: endpoint.models.length > 0
							? 'Refresh'
							: 'Fetch'}
				</Button>
			</div>
			{endpoint.testStatus.error && (
				<div className="px-2.5 py-0.5">
					<StatusMessage error={endpoint.testStatus.error} />
				</div>
			)}
			{endpoint.models.length > 0 ? (
				<ModelList searchValue={modelSearch} onSearchChange={setModelSearch} maxHeight={320}>
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
		</>
	);
};
