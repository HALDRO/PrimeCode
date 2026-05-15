import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { EditIcon, PlusIcon, TrashIcon } from '../../icons';
import { Button } from '../../ui';
import {
	EmptyState,
	GroupTitle,
	SettingRow,
	SettingRowActions,
	SettingsBadge,
	SettingsGroup,
} from '../SettingsUI';

const inputClass =
	'w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder';

const PLUGIN_SCOPE_LABELS = {
	project: 'Project',
	global: 'Global',
} as const;

export const PluginsTab: React.FC = () => {
	const plugins = useSettingsStore(state => state.resources.plugin);
	const { postMessage } = useVSCode();
	const [isCreating, setIsCreating] = useState(false);
	const [newPlugin, setNewPlugin] = useState('');

	useEffect(() => {
		postMessage({ type: 'getResources', kind: 'plugin' });
	}, [postMessage]);

	const handleCreate = () => {
		const name = newPlugin.trim();
		if (!name) return;
		postMessage({ type: 'mutateResource', kind: 'plugin', action: 'create', name });
		setIsCreating(false);
		setNewPlugin('');
	};

	const handleDelete = (name: string) =>
		postMessage({ type: 'mutateResource', kind: 'plugin', action: 'delete', name });
	const handleOpen = (filePath: string) => postMessage({ type: 'openPluginFile', filePath });
	const handleOpenConfig = (scope: 'project' | 'global') =>
		postMessage({ type: 'openOpenCodeConfig', scope });

	return (
		<>
			<GroupTitle>Plugins</GroupTitle>
			<p className="mx-(--gap-1) -mt-(--gap-1) mb-(--gap-3) text-xs text-vscode-descriptionForeground leading-relaxed">
				OpenCode server plugins are loaded from plugin files or the plugin array in opencode.json.
				There is no general server plugin enabled flag; removing the config entry or file stops
				loading it after OpenCode reload.
			</p>
			<SettingsGroup>
				{!isCreating && (
					<SettingRow title="Add Plugin" tooltip="Add a plugin entry to opencode.json" last>
						<Button size="sm" onClick={() => setIsCreating(true)}>
							<PlusIcon size={12} className="mr-1" />
							Add
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{isCreating && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							Add Plugin
						</h3>
						<div className="flex flex-col gap-1">
							<label htmlFor="plugin-name" className="text-xs text-vscode-descriptionForeground">
								Package or file path
							</label>
							<input
								id="plugin-name"
								type="text"
								value={newPlugin}
								onChange={e => setNewPlugin(e.target.value)}
								placeholder="@scope/opencode-plugin or ./plugins/local.js"
								className={inputClass}
							/>
						</div>
						<div className="flex justify-end gap-2 mt-2">
							<Button size="sm" variant="secondary" onClick={() => setIsCreating(false)}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleCreate} disabled={!newPlugin.trim()}>
								Add
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			<GroupTitle>Installed Plugins</GroupTitle>
			<SettingsGroup>
				{plugins.error && (
					<div className="px-3 py-2 text-xs text-vscode-errorForeground border-b border-(--alpha-10)">
						{plugins.error}
					</div>
				)}
				{plugins.items.length === 0 ? (
					<EmptyState>
						{plugins.isLoading ? 'Loading plugins...' : 'No plugins configured'}
					</EmptyState>
				) : (
					plugins.items.map((plugin, index) => (
						<SettingRow
							key={plugin.id}
							title={plugin.name}
							titleExtra={
								<SettingsBadge>{PLUGIN_SCOPE_LABELS[plugin.locationScope]}</SettingsBadge>
							}
							tooltip={plugin.path || plugin.name}
							last={index === plugins.items.length - 1}
						>
							<SettingRowActions>
								{plugin.path && (
									<Button
										size="xs"
										variant="ghost"
										onClick={() => handleOpen(plugin.path as string)}
									>
										<EditIcon size={12} />
									</Button>
								)}
								{plugin.origin === 'config' && (
									<Button
										size="xs"
										variant="ghost"
										onClick={() => handleOpenConfig(plugin.locationScope)}
									>
										<EditIcon size={12} />
									</Button>
								)}
								{plugin.source === 'config' && (
									<Button size="xs" variant="ghost" onClick={() => handleDelete(plugin.name)}>
										<TrashIcon size={12} />
									</Button>
								)}
							</SettingRowActions>
						</SettingRow>
					))
				)}
			</SettingsGroup>
		</>
	);
};
