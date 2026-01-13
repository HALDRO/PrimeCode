/**
 * @file SubagentsTab.tsx
 * @description Settings tab for managing subagents stored in .agents/subagents/.
 *              Provides UI for creating, editing, deleting, importing, and syncing subagents
 *              to/from CLI-specific directories (.claude/agents/ and .opencode/agent/).
 */

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

export const SubagentsTab: React.FC = () => {
	const { subagents } = useSettingsStore();
	const { postMessage } = useVSCode();

	// Create subagent form state
	const [isCreating, setIsCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const [newDescription, setNewDescription] = useState('');
	const [newContent, setNewContent] = useState('');

	// Initial load
	useEffect(() => {
		postMessage('getSubagents');
	}, [postMessage]);

	const handleCreate = () => {
		if (!newName || !newContent) {
			return;
		}

		postMessage('createSubagent', {
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
		postMessage('deleteSubagent', { name });
	};

	const handleOpen = (name: string) => {
		postMessage('openSubagentFile', { name });
	};

	const handleImport = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'import',
			status: 'working',
			message: 'Importing subagents from CLI...',
		});
		postMessage('importSubagentsFromCLI');
	};

	const handleSync = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'sync',
			status: 'working',
			message: 'Syncing subagents to CLI...',
		});
		postMessage('syncSubagentsToCLI');
	};

	return (
		<>
			{/* Actions Bar */}
			<GroupTitle>Import & Sync</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="Import from CLI"
					tooltip="Import existing subagents from .claude/agents/ or .opencode/agent/"
				>
					<Button
						size="sm"
						variant="secondary"
						title="Import from .claude/.opencode into .agents"
						onClick={handleImport}
					>
						<DownloadIcon size={12} className="mr-1" />
						Import
					</Button>
				</SettingRow>

				<SettingRow
					title="Sync to CLI"
					tooltip="Export subagents to .claude/agents/ and .opencode/agent/"
					last={isCreating}
				>
					<Button
						size="sm"
						variant="secondary"
						title="Export from .agents to .claude/.opencode"
						onClick={handleSync}
					>
						<RefreshIcon size={12} className="mr-1" />
						Sync
					</Button>
				</SettingRow>

				{!isCreating && (
					<SettingRow
						title="New Subagent"
						tooltip="Create a new subagent under .agents/subagents/"
						last
					>
						<Button size="sm" onClick={() => setIsCreating(true)}>
							<PlusIcon size={12} className="mr-1" />
							New
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{/* Create New Subagent Form */}
			{isCreating && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							New Subagent
						</h3>

						<div className="flex flex-col gap-1">
							<label htmlFor="subagent-name" className="text-xs text-vscode-descriptionForeground">
								Name
							</label>
							<input
								id="subagent-name"
								type="text"
								value={newName}
								onChange={e => setNewName(e.target.value)}
								placeholder="Subagent name (e.g., research-codebase)"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="subagent-desc" className="text-xs text-vscode-descriptionForeground">
								Description
							</label>
							<input
								id="subagent-desc"
								type="text"
								value={newDescription}
								onChange={e => setNewDescription(e.target.value)}
								placeholder="Description of what this subagent does"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label
								htmlFor="subagent-content"
								className="text-xs text-vscode-descriptionForeground"
							>
								Prompt Content
							</label>
							<textarea
								id="subagent-content"
								value={newContent}
								onChange={e => setNewContent(e.target.value)}
								className="w-full h-32 px-2 py-1.5 text-xs font-mono bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder resize-y"
								placeholder="Enter subagent prompt/instructions here..."
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

			{/* Subagents List */}
			<SettingsGroup>
				{subagents.isLoading ? (
					<div className="p-4 text-center text-vscode-descriptionForeground text-xs">
						Loading subagents...
					</div>
				) : subagents.items.length === 0 ? (
					<EmptyState>No subagents found. Create one or import from CLI.</EmptyState>
				) : (
					subagents.items.map((subagent, idx) => (
						<SettingRow
							key={subagent.name}
							title={`@${subagent.name}`}
							tooltip={subagent.description || subagent.path}
							last={idx === subagents.items.length - 1}
						>
							<SettingRowActions>
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleOpen(subagent.name)}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<SettingsBadge>Subagent</SettingsBadge>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleDelete(subagent.name)}
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
