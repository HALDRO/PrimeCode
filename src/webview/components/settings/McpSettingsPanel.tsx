/**
 * @file McpSettingsPanel
 * @description MCP management UI inside Settings > MCP tab.
 *              Provides inner tabs (Installed / Marketplace), showing installed servers with
 *              enable/disable, status, delete actions, command display, and expandable details.
 *              Edit/Add actions open .agents/mcp.json in editor for direct editing.
 *              Uses Cline API for marketplace — installation is AI-assisted via README.
 *              Includes useIsMounted hook to prevent memory leaks during async operations.
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import type { MCPServerConfig, McpMarketplaceItem } from '../../../types';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { EditIcon, RefreshIcon, TrashIcon } from '../icons';
import { Button, IconButton, Switch, TextInput } from '../ui';
import { GroupTitle, SettingRow, SettingsBadge, SettingsGroup } from './SettingsUI';

const MCP_TABS = [
	{ id: 'installed', label: 'Installed' },
	{ id: 'marketplace', label: 'Marketplace' },
] as const;

type McpTab = (typeof MCP_TABS)[number]['id'];

export const McpSettingsPanel: React.FC = () => {
	const { postMessage } = useVSCode();
	const { provider, mcpServers, mcpStatus, mcpInstalledMetadata, mcpMarketplace } =
		useSettingsStore();
	const isMounted = useIsMounted();

	const [activeTab, setActiveTab] = useState<McpTab>('installed');
	const [search, setSearch] = useState('');
	const [installing, setInstalling] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<'name' | 'stars' | 'downloads'>('name');
	const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

	const toggleExpanded = (name: string) => {
		setExpandedServers(prev => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	const installedRows = useMemo(() => {
		const names = Object.keys(mcpServers).sort((a, b) => a.localeCompare(b));
		return names.map(name => {
			const config = mcpServers[name] as MCPServerConfig;
			const meta = mcpInstalledMetadata[name];
			const status = mcpStatus[name];
			return { name, config, meta, status };
		});
	}, [mcpServers, mcpInstalledMetadata, mcpStatus]);

	const marketplaceItems = useMemo(() => {
		const items = mcpMarketplace.catalog?.items ?? [];
		const q = search.trim().toLowerCase();
		const filtered = items
			.filter(i => {
				if (!q) {
					return true;
				}
				// Search only by name
				return i.name.toLowerCase().includes(q);
			})
			.slice();

		// Stable sort: primary by selected option, secondary by name for consistency
		filtered.sort((a, b) => {
			if (sortBy === 'stars') {
				const diff = (b.githubStars ?? 0) - (a.githubStars ?? 0);
				if (diff !== 0) {
					return diff;
				}
			} else if (sortBy === 'downloads') {
				const diff = (b.downloadCount ?? 0) - (a.downloadCount ?? 0);
				if (diff !== 0) {
					return diff;
				}
			}
			// Fallback to name for stable ordering
			return a.name.localeCompare(b.name);
		});

		return filtered;
	}, [mcpMarketplace.catalog, search, sortBy]);

	// Open .agents/mcp.json in editor
	const openMcpConfig = () => {
		postMessage('openAgentsMcpConfig');
	};

	const deleteServer = (name: string) => postMessage('deleteMCPServer', { name });

	const toggleEnabled = (name: string, config: MCPServerConfig, enabled: boolean) => {
		postMessage('saveMCPServer', { name, config: { ...config, enabled } });
	};

	const installMcp = (item: McpMarketplaceItem) => {
		setInstalling(item.mcpId);
		postMessage('installMcpFromMarketplace', { mcpId: item.mcpId });
		// Installing state will be cleared by message handler, but safeguard with timeout
		setTimeout(() => {
			if (isMounted()) {
				setInstalling(null);
			}
		}, 8000);
	};

	const refreshMarketplace = () => {
		postMessage('fetchMcpMarketplaceCatalog', { forceRefresh: true });
	};
	return (
		<div className="animate-fade-in">
			<GroupTitle>MCP</GroupTitle>
			<SettingsGroup>
				{/* Import from CLI sources */}
				<SettingRow
					title="Import from CLI"
					tooltip="Import MCP configs from .cursor/mcp.json, .mcp.json, opencode.json into .agents/mcp.json"
				>
					<div className="flex items-center gap-2">
						<Button
							size="sm"
							variant="secondary"
							title="Import and reload MCP configs from all CLI sources"
							onClick={() => postMessage('importMcpFromCLI')}
						>
							Import
						</Button>
						<Button size="sm" variant="secondary" onClick={openMcpConfig}>
							Edit
						</Button>
					</div>
				</SettingRow>

				{/* Sync to CLI targets */}
				<SettingRow
					title="Sync to CLI"
					tooltip="Export .agents/mcp.json to CLI-specific config files"
					last
				>
					<div className="flex items-center gap-1.5">
						<Button
							size="sm"
							variant="secondary"
							onClick={() => postMessage('syncAgentsToClaudeProject')}
						>
							Claude
						</Button>
						<Button
							size="sm"
							variant="secondary"
							onClick={() => postMessage('syncAgentsToOpenCodeProject')}
						>
							OpenCode
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>

			<div className="flex items-center justify-center gap-1.5 px-1 py-1">
				{MCP_TABS.map(t => (
					<button
						key={t.id}
						type="button"
						onClick={() => setActiveTab(t.id)}
						className={cn(
							'px-2 h-(--btn-height-sm) text-sm rounded-md border border-white/10 transition-all',
							activeTab === t.id
								? 'bg-white/10 text-white/90 border-white/20'
								: 'bg-transparent text-white/60 hover:bg-white/5 hover:text-white/85',
						)}
					>
						{t.label}
					</button>
				))}
			</div>

			{activeTab === 'installed' && (
				<SettingsGroup>
					{installedRows.length === 0 ? (
						<div className="px-2.5 py-3 text-sm text-white/50 text-center">
							No MCP servers configured yet.
							<br />
							<button
								type="button"
								onClick={openMcpConfig}
								className="text-blue-400 hover:text-blue-300 underline mt-1"
							>
								Add one in .agents/mcp.json
							</button>
						</div>
					) : (
						installedRows.map((r, idx) => {
							const displayName = r.meta?.displayName || r.name;
							const status = r.status?.status;
							const canAuth = provider === 'opencode' && status === 'needs_auth';
							const enabled = r.config.enabled !== false;
							const isExpanded = expandedServers.has(r.name);
							const tools = r.status?.tools ?? [];
							const toolsCount = tools.length;
							const isLast = idx === installedRows.length - 1;

							// Status dot color
							const dotColor = !enabled
								? 'bg-white/20'
								: status === 'connected'
									? 'bg-green-500'
									: status === 'failed' || status === 'timeout'
										? 'bg-red-500'
										: status === 'needs_auth'
											? 'bg-yellow-500'
											: 'bg-white/30';

							return (
								<div
									key={r.name}
									className={cn(
										'px-2.5 py-2 hover:bg-white/3 transition-colors',
										!isLast && 'border-b border-white/6',
										!enabled && 'opacity-50',
									)}
								>
									{/* Main row */}
									<div className="flex items-center gap-2.5">
										{/* Circle avatar */}
										<div
											className={cn(
												'w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold shrink-0',
												enabled ? 'bg-white/8 text-white/70' : 'bg-white/5 text-white/40',
											)}
										>
											{displayName.charAt(0).toUpperCase()}
										</div>

										{/* Name + status dot + tools button */}
										<div className="flex items-center gap-1.5 flex-1 min-w-0">
											<span
												className={cn(
													'text-sm font-medium truncate',
													enabled ? 'text-white/90' : 'text-white/50',
												)}
											>
												{displayName}
											</span>
											{/* Status dot */}
											<span
												className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColor)}
												title={status || 'unknown'}
											/>
											{/* Tools button */}
											{enabled && toolsCount > 0 && (
												<button
													type="button"
													onClick={() => toggleExpanded(r.name)}
													className={cn(
														'text-2xs px-1 py-0.5 rounded border transition-colors',
														isExpanded
															? 'bg-white/10 text-white/70 border-white/20'
															: 'bg-transparent text-white/40 border-white/10 hover:bg-white/5 hover:text-white/60',
													)}
												>
													{toolsCount} tools
												</button>
											)}
										</div>

										{/* Actions */}
										<div className="flex items-center gap-1 shrink-0">
											{canAuth && (
												<Button
													size="sm"
													variant="secondary"
													onClick={() => postMessage('startOpenCodeMcpAuth', { name: r.name })}
												>
													Auth
												</Button>
											)}
											<IconButton
												icon={<EditIcon size={10} />}
												title="Edit in .agents/mcp.json"
												onClick={openMcpConfig}
											/>
											<IconButton
												icon={<TrashIcon size={10} />}
												title="Delete"
												danger
												onClick={() => deleteServer(r.name)}
											/>
											<Switch
												checked={enabled}
												onChange={val => toggleEnabled(r.name, r.config, val)}
											/>
										</div>
									</div>

									{/* Tools list (expandable) */}
									{enabled && toolsCount > 0 && isExpanded && (
										<div className="mt-1.5 pt-1.5 border-t border-white/5">
											<div className="flex flex-wrap gap-1">
												{tools.map(tool => (
													<span
														key={tool.name}
														className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-white/55 border border-white/8 font-mono"
														title={tool.description || tool.name}
													>
														{tool.name}
													</span>
												))}
											</div>
										</div>
									)}

									{/* Error message */}
									{r.status?.error && (
										<div className="text-2xs text-red-400/70 mt-1 truncate">{r.status.error}</div>
									)}
								</div>
							);
						})
					)}
				</SettingsGroup>
			)}

			{activeTab === 'marketplace' && (
				<>
					{mcpMarketplace.error && (
						<div className="p-2 mx-1 mb-2 bg-red-500/10 border border-red-500/20 rounded text-sm text-red-300">
							{mcpMarketplace.error}
						</div>
					)}

					<SettingsGroup>
						{/* Search and sort controls */}
						<div className="flex items-center gap-1 px-2.5 py-2 border-b border-white/6">
							<TextInput
								value={search}
								onChange={e => setSearch(e.target.value)}
								placeholder="Search..."
								className="w-full h-7"
							/>
							<button
								type="button"
								onClick={() => setSortBy('stars')}
								title="Sort by Stars"
								className={cn(
									'h-7 px-2 text-sm rounded border transition-colors shrink-0',
									sortBy === 'stars'
										? 'bg-white/10 text-white/90 border-white/20'
										: 'bg-transparent text-white/50 border-white/10 hover:bg-white/5 hover:text-white/70',
								)}
							>
								★
							</button>
							<button
								type="button"
								onClick={() => setSortBy('downloads')}
								title="Sort by Downloads"
								className={cn(
									'h-7 px-2 text-sm rounded border transition-colors shrink-0',
									sortBy === 'downloads'
										? 'bg-white/10 text-white/90 border-white/20'
										: 'bg-transparent text-white/50 border-white/10 hover:bg-white/5 hover:text-white/70',
								)}
							>
								↓
							</button>
							<IconButton
								icon={<RefreshIcon size={12} />}
								title="Refresh"
								onClick={refreshMarketplace}
							/>
						</div>

						{/* Items list */}
						{marketplaceItems.length === 0 ? (
							<div className="px-2.5 py-3 text-sm text-white/50 text-center">
								{search
									? 'No MCP servers found matching your search.'
									: 'No MCP servers available.'}
							</div>
						) : (
							marketplaceItems.map((item, idx) => {
								const stars = item.githubStars ?? 0;
								const downloads = item.downloadCount ?? 0;
								const isInstalled = !!mcpServers[item.mcpId];
								const isLast = idx === marketplaceItems.length - 1;

								return (
									<div
										key={item.mcpId}
										className={cn(
											'px-2.5 py-2 hover:bg-white/3 transition-colors',
											!isLast && 'border-b border-white/6',
										)}
									>
										{/* Main row */}
										<div className="flex items-center gap-2.5">
											{/* Circle avatar */}
											<div
												className={cn(
													'w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold shrink-0',
													isInstalled
														? 'bg-green-500/20 text-green-400'
														: 'bg-white/8 text-white/70',
												)}
											>
												{item.name.charAt(0).toUpperCase()}
											</div>

											{/* Name + stats */}
											<div className="flex items-center gap-1.5 flex-1 min-w-0">
												<span className="text-sm font-medium text-white/90 truncate">
													{item.name}
												</span>
												{/* Stats badges */}
												{(stars > 0 || downloads > 0) && (
													<div className="flex items-center gap-1.5 shrink-0">
														{stars > 0 && (
															<span
																className="text-2xs px-1 py-0.5 rounded bg-transparent text-white/40 border border-white/10"
																title="GitHub Stars"
															>
																★ {stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : stars}
															</span>
														)}
														{downloads > 0 && (
															<span
																className="text-2xs px-1 py-0.5 rounded bg-transparent text-white/40 border border-white/10"
																title="Downloads"
															>
																↓{' '}
																{downloads >= 1000
																	? `${(downloads / 1000).toFixed(1)}k`
																	: downloads}
															</span>
														)}
													</div>
												)}
											</div>

											{/* Actions */}
											<div className="flex items-center gap-1 shrink-0">
												{isInstalled ? (
													<SettingsBadge variant="green">Installed</SettingsBadge>
												) : (
													<Button
														size="sm"
														variant="secondary"
														disabled={installing === item.mcpId}
														onClick={() => installMcp(item)}
													>
														{installing === item.mcpId ? 'Loading...' : 'Install'}
													</Button>
												)}
											</div>
										</div>

										{/* Description */}
										{item.description && (
											<div className="text-xs text-white/50 mt-1 ml-(--gap-7) line-clamp-2">
												{item.description}
											</div>
										)}

										{/* Tags */}
										{(item.tags || []).length > 0 && (
											<div className="flex flex-wrap gap-1 mt-1.5 ml-(--gap-7)">
												{(item.tags || []).slice(0, 5).map(t => (
													<span
														key={t}
														className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-white/55 border border-white/8 font-mono"
													>
														{t}
													</span>
												))}
											</div>
										)}
									</div>
								);
							})
						)}
					</SettingsGroup>
				</>
			)}
		</div>
	);
};
