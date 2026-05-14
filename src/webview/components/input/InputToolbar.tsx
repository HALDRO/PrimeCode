/**
 * @file InputToolbar — Bottom toolbar with agent, model, thinking, permissions, plus (attach), improve buttons
 * @description Extracted from ChatInput. Contains toolbar buttons and their dropdowns, including the agent selector opened from the main agent button.
 */

import type React from 'react';
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { ImprovePromptIcon, LoaderIcon, PlusIcon } from '../icons';
import { Button, IconButton } from '../ui';
import { AgentButtonIcon, AgentDropdown, getAgentLabel } from './AgentDropdown';
import { AutoAcceptButton } from './AutoAcceptButton';
import { ModelDropdown } from './ModelDropdown';
import { ThinkingBudgetButton } from './ThinkingBudgetButton';

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
	const effectiveAgent = useSettingsStore(s => {
		if (selectedAgent) return selectedAgent;
		const configured = s.opencodeAgent;
		if (configured) return configured;
		const primary = s.resources.agent.items.find(
			a => !a.disabled && !a.hidden && (a.mode === 'primary' || a.mode === undefined),
		);
		return primary?.name || undefined;
	});
	const [showAgentDropdown, setShowAgentDropdown] = useState(false);
	const [agentButtonAnchorElement, setAgentButtonAnchorElement] = useState<HTMLElement | null>(
		null,
	);

	return (
		<div className="h-(--input-toolbar-height) flex items-center justify-between pl-(--gap-2) pr-0 box-border shrink-0">
			{/* Left Toolbar */}
			<div className="flex items-center gap-(--gap-0-5) z-5 min-w-0 overflow-hidden leading-none [&_svg]:block [&_svg]:shrink-0">
				{/* Agent button */}
				<div className="relative shrink-0 flex items-center">
					<Button
						variant="ghost"
						size="xs"
						onClick={e => {
							setAgentButtonAnchorElement(e.currentTarget as HTMLElement);
							setShowAgentDropdown(!showAgentDropdown);
						}}
						title="Select agent"
						className={cn(
							'h-(--input-toolbar-height) rounded-md opacity-70 hover:opacity-100 hover:bg-white/10 text-vscode-foreground text-sm font-(family-name:--vscode-font-family) shrink-0 flex items-center gap-2 px-(--gap-1-5) transition-all duration-200 border-none bg-(--surface-raised)',
							showAgentDropdown && 'opacity-100 bg-white/10',
						)}
					>
						<AgentButtonIcon agentId={effectiveAgent} size={14} />
						<span>{getAgentLabel(effectiveAgent)}</span>
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
