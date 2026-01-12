import type React from 'react';
import { cn } from '../../lib/cn';
import type { SubtaskMessage } from '../../store/chatStore';
import { formatDuration } from '../../utils/format';
import {
	AgentsIcon,
	ExpandChevronIcon,
	TodoCheckIcon,
	TodoProgressIcon,
} from '../icons/CustomIcons';

interface SubtaskHeaderProps {
	subtask: SubtaskMessage;
	isExpanded: boolean;
	onToggle: () => void;
	totalDuration?: number;
}

export const SubtaskHeader: React.FC<SubtaskHeaderProps> = ({
	subtask,
	isExpanded,
	onToggle,
	totalDuration,
}) => {
	const isRunning = subtask.status === 'running';
	const isCompleted = subtask.status === 'completed';
	const isError = subtask.status === 'error';

	return (
		<div
			onClick={onToggle}
			className={cn(
				'flex items-center gap-2 p-2 cursor-pointer select-none transition-colors group',
				'bg-vscode-input-background hover:bg-vscode-toolbar-hoverBackground',
			)}
		>
			<div
				className={cn(
					'flex items-center justify-center w-5 h-5 rounded-full shrink-0',
					// Status icon colors
					isRunning && 'text-vscode-button-background',
					isCompleted && 'text-vscode-editorGutter-addedBackground',
					isError && 'text-vscode-errorForeground',
				)}
			>
				{isRunning && (
					<div className="animate-spin duration-3000">
						<TodoProgressIcon size={14} />
					</div>
				)}
				{isCompleted && <TodoCheckIcon size={14} />}
				{isError && (
					<div className="text-vscode-errorForeground">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-label="Error">
							<title>Error</title>
							<path d="M8 7.293l3.646-3.647.708.708L8.707 8l3.647 3.646-.708.708L8 8.707l-3.646 3.647-.708-.708L7.293 8 3.646 4.354l.708-.708L8 7.293z" />
						</svg>
					</div>
				)}
			</div>

			<div className="flex-1 min-w-0 flex flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium px-1.5 py-0.5 rounded-sm bg-vscode-badge-background text-vscode-badge-foreground flex items-center gap-1">
						<AgentsIcon size={10} />
						{subtask.agent.toUpperCase()}
					</span>
					<span className="text-xs opacity-70 truncate">
						{isCompleted && subtask.result ? subtask.result : subtask.description}
					</span>
				</div>
				{subtask.command && (
					<div className="text-xs font-mono opacity-50 truncate pl-0.5">$ {subtask.command}</div>
				)}
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{totalDuration && totalDuration > 0 ? (
					<span className="text-xs text-vscode-foreground opacity-70">
						{formatDuration(totalDuration)}
					</span>
				) : null}
				<div className="opacity-50 group-hover:opacity-100 transition-opacity">
					<ExpandChevronIcon expanded={isExpanded} size={14} />
				</div>
			</div>
		</div>
	);
};
