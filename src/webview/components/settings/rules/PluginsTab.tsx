import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { PlusIcon, TrashIcon } from '../../icons';
import { Button } from '../../ui';
import { GroupTitle, SettingRow, SettingRowActions, SettingsGroup } from '../SettingsUI';

export const PluginsTab: React.FC = () => {
	const { plugins } = useSettingsStore();
	const { postMessage } = useVSCode();

	const [isCreating, setIsCreating] = useState(false);
	const [newPlugin, setNewPlugin] = useState('');

	useEffect(() => {
		postMessage({ type: 'getPlugins' });
	}, [postMessage]);

	const handleCreate = () => {
		if (!newPlugin.trim()) return;

		postMessage({
			type: 'addPlugin',
			plugin: newPlugin.trim(),
		});

		setIsCreating(false);
		setNewPlugin('');
	};

	const handleDelete = (plugin: string) => {
		postMessage({ type: 'removePlugin', plugin });
	};

	return (
		<>
			<GroupTitle>Plugins</GroupTitle>
			<SettingsGroup>
				{!isCreating && (
					<SettingRow
						title="Add Plugin"
						tooltip="Add a plugin to opencode.json (npm package or file:// URL)"
						last
					>
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
							<label htmlFor="plugin-spec" className="text-xs text-vscode-descriptionForeground">
								Plugin Specifier
							</label>
							<input
								id="plugin-spec"
								type="text"
								value={newPlugin}
								onChange={e => setNewPlugin(e.target.value)}
								onKeyDown={e => {
									if (e.key === 'Enter' && newPlugin.trim()) {
										handleCreate();
									}
									if (e.key === 'Escape') {
										setIsCreating(false);
										setNewPlugin('');
									}
								}}
								placeholder="npm-package@1.0.0 or file:///path/to/plugin.js"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
							<p className="text-xs text-vscode-descriptionForeground mt-1">
								Examples: <code className="bg-(--alpha-10) px-1 rounded">oh-my-opencode</code>,{' '}
								<code className="bg-(--alpha-10) px-1 rounded">@scope/plugin@2.0.0</code>,{' '}
								<code className="bg-(--alpha-10) px-1 rounded">
									file:///C:/plugins/my-plugin.js
								</code>
							</p>
						</div>

						<div className="flex gap-2">
							<Button size="sm" onClick={handleCreate} disabled={!newPlugin.trim()}>
								Add
							</Button>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => {
									setIsCreating(false);
									setNewPlugin('');
								}}
							>
								Cancel
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			<SettingsGroup>
				{plugins.isLoading ? (
					<div className="px-2.5 py-3 text-sm text-vscode-descriptionForeground text-center">
						Loading plugins...
					</div>
				) : plugins.error ? (
					<div className="px-2.5 py-3 text-sm text-vscode-errorForeground text-center">
						{plugins.error}
					</div>
				) : plugins.items.length === 0 ? (
					<div className="px-2.5 py-3 text-sm text-vscode-descriptionForeground text-center">
						No plugins configured. Plugins are JavaScript/TypeScript modules loaded by OpenCode CLI.
					</div>
				) : (
					plugins.items.map((plugin, idx) => (
						<SettingRow
							key={plugin}
							title={plugin}
							tooltip="Plugin loaded by OpenCode CLI"
							last={idx === plugins.items.length - 1}
						>
							<SettingRowActions>
								<Button
									size="sm"
									variant="danger"
									onClick={() => handleDelete(plugin)}
									title="Remove plugin"
								>
									<TrashIcon size={10} />
								</Button>
							</SettingRowActions>
						</SettingRow>
					))
				)}
			</SettingsGroup>
		</>
	);
};
