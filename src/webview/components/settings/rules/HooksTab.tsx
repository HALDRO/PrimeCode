import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { DownloadIcon, EditIcon, PlusIcon, RefreshIcon, TrashIcon } from '../../icons';
import { Button, Tooltip } from '../../ui';
import {
	EmptyState,
	GroupTitle,
	SettingRow,
	SettingRowActions,
	SettingsGroup,
} from '../SettingsUI';

export const HooksTab: React.FC = () => {
	const { hooks } = useSettingsStore();
	const { postMessage } = useVSCode();

	// Hooks State
	const [isCreatingHook, setIsCreatingHook] = useState(false);
	const [newHookName, setNewHookName] = useState('');
	const [newHookPattern, setNewHookPattern] = useState('');
	const [newHookContent, setNewHookContent] = useState('');
	const [newHookEvent, setNewHookEvent] = useState('bash');

	useEffect(() => {
		postMessage('getHooks');
	}, [postMessage]);

	const handleCreateHook = () => {
		if (!newHookName) {
			return;
		}

		postMessage('createHook', {
			name: newHookName,
			enabled: true,
			event: newHookEvent,
			pattern: newHookPattern,
			action: 'warn',
			content: newHookContent || `⚠️ Rule: ${newHookName}\n\nExplain why this is important.`,
		});

		setIsCreatingHook(false);
		setNewHookName('');
		setNewHookPattern('');
		setNewHookContent('');
		setNewHookEvent('bash');
	};

	const handleDeleteHook = (name: string) => postMessage('deleteHook', { name });
	const handleOpenHook = (name: string) => postMessage('openHookFile', { name });
	const handleImportHooks = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'import',
			status: 'working',
			message: 'Importing hooks from Claude...',
		});
		postMessage('importHooksFromClaude');
	};
	const handleSyncHooks = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'sync',
			status: 'working',
			message: 'Syncing hooks to Claude...',
		});
		postMessage('syncHooksToClaude');
	};

	return (
		<>
			<GroupTitle>Import & Sync</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="Import from CLI"
					tooltip="Import hookify rules from .claude/ into .agents/hooks/"
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleImportHooks}
						title="Import hookify.*.local.md from .claude"
					>
						<DownloadIcon size={12} className="mr-1" />
						Import
					</Button>
				</SettingRow>
				<SettingRow
					title="Sync to CLI"
					tooltip="Export hookify rules from .agents/hooks/ to .claude/"
					last={isCreatingHook}
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleSyncHooks}
						title="Export hooks to .claude"
					>
						<RefreshIcon size={12} className="mr-1" />
						Sync
					</Button>
				</SettingRow>
				{!isCreatingHook && (
					<SettingRow
						title="New Hook"
						tooltip="Create a new hookify rule under .agents/hooks/"
						last
					>
						<Button size="sm" onClick={() => setIsCreatingHook(true)}>
							<PlusIcon size={12} className="mr-1" />
							New
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{isCreatingHook && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							New Hook
						</h3>

						<div className="flex flex-col gap-1">
							<label htmlFor="hook-name" className="text-xs text-vscode-descriptionForeground">
								Name
							</label>
							<input
								id="hook-name"
								type="text"
								value={newHookName}
								onChange={e => setNewHookName(e.target.value)}
								placeholder="my-hook-rule"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="grid grid-cols-2 gap-2">
							<div className="flex flex-col gap-1">
								<label htmlFor="hook-event" className="text-xs text-vscode-descriptionForeground">
									Event
								</label>
								<select
									id="hook-event"
									value={newHookEvent}
									onChange={e => setNewHookEvent(e.target.value)}
									className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground focus:outline-none focus:border-vscode-focusBorder"
								>
									<option value="bash">bash</option>
									<option value="code_edit">code_edit</option>
									<option value="all">all</option>
								</select>
							</div>
							<div className="flex flex-col gap-1">
								<label htmlFor="hook-pattern" className="text-xs text-vscode-descriptionForeground">
									Pattern (Regex)
								</label>
								<input
									id="hook-pattern"
									type="text"
									value={newHookPattern}
									onChange={e => setNewHookPattern(e.target.value)}
									placeholder="rm -rf .*"
									className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
								/>
							</div>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="hook-content" className="text-xs text-vscode-descriptionForeground">
								Message / Warning
							</label>
							<textarea
								id="hook-content"
								value={newHookContent}
								onChange={e => setNewHookContent(e.target.value)}
								className="w-full h-20 px-2 py-1.5 text-xs font-mono bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder resize-y"
								placeholder="Warning text to show the user..."
							/>
						</div>

						<div className="flex justify-end gap-2 mt-2">
							<Button size="sm" variant="secondary" onClick={() => setIsCreatingHook(false)}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleCreateHook} disabled={!newHookName}>
								Create
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			<SettingsGroup>
				{hooks.isLoading ? (
					<div className="p-4 text-center text-vscode-descriptionForeground text-xs">
						Loading hooks...
					</div>
				) : hooks.items.length === 0 ? (
					<EmptyState>No hook rules found. Create one or import from Claude.</EmptyState>
				) : (
					hooks.items.map((hook, i) => (
						<SettingRow
							key={hook.path}
							title={hook.name}
							tooltip={hook.path}
							last={i === hooks.items.length - 1}
						>
							<SettingRowActions>
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleOpenHook(hook.name)}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleDeleteHook(hook.name)}
										className="p-1 rounded hover:bg-vscode-errorForeground/20 text-vscode-descriptionForeground hover:text-vscode-errorForeground transition-colors"
									>
										<TrashIcon size={12} />
									</button>
								</Tooltip>
							</SettingRowActions>
						</SettingRow>
					))
				)}
			</SettingsGroup>
		</>
	);
};
