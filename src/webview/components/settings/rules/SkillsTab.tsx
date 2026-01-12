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

export const SkillsTab: React.FC = () => {
	const { skills } = useSettingsStore();
	const { postMessage } = useVSCode();

	// Skills State
	const [isCreatingSkill, setIsCreatingSkill] = useState(false);
	const [newSkillName, setNewSkillName] = useState('');
	const [newSkillDesc, setNewSkillDesc] = useState('');
	const [newSkillContent, setNewSkillContent] = useState('');

	useEffect(() => {
		postMessage('getSkills');
	}, [postMessage]);

	const handleCreateSkill = () => {
		if (!newSkillName || !newSkillContent) {
			return;
		}

		postMessage('createSkill', {
			name: newSkillName,
			description: newSkillDesc,
			content: newSkillContent,
			version: '0.1.0',
		});

		setIsCreatingSkill(false);
		setNewSkillName('');
		setNewSkillDesc('');
		setNewSkillContent('');
	};

	const handleDeleteSkill = (name: string) => postMessage('deleteSkill', { name });
	const handleOpenSkill = (name: string) => postMessage('openSkillFile', { name });
	const handleImportSkills = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'import',
			status: 'working',
			message: 'Importing skills from CLI...',
		});
		postMessage('importSkillsFromCLI');
	};
	const handleSyncSkills = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'sync',
			status: 'working',
			message: 'Syncing skills to CLI...',
		});
		postMessage('syncSkillsToCLI');
	};

	return (
		<>
			<GroupTitle>Import & Sync</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="Import from CLI"
					tooltip="Import skills from .claude/skills/, .opencode/skill/ and .cursor/skills/ into .agents/skills/"
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleImportSkills}
						title="Import from .claude/.opencode/.cursor into .agents"
					>
						<DownloadIcon size={12} className="mr-1" />
						Import
					</Button>
				</SettingRow>
				<SettingRow
					title="Sync to CLI"
					tooltip="Export skills from .agents/skills/ to .claude/skills/, .opencode/skill/ and .cursor/skills/"
					last={isCreatingSkill}
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleSyncSkills}
						title="Export from .agents to .claude/.opencode/.cursor"
					>
						<RefreshIcon size={12} className="mr-1" />
						Sync
					</Button>
				</SettingRow>
				{!isCreatingSkill && (
					<SettingRow title="New Skill" tooltip="Create a new skill under .agents/skills/" last>
						<Button size="sm" onClick={() => setIsCreatingSkill(true)}>
							<PlusIcon size={12} className="mr-1" />
							New
						</Button>
					</SettingRow>
				)}
			</SettingsGroup>

			{isCreatingSkill && (
				<SettingsGroup>
					<div className="p-3 flex flex-col gap-3 bg-(--alpha-5) rounded-md">
						<h3 className="text-xs font-semibold uppercase tracking-wider text-vscode-descriptionForeground">
							New Skill
						</h3>

						<div className="flex flex-col gap-1">
							<label htmlFor="skill-name" className="text-xs text-vscode-descriptionForeground">
								Name (Folder/ID)
							</label>
							<input
								id="skill-name"
								type="text"
								value={newSkillName}
								onChange={e => setNewSkillName(e.target.value)}
								placeholder="my-skill"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="skill-desc" className="text-xs text-vscode-descriptionForeground">
								Description
							</label>
							<input
								id="skill-desc"
								type="text"
								value={newSkillDesc}
								onChange={e => setNewSkillDesc(e.target.value)}
								placeholder="What does this skill do?"
								className="w-full px-2 py-1.5 text-xs bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder"
							/>
						</div>

						<div className="flex flex-col gap-1">
							<label htmlFor="skill-content" className="text-xs text-vscode-descriptionForeground">
								Instructions / Content
							</label>
							<textarea
								id="skill-content"
								value={newSkillContent}
								onChange={e => setNewSkillContent(e.target.value)}
								className="w-full h-24 px-2 py-1.5 text-xs font-mono bg-vscode-input-background border border-vscode-input-border rounded text-vscode-input-foreground placeholder:text-vscode-input-placeholderForeground focus:outline-none focus:border-vscode-focusBorder resize-y"
								placeholder="Describe when and how a model should use this skill..."
							/>
						</div>

						<div className="flex justify-end gap-2 mt-2">
							<Button size="sm" variant="secondary" onClick={() => setIsCreatingSkill(false)}>
								Cancel
							</Button>
							<Button
								size="sm"
								onClick={handleCreateSkill}
								disabled={!newSkillName || !newSkillContent}
							>
								Create
							</Button>
						</div>
					</div>
				</SettingsGroup>
			)}

			<SettingsGroup>
				{skills.isLoading ? (
					<div className="p-4 text-center text-vscode-descriptionForeground text-xs">
						Loading skills...
					</div>
				) : skills.items.length === 0 ? (
					<EmptyState>No skills found. Create one or import from CLI.</EmptyState>
				) : (
					skills.items.map((skill, i) => (
						<SettingRow
							key={skill.path}
							title={skill.name}
							tooltip={skill.path}
							last={i === skills.items.length - 1}
						>
							<SettingRowActions>
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleOpenSkill(skill.name)}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<SettingsBadge>Skill</SettingsBadge>
								<Tooltip content="Delete" position="top" delay={200}>
									<button
										type="button"
										onClick={() => handleDeleteSkill(skill.name)}
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
