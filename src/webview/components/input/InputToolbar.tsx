/**
 * @file InputToolbar — Bottom toolbar with agent, model, thinking, permissions, plus (attach), improve buttons
 * @description Extracted from ChatInput. Contains toolbar buttons and their dropdowns, including the agent selector
 *              opened from the main agent button. The plus (+) button opens a small portal dropdown with two options:
 *              attach file/image and attach folder — replacing the old hover-based folder overlay.
 */

import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { useSettingsStore } from '../../store';
import { useVSCode } from '../../utils/vscode';
import { FolderOpenIcon, ImprovePromptIcon, LoaderIcon, PlusIcon } from '../icons';
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

/** Portal dropdown shown when user clicks the + button */
const AttachDropdown: React.FC<{
	anchorEl: HTMLElement;
	onClose: () => void;
	onAttachFile: () => void;
	onAttachFolder: () => void;
}> = ({ anchorEl, onClose, onAttachFile, onAttachFolder }) => {
	const ref = useRef<HTMLDivElement>(null);
	const rect = anchorEl.getBoundingClientRect();

	useEffect(() => {
		const handlePointerDown = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (ref.current && target && !ref.current.contains(target) && !anchorEl.contains(target)) {
				onClose();
			}
		};
		document.addEventListener('pointerdown', handlePointerDown);
		return () => document.removeEventListener('pointerdown', handlePointerDown);
	}, [anchorEl, onClose]);

	const menuStyle: React.CSSProperties = {
		position: 'fixed',
		bottom: `${window.innerHeight - rect.top + 4}px`,
		right: `${window.innerWidth - rect.right}px`,
		zIndex: 9999,
	};

	return createPortal(
		<div
			ref={ref}
			style={menuStyle}
			className="min-w-[160px] bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden shadow-lg py-1"
		>
			<button
				type="button"
				className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vscode-foreground opacity-80 hover:opacity-100 hover:bg-vscode-list-hoverBackground transition-colors duration-100 font-(family-name:--vscode-font-family) cursor-pointer"
				onClick={() => {
					onAttachFile();
					onClose();
				}}
			>
				<PlusIcon size={13} strokeWidth={2.5} className="shrink-0" />
				<span>Attach file or image</span>
			</button>
			<button
				type="button"
				className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-vscode-foreground opacity-80 hover:opacity-100 hover:bg-vscode-list-hoverBackground transition-colors duration-100 font-(family-name:--vscode-font-family) cursor-pointer"
				onClick={() => {
					onAttachFolder();
					onClose();
				}}
			>
				<FolderOpenIcon size={13} strokeWidth={2.2} className="shrink-0" />
				<span>Attach folder</span>
			</button>
		</div>,
		document.body,
	);
};

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
	const [showAttachDropdown, setShowAttachDropdown] = useState(false);
	const [plusAnchorEl, setPlusAnchorEl] = useState<HTMLElement | null>(null);

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
					onClick={e => {
						setPlusAnchorEl(e.currentTarget as HTMLElement);
						setShowAttachDropdown(prev => !prev);
					}}
					title="Attach file, image or folder"
					size={22}
					className={cn(
						'group/plus text-vscode-foreground opacity-70 hover:opacity-100',
						showAttachDropdown && 'opacity-100',
					)}
				/>
				{showAttachDropdown && plusAnchorEl && (
					<AttachDropdown
						anchorEl={plusAnchorEl}
						onClose={() => setShowAttachDropdown(false)}
						onAttachFile={() => postMessage({ type: 'browseFiles' })}
						onAttachFolder={() => postMessage({ type: 'browseFolders' })}
					/>
				)}
			</div>
		</div>
	);
};
InputToolbar.displayName = 'InputToolbar';
