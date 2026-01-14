import type React from 'react';
import { useSettingsStore } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { EditIcon } from '../../icons';
import { Button, Switch, Tooltip } from '../../ui';
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
	const { hasAgentsMd } = discoveryStatus.rules;

	const handleOpenAgents = () => postMessage('openFile', { filePath: 'AGENTS.md' });

	const handleToggleRule = (path: string, enabled: boolean, source: 'claude' | 'opencode') => {
		postMessage('toggleRule', { path, enabled, source });
	};

	return (
		<>
			<GroupTitle>Core Rules</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="AGENTS.md"
					tooltip="Auto-generated from first enabled rule in .agents/rules/"
					last
				>
					<div className="flex items-center gap-2">
						{hasAgentsMd ? (
							<SettingsBadge variant="green">Active</SettingsBadge>
						) : (
							<SettingsBadge>Not Generated</SettingsBadge>
						)}
						<Button size="sm" variant="secondary" onClick={handleOpenAgents}>
							View
						</Button>
					</div>
				</SettingRow>
			</SettingsGroup>

			<GroupTitle>Rules (.agents/rules/)</GroupTitle>
			<SettingsGroup>
				{rules.length === 0 ? (
					<EmptyState>No rule files found in .agents/rules/</EmptyState>
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
										onClick={() => postMessage('openFile', { filePath: rule.path })}
										className="p-1 rounded hover:bg-vscode-list-hoverBackground text-vscode-descriptionForeground hover:text-vscode-foreground transition-colors"
									>
										<EditIcon size={12} />
									</button>
								</Tooltip>
								<Switch
									checked={rule.isEnabled}
									onChange={v => handleToggleRule(rule.path, v, rule.source)}
								/>
							</SettingRowActions>
						</SettingRow>
					))
				)}
			</SettingsGroup>
		</>
	);
};
