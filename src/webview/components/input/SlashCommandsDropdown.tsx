/**
 * @file SlashCommandsDropdown - Slash commands picker
 * @description Uses universal DropdownMenu for consistent styling. Shows CLI commands,
 *              built-in snippets, and custom snippets with type badges.
 *              CLI commands are filtered based on selected provider (Claude/OpenCode).
 */

import type React from 'react';
import { useCallback, useMemo } from 'react';
import { CLI_COMMANDS, type CommandItem, OPENCODE_COMMANDS } from '../../constants';
import { useChatInputState, useSettingsStore, useSlashCommandsState } from '../../store';
import { type AnchorRectLike, DropdownMenu, type DropdownMenuItem } from '../ui';

const getTypeLabel = (type: string) => {
	switch (type) {
		case 'cli':
			return 'CLI';
		case 'custom':
			return 'Custom';
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
	const { provider, commands } = useSettingsStore();
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
			description: cmd.description,
			type: 'custom' as const,
			prompt: cmd.prompt,
		}));
		// Use provider-specific CLI commands
		const cliCommands = provider === 'opencode' ? OPENCODE_COMMANDS : CLI_COMMANDS;
		return [...customList, ...cliCommands];
	}, [commands.custom, provider]);

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
				// - OpenCode: MessageHandler detects leading '/' and uses SDK session.command().
				// - Claude: ClaudeSDKService receives the prompt and handles built-in commands via SDK.
				replaceCurrentCommand(`/${cmd.id}  `);
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
			filteredCommands.map(cmd => ({
				id: `${cmd.type}-${cmd.id}`,
				label: `/${cmd.name}`,
				description: cmd.description,
				meta: getTypeLabel(cmd.type),
				data: cmd,
			})),
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
			minWidth={280}
			maxWidth={340}
			anchorElement={anchorElement}
			anchorRect={anchorRect}
		/>
	);
};
