/**
 * @file RulesSettingsPanel.tsx
 * @description Settings panel for managing Rules, Skills, Hooks, and Commands.
 *              Acts as a unified "Rule Settings" view with sub-tabs.
 *              All items are stored in .opencode/ directory.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { HelpCircleIcon } from '../icons';
import { Tooltip } from '../ui';
import { CommandsTab, HooksTab, RulesTab, SkillsTab, SubagentsTab } from './rules';
import { OperationStatus } from './SettingsUI';

const AgentsHelpContent = () => (
	<div className="flex flex-col gap-1.5 text-sm">
		<div className="font-semibold text-vscode-foreground">Configuration</div>
		<div className="text-vscode-foreground">
			All rules, commands, skills, hooks, and subagents are stored in{' '}
			<code className="bg-(--alpha-10) px-1 rounded text-xs">.opencode/</code> directory.
		</div>
		<div className="text-vscode-descriptionForeground text-xs">Manage everything in one place.</div>
	</div>
);

export const RulesSettingsPanel: React.FC = () => {
	const [activeTab, setActiveTab] = useState<
		'rules' | 'commands' | 'skills' | 'hooks' | 'subagents'
	>('rules');
	const { resourceOps } = useSettingsStore();

	return (
		<div className="animate-fade-in">
			<div className="flex items-center justify-center gap-(--gap-1-5) px-1 py-1">
				{[
					{ id: 'rules', label: 'Rules' },
					{ id: 'commands', label: 'Commands' },
					{ id: 'skills', label: 'Skills' },
					{ id: 'hooks', label: 'Hooks' },
					{ id: 'subagents', label: 'Subagents' },
				].map(tab => (
					<button
						type="button"
						key={tab.id}
						onClick={() => setActiveTab(tab.id as typeof activeTab)}
						className={cn(
							'px-2 h-(--btn-height-sm) text-sm rounded transition-colors',
							activeTab === tab.id
								? 'bg-vscode-list-hoverBackground text-vscode-foreground'
								: 'text-vscode-descriptionForeground hover:bg-(--alpha-5) hover:text-vscode-foreground',
						)}
					>
						{tab.label}
					</button>
				))}
				<Tooltip content={<AgentsHelpContent />} position="bottom" delay={200}>
					<button
						type="button"
						className="ml-1 p-0.5 rounded text-vscode-descriptionForeground hover:text-vscode-foreground hover:bg-(--alpha-5) transition-colors"
					>
						<HelpCircleIcon size={14} />
					</button>
				</Tooltip>
			</div>

			<div className="px-2.5 pb-2">
				<OperationStatus status={resourceOps.status} message={resourceOps.message} />
			</div>

			{activeTab === 'commands' && <CommandsTab />}
			{activeTab === 'rules' && <RulesTab />}
			{activeTab === 'skills' && <SkillsTab />}
			{activeTab === 'hooks' && <HooksTab />}
			{activeTab === 'subagents' && <SubagentsTab />}
		</div>
	);
};
