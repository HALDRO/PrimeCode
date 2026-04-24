/**
 * @file InputToolbar — Bottom toolbar with agent, model, thinking, permissions, plus (attach), improve buttons
 * @description Extracted from ChatInput. Contains all toolbar buttons and their dropdowns.
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { ChevronIcon, ImprovePromptIcon, LoaderIcon, PlusIcon } from '../icons';
import { Button, IconButton } from '../ui';
import { AgentButtonIcon, AgentDropdown, getAgentLabel } from './AgentDropdown';
import { AutoAcceptButton } from './AutoAcceptButton';
import { ModelDropdown } from './ModelDropdown';
import { ThinkingBudgetButton } from './ThinkingBudgetButton';

/** IDs of built-in agents that are toggled via the main button click. */
const BUILTIN_TOGGLE_IDS = new Set(['build', 'plan']);

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

	// Check if there are custom (non-builtin) agents that need a dropdown
	const agents = useSettingsStore(state => state.agents);
	const hasCustomAgents = useMemo(
		() =>
			agents.items.some(
				a =>
					!a.hidden &&
					(a.mode === 'primary' || a.mode === undefined) &&
					!BUILTIN_TOGGLE_IDS.has(a.id),
			),
		[agents.items],
	);

	/** Toggle between build and plan on click. */
	const handleAgentToggle = () => {
		onAgentChange(selectedAgent === 'plan' ? undefined : 'plan');
	};

	return (
		<div className="h-(--input-toolbar-height) flex items-center justify-between pl-(--gap-2) pr-0 box-border shrink-0">
			{/* Left Toolbar */}
			<div className="flex items-center gap-(--gap-0-5) z-5 min-w-0 overflow-hidden leading-none [&_svg]:block [&_svg]:shrink-0">
				{/* Agent button: click toggles build↔plan, chevron opens dropdown only if custom agents exist */}
				<div className="relative shrink-0 flex items-center">
					<Button
						variant="ghost"
						size="xs"
						onClick={handleAgentToggle}
						title={selectedAgent === 'plan' ? 'Switch to Build mode' : 'Switch to Plan mode'}
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
					</Button>
					{hasCustomAgents && (
						<IconButton
							icon={<ChevronIcon expanded={showAgentDropdown} size={10} />}
							onClick={e => {
								setAgentButtonAnchorElement(e.currentTarget as HTMLElement);
								setShowAgentDropdown(!showAgentDropdown);
							}}
							title="More agents"
							size={18}
							className="text-vscode-foreground opacity-50 hover:opacity-100 -ml-1"
						/>
					)}
					{showAgentDropdown && hasCustomAgents && (
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
							'h-(--input-toolbar-height) rounded-md opacity-70 hover:opacity-100 hover:bg-white/10 text-vscode-foreground text-sm font-(family-name:--vscode-font-family) min-w-0 max-w-full flex items-center gap-2 px-(--gap-1-5) transition-all duration-200 border-none bg-(--surface-raised)',
							showModelDropdown && 'opacity-100 bg-white/10',
						)}
					>
						<span className="truncate">{modelDisplayName}</span>
					</Button>
					{showModelDropdown && (
						<ModelDropdown anchorElement={modelButtonAnchorElement} onClose={onModelClose} />
					)}
				</div>

				{/* Thinking effort variant */}
				<ThinkingBudgetButton />

				{/* Auto-accept permissions */}
				<AutoAcceptButton />
			</div>

			{/* Right Toolbar */}
			<div className="flex items-center gap-0 pr-0 shrink-0 leading-none [&_svg]:block [&_svg]:shrink-0">
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
				<IconButton
					icon={
						<PlusIcon
							size={14}
							strokeWidth={2.5}
							className="transition-transform duration-200 group-hover/plus:scale-110"
						/>
					}
					onClick={() => postMessage({ type: 'browseFiles' })}
					title="Attach file or image"
					size={22}
					className="group/plus text-vscode-foreground opacity-70 hover:opacity-100"
				/>
			</div>
		</div>
	);
};
InputToolbar.displayName = 'InputToolbar';
