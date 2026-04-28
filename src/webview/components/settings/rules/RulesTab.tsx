import type React from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { EditIcon } from '../../icons';
import { Button, Tooltip } from '../../ui';
import {
	EmptyState,
	GroupTitle,
	SettingRow,
	SettingRowActions,
	SettingsBadge,
	SettingsGroup,
} from '../SettingsUI';

export const RulesTab: React.FC = () => {
	const { postMessage } = useVSCode();
	const { discoveryStatus, rules } = useSettingsStore();
	const { hasAgentsMd, ruleFiles } = discoveryStatus.rules;
	const agentsMdBadges = (
		<>
			{!hasAgentsMd && <SettingsBadge>Not found</SettingsBadge>}
			{ruleFiles.some(file => file.startsWith('Project')) && <SettingsBadge>Project</SettingsBadge>}
			{ruleFiles.some(file => file.startsWith('Global')) && <SettingsBadge>Global</SettingsBadge>}
		</>
	);

	const handleOpenAgents = () => postMessage({ type: 'openFile', filePath: 'AGENTS.md' });

	return (
		<>
			<GroupTitle>Core Rules</GroupTitle>
			<p className="mx-(--gap-1) -mt-(--gap-1) mb-(--gap-3) text-xs text-vscode-descriptionForeground leading-relaxed">
				OpenCode rules are instruction sources such as AGENTS.md and configured instruction files.
				OpenCode has no per-rule enabled flag; edit a rule file to change it.
			</p>
			<SettingsGroup>
				<SettingRow
					title="AGENTS.md"
					titleExtra={agentsMdBadges}
					tooltip={ruleFiles.join('\n') || 'No AGENTS.md found'}
					last
				>
					<Button size="sm" variant="secondary" onClick={handleOpenAgents}>
						View
					</Button>
				</SettingRow>
			</SettingsGroup>

			<GroupTitle>Rules (.opencode/rules/)</GroupTitle>
			<SettingsGroup>
				{rules.length === 0 ? (
					<EmptyState>No rule files found in .opencode/rules/</EmptyState>
				) : (
					rules.map((rule, i) => (
						<SettingRow
							key={rule.path}
							title={rule.name}
							tooltip={rule.path}
							last={i === rules.length - 1}
						>
							<SettingRowActions>
								<Tooltip content="Edit file" position="top" delay={200}>
									<button
										type="button"
										onClick={() => postMessage({ type: 'openFile', filePath: rule.path })}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
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
