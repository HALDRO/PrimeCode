/**
 * @file Access gate component
 * @description Compact permission-request banner embedded inside ToolCards.
 *              All response logic is delegated to the shared `useAccessResponse` hook.
 */

import type React from 'react';
import { useAccessResponse } from '../../hooks/useAccessResponse';
import { cn } from '../../lib/cn';
import { CheckIcon, CloseIcon, ShieldIcon } from '../icons';
import { Tooltip } from '../ui';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface AccessGateProps {
	/** Permission request id */
	requestId: string;
	/** Store message id (for optimistic update) */
	messageId?: string;
	/** Tool name */
	tool: string;
	/** Tool input payload */
	input: Record<string, unknown> | unknown;
	/** Optional glob pattern */
	pattern?: string;
	className?: string;
	/** Hide input details (e.g. when diff or command is already visible) */
	hideDetails?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract display-friendly details from tool input, filtering out large content fields. */
function getDisplayDetails(input: unknown, hideDetails?: boolean): string | null {
	if (hideDetails || !input || typeof input !== 'object') return null;

	const filtered = Object.fromEntries(
		Object.entries(input as Record<string, unknown>).filter(
			([key]) => !['content', 'new_content', 'old_content', 'file_content'].includes(key),
		),
	);

	return Object.keys(filtered).length > 0 ? JSON.stringify(filtered, null, 2) : null;
}

// ---------------------------------------------------------------------------
// Internal layout
// ---------------------------------------------------------------------------

const InlineGate: React.FC<{
	handleResponse: (approved: boolean, always?: boolean) => void;
	details: string | null;
	className?: string;
}> = ({ handleResponse, details, className }) => (
	<div className={cn('py-0', className)}>
		<div className="flex items-center gap-3">
			<div className="flex items-center gap-1.5 shrink-0">
				<div className="flex items-center justify-center w-5 h-5 rounded bg-warning/15">
					<ShieldIcon size={12} className="text-warning" />
				</div>
				<span className="text-sm text-warning font-medium font-(family-name:--vscode-font-family)">
					Permission
				</span>
			</div>

			<div className="flex items-center gap-2">
				<Tooltip content="Allow once" position="top" delay={150}>
					<button
						type="button"
						onClick={() => handleResponse(true)}
						className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-success/15 text-success hover:bg-success/25 transition-colors cursor-pointer border-none"
					>
						<CheckIcon size={12} />
						<span>Allow</span>
					</button>
				</Tooltip>
				<Tooltip content="Always allow this pattern" position="top" delay={150}>
					<button
						type="button"
						onClick={() => handleResponse(true, true)}
						className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-info/15 text-info hover:bg-info/25 transition-colors cursor-pointer border-none"
					>
						<CheckIcon size={12} />
						<span>Always</span>
					</button>
				</Tooltip>
				<Tooltip content="Deny this action" position="top" delay={150}>
					<button
						type="button"
						onClick={() => handleResponse(false)}
						className="flex items-center gap-1 h-(--btn-height-sm) px-2.5 rounded text-sm font-medium bg-error/15 text-error hover:bg-error/25 transition-colors cursor-pointer border-none"
					>
						<CloseIcon size={12} />
						<span>Deny</span>
					</button>
				</Tooltip>
			</div>
		</div>

		{details && (
			<div className="mt-1.5 p-1.5 rounded bg-black/20 text-xs font-mono text-vscode-foreground/70 whitespace-pre-wrap break-all max-h-(--content-max-height-sm) overflow-auto">
				{details}
			</div>
		)}
	</div>
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const AccessGate: React.FC<AccessGateProps> = ({
	requestId,
	messageId,
	tool,
	input,
	className,
	hideDetails,
}) => {
	const handleResponse = useAccessResponse({ requestId, tool, messageId });

	return (
		<InlineGate
			handleResponse={handleResponse}
			details={getDisplayDetails(input, hideDetails)}
			className={className}
		/>
	);
};
