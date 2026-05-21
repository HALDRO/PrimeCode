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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TIMEOUTS } from '../../../common';
import { DEFAULT_POLICIES, PERMISSION_CATEGORIES } from '../../../common/permissions';
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
import { Button, IconButton, ScrollContainer, SegmentedControl, Tooltip } from '../ui';
import { McpSettingsPanel } from './McpSettingsPanel';
import { PromptImproverSettings } from './PromptImproverSettings';
import { AddProviderSection, ProviderManager } from './ProviderManager';
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
				'flex items-center gap-1.5 px-1.5 h-(--btn-height-sm) bg-transparent border-none rounded cursor-pointer transition-all duration-75 text-sm text-vscode-descriptionForeground',
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

	useEffect(() => {
		if (initialLoadDone.current) {
			return;
		}
		initialLoadDone.current = true;

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	const handleRefresh = () => {
		setOpenCodeStatus({ isChecking: true, error: undefined });
		setOpenCodeConfig({ isLoading: true, error: undefined });
		postMessage({ type: 'syncAll' });
		startTimeout();
	};

	const handleOpenDocs = () => {
		postMessage({ type: 'openExternal', url: 'https://opencode.ai/docs' });
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
const OpenCodeProvidersSection: React.FC = () => <ProviderManager />;

// Rules settings tab (consolidated Rules, Skills, Hooks) - OPENCODE-REFAC: Moved to CommandsSettingsPanel.tsx as RulesSettingsPanel

// Permissions settings tab (Unified)

import type { PermissionPolicies } from '../../../common/permissions';

interface PermissionItem {
	key: keyof PermissionPolicies;
	title: string;
	tooltip: string;
}

interface PermissionSection {
	title: string;
	items: PermissionItem[];
}

const PERMISSION_SECTIONS: PermissionSection[] = [
	{
		title: 'File Operations',
		items: [
			{ key: 'read', title: 'Read Files', tooltip: 'Allow AI to read files' },
			{ key: 'edit', title: 'Edit Files', tooltip: 'Allow AI to modify files in workspace' },
			{ key: 'glob', title: 'Glob', tooltip: 'Allow AI to search files by pattern' },
			{ key: 'grep', title: 'Grep', tooltip: 'Allow AI to search file contents' },
			{ key: 'list', title: 'List Directory', tooltip: 'Allow AI to list directory contents' },
		],
	},
	{
		title: 'Shell & Execution',
		items: [
			{ key: 'bash', title: 'Shell Commands', tooltip: 'Allow AI to execute shell commands' },
			{ key: 'task', title: 'Sub-agents', tooltip: 'Allow AI to run sub-agents' },
			{ key: 'skill', title: 'Skills', tooltip: 'Allow AI to load skills' },
		],
	},
	{
		title: 'LSP & Todo',
		items: [
			{ key: 'lsp', title: 'LSP Requests', tooltip: 'Allow AI to execute LSP requests' },
			{ key: 'todoread', title: 'Read Todo', tooltip: 'Allow AI to read the todo list' },
			{ key: 'todowrite', title: 'Write Todo', tooltip: 'Allow AI to update the todo list' },
		],
	},
	{
		title: 'Network',
		items: [
			{ key: 'webfetch', title: 'Fetch URL', tooltip: 'Allow AI to fetch URLs' },
			{ key: 'websearch', title: 'Web Search', tooltip: 'Allow AI to perform web searches' },
			{ key: 'codesearch', title: 'Code Search', tooltip: 'Allow AI to perform code searches' },
		],
	},
	{
		title: 'Safety',
		items: [
			{
				key: 'external_directory',
				title: 'External Directory',
				tooltip: 'Allow AI to access paths outside the project',
			},
			{
				key: 'doom_loop',
				title: 'Doom Loop Protection',
				tooltip: 'Allow AI to repeat identical tool calls',
			},
		],
	},
];

const PermissionsSettings: React.FC = () => {
	const { postMessage } = useVSCode();
	const { discoveryStatus, policies } = useSettingsStore();
	const { permissions } = discoveryStatus;

	const handlePolicyChange = (key: keyof PermissionPolicies, value: 'ask' | 'allow' | 'deny') => {
		postMessage({ type: 'setPermissionPolicy', category: key, policy: value });
	};

	const handlePreset = (preset: 'ask' | 'allow') => {
		for (const category of PERMISSION_CATEGORIES) {
			postMessage({ type: 'setPermissionPolicy', category, policy: preset });
		}
	};

	const handleDefaults = () => {
		for (const category of PERMISSION_CATEGORIES) {
			postMessage({
				type: 'setPermissionPolicy',
				category,
				policy: DEFAULT_POLICIES[category],
			});
		}
	};

	const policyOptions = [
		{ value: 'allow', label: 'Allow', title: 'Allow this tool in the project' },
		{ value: 'ask', label: 'Ask', title: 'Ask before using this tool in the project' },
		{ value: 'deny', label: 'Deny', title: 'Deny this tool in the project' },
	];

	return (
		<div className="animate-fade-in">
			{PERMISSION_SECTIONS.map(section => (
				<React.Fragment key={section.title}>
					<GroupTitle>{section.title}</GroupTitle>
					<SettingsGroup>
						{section.items.map((item, idx) => (
							<SettingRow
								key={item.key}
								title={item.title}
								tooltip={item.tooltip}
								last={idx === section.items.length - 1}
							>
								<SegmentedControl
									ariaLabel={`${item.title} policy`}
									value={policies[item.key]}
									options={policyOptions}
									onChange={value =>
										handlePolicyChange(item.key, value as 'ask' | 'allow' | 'deny')
									}
								/>
							</SettingRow>
						))}
					</SettingsGroup>
				</React.Fragment>
			))}

			<SettingsGroup>
				<SettingRow title="Quick Presets" tooltip="Apply preset to all policies" last>
					<div className="flex items-center gap-1.5">
						<Button size="xs" variant="secondary" onClick={handleDefaults}>
							Defaults
						</Button>
						<Button size="xs" variant="secondary" onClick={() => handlePreset('ask')}>
							Ask All
						</Button>
						<Button size="xs" variant="secondary" onClick={() => handlePreset('allow')}>
							Allow All
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>

			<div className="p-3 bg-(--alpha-5) border border-(--alpha-10) rounded text-sm text-vscode-descriptionForeground mt-4 mb-4">
				These settings are persisted per workspace and synced to the OpenCode server at runtime.
			</div>

			<GroupTitle>Configuration Files</GroupTitle>
			<SettingsGroup>
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
							onClick={() => postMessage({ type: 'openOpenCodeConfig', scope: 'project' })}
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

const POPULAR_PROVIDER_IDS = new Set([
	'opencode',
	'anthropic',
	'github-copilot',
	'openai',
	'google',
	'openrouter',
	'vercel',
]);

// Main settings tab
const MainSettings: React.FC = () => {
	useMainSettings();
	const { opencodeProviders, availableProviders, providerAuthState } = useSettingsStore();
	const { postMessage } = useVSCode();
	const [selectedNewProvider, setSelectedNewProvider] = useState('');
	const [apiKeyInput, setApiKeyInput] = useState('');

	const availableForConnection = useMemo(
		() =>
			availableProviders
				.filter(ap => !opencodeProviders.some(cp => cp.id === ap.id))
				.filter(ap => !POPULAR_PROVIDER_IDS.has(ap.id))
				.sort((a, b) => a.name.localeCompare(b.name)),
		[availableProviders, opencodeProviders],
	);

	const handleConnectProvider = (providerId: string) => {
		if (!apiKeyInput.trim()) return;
		postMessage({
			type: 'setOpenCodeProviderAuth',
			providerId,
			apiKey: apiKeyInput.trim(),
		});
	};

	useEffect(() => {
		if (providerAuthState?.success && !providerAuthState.isLoading) {
			setSelectedNewProvider('');
			setApiKeyInput('');
		}
	}, [providerAuthState]);

	return (
		<div className="animate-fade-in">
			<GroupTitle>Main</GroupTitle>
			<SettingsGroup>
				<AddProviderSection
					availableForConnection={availableForConnection}
					selectedNewProvider={selectedNewProvider}
					setSelectedNewProvider={setSelectedNewProvider}
					apiKeyInput={apiKeyInput}
					setApiKeyInput={setApiKeyInput}
					providerAuthState={providerAuthState}
					onConnect={handleConnectProvider}
					last
				/>
			</SettingsGroup>

			{/* Provider Manager */}
			<OpenCodeProvidersSection />

			<PromptImproverSettings />

			{/* CLI Status at the bottom */}
		</div>
	);
};

// Main settings page component
export const SettingsPage: React.FC = () => {
	const [activeTab, setActiveTab] = useState<SettingsTab>('main');
	const { setActiveModal } = useUIActions();
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
		<div
			className="fixed inset-0 z-50 text-vscode-editor-foreground font-(family-name:--vscode-font-family) overflow-hidden flex flex-col"
			style={{ backgroundColor: 'var(--surface-base)' }}
		>
			{/* Top navigation (moved from left sidebar) */}
			<div className="shrink-0 px-1 pt-2 pb-1" style={{ backgroundColor: 'var(--surface-base)' }}>
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
			<div className="shrink-0 pb-2" style={{ backgroundColor: 'var(--surface-base)' }}>
				<div className="max-w-(--modal-width-md) mx-auto px-3">
					<OpenCodeCLIStatus />
				</div>
			</div>
		</div>
	);
};
