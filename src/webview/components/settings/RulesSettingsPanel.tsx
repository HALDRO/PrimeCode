/**
 * @file RulesSettingsPanel.tsx
 * @description Settings panel for managing Rules, Skills, Hooks, and Commands.
 *              Acts as a unified "Rule Settings" view with sub-tabs.
 *              All items are stored in .agents/ and can be synced to/from CLI directories.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { HelpCircleIcon } from '../icons';
import { Tooltip } from '../ui';
import { CommandsTab, HooksTab, RulesTab, SkillsTab } from './rules';
import { OperationStatus } from './SettingsUI';

const AgentsHelpContent = () => (
	<div className="flex flex-col gap-1.5 text-sm">
		<div className="font-semibold text-white/90">Agents Configuration</div>
		<div className="text-white/70">
			All rules, commands, skills, and hooks are stored in{' '}
			<code className="bg-white/10 px-1 rounded text-xs">.agents/</code> directory as the single
			source of truth.
		</div>
		<div className="flex flex-col gap-0.5 text-white/70">
			<div>
				<span className="text-blue-400">Import</span> — copies from{' '}
				<code className="bg-white/10 px-0.5 rounded text-xs">.claude/</code>,{' '}
				<code className="bg-white/10 px-0.5 rounded text-xs">.cursor/</code> and{' '}
				<code className="bg-white/10 px-0.5 rounded text-xs">.opencode/</code> into{' '}
				<code className="bg-white/10 px-0.5 rounded text-xs">.agents/</code> (skips duplicates)
			</div>
			<div>
				<span className="text-green-400">Sync</span> — copies from{' '}
				<code className="bg-white/10 px-0.5 rounded text-xs">.agents/</code> back to CLI directories
			</div>
		</div>
		<div className="text-white/50 text-xs">
			Manage everything in one place while keeping all CLIs in sync.
		</div>
	</div>
);

export const RulesSettingsPanel: React.FC = () => {
	const [activeTab, setActiveTab] = useState<'rules' | 'commands' | 'skills' | 'hooks'>('rules');
	const { agentsOps } = useSettingsStore();

	return (
		<div className="animate-fade-in">
			<div className="flex items-center justify-center gap-(--gap-1-5) border-b border-white/10 pb-1.5 mb-2 mt-1.5">
				{[
					{ id: 'rules', label: 'Rules' },
					{ id: 'commands', label: 'Commands' },
					{ id: 'skills', label: 'Skills' },
					{ id: 'hooks', label: 'Hooks' },
				].map(tab => (
					<button
						type="button"
						key={tab.id}
						onClick={() => setActiveTab(tab.id as typeof activeTab)}
						className={cn(
							'px-2 py-0.5 text-sm font-medium rounded transition-colors',
							activeTab === tab.id
								? 'bg-white/10 text-white/90'
								: 'text-white/60 hover:bg-white/5 hover:text-white/80',
						)}
					>
						{tab.label}
					</button>
				))}
				<Tooltip content={<AgentsHelpContent />} position="bottom" delay={200}>
					<button
						type="button"
						className="ml-1 p-0.5 rounded text-white/40 hover:text-white/70 hover:bg-white/5 transition-colors"
					>
						<HelpCircleIcon size={14} />
					</button>
				</Tooltip>
			</div>

			<div className="px-2.5 pb-2">
				<OperationStatus status={agentsOps.status} message={agentsOps.message} />
			</div>

			{activeTab === 'commands' && <CommandsTab />}
			{activeTab === 'rules' && <RulesTab />}
			{activeTab === 'skills' && <SkillsTab />}
			{activeTab === 'hooks' && <HooksTab />}
		</div>
	);
};
