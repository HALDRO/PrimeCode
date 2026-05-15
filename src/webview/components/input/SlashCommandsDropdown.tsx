/**
 * @file SlashCommandsDropdown - Slash commands picker
 * @description Uses universal DropdownMenu for consistent styling. Shows CLI commands,
 *              skills, and subagents in separate sections. The open/filter state is
 *              controlled by the owning ChatInput instance so multiple editors do not
 *              share transient slash-command UI state.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import type { CommandItem } from '../../constants';
import { useSettingsStore } from '../../store';
import { type AnchorRectLike, DropdownMenu } from '../ui';

/**
 * Commands that are handled by dedicated UI and should not appear in the slash dropdown.
 * These are filtered out from the dynamic CLI commands list.
 */
const CLI_COMMANDS_UI_BLOCKLIST = new Set([
	'config',
	'model',
	'provider',
	'mcp',
	'clear',
	'help',
	'version',
	'share',
	'unshare',
]);

const getTypeLabel = (type: string, source?: string) => {
	switch (type) {
		case 'cli':
			return source === 'mcp' ? 'MCP' : 'CLI';
		case 'custom':
			return 'Command';
		case 'subagent':
			return 'Subagent';
		case 'skill':
			return 'Skill';
		default:
			return 'Prompt';
	}
};

interface SlashCommandsDropdownProps {
	/** Optional anchor element for positioning */
	anchorElement?: HTMLElement | null;
	/** Optional explicit anchor rect override (e.g. caret position). */
	anchorRect?: AnchorRectLike | null;
	slashFilter: string;
	setSlashFilter: (value: string) => void;
	onClose: () => void;
	onInsertCommand: (text: string) => void;
}

export const SlashCommandsDropdown: React.FC<SlashCommandsDropdownProps> = ({
	anchorElement,
	anchorRect,
	slashFilter,
	setSlashFilter,
	onClose,
	onInsertCommand,
}) => {
	const agentResources = useSettingsStore(state => state.resources.agent.items);
	const commandResources = useSettingsStore(state => state.resources.command.items);
	const skillResources = useSettingsStore(state => state.resources.skill.items);

	const sections = useMemo(() => {
		const skillList: CommandItem[] = skillResources.map(skill => ({
			id: skill.name,
			name: skill.name,
			description: skill.description ?? '',
			type: 'skill' as const,
			prompt: skill.name,
		}));

		const subagentList: CommandItem[] = agentResources
			.filter(
				agent =>
					!agent.disabled && !agent.hidden && (agent.mode === 'subagent' || agent.mode === 'all'),
			)
			.map(agent => ({
				id: agent.name,
				name: agent.name,
				description: agent.description ?? '',
				type: 'subagent' as const,
				prompt: `@${agent.name}`,
			}));

		const runtimeCommands: CommandItem[] = commandResources
			.filter(command => !CLI_COMMANDS_UI_BLOCKLIST.has(command.name))
			.map(command => ({
				id: command.name,
				name: command.name,
				description: command.description ?? '',
				type: 'cli' as const,
				source: command.source,
			}));

		return [
			{ title: 'CLI', items: runtimeCommands },
			{ title: 'Skills', items: skillList },
			{ title: 'Subagents', items: subagentList },
		];
	}, [agentResources, commandResources, skillResources]);

	const filteredSections = useMemo(() => {
		const term = slashFilter.toLowerCase().replace(/^\//, '');
		if (!term) {
			return sections.filter(section => section.items.length > 0);
		}
		return sections
			.map(section => ({
				...section,
				items: section.items.filter(cmd => {
					const name = cmd.name || '';
					const description = cmd.description || '';
					return name.toLowerCase().includes(term) || description.toLowerCase().includes(term);
				}),
			}))
			.filter(section => section.items.length > 0);
	}, [sections, slashFilter]);

	const handleSelect = useCallback(
		(cmd: CommandItem) => {
			if (cmd.type === 'cli' || cmd.type === 'custom') {
				onInsertCommand(`/${cmd.id} `);
			} else if (cmd.type === 'skill') {
				onInsertCommand(`/skill ${cmd.prompt} `);
			} else if (cmd.type === 'subagent') {
				onInsertCommand(`${cmd.prompt} `);
			} else {
				onInsertCommand(cmd.prompt || '');
			}
			onClose();
		},
		[onClose, onInsertCommand],
	);

	const dropdownSections = useMemo(
		() =>
			filteredSections.map(section => ({
				title: section.title,
				items: section.items.map(cmd => {
					const parts: string[] = [];
					if (cmd.description) parts.push(cmd.description);
					if (cmd.prompt && cmd.type !== 'subagent' && cmd.type !== 'skill') parts.push(cmd.prompt);
					const tooltipContent = parts.length > 0 ? parts.join('\n\n') : undefined;
					return {
						id: `${cmd.type}-${cmd.id}`,
						label:
							cmd.type === 'skill'
								? cmd.name
								: cmd.type === 'subagent'
									? `@${cmd.name}`
									: `/${cmd.name}`,
						description: tooltipContent,
						meta: getTypeLabel(cmd.type, cmd.source),
						data: cmd,
					};
				}),
			})),
		[filteredSections],
	);

	return (
		<DropdownMenu
			sections={dropdownSections}
			searchable
			searchPlaceholder="Search commands..."
			searchValue={slashFilter.replace(/^\//, '')}
			onSearchChange={value => setSlashFilter(value)}
			searchAutoFocus
			onSelect={handleSelect}
			onClose={onClose}
			keyHints={{}}
			emptyMessage="No commands found"
			position="top"
			minWidth={220}
			maxWidth={420}
			anchorElement={anchorElement}
			anchorRect={anchorRect}
		/>
	);
};
