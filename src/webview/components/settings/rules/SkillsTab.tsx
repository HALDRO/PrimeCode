import type React from 'react';
import { useEffect, useState } from 'react';
import type { SkillListItem } from '../../../../common';
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

const canDeleteSkill = (skill: SkillListItem) => skill.source === 'project';

const SKILL_SCOPE_LABELS = {
	project: 'Project',
	global: 'Global',
} as const;

export const SkillsTab: React.FC = () => {
	const skills = useSettingsStore(state => state.resources.skill);
	const { postMessage } = useVSCode();
	const [isCreatingSkill, setIsCreatingSkill] = useState(false);
	const [newSkillName, setNewSkillName] = useState('');
	const [newSkillDesc, setNewSkillDesc] = useState('');
	const [newSkillContent, setNewSkillContent] = useState('');

	useEffect(() => {
		postMessage({ type: 'getResources', kind: 'skill' });
	}, [postMessage]);

	const handleCreateSkill = () => {
		if (!newSkillName || !newSkillContent) return;
		postMessage({
			type: 'mutateResource',
			kind: 'skill',
			action: 'create',
			name: newSkillName,
			payload: {
				description: newSkillDesc,
				content: newSkillContent,
			},
		});
		setIsCreatingSkill(false);
		setNewSkillName('');
		setNewSkillDesc('');
		setNewSkillContent('');
	};

	const handleDeleteSkill = (name: string) =>
		postMessage({ type: 'mutateResource', kind: 'skill', action: 'delete', name });
	const handleOpenSkill = (filePath: string) => postMessage({ type: 'openSkillFile', filePath });

	return (
		<>
			<GroupTitle>Skills</GroupTitle>
			<p className="mx-(--gap-1) -mt-(--gap-1) mb-(--gap-3) text-xs text-vscode-descriptionForeground leading-relaxed">
				Skills are discovered from OpenCode skill folders and compatible .claude/.agents folders.
				OpenCode does not have a file-level skill enable switch; access is controlled by
				permission.skill policies or by disabling the skill tool for an agent.
			</p>
			<SettingsGroup>
				{!isCreatingSkill && (
					<SettingRow title="New Skill" tooltip="Create a new skill under .opencode/skills/" last>
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
								className={inputClass}
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
								className={inputClass}
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
								className={`${inputClass} h-24 font-mono resize-y`}
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

			<GroupTitle>Installed Skills</GroupTitle>
			<SettingsGroup>
				{skills.error && (
					<div className="px-3 py-2 text-xs text-vscode-errorForeground border-b border-(--alpha-10)">
						{skills.error}
					</div>
				)}
				{skills.items.length === 0 ? (
					<EmptyState>{skills.isLoading ? 'Loading skills...' : 'No skills found'}</EmptyState>
				) : (
					skills.items.map((skill, index) => (
						<SettingRow
							key={`${skill.source}:${skill.path}`}
							title={skill.name}
							titleExtra={<SettingsBadge>{SKILL_SCOPE_LABELS[skill.locationScope]}</SettingsBadge>}
							tooltip={skill.description || skill.path}
							last={index === skills.items.length - 1}
						>
							<SettingRowActions>
								<Button size="xs" variant="ghost" onClick={() => handleOpenSkill(skill.path)}>
									<EditIcon size={12} />
								</Button>
								{canDeleteSkill(skill) && (
									<Button size="xs" variant="ghost" onClick={() => handleDeleteSkill(skill.name)}>
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
