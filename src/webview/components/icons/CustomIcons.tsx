/**
 * @file Custom SVG icons - specialized icons not available in lucide-react
 * @description Contains custom SVG icon components for specific UI needs like
 * chevron animations, view mode toggles, and diff indicators. These icons have
 * custom styling or behavior not available in standard icon libraries.
 */

import type React from 'react';
import { cn } from '../../lib/cn';

interface IconProps {
	size?: number;
	style?: React.CSSProperties;
	className?: string;
}

/**
 * Animated chevron icon for expandable sections
 * Rotates based on expanded state
 */
export const ChevronIcon: React.FC<IconProps & { expanded: boolean }> = ({
	expanded,
	size = 12,
	style,
}) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
		style={{
			transition: 'transform 0.2s ease',
			transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
			opacity: 0.7,
			flexShrink: 0,
			...style,
		}}
	>
		<path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
	</svg>
);

/**
 * View mode toggle icon for diff viewer
 * Shows split or inline view indicator
 */
export const ViewModeIcon: React.FC<IconProps & { sideBySide: boolean }> = ({
	sideBySide,
	size = 12,
	style,
	className,
}) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="currentColor"
		style={style}
		className={className}
		aria-hidden="true"
	>
		{sideBySide ? (
			<>
				<rect
					x="1"
					y="2"
					width="6"
					height="12"
					rx="1"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
				/>
				<rect
					x="9"
					y="2"
					width="6"
					height="12"
					rx="1"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
				/>
			</>
		) : (
			<>
				<rect
					x="2"
					y="2"
					width="12"
					height="12"
					rx="1"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.2"
				/>
				<line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" strokeWidth="1" />
				<line x1="2" y1="10" x2="14" y2="10" stroke="currentColor" strokeWidth="1" />
			</>
		)}
	</svg>
);

/**
 * Diff/external link icon for opening diff editor
 */
export const DiffIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<path
			d="M2 3.5A1.5 1.5 0 013.5 2h2a.5.5 0 010 1h-2a.5.5 0 00-.5.5v9a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 011 0v2a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-9z"
			fill="currentColor"
		/>
		<path
			d="M8.5 2a.5.5 0 000 1h3.793L7.146 8.146a.5.5 0 00.708.708L13 3.707V7.5a.5.5 0 001 0v-5a.5.5 0 00-.5-.5h-5z"
			fill="currentColor"
		/>
	</svg>
);

/**
 * Accept/checkmark icon for file changes
 */
export const AcceptIcon: React.FC<IconProps> = ({ size = 12, style }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		aria-hidden="true"
		style={style}
	>
		<path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
	</svg>
);

/**
 * Reject/X icon for file changes
 */
export const RejectIcon: React.FC<IconProps> = ({ size = 12, style }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		aria-hidden="true"
		style={style}
	>
		<path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
	</svg>
);

/**
 * Expandable chevron for panels (rotates 90deg when expanded)
 */
export const ExpandChevronIcon: React.FC<IconProps & { expanded: boolean }> = ({
	expanded,
	size = 10,
	style,
}) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
		style={{
			transition: 'transform 0.15s ease',
			transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
			opacity: 0.6,
			...style,
		}}
	>
		<path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" />
	</svg>
);

/**
 * Small X icon for badges and removable items
 */
export const SmallCloseIcon: React.FC<IconProps> = ({ size = 10, style }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="currentColor"
		aria-hidden="true"
		style={style}
	>
		<path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
	</svg>
);

/**
 * Expand/Collapse icon with up-down arrows for expandable panels
 */
export const ExpandCollapseIcon: React.FC<IconProps> = ({ size = 12, style, className }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		style={style}
		className={cn('shrink-0', className)}
	>
		{/* Arrow up */}
		<path d="M8 2L4 6M8 2L12 6" />
		{/* Arrow down */}
		<path d="M8 14L4 10M8 14L12 10" />
	</svg>
);

/**
 * Brain side view icon for thinking/reasoning indicators
 * Based on Tabler Icons brain icon
 */
export const BrainSideIcon: React.FC<IconProps> = ({ size = 14, style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		aria-hidden="true"
		style={style}
	>
		<path
			fill="currentColor"
			d="M21.33 12.91c.09 1.55-.62 3.04-1.89 3.95l.77 1.49c.23.45.26.98.06 1.45c-.19.47-.58.84-1.06 1l-.79.25a1.69 1.69 0 0 1-1.86-.55L14.44 18c-.89-.15-1.73-.53-2.44-1.1c-.5.15-1 .23-1.5.23c-.88 0-1.76-.27-2.5-.79c-.53.16-1.07.23-1.62.22c-.79.01-1.57-.15-2.3-.45a4.1 4.1 0 0 1-2.43-3.61c-.08-.72.04-1.45.35-2.11c-.29-.75-.32-1.57-.07-2.33C2.3 7.11 3 6.32 3.87 5.82c.58-1.69 2.21-2.82 4-2.7c1.6-1.5 4.05-1.66 5.83-.37c.42-.11.86-.17 1.3-.17c1.36-.03 2.65.57 3.5 1.64c2.04.53 3.5 2.35 3.58 4.47c.05 1.11-.25 2.2-.86 3.13c.07.36.11.72.11 1.09m-5-1.41c.57.07 1.02.5 1.02 1.07a1 1 0 0 1-1 1h-.63c-.32.9-.88 1.69-1.62 2.29c.25.09.51.14.77.21c5.13-.07 4.53-3.2 4.53-3.25a2.59 2.59 0 0 0-2.69-2.49a1 1 0 0 1-1-1a1 1 0 0 1 1-1c1.23.03 2.41.49 3.33 1.3c.05-.29.08-.59.08-.89c-.06-1.24-.62-2.32-2.87-2.53c-1.25-2.96-4.4-1.32-4.4-.4c-.03.23.21.72.25.75a1 1 0 0 1 1 1c0 .55-.45 1-1 1c-.53-.02-1.03-.22-1.43-.56c-.48.31-1.03.5-1.6.56c-.57.05-1.04-.35-1.07-.9a.97.97 0 0 1 .88-1.1c.16-.02.94-.14.94-.77c0-.66.25-1.29.68-1.79c-.92-.25-1.91.08-2.91 1.29C6.75 5 6 5.25 5.45 7.2C4.5 7.67 4 8 3.78 9c1.08-.22 2.19-.13 3.22.25c.5.19.78.75.59 1.29c-.19.52-.77.78-1.29.59c-.73-.32-1.55-.34-2.3-.06c-.32.27-.32.83-.32 1.27c0 .74.37 1.43 1 1.83c.53.27 1.12.41 1.71.4q-.225-.39-.39-.81a1.038 1.038 0 0 1 1.96-.68c.4 1.14 1.42 1.92 2.62 2.05c1.37-.07 2.59-.88 3.19-2.13c.23-1.38 1.34-1.5 2.56-1.5m2 7.47l-.62-1.3l-.71.16l1 1.25zm-4.65-8.61a1 1 0 0 0-.91-1.03c-.71-.04-1.4.2-1.93.67c-.57.58-.87 1.38-.84 2.19a1 1 0 0 0 1 1c.57 0 1-.45 1-1c0-.27.07-.54.23-.76c.12-.1.27-.15.43-.15c.55.03 1.02-.38 1.02-.92"
		/>
	</svg>
);

/**
 * Todo list icon for task management
 * Based on Material Symbols by Google - lightbulb/idea icon
 */
export const TodoListIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<path
			fill="currentColor"
			d="M10 18q-.825 0-1.412-.587T8 16v-1.25q-1.425-.975-2.212-2.5T5 9q0-2.925 2.038-4.962T12 2t4.963 2.038T19 9q0 1.725-.788 3.238T16 14.75V16q0 .825-.587 1.413T14 18zm0-2h4v-2.3l.85-.6q1.025-.7 1.588-1.787T17 9q0-2.075-1.463-3.537T12 4T8.463 5.463T7 9q0 1.225.563 2.313T9.15 13.1l.85.6zm0 6q-.425 0-.712-.288T9 21v-1h6v1q0 .425-.288.713T14 22zm2-13"
		/>
	</svg>
);

/**
 * Checkmark circle icon for completed tasks
 */
export const TodoCheckIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<circle
			cx="8"
			cy="8"
			r="6"
			stroke="currentColor"
			strokeWidth="1.5"
			fill="currentColor"
			fillOpacity="0.15"
		/>
		<path
			d="M5 8l2 2 4-4"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

/**
 * In-progress sparkle icon for active tasks
 */
export const TodoProgressIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
		/>
	</svg>
);

/**
 * Empty circle icon for pending tasks
 */
export const TodoPendingIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 16 16"
		fill="none"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
	</svg>
);

/**
 * Agents icon for rules/commands/skills/hooks settings
 * Sparkle icon from Lucide representing AI agent capabilities
 */
export const AgentsIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<path
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
		/>
	</svg>
);

/**
 * Plan icon for Plan Mode button
 * Custom path icon provided by user (optimized)
 */
export const PlanIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 16 16"
		aria-hidden="true"
		style={style}
		className={className}
		fill="currentColor"
	>
		<path
			fillRule="evenodd"
			clipRule="evenodd"
			d="M5 2.5h9.5v11H5v-11zm1-1a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9.5a1 1 0 0 0 1-1v-11a1 1 0 0 0-1-1H6z"
		/>
		<path d="M7 4h6v1H7V4zm0 3h6v1H7V7zm0 3h6v1H7v-1zm-4.5-5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 3a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
	</svg>
);

/**
 * Improve Prompt icon - hammer/build icon for prompt enhancement
 * Based on Material Symbols by Google
 */
export const ImprovePromptIcon: React.FC<IconProps> = ({ size = 14, style, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
		viewBox="0 0 24 24"
		aria-hidden="true"
		style={style}
		className={className}
	>
		<path
			fill="currentColor"
			d="m8.275 7.725l-3-3L6.7 3.3l3 3zM12 5.35V1.1h2v4.25zm7.275 13.375l-3-3L17.7 14.3l3 3zm-1.575-11L16.275 6.3l3-3L20.7 4.725zM18.65 12v-2h4.25v2zM5.825 22.425l-4.25-4.25l9.8-9.8Q12.25 7.5 13.5 7.5t2.125.875t.875 2.125t-.875 2.125zm6.275-9.1l2.1-2.125q.3-.3.3-.7t-.3-.7t-.7-.3t-.7.3l-2.125 2.125z"
		/>
	</svg>
);
