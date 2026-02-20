/**
 * @file McpSettingsPanel
 * @description MCP management UI inside Settings > MCP tab.
 *              Shows installed servers with enable/disable, status, delete actions,
 *              and expandable tool details. Edit/Add actions open opencode.json in editor.
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import type { MCPServerConfig } from '../../../common';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { EditIcon, TrashIcon } from '../icons';
import { Button, IconButton, Switch } from '../ui';
import { GroupTitle, SettingRow, SettingsGroup } from './SettingsUI';

export const McpSettingsPanel: React.FC = () => {
	const { postMessage } = useVSCode();
	const { mcpServers, mcpStatus, mcpInstalledMetadata } = useSettingsStore();

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

	const openMcpConfig = () => {
		postMessage({ type: 'openMcpConfig' });
	};

	const deleteServer = (name: string) => postMessage({ type: 'deleteMCPServer', name });

	const toggleEnabled = (name: string, config: MCPServerConfig, enabled: boolean) => {
		postMessage({ type: 'saveMCPServer', name, config: { ...config, enabled } });
	};

	return (
		<div className="animate-fade-in">
			<GroupTitle>MCP</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="MCP Config"
					tooltip="Edit MCP server configuration in opencode.json"
					last
				>
					<Button size="sm" variant="secondary" onClick={openMcpConfig}>
						Edit
					</Button>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup>
				{installedRows.length === 0 ? (
					<div className="px-2.5 py-3 text-sm text-vscode-descriptionForeground text-center">
						No MCP servers configured yet.
						<br />
						<button
							type="button"
							onClick={openMcpConfig}
							className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground underline mt-1"
						>
							Add one in opencode.json
						</button>
					</div>
				) : (
					installedRows.map((r, idx) => {
						const displayName = r.meta?.displayName || r.name;
						const status = r.status?.status;
						const enabled = r.config.enabled !== false;
						const isExpanded = expandedServers.has(r.name);
						const tools = r.status?.tools ?? [];
						const toolsCount = tools.length;
						const isLast = idx === installedRows.length - 1;

						const dotColor = !enabled
							? 'bg-(--alpha-20)'
							: status === 'connected'
								? 'bg-vscode-editorGutter-addedBackground'
								: status === 'failed' || status === 'timeout'
									? 'bg-vscode-errorForeground'
									: status === 'needs_auth'
										? 'bg-vscode-editorGutter-modifiedBackground'
										: 'bg-(--alpha-30)';

						return (
							<div
								key={r.name}
								className={cn(
									'px-2.5 py-2 hover:bg-vscode-list-hoverBackground transition-colors',
									!isLast && 'border-b border-(--border-subtle)',
									!enabled && 'opacity-50',
								)}
							>
								<div className="flex items-center gap-2.5">
									<div
										className={cn(
											'w-6 h-6 rounded-full flex items-center justify-center text-sm font-semibold shrink-0',
											enabled
												? 'bg-(--alpha-10) text-vscode-foreground'
												: 'bg-(--alpha-5) text-vscode-descriptionForeground',
										)}
									>
										{displayName.charAt(0).toUpperCase()}
									</div>

									<div className="flex items-center gap-1.5 flex-1 min-w-0">
										<span
											className={cn(
												'text-sm font-medium truncate',
												enabled ? 'text-vscode-foreground' : 'text-vscode-descriptionForeground',
											)}
										>
											{displayName}
										</span>
										<span
											className={cn('w-1.5 h-1.5 rounded-full shrink-0', dotColor)}
											title={status || 'unknown'}
										/>
										{enabled && toolsCount > 0 && (
											<button
												type="button"
												onClick={() => toggleExpanded(r.name)}
												className={cn(
													'text-xs px-1 py-0.5 rounded border transition-colors',
													isExpanded
														? 'bg-vscode-list-hoverBackground text-vscode-foreground border-vscode-focusBorder'
														: 'bg-transparent text-vscode-descriptionForeground border-vscode-panel-border hover:bg-(--alpha-5) hover:text-vscode-foreground',
												)}
											>
												{toolsCount} tools
											</button>
										)}
									</div>

									<div className="flex items-center gap-1 shrink-0">
										<IconButton
											icon={<EditIcon size={10} />}
											title="Edit in opencode.json"
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

								{enabled && toolsCount > 0 && isExpanded && (
									<div className="mt-1.5 pt-1.5 border-t border-(--border-subtle)">
										<div className="flex flex-wrap gap-1">
											{tools.map(tool => (
												<span
													key={tool.name}
													className="text-xs px-1.5 py-0.5 rounded bg-(--alpha-5) text-vscode-descriptionForeground border border-vscode-panel-border font-mono"
													title={tool.description || tool.name}
												>
													{tool.name}
												</span>
											))}
										</div>
									</div>
								)}

								{r.status?.error && (
									<div className="text-xs text-vscode-errorForeground/70 mt-1 truncate">
										{r.status.error}
									</div>
								)}
							</div>
						);
					})
				)}
			</SettingsGroup>
		</div>
	);
};
