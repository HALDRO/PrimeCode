/**
 * @file SlashCommandsDropdown - Slash commands picker
 * @description Uses universal DropdownMenu for consistent styling. Shows CLI commands,
 *              built-in snippets, and custom snippets with type badges.
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import type { CommandItem } from '../../constants';

import { useChatInputState, useSettingsStore, useSlashCommandsState } from '../../store';
import { type AnchorRectLike, DropdownMenu, type DropdownMenuItem } from '../ui';

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

const getTypeLabel = (type: string) => {
	switch (type) {
		case 'cli':
			return 'CLI';
		case 'custom':
			return 'Command';
		case 'subagent':
			return 'Subagent';
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
	const { commands, subagents } = useSettingsStore();

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
			// Find the last / in the input to replace from there
			const lastSlashIndex = input.lastIndexOf('/');
			if (lastSlashIndex >= 0) {
				// Find where the command ends (next space or end of string)
				const afterSlash = input.substring(lastSlashIndex);
				const spaceIndex = afterSlash.indexOf(' ');
				const commandEnd = spaceIndex >= 0 ? lastSlashIndex + spaceIndex : input.length;
				// Replace only the command part
				const before = input.substring(0, lastSlashIndex);
				const after = input.substring(commandEnd);
				setInput(`${before}${newCommand}${after}`);
			} else {
				// No slash found, just append
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
				// Clear command if empty text
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

	const allCommands = useMemo(() => {
		const customList: CommandItem[] = commands.custom.map(cmd => ({
			id: cmd.name,
			name: cmd.name,
			description: cmd.description ?? '',
			type: 'custom' as const,
			prompt: cmd.template,
		}));

		const subagentList: CommandItem[] = subagents.items.map(agent => ({
			id: agent.name,
			name: agent.name,
			description: agent.description ?? '',
			type: 'subagent' as const,
			prompt: `@${agent.name}`,
		}));

		const cliList: CommandItem[] = (commands.cli ?? [])
			.filter(cmd => !CLI_COMMANDS_UI_BLOCKLIST.has(cmd.name))
			.map(cmd => ({
				id: cmd.name,
				name: cmd.name,
				description: cmd.description ?? '',
				type: 'cli' as const,
			}));

		return [...customList, ...cliList, ...subagentList];
	}, [commands.custom, commands.cli, subagents.items]);

	const filteredCommands = useMemo(() => {
		const term = slashFilter.toLowerCase().replace(/^\//, '');
		if (!term) {
			return allCommands;
		}
		return allCommands.filter(cmd => {
			const name = cmd.name || '';
			const description = cmd.description || '';
			return name.toLowerCase().includes(term) || description.toLowerCase().includes(term);
		});
	}, [allCommands, slashFilter]);

	const handleSelect = useCallback(
		(cmd: CommandItem) => {
			if (cmd.type === 'cli' || cmd.type === 'custom') {
				// Execute CLI + custom commands through the chat pipeline (extension-side).
				// OpenCode commands are detected by MessageHandler and routed to SDK session.command().
				replaceCurrentCommand(`/${cmd.id}  `);
			} else if (cmd.type === 'subagent') {
				// Subagent type - insert @agent-name
				replaceCurrentCommand(`${cmd.prompt} `);
			} else {
				// Snippet type - insert prompt text directly
				onSelectCommand(cmd.prompt || '');
			}
			onClose();
		},
		[onClose, onSelectCommand, replaceCurrentCommand],
	);

	const items = useMemo(
		(): DropdownMenuItem<CommandItem>[] =>
			filteredCommands.map(cmd => {
				// Build full tooltip: description + prompt body
				// For subagents, prompt is just "@name" — skip it, show only description
				const parts: string[] = [];
				if (cmd.description) parts.push(cmd.description);
				if (cmd.prompt && cmd.type !== 'subagent') parts.push(cmd.prompt);
				const tooltipContent = parts.length > 0 ? parts.join('\n\n') : undefined;
				return {
					id: `${cmd.type}-${cmd.id}`,
					label: `/${cmd.name}`,
					description: tooltipContent,
					meta: getTypeLabel(cmd.type),
					data: cmd,
				};
			}),
		[filteredCommands],
	);

	return (
		<DropdownMenu
			items={items}
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
			minWidth={200}
			maxWidth={400}
			anchorElement={anchorElement}
			anchorRect={anchorRect}
		/>
	);
};
