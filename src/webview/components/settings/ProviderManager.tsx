/**
 * @file Provider Manager Component
 * @description Unified interface for managing AI providers. Shows connected providers with
 *              ability to enable/disable individual models and disconnect providers. Includes
 *              OpenAI-compatible provider configuration. Uses shared SettingsUI primitives.
 *              For OpenCode CLI, provider auth is handled via OpenCode server endpoints.
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { isNonDisconnectableProviderId, OPENAI_COMPATIBLE_PROVIDER_ID } from '../../../common';
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
			return;
		}
		setExpandedProvider(providerId);
		setApiKeyInput('');
		setSelectedNewProvider('');
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
	};

	const handleToggleProviderEnabled = (providerId: string) => {
		const nextDisabled = disabledProviders.includes(providerId)
			? disabledProviders.filter(id => id !== providerId)
			: [...disabledProviders, providerId];
		setSettings({ disabledProviders: nextDisabled });
		postMessage({ type: 'updateSettings', settings: { 'providers.disabled': nextDisabled } });
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
						className="text-2xs text-vscode-descriptionForeground hover:text-vscode-foreground pr-1"
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
													className="text-2xs text-vscode-errorForeground/70 hover:text-vscode-errorForeground transition-colors"
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
										<ModelList>
											{provider.models.map(model => {
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
						<ModelList>
							{models.map(model => (
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
