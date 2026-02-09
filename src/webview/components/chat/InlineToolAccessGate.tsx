/**
 * @file Inline tool access gate
 * @description Renders a compact, stylish access request banner embedded inside tool cards.
 *              Uses VS Code-native styling with subtle warning accent. For file operations,
 *              only shows minimal info since content is visible in diff viewer below.
 */

import type React from 'react';
import { cn } from '../../lib/cn';
import { useVSCode } from '../../utils/vscode';
import { CheckIcon, CloseIcon, ShieldIcon } from '../icons';
import { Tooltip } from '../ui';

export interface InlineToolAccessGateProps {
	requestId: string;
	tool: string;
	input: Record<string, unknown> | unknown;
	pattern?: string;
	className?: string;
	/** If true, input details are hidden (e.g. for file edits where diff is shown, or bash commands shown in header) */
	hideDetails?: boolean;
}

/**
 * Extract display-friendly details from tool input.
 * Returns null if hideDetails is true or if input is empty.
 */
function getDisplayDetails(input: unknown, hideDetails?: boolean): string | null {
	if (hideDetails) {
		return null;
	}

	if (!input || typeof input !== 'object') {
		return null;
	}

	const inputObj = input as Record<string, unknown>;

	// For other tools, show compact JSON without large content fields
	const filtered = Object.fromEntries(
		Object.entries(inputObj).filter(
			([key]) => !['content', 'new_content', 'old_content', 'file_content'].includes(key),
		),
	);

	if (Object.keys(filtered).length === 0) {
		return null;
	}
	return JSON.stringify(filtered, null, 2);
}

export const InlineToolAccessGate: React.FC<InlineToolAccessGateProps> = props => {
	const { requestId, tool, input, className } = props;
	const { postMessage } = useVSCode();

	const handleResponse = (isApproved: boolean, alwaysAllow = false) => {
		postMessage('accessResponse', {
			id: requestId,
			toolName: tool,
			approved: isApproved,
			alwaysAllow,
			response: isApproved ? (alwaysAllow ? 'always' : 'once') : 'reject',
		});
	};

	const details = getDisplayDetails(input, props.hideDetails);

	return (
		<div className={cn('py-1', className)}>
			{/* Single row: label left, buttons centered */}
			<div className="flex items-center gap-2">
				{/* Left: icon + label */}
				<div className="flex items-center gap-1.5 shrink-0">
					<div className="flex items-center justify-center w-5 h-5 rounded bg-warning/15">
						<ShieldIcon size={12} className="text-warning" />
					</div>
					<span className="text-sm text-warning font-medium font-(family-name:--vscode-font-family)">
						Permission
					</span>
				</div>

				{/* Center: action buttons */}
				<div className="flex-1 flex items-center justify-center gap-2">
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

			{/* Details (only for bash commands, etc.) */}
			{details && (
				<div className="mt-1.5 p-1.5 rounded bg-black/20 text-xs font-mono text-vscode-foreground/70 whitespace-pre-wrap break-all max-h-(--content-max-height-sm) overflow-auto">
					{details}
				</div>
			)}
		</div>
	);
};
