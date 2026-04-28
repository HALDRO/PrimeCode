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

const COMMAND_SCOPE_LABELS = {
	project: 'Project',
	global: 'Global',
} as const;

export const CommandsTab: React.FC = () => {
	const commands = useSettingsStore(state => state.resources.command);
	const { postMessage } = useVSCode();

	// Create command form state
	const [isCreating, setIsCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [newDescription, setNewDescription] = useState('');
	const [newContent, setNewContent] = useState('');

	useEffect(() => {
		postMessage({ type: 'getResources', kind: 'command' });
	}, [postMessage]);

	const handleCreate = () => {
		if (!newName || !newContent) {
			return;
		}

		postMessage({
			type: 'mutateResource',
			kind: 'command',
			action: 'create',
			name: newName,
			payload: {
				description: newDescription,
				content: newContent,
			},
		});

		setIsCreating(false);
		setNewName('');
		setNewDescription('');
		setNewContent('');
	};

	const handleDelete = (name: string) =>
		postMessage({ type: 'mutateResource', kind: 'command', action: 'delete', name });
	const handleOpen = (filePath: string) => postMessage({ type: 'openCommandFile', filePath });

	return (
		<>
			{/* Actions Bar */}
			<GroupTitle>Commands</GroupTitle>
			<p className="mx-(--gap-1) -mt-(--gap-1) mb-(--gap-3) text-xs text-vscode-descriptionForeground leading-relaxed">
				Commands are OpenCode command files or config entries. OpenCode does not expose an enabled
				flag for command files, so this tab supports create, edit and delete for project commands.
			</p>
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
								className={inputClass}
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
								className={inputClass}
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
								className={`${inputClass} h-24 font-mono resize-y`}
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

			<GroupTitle>Installed Commands</GroupTitle>
			<SettingsGroup>
				{commands.error && (
					<div className="px-3 py-2 text-xs text-vscode-errorForeground border-b border-(--alpha-10)">
						{commands.error}
					</div>
				)}
				{commands.items.length === 0 ? (
					<EmptyState>
						{commands.isLoading ? 'Loading commands...' : 'No commands found'}
					</EmptyState>
				) : (
					commands.items.map((command, index) => (
						<SettingRow
							key={`${command.source}:${command.path}`}
							title={command.name}
							titleExtra={
								<SettingsBadge>{COMMAND_SCOPE_LABELS[command.locationScope]}</SettingsBadge>
							}
							tooltip={command.description || command.path}
							last={index === commands.items.length - 1}
						>
							<SettingRowActions>
								<Button size="xs" variant="ghost" onClick={() => handleOpen(command.path)}>
									<EditIcon size={12} />
								</Button>
								{command.source === 'project' && (
									<Button size="xs" variant="ghost" onClick={() => handleDelete(command.name)}>
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
