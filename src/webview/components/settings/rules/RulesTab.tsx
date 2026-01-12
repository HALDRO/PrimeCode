import type React from 'react';
import { useSettingsStore, useUIActions } from '../../../store';
import { useVSCode } from '../../../utils/vscode';
import { DownloadIcon, EditIcon, RefreshIcon } from '../../icons';
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
	const { showConfirmDialog } = useUIActions();
	const { discoveryStatus, rules } = useSettingsStore();
	const { hasAgentsMd, hasClaudeShim, hasClaudeMd } = discoveryStatus.rules;

	const handleOpenAgents = () => postMessage('openFile', { filePath: 'AGENTS.md' });
	const handleCreateClaudeShim = () => {
		showConfirmDialog({
			title: 'Create CLAUDE.md shim?',
			message:
				"This will create 'CLAUDE.md' with a single line '@AGENTS.md' to enable Claude-compatible rule loading.",
			confirmLabel: 'Create',
			cancelLabel: 'Cancel',
			onConfirm: () => postMessage('createClaudeShim'),
		});
	};

	const handleToggleRule = (path: string, enabled: boolean, source: 'claude' | 'opencode') => {
		postMessage('toggleRule', { path, enabled, source });
	};

	const handleImportRules = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'import',
			status: 'working',
			message: 'Importing rules from CLI...',
		});
		postMessage('importRulesFromClaude');
	};
	const handleSyncRules = () => {
		useSettingsStore.getState().actions.setAgentsOps({
			lastAction: 'sync',
			status: 'working',
			message: 'Syncing rules to CLI...',
		});
		postMessage('syncRulesToClaude');
	};

	return (
		<>
			<GroupTitle>Import & Sync</GroupTitle>
			<SettingsGroup>
				<SettingRow
					title="Import from CLI"
					tooltip="Copy rules from .claude/rules/ and .cursor/rules/ into .agents/rules/ (non-destructive, skips existing)"
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleImportRules}
						title="Copy rules into .agents (non-destructive)"
					>
						<DownloadIcon size={12} className="mr-1" />
						Import
					</Button>
				</SettingRow>
				<SettingRow
					title="Sync to CLI"
					tooltip="Copy rules from .agents/rules/ into .claude/rules/ and .cursor/rules/ for CLI compatibility"
					last
				>
					<Button
						size="sm"
						variant="secondary"
						onClick={handleSyncRules}
						title="Export .agents rules back to .claude/.cursor"
					>
						<RefreshIcon size={12} className="mr-1" />
						Sync
					</Button>
				</SettingRow>
			</SettingsGroup>

			<GroupTitle>Core Rules</GroupTitle>
			<SettingsGroup>
				<SettingRow title="AGENTS.md" tooltip="Canonical rules entry used by OpenCode">
					<div className="flex items-center gap-2">
						{hasAgentsMd ? (
							<SettingsBadge variant="green">Found</SettingsBadge>
						) : (
							<SettingsBadge>Missing</SettingsBadge>
						)}
						<Button size="sm" variant="secondary" onClick={handleOpenAgents}>
							{hasAgentsMd ? 'Open' : 'Create'}
						</Button>
					</div>
				</SettingRow>
				<SettingRow
					title="CLAUDE.md"
					tooltip="Compatibility shim for Claude Code (@AGENTS.md)"
					last
				>
					<div className="flex items-center gap-2">
						{hasClaudeShim ? (
							<SettingsBadge variant="green">Shim Active</SettingsBadge>
						) : hasClaudeMd ? (
							<SettingsBadge variant="blue">Custom</SettingsBadge>
						) : (
							<SettingsBadge>Missing</SettingsBadge>
						)}
						{!hasClaudeShim && (
							<Button size="sm" variant="secondary" onClick={handleCreateClaudeShim}>
								Shim
							</Button>
						)}
					</div>
				</SettingRow>
			</SettingsGroup>

			<GroupTitle>Discovered Rules</GroupTitle>
			<SettingsGroup>
				{rules.length === 0 ? (
					<EmptyState>No rule files found in .claude/rules or instructions</EmptyState>
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
