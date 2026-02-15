import type React from 'react';
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { EditIcon, PlusIcon, TrashIcon } from '../../icons';
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
		postMessage({ type: 'getCommands' });
	}, [postMessage]);

	const handleCreate = () => {
		if (!newName || !newContent) {
			return;
		}

		postMessage({
			type: 'createCommand',
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
		postMessage({ type: 'deleteCommand', name });
	};

	const handleOpen = (name: string) => {
		postMessage({ type: 'openCommandFile', name });
	};

	return (
		<>
			{/* Actions Bar */}
			<GroupTitle>Commands</GroupTitle>
			<SettingsGroup>
				{!isCreating && (
					<SettingRow
						title="New Command"
						tooltip="Create a new custom command under .opencode/commands/"
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
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							New Command
						</h3>

						<div className="flex flex-col gap-1">
							<label htmlFor="cmd-name" className="text-xs text-vscode-descriptionForeground">
								Name
							</label>
							<input
								id="cmd-name"
								type="text"
								value={newName}
								onChange={e => setNewName(e.target.value)}
								placeholder="Command name (e.g., commit)"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="cmd-desc" className="text-xs text-vscode-descriptionForeground">
								Description
							</label>
							<input
								id="cmd-desc"
								type="text"
								value={newDescription}
								onChange={e => setNewDescription(e.target.value)}
								placeholder="Description"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="prompt-content" className="text-xs text-vscode-descriptionForeground">
								Prompt Content
							</label>
							<textarea
								id="prompt-content"
								value={newContent}
								onChange={e => setNewContent(e.target.value)}
								className="w-full h-24 px-2 py-1.5 text-xs font-mono bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder resize-y"
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
					<div className="p-4 text-center text-vscode-descriptionForeground text-xs">
						Loading commands...
					</div>
				) : commands.custom.length === 0 ? (
					<EmptyState>No custom commands found. Create one above.</EmptyState>
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
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<SettingsBadge>Custom</SettingsBadge>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleDelete(cmd.name)}
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
