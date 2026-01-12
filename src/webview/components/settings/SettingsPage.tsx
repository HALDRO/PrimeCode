/**
 * @file SettingsPage - full-screen settings interface
 * @description Settings page with top navigation and grouped settings sections.
 *              Navigation adapts to available width: shows full tab labels when space allows,
 *              and gracefully collapses to icon-only buttons with tooltips when constrained.
 *              Uses CSS classes for hover states to avoid unnecessary re-renders.
 *              Organized into Main, Rules, Permissions, Skills, Hooks, and MCP tabs.
 *              Uses shared SettingsUI primitives. Provider change triggers reload
 *              of OpenCode providers/available providers when switching to OpenCode CLI.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TIMEOUTS } from '../../../shared';
import { SETTINGS_NAV_ITEMS, type SettingsTab } from '../../constants';
import { cn } from '../../lib/cn';
import { useMainSettings, useSettingsActions, useSettingsStore, useUIActions } from '../../store';
import { useVSCode } from '../../utils/vscode';
import {
	AgentsIcon,
	BookIcon,
	CloseIcon,
	PlugIcon,
	ServerIcon,
	SettingsIcon,
	ShieldIcon,
	SparklesIcon,
} from '../icons';
import { Button, IconButton, ScrollContainer, Select, Switch, Tooltip } from '../ui';
import { McpSettingsPanel } from './McpSettingsPanel';
import { PromptImproverSettings } from './PromptImproverSettings';
import { OpenCodeProviderManager } from './ProviderManager';
import { RulesSettingsPanel } from './RulesSettingsPanel';
import { CLIStatusBar, GroupTitle, SettingRow, SettingsBadge, SettingsGroup } from './SettingsUI';

const NAV_ICONS: Record<string, React.ReactNode> = {
	settings: <SettingsIcon size={14} />,
	server: <ServerIcon size={14} />,
	shield: <ShieldIcon size={14} />,
	book: <BookIcon size={14} />,
	sparkles: <SparklesIcon size={14} />,
	plug: <PlugIcon size={14} />,
	agents: <AgentsIcon size={16} />,
};

// Navigation button using CSS classes for hover
const NavButton = React.memo<{
	item: { id: string; label: string };
	icon: React.ReactNode;
	isActive: boolean;
	showLabel: boolean;
	onClick: () => void;
	className?: string;
}>(({ item, icon, isActive, showLabel, onClick, className }) => {
	const shouldShowLabel = showLabel || isActive;

	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={item.label}
			className={cn(
				'flex items-center gap-1.5 px-1.5 h-(--btn-height-sm) bg-transparent border-none rounded-sm cursor-pointer transition-all duration-75 text-sm text-vscode-descriptionForeground',
				'hover:bg-vscode-list-hoverBackground hover:text-vscode-foreground',
				isActive && 'bg-vscode-list-hoverBackground text-vscode-foreground',
				className ?? 'w-full',
			)}
		>
			{shouldShowLabel ? (
				<>
					<span className="flex shrink-0 opacity-70">{icon}</span>
					<span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">
						{item.label}
					</span>
				</>
			) : (
				<Tooltip content={item.label} position="top" delay={200}>
					<span className="flex shrink-0 opacity-70">{icon}</span>
				</Tooltip>
			)}
		</button>
	);
});
NavButton.displayName = 'NavButton';

// Claude CLI Status wrapper - uses unified CLIStatusBar
const ClaudeCLIStatus: React.FC = () => {
	const { cliDiagnostics } = useSettingsStore();
	const { setCLIDiagnostics } = useSettingsActions();
	const { postMessage } = useVSCode();

	useEffect(() => {
		postMessage('checkCLIDiagnostics');
	}, [postMessage]);

	const handleRefresh = () => {
		setCLIDiagnostics({ isChecking: true });
		postMessage('checkCLIDiagnostics');
	};

	const handleOpenDocs = () => {
		postMessage('openExternal', { url: 'https://docs.anthropic.com/en/docs/claude-code' });
	};

	return (
		<CLIStatusBar
			variant="claude"
			isChecking={cliDiagnostics.isChecking}
			installed={cliDiagnostics.installed}
			version={cliDiagnostics.version ?? undefined}
			updateAvailable={cliDiagnostics.updateAvailable}
			onRefresh={handleRefresh}
			onOpenDocs={handleOpenDocs}
		/>
	);
};

// OpenCode CLI Status wrapper - uses unified CLIStatusBar
const OpenCodeCLIStatus: React.FC = () => {
	const { postMessage } = useVSCode();
	const { opencodeConfig, opencodeStatus } = useSettingsStore();
	const { setOpenCodeStatus, setOpenCodeConfig } = useSettingsActions();
	const initialLoadDone = useRef(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const startTimeout = () => {
		// Clear any existing timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = setTimeout(() => {
			const { opencodeStatus: status, opencodeConfig: config } = useSettingsStore.getState();
			const actions = useSettingsStore.getState().actions;
			if (status.isChecking) {
				actions.setOpenCodeStatus({ isChecking: false, error: 'Connection timed out' });
			}
			if (config.isLoading) {
				actions.setOpenCodeConfig({ isLoading: false, error: 'Loading timed out' });
			}
		}, TIMEOUTS.CLI_STATUS_CHECK);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: Intentionally run only once on mount
	useEffect(() => {
		if (initialLoadDone.current) {
			return;
		}
		initialLoadDone.current = true;

		postMessage('checkOpenCodeStatus');
		postMessage('loadOpenCodeProviders');
		startTimeout();

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	const handleRefresh = () => {
		setOpenCodeStatus({ isChecking: true, error: undefined });
		setOpenCodeConfig({ isLoading: true, error: undefined });
		postMessage('checkOpenCodeStatus');
		postMessage('loadOpenCodeProviders');
		startTimeout();
	};

	const handleOpenDocs = () => {
		postMessage('openExternal', { url: 'https://opencode.ai/docs' });
	};

	return (
		<CLIStatusBar
			variant="opencode"
			isChecking={opencodeStatus.isChecking}
			installed={opencodeStatus.installed}
			version={opencodeStatus.version}
			error={opencodeStatus.error}
			isLoadingProviders={opencodeConfig.isLoading}
			onRefresh={handleRefresh}
			onOpenDocs={handleOpenDocs}
		/>
	);
};

// OpenCode Providers & Model Selection component - uses new unified manager
const OpenCodeProvidersSection: React.FC = () => <OpenCodeProviderManager />;

// Rules settings tab (consolidated Rules, Skills, Hooks) - OPENCODE-REFAC: Moved to CommandsSettingsPanel.tsx as RulesSettingsPanel

// Permissions settings tab (Unified)

// Permissions settings tab (Unified)
const PermissionsSettings: React.FC = () => {
	const { postMessage } = useVSCode();
	const { discoveryStatus, policies, provider } = useSettingsStore();
	const { permissions } = discoveryStatus;

	const handlePolicyChange = (
		type: 'edit' | 'terminal' | 'network',
		value: 'ask' | 'allow' | 'deny',
	) => {
		const newPolicies = { ...policies, [type]: value };
		postMessage('setPermissions', { policies: newPolicies, provider });
	};

	const handlePreset = (preset: 'ask' | 'allow') => {
		const newPolicies = { edit: preset, terminal: preset, network: preset };
		postMessage('setPermissions', { policies: newPolicies, provider });
	};

	const policyOptions = [
		{ value: 'ask', label: 'Ask' },
		{ value: 'allow', label: 'Allow' },
		{ value: 'deny', label: 'Deny' },
	];

	return (
		<div className="animate-fade-in">
			<GroupTitle>Global Policies ({provider === 'opencode' ? 'OpenCode' : 'Claude'})</GroupTitle>
			<SettingsGroup>
				<SettingRow title="Edit Files" tooltip="Allow AI to modify files in workspace">
					<Select
						value={policies.edit}
						onChange={e => handlePolicyChange('edit', e.target.value as 'ask' | 'allow' | 'deny')}
						options={policyOptions}
					/>
				</SettingRow>
				<SettingRow title="Terminal" tooltip="Allow AI to execute shell commands">
					<Select
						value={policies.terminal}
						onChange={e =>
							handlePolicyChange('terminal', e.target.value as 'ask' | 'allow' | 'deny')
						}
						options={policyOptions}
					/>
				</SettingRow>
				<SettingRow title="Network" tooltip="Allow AI to access internet">
					<Select
						value={policies.network}
						onChange={e =>
							handlePolicyChange('network', e.target.value as 'ask' | 'allow' | 'deny')
						}
						options={policyOptions}
					/>
				</SettingRow>
				<SettingRow title="Quick Presets" tooltip="Apply preset to all policies" last>
					<div className="flex items-center gap-1.5">
						<Button size="xs" variant="secondary" onClick={() => handlePreset('ask')}>
							Ask All
						</Button>
						<Button size="xs" variant="secondary" onClick={() => handlePreset('allow')}>
							Allow All
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>

			<div className="p-3 bg-white/3 border border-white/8 rounded text-sm text-white/60 mt-4 mb-4">
				These settings are persisted in{' '}
				<code className="bg-white/10 px-1 rounded">
					{provider === 'opencode' ? 'opencode.json' : '.claude/settings.json'}
				</code>
				.
			</div>

			<GroupTitle>Configuration Files</GroupTitle>
			<SettingsGroup>
				<SettingRow title="Claude Settings" tooltip=".claude/settings.json">
					<div className="flex items-center gap-2">
						{permissions.claudeConfig ? (
							<SettingsBadge variant="green">Active</SettingsBadge>
						) : (
							<SettingsBadge>Missing</SettingsBadge>
						)}
						<Button
							size="sm"
							variant="secondary"
							onClick={() => postMessage('openFile', { filePath: '.claude/settings.json' })}
						>
							{permissions.claudeConfig ? 'Open' : 'Create'}
						</Button>
					</div>
				</SettingRow>
				<SettingRow title="OpenCode Config" tooltip="opencode.json" last>
					<div className="flex items-center gap-2">
						{permissions.openCodeConfig ? (
							<SettingsBadge variant="green">Active</SettingsBadge>
						) : (
							<SettingsBadge>Missing</SettingsBadge>
						)}
						<Button
							size="sm"
							variant="secondary"
							onClick={() => postMessage('openFile', { filePath: 'opencode.json' })}
						>
							{permissions.openCodeConfig ? 'Open' : 'Create'}
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>
		</div>
	);
};

// Skills settings tab (discovery-only for now) - MERGED INTO RULES
// Hooks settings tab (discovery-only for now) - MERGED INTO RULES

// Proxy Models Test & Selection component - MOVED TO ProviderManager.tsx

// Main settings tab
const MainSettings: React.FC = () => {
	const { provider } = useMainSettings();
	const {
		proxyUseSingleModel,
		proxyHaikuModel,
		proxySonnetModel,
		proxyOpusModel,
		proxySubagentModel,
		proxyModels,
		enabledProxyModels,
		disabledProviders,
		anthropicModels,
		anthropicKeyStatus,
	} = useSettingsStore();
	const { setSettings } = useSettingsActions();
	const { postMessage } = useVSCode();

	const handleProviderChange = (newProvider: string) => {
		setSettings({ provider: newProvider as 'claude' | 'opencode' });
		postMessage('updateSettings', { settings: { provider: newProvider } });
		// Refresh permissions when provider changes
		setTimeout(() => postMessage('getPermissions'), 100);
		// Load OpenCode providers when switching to OpenCode CLI
		if (newProvider === 'opencode') {
			postMessage('reloadAllProviders');
		}
	};

	// Save task-specific model settings
	const saveTaskModels = (key: string, value: string) => {
		setSettings({ [key]: value } as Record<string, string>);
		postMessage('updateSettings', {
			settings: {
				[`proxy.${key.replace('proxy', '').charAt(0).toLowerCase()}${key.replace('proxy', '').slice(1)}`]:
					value,
			},
		});
	};

	const isClaude = provider === 'claude';

	// Check if OpenAI Compatible provider is enabled and has models
	const hasEnabledProxyModels = enabledProxyModels.length > 0;

	// Check if Anthropic provider is enabled and has models (via API key or CLI auth)
	const isAnthropicEnabled = !disabledProviders.includes('anthropic');
	const hasAnthropicModels = anthropicModels.length > 0 || anthropicKeyStatus.hasKey;

	// Build model options for Select component - include both proxy and Anthropic models
	const modelOptions = [
		{ value: '', label: 'Use main model' },
		// Anthropic Claude models (when available)
		...(isAnthropicEnabled
			? (anthropicModels.length > 0
					? anthropicModels
					: [
							{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
							{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
							{ id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
						]
				).map(m => ({ value: m.id, label: m.name }))
			: []),
		// OpenAI Compatible models
		...enabledProxyModels.map(id => {
			const model = proxyModels.find(m => m.id === id);
			return { value: id, label: model?.name || id };
		}),
	];

	// Show task-specific models when we have any models available
	const hasAnyModels = hasEnabledProxyModels || (isAnthropicEnabled && hasAnthropicModels);

	return (
		<div className="animate-fade-in">
			<GroupTitle>Main</GroupTitle>
			<SettingsGroup>
				<SettingRow title="CLI Provider" tooltip="Select which AI coding assistant CLI to use" last>
					<Select
						value={provider}
						onChange={e => handleProviderChange(e.target.value)}
						options={[
							{ value: 'claude', label: 'Claude Code' },
							{ value: 'opencode', label: 'OpenCode' },
						]}
					/>
				</SettingRow>
			</SettingsGroup>

			{/* Unified Provider Manager - works for both Claude and OpenCode */}
			<OpenCodeProvidersSection />

			<PromptImproverSettings />

			{/* Task-Specific Models - only for Claude provider with available models */}
			{isClaude && hasAnyModels && (
				<>
					<GroupTitle>Task-Specific Models</GroupTitle>
					<SettingsGroup>
						<SettingRow
							title="Use Single Model"
							tooltip="When enabled, only the main selected model is used for all tasks. Disable to configure separate models for different task types."
							last={proxyUseSingleModel}
						>
							<Switch
								checked={proxyUseSingleModel}
								onChange={() => {
									const newValue = !proxyUseSingleModel;
									setSettings({ proxyUseSingleModel: newValue });
									postMessage('updateSettings', {
										settings: { 'proxy.useSingleModel': newValue },
									});
								}}
							/>
						</SettingRow>
						{!proxyUseSingleModel && (
							<>
								<SettingRow title="Haiku (Fast)" tooltip="Model for quick tasks like Explore agent">
									<Select
										value={proxyHaikuModel}
										onChange={e => saveTaskModels('proxyHaikuModel', e.target.value)}
										options={modelOptions}
									/>
								</SettingRow>
								<SettingRow title="Sonnet (Standard)" tooltip="Model for standard coding tasks">
									<Select
										value={proxySonnetModel}
										onChange={e => saveTaskModels('proxySonnetModel', e.target.value)}
										options={modelOptions}
									/>
								</SettingRow>
								<SettingRow
									title="Opus (Complex)"
									tooltip="Model for plan mode and complex analysis"
								>
									<Select
										value={proxyOpusModel}
										onChange={e => saveTaskModels('proxyOpusModel', e.target.value)}
										options={modelOptions}
									/>
								</SettingRow>
								<SettingRow title="Subagent" tooltip="Model for subagents (Explore, etc.)" last>
									<Select
										value={proxySubagentModel}
										onChange={e => saveTaskModels('proxySubagentModel', e.target.value)}
										options={modelOptions}
									/>
								</SettingRow>
							</>
						)}
					</SettingsGroup>
				</>
			)}

			{/* CLI Status at the bottom */}
		</div>
	);
};

// Main settings page component
export const SettingsPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<SettingsTab>('main');
	const { setActiveModal } = useUIActions();
	const { provider } = useSettingsStore();
	const navContainerRef = useRef<HTMLDivElement | null>(null);
	const visibleNavRef = useRef<HTMLElement | null>(null);
	const measureNavRef = useRef<HTMLElement | null>(null);
	const [showLabels, setShowLabels] = useState(true);

	useLayoutEffect(() => {
		const container = navContainerRef.current;
		const visibleNav = visibleNavRef.current;
		if (!container || !visibleNav) {
			return;
		}

		const compute = () => {
			const neededNav = measureNavRef.current;
			if (!neededNav) {
				return;
			}

			const needed = neededNav.scrollWidth;
			const available = visibleNav.clientWidth;

			// Use hysteresis to avoid "thrashing" when close to the boundary.
			// - When labels are visible: hide as soon as they don't fit.
			// - When labels are hidden: require extra space before showing again.
			const showBufferPx = 24;

			setShowLabels(prev => {
				if (prev) {
					return available >= needed;
				}
				return available >= needed + showBufferPx;
			});
		};

		compute();

		const ro = new ResizeObserver(() => compute());
		ro.observe(container);
		return () => ro.disconnect();
	}, []);

	const handleClose = () => setActiveModal(null);

	return (
		<div className="fixed inset-0 z-50 text-vscode-editor-foreground font-(family-name:--vscode-font-family) overflow-hidden flex flex-col bg-(--panel-header-bg)">
			{/* Top navigation (moved from left sidebar) */}
			<div className="shrink-0 bg-(--panel-header-bg) px-1 pt-2 pb-1">
				<div ref={navContainerRef} className="relative">
					{/* Hidden measurement nav (always full labels) */}
					<nav
						ref={measureNavRef}
						aria-hidden="true"
						className="absolute left-0 top-0 opacity-0 pointer-events-none -z-10 flex items-center justify-center gap-0.5 pr-7"
					>
						{SETTINGS_NAV_ITEMS.map(item => (
							<NavButton
								key={`measure-${item.id}`}
								item={item}
								icon={NAV_ICONS[item.iconName]}
								isActive={activeTab === item.id}
								showLabel={true}
								onClick={() => {}}
								className="w-auto"
							/>
						))}
					</nav>

					<nav
						ref={visibleNavRef}
						className={cn(
							'flex items-center justify-center gap-(--gap-1-5) pt-1 pr-7',
							!showLabels && 'px-0.5',
						)}
					>
						{SETTINGS_NAV_ITEMS.map(item => (
							<NavButton
								key={item.id}
								item={item}
								icon={NAV_ICONS[item.iconName]}
								isActive={activeTab === item.id}
								showLabel={showLabels}
								onClick={() => setActiveTab(item.id)}
								className={cn('w-auto', !showLabels && 'px-1')}
							/>
						))}
					</nav>

					{/* Close button - fixed to top-right inside header */}
					<div className="absolute right-0 top-1/2 -translate-y-1/2">
						<Tooltip content="Close" position="top" delay={200}>
							<IconButton
								onClick={handleClose}
								icon={<CloseIcon size={14} />}
								size={22}
								className="opacity-70 hover:opacity-100"
							/>
						</Tooltip>
					</div>
				</div>
			</div>

			{/* Main content area - scrollbar will be at the very right edge of the screen */}
			<ScrollContainer className="flex-1 relative" autoHide="never">
				{/* Settings content area */}
				<div className="max-w-(--modal-width-md) mx-auto pb-2 px-3 pt-4">
					{activeTab === 'main' && <MainSettings />}
					{activeTab === 'agents' && <RulesSettingsPanel />}
					{activeTab === 'permissions' && <PermissionsSettings />}
					{activeTab === 'mcp' && <McpSettingsPanel />}
				</div>
			</ScrollContainer>

			{/* CLI Status fixed at the bottom */}
			<div className="shrink-0 pb-2 bg-(--panel-header-bg)">
				<div className="max-w-(--modal-width-md) mx-auto px-3">
					{provider === 'claude' ? <ClaudeCLIStatus /> : <OpenCodeCLIStatus />}
				</div>
			</div>
		</div>
	);
};
