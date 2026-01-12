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
	SettingsBadge,
	SettingsGroup,
} from '../SettingsUI';

export const CommandsTab: React.FC = () => {
	const { commands } = useSettingsStore();
	const { postMessage } = useVSCode();

	// Create command form state
	const [isCreating, setIsCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [newDescription, setNewDescription] = useState('');
	const [newContent, setNewContent] = useState('');

	// Initial load
	useEffect(() => {
		postMessage('getCommands');
	}, [postMessage]);

	const handleCreate = () => {
		if (!newName || !newContent) {
			return;
		}

		postMessage('createCommand', {
			name: newName,
			description: newDescription,
			content: newContent,
		});

		setIsCreating(false);
		setNewName('');
		setNewDescription('');
		setNewContent('');
	};

	const handleDelete = (name: string) => {
		postMessage('deleteCommand', { name });
	};

	const handleOpen = (name: string) => {
		postMessage('openCommandFile', { name });
	};

	return (
		<>
			{/* Actions Bar */}
			<GroupTitle>Import & Sync</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="Import from CLI"
					tooltip="Import existing commands from .claude/commands/, .opencode/command/ or .cursor/commands/"
				>
					<Button
						size="sm"
						variant="secondary"
						title="Import from .claude/.opencode/.cursor into .agents"
						onClick={() => {
							useSettingsStore.getState().actions.setAgentsOps({
								lastAction: 'import',
								status: 'working',
								message: 'Importing commands from CLI...',
							});
							postMessage('importCommandsFromClaude');
						}}
					>
						<DownloadIcon size={12} className="mr-1" />
						Import
					</Button>
				</SettingRow>

				<SettingRow
					title="Sync to CLI"
					tooltip="Export commands to .claude/commands/, .opencode/command/ and .cursor/commands/"
					last={isCreating}
				>
					<Button
						size="sm"
						variant="secondary"
						title="Export from .agents to .claude/.opencode/.cursor"
						onClick={() => {
							useSettingsStore.getState().actions.setAgentsOps({
								lastAction: 'sync',
								status: 'working',
								message: 'Syncing commands to CLI...',
							});
							postMessage('syncCommandsToCLI');
						}}
					>
						<RefreshIcon size={12} className="mr-1" />
						Sync
					</Button>
				</SettingRow>

				{!isCreating && (
					<SettingRow
						title="New Command"
						tooltip="Create a new custom command under .agents/commands/"
						last
					>
						<Button size="sm" onClick={() => setIsCreating(true)}>
							<PlusIcon size={12} className="mr-1" />
							New
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{/* Create New Command Form */}
			{isCreating && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-black/20 rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-white/50">
							New Command
						</h3>

						<div className="flex flex-col gap-1">
							<label htmlFor="cmd-name" className="text-xs text-white/50">
								Name
							</label>
							<input
								id="cmd-name"
								type="text"
								value={newName}
								onChange={e => setNewName(e.target.value)}
								placeholder="Command name (e.g., commit)"
								className="w-full px-2 py-1.5 text-xs bg-white/5 border border-white/10 rounded text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="cmd-desc" className="text-xs text-white/50">
								Description
							</label>
							<input
								id="cmd-desc"
								type="text"
								value={newDescription}
								onChange={e => setNewDescription(e.target.value)}
								placeholder="Description"
								className="w-full px-2 py-1.5 text-xs bg-white/5 border border-white/10 rounded text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="prompt-content" className="text-xs text-white/50">
								Prompt Content
							</label>
							<textarea
								id="prompt-content"
								value={newContent}
								onChange={e => setNewContent(e.target.value)}
								className="w-full h-24 px-2 py-1.5 text-xs font-mono bg-white/5 border border-white/10 rounded text-white/90 placeholder:text-white/30 focus:outline-none focus:border-white/30 resize-y"
								placeholder="Enter prompt content here..."
							/>
						</div>

						<div className="flex justify-end gap-2 mt-2">
							<Button size="sm" variant="secondary" onClick={() => setIsCreating(false)}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleCreate} disabled={!newName || !newContent}>
								Create
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			{/* Custom Commands List */}
			<SettingsGroup>
				{commands.isLoading ? (
					<div className="p-4 text-center text-white/50 text-xs">Loading commands...</div>
				) : commands.custom.length === 0 ? (
					<EmptyState>No custom commands found. Create one or import from CLI.</EmptyState>
				) : (
					commands.custom.map((cmd, idx) => (
						<SettingRow
							key={cmd.name}
							title={`/${cmd.name}`}
							tooltip={cmd.description}
							last={idx === commands.custom.length - 1}
						>
							<SettingRowActions>
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleOpen(cmd.name)}
										className="p-1 rounded hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<SettingsBadge>Custom</SettingsBadge>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleDelete(cmd.name)}
										className="p-1 rounded hover:bg-red-500/20 text-white/50 hover:text-red-400 transition-colors"
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
