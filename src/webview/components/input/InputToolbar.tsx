/**
 * @file InputToolbar — Bottom toolbar with agent, model, slash, file, image buttons
 * @description Extracted from ChatInput. Contains all toolbar buttons and their dropdowns.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useVSCode } from '../../utils/vscode';
import {
	AtSignIcon,
	ChevronIcon,
	ImageIcon,
	ImprovePromptIcon,
	LoaderIcon,
	TerminalIcon,
} from '../icons';
import { type AnchorRectLike, Button, IconButton } from '../ui';
import { AgentButtonIcon, AgentDropdown, getAgentLabel } from './AgentDropdown';
import { FilePickerDropdown } from './FilePickerDropdown';
import { ModelDropdown } from './ModelDropdown';
import { SlashCommandsDropdown } from './SlashCommandsDropdown';

interface InputToolbarProps {
	// Agent
	selectedAgent: string | undefined;
	onAgentChange: (agent: string | undefined) => void;
	// Model
	modelDisplayName: string;
	// Prompt improver
	isImproving: boolean;
	canImprove: boolean;
	onImprovePrompt: () => void;
	// Slash commands
	showSlashCommands: boolean;
	slashCommandsAnchorRect: AnchorRectLike | null;
	slashButtonAnchorElement: HTMLElement | null;
	onSlashToggle: (anchor: HTMLElement) => void;
	// File picker
	showFilePicker: boolean;
	filePickerAnchorRect: AnchorRectLike | null;
	fileButtonAnchorElement: HTMLElement | null;
	onFileToggle: (anchor: HTMLElement) => void;
	onFileSelect: (path: string) => void;
	// Model dropdown
	showModelDropdown: boolean;
	modelButtonAnchorElement: HTMLElement | null;
	onModelToggle: (anchor: HTMLElement) => void;
	onModelClose: () => void;
}

export const InputToolbar: React.FC<InputToolbarProps> = ({
	selectedAgent,
	onAgentChange,
	modelDisplayName,
	isImproving,
	canImprove,
	onImprovePrompt,
	showSlashCommands,
	slashCommandsAnchorRect,
	slashButtonAnchorElement,
	onSlashToggle,
	showFilePicker,
	filePickerAnchorRect,
	fileButtonAnchorElement,
	onFileToggle,
	onFileSelect,
	showModelDropdown,
	modelButtonAnchorElement,
	onModelToggle,
	onModelClose,
}) => {
	const { postMessage } = useVSCode();
	const [showAgentDropdown, setShowAgentDropdown] = useState(false);
	const [agentButtonAnchorElement, setAgentButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);

	return (
		<div className="h-(--input-toolbar-height) flex items-center justify-between pl-(--gap-2) pr-0 box-border shrink-0">
			{/* Left Toolbar */}
			<div className="flex items-center gap-(--gap-0-5) z-5 min-w-0 overflow-hidden">
				{/* Agent button */}
				<div className="relative shrink-0">
					<Button
						variant="ghost"
						size="xs"
						onClick={e => {
							setAgentButtonAnchorElement(e.currentTarget as HTMLElement);
							setShowAgentDropdown(!showAgentDropdown);
						}}
						className={cn(
							'h-(--input-toolbar-height) rounded-md select-none text-sm font-(family-name:--vscode-font-family) shrink-0 flex items-center gap-2 px-(--gap-1-5) transition-all duration-200 border',
							selectedAgent
								? 'text-vscode-button-background bg-vscode-button-background/10 border-vscode-button-background/30'
								: 'text-vscode-foreground opacity-70 hover:opacity-100 bg-transparent hover:bg-(--alpha-5) border-transparent',
						)}
					>
						<AgentButtonIcon
							agentId={selectedAgent}
							size={14}
							className={cn('transition-transform duration-200', selectedAgent && 'scale-110')}
						/>
						<span>{getAgentLabel(selectedAgent)}</span>
						<ChevronIcon expanded={showAgentDropdown} size={10} className="shrink-0" />
					</Button>
					{showAgentDropdown && (
						<AgentDropdown
							anchorElement={agentButtonAnchorElement}
							onSelect={agent => {
								onAgentChange(agent);
								setShowAgentDropdown(false);
							}}
							onClose={() => setShowAgentDropdown(false)}
						/>
					)}
				</div>

				{/* Model button */}
				<div className="relative min-w-0">
					<Button
						variant="ghost"
						size="xs"
						onClick={e => {
							onModelToggle(e.currentTarget as HTMLElement);
						}}
						className={cn(
							'h-(--input-toolbar-height) rounded-md opacity-70 hover:opacity-100 hover:bg-(--alpha-5) text-sm font-(family-name:--vscode-font-family) min-w-0 max-w-full flex items-center gap-2 px-(--gap-1-5) transition-all duration-200 border border-transparent',
							showModelDropdown && 'bg-(--alpha-5) opacity-100',
						)}
					>
						<span className="truncate">{modelDisplayName}</span>
						<ChevronIcon expanded={showModelDropdown} size={10} className="shrink-0" />
					</Button>
					{showModelDropdown && (
						<ModelDropdown anchorElement={modelButtonAnchorElement} onClose={onModelClose} />
					)}
				</div>
			</div>

			{/* Right Toolbar */}
			<div className="flex items-center gap-0 pr-0 shrink-0">
				{/* Improve prompt */}
				<div className="relative">
					<IconButton
						icon={
							isImproving ? (
								<LoaderIcon className="animate-spin" size={14} />
							) : (
								<ImprovePromptIcon
									size={14}
									className="transition-transform duration-200 group-hover/improve:scale-110"
								/>
							)
						}
						onClick={onImprovePrompt}
						title={isImproving ? 'Cancel improvement' : 'Improve prompt'}
						size={22}
						disabled={!canImprove && !isImproving}
						className={cn(
							'group/improve',
							isImproving
								? 'opacity-100 text-(--color-accent)'
								: 'text-vscode-foreground opacity-70 hover:opacity-100 hover:text-(--color-accent)',
						)}
					/>
				</div>
				{/* Slash commands */}
				<div className="relative">
					<IconButton
						icon={
							<TerminalIcon
								size={14}
								strokeWidth={2.5}
								className="transition-transform duration-200 group-hover/terminal:scale-110"
							/>
						}
						onClick={e => onSlashToggle(e.currentTarget as HTMLElement)}
						title="Slash commands (/)"
						size={22}
						className="group/terminal text-vscode-foreground opacity-70 hover:opacity-100"
					/>
					{showSlashCommands && (
						<SlashCommandsDropdown
							anchorElement={slashButtonAnchorElement}
							anchorRect={
								!slashButtonAnchorElement ? (slashCommandsAnchorRect ?? undefined) : undefined
							}
						/>
					)}
				</div>
				{/* File picker */}
				<div className="relative">
					<IconButton
						icon={
							<AtSignIcon
								size={14}
								strokeWidth={2.5}
								className="transition-transform duration-200 group-hover/at:scale-110"
							/>
						}
						onClick={e => onFileToggle(e.currentTarget as HTMLElement)}
						title="Reference files (@)"
						size={22}
						className="group/at text-vscode-foreground opacity-70 hover:opacity-100"
					/>
					{showFilePicker && (
						<FilePickerDropdown
							onSelectFile={onFileSelect}
							anchorElement={fileButtonAnchorElement}
							anchorRect={
								!fileButtonAnchorElement ? (filePickerAnchorRect ?? undefined) : undefined
							}
						/>
					)}
				</div>
				{/* Image attach */}
				<IconButton
					icon={
						<ImageIcon
							size={14}
							strokeWidth={2.5}
							className="transition-transform duration-200 group-hover/image:scale-110"
						/>
					}
					onClick={() => postMessage({ type: 'getImageData' })}
					title="Attach image"
					size={22}
					className="group/image text-vscode-foreground opacity-70 hover:opacity-100"
				/>
			</div>
		</div>
	);
};
InputToolbar.displayName = 'InputToolbar';
