/**
 * @file SlashCommandsDropdown - Slash commands picker
 * @description Uses universal DropdownMenu for consistent styling. Shows CLI commands,
 *              skills, and subagents in separate sections.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import type { CommandItem } from '../../constants';
import { useChatInputState, useSettingsStore, useSlashCommandsState } from '../../store';
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
}

export const SlashCommandsDropdown: React.FC<SlashCommandsDropdownProps> = ({
	anchorElement,
	anchorRect,
}) => {
	const agentResources = useSettingsStore(state => state.resources.agent.items);
	const skillResources = useSettingsStore(state => state.resources.skill.items);

	const { input, setInput } = useChatInputState();
	const { slashFilter, setShowSlashCommands, setSlashFilter } = useSlashCommandsState();

	const onClose = useCallback(() => {
		setShowSlashCommands(false);
		setSlashFilter('');
	}, [setShowSlashCommands, setSlashFilter]);

	/**
	 * Replace the current slash command being typed with selected text.
	 * If input starts with /, replace from start to first space (or end).
	 * Otherwise append the text.
	 */
	const replaceCurrentCommand = useCallback(
		(newCommand: string) => {
			const lastSlashIndex = input.lastIndexOf('/');
			if (lastSlashIndex >= 0) {
				const afterSlash = input.substring(lastSlashIndex);
				const spaceIndex = afterSlash.indexOf(' ');
				const commandEnd = spaceIndex >= 0 ? lastSlashIndex + spaceIndex : input.length;
				const before = input.substring(0, lastSlashIndex);
				const after = input.substring(commandEnd);
				setInput(`${before}${newCommand}${after}`);
			} else {
				setInput(input.trim() ? `${input} ${newCommand} ` : `${newCommand} `);
			}
		},
		[input, setInput],
	);

	const onSelectCommand = useCallback(
		(text: string) => {
			if (text) {
				replaceCurrentCommand(text);
			} else {
				const lastSlashIndex = input.lastIndexOf('/');
				if (lastSlashIndex >= 0) {
					const afterSlash = input.substring(lastSlashIndex);
					const spaceIndex = afterSlash.indexOf(' ');
					const commandEnd = spaceIndex >= 0 ? lastSlashIndex + spaceIndex : input.length;
					const before = input.substring(0, lastSlashIndex);
					const after = input.substring(commandEnd);
					setInput(`${before}${after}`.trim());
				}
			}
		},
		[input, setInput, replaceCurrentCommand],
	);

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

		const runtimeCommands: CommandItem[] = [
			{
				id: 'compact',
				name: 'compact',
				description: 'Summarize and compact session context',
				type: 'cli' as const,
			},
		].filter(command => !CLI_COMMANDS_UI_BLOCKLIST.has(command.name));

		return [
			{ title: 'Skills', items: skillList },
			{ title: 'Commands', items: [...runtimeCommands, ...subagentList] },
		];
	}, [agentResources, skillResources]);

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
				replaceCurrentCommand(`/${cmd.id} `);
			} else if (cmd.type === 'skill') {
				replaceCurrentCommand(`/skill ${cmd.prompt} `);
			} else if (cmd.type === 'subagent') {
				replaceCurrentCommand(`${cmd.prompt} `);
			} else {
				onSelectCommand(cmd.prompt || '');
			}
			onClose();
		},
		[onClose, onSelectCommand, replaceCurrentCommand],
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
						label: cmd.type === 'skill' ? cmd.name : `/${cmd.name}`,
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
